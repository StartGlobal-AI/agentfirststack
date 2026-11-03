import { ApiError, badRequest, newId, notFound } from "@afs/shared";
import { type ContainerConfig, EMPTY_CONFIG } from "../config/schema";
import { validateConfig } from "../config/validate";
import type { ContainerState } from "../do/container-do";
import type { Bindings } from "../env";
import type { DestinationInfo } from "./dispatch-plan";
import { PROXY_KEY_HEADER } from "./proxy";

export interface ContainerRow {
  id: string;
  account_id: string;
  domain: string;
  name: string | null;
  allowed_hostnames: string;
  draft: string;
  draft_revision: number;
  draft_updated_at: number;
  live_version: number | null;
  published_at: number | null;
  created_at: number;
  updated_at: number;
}

/** "https://www.Example.com/path" -> "example.com". */
export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase();
  s = s
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  s = s.replace(/^www\./, "");
  if (
    !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(s) ||
    (!s.includes(".") && s !== "localhost")
  ) {
    throw badRequest(`"${input}" is not a valid domain.`, 'Pass the site\'s domain, e.g. "example.com" (no path).');
  }
  return s;
}

export function normalizeHostnames(list: string[]): string[] {
  return [
    ...new Set(
      list.map((h) => {
        const wild = h.trim().startsWith("*.");
        const d = h
          .trim()
          .replace(/^\*\./, "")
          .toLowerCase()
          .replace(/^[a-z]+:\/\//, "")
          .replace(/[/:].*$/, "");
        if (!/^[a-z0-9.-]+$/.test(d))
          throw badRequest(`"${h}" is not a hostname.`, 'Use hostnames like "shop.example.net", "*.example.net" or "localhost".');
        return wild ? `*.${d}` : d;
      }),
    ),
  ];
}

export function publicContainer(row: ContainerRow, base: string) {
  return {
    id: row.id,
    domain: row.domain,
    name: row.name,
    allowed_hostnames: JSON.parse(row.allowed_hostnames) as string[],
    live_version: row.live_version,
    published_at: row.published_at,
    draft_revision: row.draft_revision,
    draft_updated_at: row.draft_updated_at,
    script_url: `${base}/c/${row.id}.js`,
    snippet: snippet(base, row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const snippet = (base: string, id: string) => `<script async src="${base}/c/${id}.js"></script>`;

export async function getContainerRow(env: Bindings, accountId: string, id: string): Promise<ContainerRow> {
  const row = await env.DB.prepare("SELECT * FROM containers WHERE id = ? AND account_id = ?").bind(id, accountId).first<ContainerRow>();
  if (!row) throw notFound("Container", "GET /v1/containers lists your containers; POST /v1/containers { domain } creates one.");
  return row;
}

export function containerStub(env: Bindings, id: string) {
  return env.CONTAINER.getByName(id);
}

export async function destinationInfos(env: Bindings, containerId: string): Promise<DestinationInfo[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, type, enabled, settings FROM destinations WHERE container_id = ? ORDER BY created_at",
  )
    .bind(containerId)
    .all<{ id: string; type: string; enabled: number; settings: string }>();
  return results.map((r) => ({
    id: r.id,
    type: r.type,
    enabled: !!r.enabled,
    settings: JSON.parse(r.settings) as DestinationInfo["settings"],
  }));
}

export async function liveConfig(env: Bindings, row: Pick<ContainerRow, "id" | "live_version">): Promise<ContainerConfig | null> {
  if (row.live_version == null) return null;
  const v = await env.DB.prepare("SELECT config FROM container_versions WHERE container_id = ? AND version = ?")
    .bind(row.id, row.live_version)
    .first<{ config: string }>();
  return v ? (JSON.parse(v.config) as ContainerConfig) : null;
}

export const containerState = (row: ContainerRow): ContainerState => ({
  id: row.id,
  account_id: row.account_id,
  domain: row.domain,
  allowed_hostnames: JSON.parse(row.allowed_hostnames) as string[],
  live_version: row.live_version,
});

/** Push everything the data plane needs into the container's Durable Object. */
export async function syncToDO(
  env: Bindings,
  row: ContainerRow,
  parts: { config?: boolean; destinations?: boolean } = { config: true, destinations: true },
) {
  const stub = containerStub(env, row.id);
  await stub.sync({
    container: containerState(row),
    ...(parts.config ? { config: await liveConfig(env, row) } : {}),
    ...(parts.destinations ? { destinations: await destinationInfos(env, row.id) } : {}),
  });
}

/** Load a container by id (no account check; public data plane) and sync it into its DO. */
export async function resyncById(env: Bindings, id: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT * FROM containers WHERE id = ?").bind(id).first<ContainerRow>();
  if (!row) return false;
  await syncToDO(env, row);
  return true;
}

/**
 * Snippet + first-party proxy configs. `proxyKey` (see src/service/proxy.ts) goes only into the
 * proxy configs, which run server-side on the customer's infrastructure, never into the page.
 */
export function installInstructions(base: string, row: Pick<ContainerRow, "id" | "domain">, proxyKey: string | null) {
  const id = row.id;
  const origin = base;
  const key = proxyKey ?? "<not available: ENCRYPTION_KEY is not set on this deployment>";
  return {
    snippet: snippet(base, id),
    where:
      "Paste into <head> on every page, as early as possible. One snippet loads all tags; change tags via the API, never by editing the site.",
    data_layer: {
      description: "GTM-compatible. Push events and data before or after the snippet loads.",
      example: `window.dataLayer = window.dataLayer || [];\ndataLayer.push({ event: "purchase", ecommerce: { transaction_id: "T123", value: 49.0, currency: "USD" }, user: { email: "a@b.com" } });`,
    },
    javascript_api: {
      "afst('event', name, data)": "Same as dataLayer.push({ event: name, ...data }).",
      "afst('consent', 'update', { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' })":
        "Call from your consent banner. CMPs that call gtag('consent','update',...) work too.",
      "afst('identify', user_id, { email, phone })": "Attach a logged-in user; PII is hashed in the browser.",
      "afst('get', 'visitor_id')":
        "The visitor id; send it to your backend so server events (POST /v1/containers/:id/events) join to this visitor.",
      "afst('get', 'event_id')":
        "The last conversion's event_id; pass it as event_id in the matching server event so Meta/TikTok dedupe it against the pixel.",
    },
    first_party_proxy: {
      why: "Serving the script and /collect from your own domain makes them first-party: ad blockers don't drop conversions and /collect can re-set click-id cookies server-side so they survive Safari's 7-day cap on script-set cookies. Any path prefix works; the runtime posts to <prefix>/collect next to where it was loaded from.",
      snippet: `<script async src="/_t/c/${id}.js"></script>`,
      proxy_key: proxyKey,
      proxy_key_header: PROXY_KEY_HEADER,
      cloudflare_worker: `// Worker route: ${row.domain}/_t/*\nexport default { async fetch(req) { const u = new URL(req.url); const h = new Headers(req.headers); h.set("x-forwarded-for", req.headers.get("cf-connecting-ip") || ""); h.set("${PROXY_KEY_HEADER}", "${key}"); return fetch("${origin}" + u.pathname.replace(/^\\/_t/, "") + u.search, { method: req.method, headers: h, body: req.body }); } };`,
      nextjs: `// middleware.js (Next.js): Vercel sets x-forwarded-for to the visitor's IP; this adds the key.\nimport { NextResponse } from "next/server";\nexport const config = { matcher: "/_t/:path*" };\nexport function middleware(req) { const h = new Headers(req.headers); h.set("${PROXY_KEY_HEADER}", "${key}"); return NextResponse.rewrite(new URL(req.nextUrl.pathname.replace(/^\\/_t/, "") + req.nextUrl.search, "${origin}"), { request: { headers: h } }); }`,
      vercel: `// vercel.json rewrites can't add request headers, so /collect gets Vercel's IP, not the visitor's. For the visitor's IP use the Next.js middleware above (or Vercel Routing Middleware doing the same).\n{ "rewrites": [{ "source": "/_t/:path*", "destination": "${origin}/:path*" }] }`,
      netlify: `# netlify.toml\n[[redirects]]\n  from = "/_t/*"\n  to = "${origin}/:splat"\n  status = 200\n  force = true\n  headers = { ${PROXY_KEY_HEADER} = "${key}" }`,
      nginx: `location /_t/ { proxy_pass ${origin}/; proxy_set_header Host ${new URL(origin).host}; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header ${PROXY_KEY_HEADER} "${key}"; }`,
      note: `/collect trusts X-Forwarded-For (the visitor's IP, sent on to the conversion APIs) only from requests that carry ${PROXY_KEY_HEADER}: ${proxyKey ? "this container's key" : "unavailable here"}. Keep it server-side (proxy config or env var), never in page HTML. Without it, or behind a proxy that doesn't add it, the IP sent on is the proxy's. The proxy must set X-Forwarded-For to the visitor's IP itself (the Cloudflare Worker and nginx configs above do), not append to what the browser sent.`,
    },
    verify: [
      `POST /v1/containers/${id}/scan confirms the snippet is on ${row.domain}.`,
      `GET /v1/containers/${id} shows stats.last_24h.visits once pages load.`,
      `GET /v1/containers/${id}/events?include_visits=true shows each hit.`,
    ],
  };
}

export function containerNextSteps(id: string, existing: boolean, published: boolean) {
  const steps = [
    existing
      ? "This domain already had a container; it was returned unchanged."
      : "Install the snippet (install.snippet) in <head> on every page.",
    `POST /v1/containers/${id}/scan to see which tags and forms the site has today and get a suggested config.`,
    `Fastest: MCP setup_conversion_tracking, or PUT /v1/containers/${id}/draft with tags, triggers and conversions (GET /v1/schema for the format).`,
    `POST /v1/containers/${id}/destinations to add server-side conversion APIs (meta, ga4, google_ads, tiktok, analytics, webhook).`,
    `POST /v1/containers/${id}/draft/validate, then POST /v1/containers/${id}/preview to test, then POST /v1/containers/${id}/publish.`,
  ];
  if (published) steps.splice(1, 0, `Live version is published; GET /v1/containers/${id}/events shows traffic.`);
  return steps;
}

export async function createContainer(
  env: Bindings,
  accountId: string,
  input: { domain: string; name?: string; allowed_hostnames?: string[] },
) {
  const domain = normalizeDomain(input.domain);
  const found = await env.DB.prepare("SELECT * FROM containers WHERE account_id = ? AND domain = ?")
    .bind(accountId, domain)
    .first<ContainerRow>();
  if (found) return { row: found, existing: true };
  // MAX_CONTAINERS_PER_ACCOUNT (hosted fair use). Unset = no cap.
  const max = Number(env.MAX_CONTAINERS_PER_ACCOUNT || 0);
  if (max > 0) {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM containers WHERE account_id = ?").bind(accountId).first<{ n: number }>();
    if ((n?.n ?? 0) >= max) {
      throw new ApiError(
        403,
        "quota_exceeded",
        `This account already has ${max} containers, the most allowed here.`,
        "Delete a container you no longer need (DELETE /v1/containers/:id), or self-host for more (see /llms.txt).",
      );
    }
  }
  const now = Date.now();
  const row: ContainerRow = {
    id: newId("ctr"),
    account_id: accountId,
    domain,
    name: input.name ?? null,
    allowed_hostnames: JSON.stringify(normalizeHostnames(input.allowed_hostnames ?? [])),
    draft: JSON.stringify(EMPTY_CONFIG),
    draft_revision: 1,
    draft_updated_at: now,
    live_version: null,
    published_at: null,
    created_at: now,
    updated_at: now,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO containers (id, account_id, domain, name, allowed_hostnames, draft, draft_revision, draft_updated_at, live_version, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
      .bind(row.id, accountId, domain, row.name, row.allowed_hostnames, row.draft, 1, now, now, now)
      .run();
  } catch (e) {
    // Lost a race with a concurrent create for the same domain: return the winner.
    const again = await env.DB.prepare("SELECT * FROM containers WHERE account_id = ? AND domain = ?")
      .bind(accountId, domain)
      .first<ContainerRow>();
    if (again) return { row: again, existing: true };
    throw e;
  }
  await syncToDO(env, row, { config: false, destinations: true });
  return { row, existing: false };
}

export async function listContainers(env: Bindings, accountId: string) {
  const { results } = await env.DB.prepare("SELECT * FROM containers WHERE account_id = ? ORDER BY created_at")
    .bind(accountId)
    .all<ContainerRow>();
  return results;
}

export async function updateContainer(
  env: Bindings,
  accountId: string,
  id: string,
  input: { name?: string | null; allowed_hostnames?: string[] },
) {
  const row = await getContainerRow(env, accountId, id);
  const name = input.name === undefined ? row.name : input.name;
  const hosts = input.allowed_hostnames === undefined ? row.allowed_hostnames : JSON.stringify(normalizeHostnames(input.allowed_hostnames));
  const now = Date.now();
  await env.DB.prepare("UPDATE containers SET name = ?, allowed_hostnames = ?, updated_at = ? WHERE id = ?")
    .bind(name, hosts, now, id)
    .run();
  const next = { ...row, name, allowed_hostnames: hosts, updated_at: now };
  await containerStub(env, id).sync({ container: containerState(next) });
  return next;
}

export async function deleteContainer(env: Bindings, accountId: string, id: string) {
  await getContainerRow(env, accountId, id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM destinations WHERE container_id = ?").bind(id),
    env.DB.prepare("DELETE FROM container_versions WHERE container_id = ?").bind(id),
    env.DB.prepare("DELETE FROM preview_tokens WHERE container_id = ?").bind(id),
    env.DB.prepare("DELETE FROM containers WHERE id = ?").bind(id),
  ]);
  await containerStub(env, id).destroy();
}

export async function containerStats(env: Bindings, id: string) {
  try {
    return await containerStub(env, id).stats();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function draftConfig(row: ContainerRow): ContainerConfig {
  return JSON.parse(row.draft) as ContainerConfig;
}

export async function draftValidation(env: Bindings, row: ContainerRow, config?: unknown) {
  const dest = await destinationInfos(env, row.id);
  return validateConfig(config ?? draftConfig(row), { destinations: dest, domain: row.domain });
}

export function assertConfigObject(v: unknown): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new ApiError(
      400,
      "bad_request",
      "The draft must be a JSON object.",
      'Send { "variables": [...], "triggers": [...], "tags": [...], "conversions": [...], "consent": {...} }.',
    );
  }
}
