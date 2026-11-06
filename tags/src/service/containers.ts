import { ApiError, accountStanding, badRequest, newId, notFound, type ProtectionMode } from "@afs/shared";
import { type ContainerConfig, EMPTY_CONFIG } from "../config/schema";
import { validateConfig } from "../config/validate";
import type { ContainerState } from "../do/container-do";
import type { Bindings } from "../env";
import { isIpLiteral, isPublicSuffix, numericTld } from "../lib/domain";
import type { DestinationInfo } from "./dispatch-plan";
import { limits } from "./limits";
import { parseMode } from "./protection";
import { PROXY_KEY_HEADER } from "./proxy";
import type { LastScan } from "./scan";
import { codeGate, customCodeProblem, verificationInfo } from "./verify";

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
  /** Domain verification (migration 0006): needed to publish custom code. */
  verified_at?: number | null;
  verified_method?: string | null;
  /** JSON (migration 0009): the last scan's tools (LastScan) and the last non-dry-run import (LastImport). */
  last_scan?: string | null;
  last_import?: string | null;
  /** Attack protection (migration 0010): auto (NULL), strict or off. */
  protection?: string | null;
}

/** container.last_import: written by every draft/import that isn't a dry run. */
export interface LastImport {
  at: number;
  format: "gtm" | "afst";
  mode: "merge" | "overwrite";
  summary: { tags: number; triggers: number; variables: number; conversions: number; skipped: number };
}

/** A stored JSON column (written by this code): null when empty or unreadable. */
function storedJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
export const lastScanOf = (row: Pick<ContainerRow, "last_scan">) => storedJson<LastScan>(row.last_scan);
export const lastImportOf = (row: Pick<ContainerRow, "last_import">) => storedJson<LastImport>(row.last_import);

/** Remember a scan on the container (not a settings change: updated_at stays). */
export async function recordScan(env: Bindings, id: string, scan: LastScan) {
  await env.DB.prepare("UPDATE containers SET last_scan = ? WHERE id = ?").bind(JSON.stringify(scan), id).run();
}
export async function recordImport(env: Bindings, id: string, imp: LastImport) {
  await env.DB.prepare("UPDATE containers SET last_import = ? WHERE id = ?").bind(JSON.stringify(imp), id).run();
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
  // A container's domain is what /collect accepts hits from (and its subdomains), what scan
  // fetches and what verification proves: a registrable name, not an address or a suffix.
  if (s !== "localhost" && (isIpLiteral(s) || numericTld(s)))
    throw badRequest(`"${input}" is an IP address.`, 'Use the site\'s domain name, e.g. "example.com".');
  if (s !== "localhost" && isPublicSuffix(s))
    throw badRequest(
      `"${input}" is a public suffix (anyone can register names under it).`,
      'Use your own domain, e.g. "example.co.uk" or "myapp.github.io".',
    );
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
        if (wild && (isPublicSuffix(d) || isIpLiteral(d)))
          throw badRequest(
            `"${h}" would allow every site under ${d}.`,
            'Wildcards must be over a domain you own, e.g. "*.example.net" (not "*.com", "*.co.uk" or "*.github.io").',
          );
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
    domain_verified: !!row.verified_at,
    // Attack protection mode; GET /v1/containers/:id has its state (protection { mode, state, ... }).
    protection: parseMode(row.protection),
    created_at: row.created_at,
    updated_at: row.updated_at,
    // What the site had at the last scan, and the last import: null until there is one.
    last_scan: lastScanOf(row),
    last_import: lastImportOf(row),
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
    "SELECT id, type, enabled, settings, consecutive_failures, circuit_open_until FROM destinations WHERE container_id = ? ORDER BY created_at",
  )
    .bind(containerId)
    .all<{
      id: string;
      type: string;
      enabled: number;
      settings: string;
      consecutive_failures: number;
      circuit_open_until: number | null;
    }>();
  return results.map((r) => ({
    id: r.id,
    type: r.type,
    enabled: !!r.enabled,
    settings: JSON.parse(r.settings) as DestinationInfo["settings"],
    circuit_open_until: r.circuit_open_until ?? null,
    consecutive_failures: r.consecutive_failures ?? 0,
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
  protection: parseMode(row.protection),
  created_at: row.created_at,
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

/** How to get the first-party proxy configs (they carry the container's proxy key). */
export const proxySetupHow = (id: string) =>
  `GET /v1/containers/${id}/install?proxy=1 (MCP get_install_instructions { "proxy": true }, full-access key) returns the proxy configs with this container's proxy key. Ask for it only when you set up the proxy, and keep the key server-side: in the proxy config or an env var, never in page HTML or chat.`;

/** Where first-party domains are created: the platform site (AUTH_ISSUER), or null when this service runs alone. */
export const platformBase = (env: { AUTH_ISSUER?: string }) => env.AUTH_ISSUER?.trim().replace(/\/+$/, "") || null;

/**
 * The three ways to install, best first: a first-party domain (one CNAME, no server code; created
 * on the platform site), the path proxy (first_party_proxy), and the direct snippet, which ad
 * blockers block. Every install answer leads with it.
 */
export function firstPartyBlock(base: string, id: string, siteBase: string | null) {
  const endpoint = siteBase ? `${siteBase}/v1/first-party-domains` : null;
  return {
    default: true,
    why: "Ad blockers block the tag runtime and /collect on a third-party host, so their conversions are lost. Serve them from the site's own domain: use the first of these that works for the site. (Only the path proxy, on the page's own host, also lets /collect re-set click-id cookies server-side.)",
    order: ["first_party_domain", "path_proxy", "direct"],
    first_party_domain: {
      rank: 1,
      what: "A subdomain of the site (e.g. edge.example.com) with one CNAME to this platform, no server code. It serves tags (/_t), analytics (/_a) and replay (/_r) for the whole project at once, with the visitor's IP and geo.",
      when: "You can add a DNS record. If you can't, it's one record to hand the owner; use the path proxy (or the direct snippet) until it's active.",
      create: endpoint
        ? `POST ${endpoint} {"hostname":"edge.<the site's domain>"} (MCP afs_add_first_party_domain): returns the CNAME to add, the filled-in snippets and next_steps`
        : "Not on this deployment (this tags service runs without the platform site): use the path proxy.",
      status: endpoint ? `GET ${endpoint} until status is "active", then swap the snippet` : null,
      snippet: `<script async src="https://<hostname>/_t/c/${id}.js"></script>`,
      label:
        "Pick a neutral label (edge, go, www2), not analytics, stats, track, metrics, pixel, tag or collect: filter lists target those names too.",
    },
    path_proxy: {
      rank: 2,
      what: "Forward /_t/* on the site's own server, edge or framework to this service with the container's proxy key. Ready configs: first_party_proxy (with ?proxy=1).",
      when: "DNS can't be changed, but the site's server or host can forward a path.",
      snippet: `<script async src="/_t/c/${id}.js"></script>`,
      configs: proxySetupHow(id),
    },
    direct: {
      rank: 3,
      what: "The plain snippet, straight to this service's host. Last resort: ad blockers block it.",
      snippet: snippet(base, id),
    },
  };
}

/**
 * Snippet + first-party proxy instructions. The proxy configs embed the container's proxy key
 * (src/service/proxy.ts), which must stay server-side, so they're only included when `proxyKey`
 * is passed (GET /install?proxy=1); otherwise first_party_proxy says how to ask for them.
 * `siteBase`: the platform site, where first-party domains are created (platformBase).
 */
export function installInstructions(
  base: string,
  row: Pick<ContainerRow, "id" | "domain">,
  proxy: { key: string | null } | null = null,
  siteBase: string | null = null,
) {
  const id = row.id;
  const origin = base;
  const why =
    "Serving the script and /collect from your own domain makes them first-party: ad blockers don't drop conversions and /collect can re-set click-id cookies server-side so they survive Safari's 7-day cap on script-set cookies. Any path prefix works; the runtime posts to <prefix>/collect next to where it was loaded from.";
  let first_party_proxy: Record<string, unknown> = {
    why,
    snippet: `<script async src="/_t/c/${id}.js"></script>`,
    proxy_key_header: PROXY_KEY_HEADER,
    configs: "not included",
    how_to_get: proxySetupHow(id),
  };
  if (proxy) {
    const proxyKey = proxy.key;
    const key = proxyKey ?? "<not available: ENCRYPTION_KEY is not set on this deployment>";
    first_party_proxy = {
      why,
      snippet: `<script async src="/_t/c/${id}.js"></script>`,
      proxy_key: proxyKey,
      proxy_key_header: PROXY_KEY_HEADER,
      warning:
        "proxy_key is a secret: it lets a request set the visitor IP /collect sends on. Put it only in the proxy config or a server env var; don't print it, commit it or put it in page HTML.",
      cloudflare_worker: `// Worker route: ${row.domain}/_t/*\nexport default { async fetch(req) { const u = new URL(req.url); const h = new Headers(req.headers); for (const k of [...h.keys()]) if (k.startsWith("x-afs-")) h.delete(k); h.delete("cookie"); h.set("x-forwarded-for", req.headers.get("cf-connecting-ip") || ""); h.set("${PROXY_KEY_HEADER}", "${key}"); const cf = req.cf || {}; for (const [k, v] of Object.entries({ country: cf.country, region: cf.region, "region-code": cf.regionCode, city: cf.city, "postal-code": cf.postalCode })) if (v != null) h.set("x-afs-geo-" + k, encodeURIComponent(String(v))); return fetch("${origin}" + u.pathname.replace(/^\\/_t/, "") + u.search, { method: req.method, headers: h, body: req.body }); } };`,
      nextjs: `// middleware.js (Next.js): Vercel sets x-forwarded-for to the visitor's IP; this adds the key.\nimport { NextResponse } from "next/server";\nexport const config = { matcher: "/_t/:path*" };\nexport function middleware(req) { const h = new Headers(req.headers); h.set("${PROXY_KEY_HEADER}", "${key}"); return NextResponse.rewrite(new URL(req.nextUrl.pathname.replace(/^\\/_t/, "") + req.nextUrl.search, "${origin}"), { request: { headers: h } }); }`,
      vercel: `// vercel.json (any framework): a route with a request-header transform adds the key; Vercel forwards the visitor's IP (x-forwarded-for) and geo (x-vercel-ip-*) to the destination.\n${JSON.stringify({ routes: [{ src: "/_t/(.*)", dest: `${origin}/_t/$1`, transforms: [{ type: "request.headers", op: "set", target: { key: PROXY_KEY_HEADER }, args: key }] }] })}`,
      netlify: `// netlify/edge-functions/afs-tags.ts: a Netlify Edge Function sends the visitor's IP and geo, which a netlify.toml proxy redirect doesn't.\nimport type { Config, Context } from "@netlify/edge-functions";\nexport default async (req: Request, context: Context) => { const u = new URL(req.url); const h = new Headers(req.headers); for (const k of [...h.keys()]) if (k.startsWith("x-afs-")) h.delete(k); h.delete("cookie"); h.set("${PROXY_KEY_HEADER}", "${key}"); h.set("x-forwarded-for", context.ip); const g = context.geo; for (const [k, v] of Object.entries({ country: g?.country?.code, "region-code": g?.subdivision?.code, region: g?.subdivision?.name, city: g?.city, "postal-code": g?.postalCode })) if (v != null && v !== "") h.set("x-afs-geo-" + k, encodeURIComponent(String(v))); return fetch("${origin}" + u.pathname + u.search, { method: req.method, headers: h, body: req.method === "POST" ? req.body : undefined }); };\nexport const config: Config = { path: "/_t/*" };`,
      nginx: `location /_t/ { proxy_pass ${origin}/; proxy_set_header Host ${new URL(origin).host}; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header ${PROXY_KEY_HEADER} "${key}"; }`,
      note: `/collect trusts X-Forwarded-For (the visitor's IP, sent on to the conversion APIs) and x-afs-geo-* (the visitor's country, region and city) only from requests that carry ${PROXY_KEY_HEADER}: ${proxyKey ? "this container's key" : "unavailable here"}. Keep it server-side (proxy config or env var), never in page HTML. Without it, or behind a proxy that doesn't add it, the IP sent on is the proxy's. The proxy must set X-Forwarded-For to the visitor's IP itself (the Cloudflare Worker, Netlify Edge Function and nginx configs above do), not append to what the browser sent. A first-party domain (first_party.first_party_domain) needs none of this: the platform's edge sends the visitor's IP and geo itself.`,
    };
  }
  return {
    first_party: firstPartyBlock(base, id, siteBase),
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
      "afst('test', true)":
        "Mark this tab as test traffic (same as opening a page with ?afsa_debug=1; afst('test', false) or ?afsa_debug=0 ends it): ad pixels don't fire in the browser and conversions reach the platforms only in their test mode.",
      "afst('get', 'test')":
        "true in test traffic (preview, ?afsa_debug=1, afst('test', true)); custom_html / custom_js tags still run there and can check it.",
    },
    privacy:
      "By default (settings.respect_dnt) the snippet does nothing in a browser that sends Global Privacy Control or Do Not Track: no tags, no /collect hits, no cookies. Install the plain snippet; no loader is needed for that.",
    first_party_proxy,
    verify: [
      `POST /v1/containers/${id}/scan confirms the snippet is on ${row.domain}.`,
      `GET /v1/containers/${id} shows stats.last_24h.visits once pages load.`,
      `GET /v1/containers/${id}/events?include_visits=true shows each hit.`,
      `Click through the site as a visitor with ?afsa_debug=1 on the first page: the tab is test traffic (ad pixels don't fire, conversions go to the platforms in test mode, events are logged with test: true).`,
    ],
  };
}

export function containerNextSteps(
  id: string,
  existing: boolean,
  published: boolean,
  siteBase: string | null = null,
  domain = "example.com",
) {
  const steps = [
    existing
      ? "This domain already had a container; it was returned unchanged."
      : `Install the snippet in <head> on every page, first-party (the default; ad blockers block third-party tag hosts): ${
          siteBase
            ? `a first-party domain is one CNAME (POST ${siteBase}/v1/first-party-domains {"hostname":"edge.${domain}"}, MCP afs_add_first_party_domain), then <script async src="https://edge.${domain}/_t/c/${id}.js"></script>; can't change DNS: the path proxy /_t/*`
            : "the path proxy /_t/*"
        }. Order and snippets: install.first_party; install.snippet (direct) is the last resort.`,
    `POST /v1/containers/${id}/scan to see which tags and forms the site has today and get a suggested config.`,
    `Fastest: MCP setup_conversion_tracking, or PUT /v1/containers/${id}/draft with tags, triggers and conversions (GET /v1/schema for the format).`,
    `POST /v1/containers/${id}/destinations to add server-side conversion APIs (meta, ga4, google_ads, tiktok, analytics, webhook).`,
    `POST /v1/containers/${id}/draft/validate, then POST /v1/containers/${id}/preview to test, then POST /v1/containers/${id}/publish.`,
    `Path proxy configs (serve the snippet and /collect from your own domain without a first-party domain): ${proxySetupHow(id)}`,
  ];
  if (published) steps.splice(1, 0, `Live version is published; GET /v1/containers/${id}/events shows traffic.`);
  return steps;
}

export async function createContainer(
  env: Bindings,
  accountId: string,
  input: { domain: string; name?: string; allowed_hostnames?: string[]; protection?: ProtectionMode },
) {
  const domain = normalizeDomain(input.domain);
  const found = await env.DB.prepare("SELECT * FROM containers WHERE account_id = ? AND domain = ?")
    .bind(accountId, domain)
    .first<ContainerRow>();
  if (found) return { row: found, existing: true };
  // MAX_CONTAINERS_PER_ACCOUNT (UNCLAIMED_MAX_CONTAINERS_PER_ACCOUNT for agent-only accounts). Unset = no cap.
  const max = limits(env, await accountStanding(env, accountId)).maxContainers;
  if (Number.isFinite(max)) {
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
    protection: input.protection && input.protection !== "auto" ? input.protection : null,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO containers (id, account_id, domain, name, allowed_hostnames, draft, draft_revision, draft_updated_at, live_version, published_at, created_at, updated_at, protection)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    )
      .bind(row.id, accountId, domain, row.name, row.allowed_hostnames, row.draft, 1, now, now, now, row.protection ?? null)
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
  input: { name?: string | null; allowed_hostnames?: string[]; protection?: ProtectionMode },
) {
  const row = await getContainerRow(env, accountId, id);
  const name = input.name === undefined ? row.name : input.name;
  const hosts = input.allowed_hostnames === undefined ? row.allowed_hostnames : JSON.stringify(normalizeHostnames(input.allowed_hostnames));
  const protection = input.protection === undefined ? (row.protection ?? null) : input.protection === "auto" ? null : input.protection;
  const now = Date.now();
  await env.DB.prepare("UPDATE containers SET name = ?, allowed_hostnames = ?, protection = ?, updated_at = ? WHERE id = ?")
    .bind(name, hosts, protection, now, id)
    .run();
  const next = { ...row, name, allowed_hostnames: hosts, protection, updated_at: now };
  await containerStub(env, id).sync({ container: containerState(next) });
  return next;
}

/** Delete a container's D1 rows, then its Durable Object's storage. Returns the rows deleted per table. */
export async function deleteContainer(env: Bindings, accountId: string, id: string) {
  await getContainerRow(env, accountId, id);
  const [destinations, versions, previewTokens, environments, lookups] = await env.DB.batch([
    env.DB.prepare("DELETE FROM destinations WHERE container_id = ?").bind(id),
    env.DB.prepare("DELETE FROM container_versions WHERE container_id = ?").bind(id),
    env.DB.prepare("DELETE FROM preview_tokens WHERE container_id = ?").bind(id),
    env.DB.prepare("DELETE FROM environments WHERE container_id = ?").bind(id),
    env.DB.prepare("DELETE FROM lookups WHERE container_id = ?").bind(id),
    env.DB.prepare("DELETE FROM containers WHERE id = ?").bind(id),
  ]);
  await containerStub(env, id).destroy();
  const n = (r: D1Result | undefined) => r?.meta.changes ?? 0;
  return {
    destinations: n(destinations),
    versions: n(versions),
    preview_tokens: n(previewTokens),
    environments: n(environments),
    lookups: n(lookups),
  };
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

/**
 * Full validation of the draft (or `config`) for this container: destinations (with their
 * circuit state) and whether its custom code may be published (account standing, domain
 * verification, MAX_CUSTOM_CODE_BYTES, the known-bad pattern check, a tags.custom_code pause).
 */
export async function draftValidation(env: Bindings, row: ContainerRow, config?: unknown) {
  const dest = await destinationInfos(env, row.id);
  const candidate = config ?? draftConfig(row);
  const { standing, pause } = await codeGate(env, row.account_id);
  const custom = (cfg: ContainerConfig) => customCodeProblem(env, row, cfg, standing, pause);
  return validateConfig(candidate, {
    destinations: dest,
    domain: row.domain,
    allowed_hostnames: JSON.parse(row.allowed_hostnames) as string[],
    customCode: custom,
  });
}

export { verificationInfo };

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
