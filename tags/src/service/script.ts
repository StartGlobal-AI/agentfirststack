import { accountStanding, capabilityPaused, sha256Hex } from "@afs/shared";
import type { ContainerConfig } from "../config/schema";
import type { Bindings } from "../env";
import { bannerAsks } from "../lib/consent";
import type { BootConfig } from "../runtime/types";
import { environmentByToken } from "./environments";
import { codeGate, customCodeProblem, hasCustomCode, stripCustomCode } from "./verify";
import { previewConfig, previewToken } from "./versions";

/**
 * /c/:id.js = `(function(){var __AFST__=<boot config>;__AFST__.geo=<visitor geo>;<runtime>})();`
 * The boot config (live version + domain) is cached at the edge per container; the visitor's
 * country/region is added per request so consent regions work without varying the cache. When
 * the config depends on the country (consent regions, a consent banner asking only in the EEA),
 * the browser may cache it but shared caches may not (cache-control: private).
 */
export const EDGE_TTL_SECONDS = 60;
export const BROWSER_TTL_SECONDS = 300;

const safeJson = (v: unknown) =>
  JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

/** The two runtime bundles (src/runtime-bundle.ts); a container gets `ext` only when its config needs it. */
export interface Runtimes {
  core: string;
  ext: string;
  /** The consent banner UI (served at /cb/<version>.js, loaded by the runtime only when it shows). */
  ui?: string;
}

/** Does the script's behaviour depend on the visitor's country? (Then shared caches may not keep it.) */
export function dependsOnCountry(cfg: ContainerConfig | null | undefined): boolean {
  const b = cfg?.consent_banner;
  return (!!b?.enabled && b.regions !== "all") || Object.keys(cfg?.consent?.regions ?? {}).length > 0;
}

/** For agents checking with curl: x-afs-consent-banner ask (this visitor sees it) or default (they get the defaults). */
const bannerHeader = (cfg: ContainerConfig | null | undefined, geo: BootConfig["geo"]): Record<string, string> =>
  cfg?.consent_banner?.enabled ? { "x-afs-consent-banner": bannerAsks(cfg.consent_banner, geo?.country) ? "ask" : "default" } : {};

/** Features that live in the extension bundle (src/runtime/ext.ts). */
export function needsExt(cfg: ContainerConfig | null | undefined): boolean {
  if (!cfg) return false;
  return (
    (cfg.triggers ?? []).some(
      (t) => t.type === "video" || t.type === "js_error" || ((t.type === "click" || t.type === "form_submit") && !!t.wait_for_tags_ms),
    ) ||
    !!cfg.settings?.cross_domain?.length ||
    !!cfg.consent?.tcf ||
    (cfg.conversions ?? []).some((c) => c.user_data === "auto")
  );
}

export const pickRuntime = (r: Runtimes | string, cfg: ContainerConfig | null | undefined) =>
  typeof r === "string" ? r : needsExt(cfg) ? r.ext : r.core;

export function compileScript(runtime: string, boot: BootConfig, geo?: BootConfig["geo"], prelude = ""): string {
  const v = boot.preview
    ? `${boot.v === "draft" ? "draft" : `v${boot.v}`} (preview)`
    : boot.env
      ? `${boot.v === "draft" ? "draft" : `v${boot.v}`} (environment ${boot.env.name})`
      : `v${boot.v}`;
  return `/* AgentFirstStack tags ${boot.id} ${v} */\n${prelude}(function(){var __AFST__=${safeJson(boot)};__AFST__.geo=${safeJson(geo ?? {})};\n${runtime}\n})();\n`;
}

const runtimeHashes = new Map<string, string>();
export async function runtimeVersion(runtime: string) {
  let h = runtimeHashes.get(runtime);
  if (!h) runtimeHashes.set(runtime, (h = (await sha256Hex(runtime)).slice(0, 10)));
  return h;
}

interface CachedBoot {
  boot: BootConfig;
  live_version: number;
  /** For the suspension check (absent in entries cached by older code). */
  account_id?: string;
}

const SUSPENDED_JS = "/* AgentFirstStack tags: this container's account is suspended. */\n";
const suspendedScript = () => new Response(SUSPENDED_JS, { status: 403, headers: { ...JS_HEADERS, "cache-control": "no-store" } });

const cacheKey = (origin: string, id: string) => new Request(`${origin.replace(/\/$/, "")}/c/${id}.js?__afst_boot=1`);

function defaultCache(): Cache | null {
  try {
    return (caches as unknown as { default: Cache }).default;
  } catch {
    return null;
  }
}

/** Delete cached boot configs after publish/rollback (Cache API is per colo; others expire in EDGE_TTL_SECONDS). */
export async function purgeScriptCache(id: string, origins: string[]) {
  const cache = defaultCache();
  if (!cache) return;
  await Promise.all([...new Set(origins.filter(Boolean))].map((o) => cache.delete(cacheKey(o, id)).catch(() => false)));
}

const bannerOn = (b: Pick<BootConfig, "cfg">) => !!b.cfg?.consent_banner?.enabled;

async function loadBoot(env: Bindings, id: string): Promise<CachedBoot | null> {
  const row = await env.DB.prepare(
    "SELECT c.id, c.account_id, c.domain, c.live_version, v.config FROM containers c LEFT JOIN container_versions v ON v.container_id = c.id AND v.version = c.live_version WHERE c.id = ?",
  )
    .bind(id)
    .first<{ id: string; account_id: string; domain: string; live_version: number | null; config: string | null }>();
  if (!row) return null;
  const cfg = row.config ? (JSON.parse(row.config) as ContainerConfig) : {};
  return {
    boot: { id: row.id, v: row.live_version ?? 0, d: row.domain, cfg, ab: env.ANALYTICS_BASE_URL || undefined },
    live_version: row.live_version ?? 0,
    account_id: row.account_id,
  };
}

export interface ScriptRequest {
  id: string;
  preview?: string | null;
  /** Environment snippet token (?env=). */
  env?: string | null;
  origin: string;
  cacheOrigin: string;
  geo: BootConfig["geo"];
  ifNoneMatch?: string | null;
}

const JS_HEADERS = {
  "content-type": "application/javascript; charset=utf-8",
  "access-control-allow-origin": "*",
  "x-content-type-options": "nosniff",
};

/** The banner UI's version for boot.ui (absent when this deployment has no UI bundle, e.g. a string runtime in tests). */
const uiVersion = async (r: Runtimes | string) => (typeof r === "string" || !r.ui ? undefined : runtimeVersion(r.ui));

/**
 * /cb/<version>.js: the consent banner UI. The current version is immutable (a year in any cache);
 * another version (an old page, a stale boot config) gets the current UI for 5 minutes.
 */
export async function serveBannerUi(ui: string, version: string): Promise<Response> {
  const current = await runtimeVersion(ui);
  return new Response(ui, {
    headers: {
      ...JS_HEADERS,
      "cache-control": version === current ? "public, max-age=31536000, immutable" : "public, max-age=300",
      etag: `W/"cb-${current}"`,
    },
  });
}

export async function serveScript(
  env: Bindings,
  runtime: Runtimes | string,
  req: ScriptRequest,
  ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  const id = req.id;
  const ui = await uiVersion(runtime);
  /** Draft or pinned-version builds: custom code only where publish would allow it. */
  const gated = async (cfg: ContainerConfig, label: string) => {
    const row = await env.DB.prepare("SELECT id, account_id, domain, verified_at FROM containers WHERE id = ?")
      .bind(id)
      .first<{ id: string; account_id: string; domain: string; verified_at: number | null }>();
    if (!row) return null;
    const { standing, pause } = await codeGate(env, row.account_id);
    if (standing.suspended) return { suspended: true as const };
    const custom = customCodeProblem(env, row, cfg, standing, pause);
    if (!custom) return { row, cfg, prelude: "" };
    return {
      row,
      cfg: stripCustomCode(cfg, env),
      prelude: `console.warn(${JSON.stringify(`[afst] ${label}: custom code tags are left out (${custom.code}). ${custom.code === "capability_paused" ? `GET /v1/containers/${id} says why.` : custom.hint}`)});\n`,
    };
  };
  if (req.env && !req.preview) {
    const e = await environmentByToken(env, id, req.env);
    if (e) {
      const g = await gated(e.config, `environment ${e.name}`);
      if (g && "suspended" in g) return suspendedScript();
      if (g) {
        const boot: BootConfig = {
          id,
          v: e.version ?? "draft",
          d: g.row.domain,
          cfg: g.cfg,
          env: { name: e.name, token: req.env },
          ab: env.ANALYTICS_BASE_URL || undefined,
          base: req.origin,
          ...(ui && bannerOn(g) ? { ui } : {}),
        };
        // Not edge cached (it's per environment): a minute in the browser.
        return new Response(compileScript(pickRuntime(runtime, g.cfg), boot, req.geo, g.prelude), {
          headers: {
            ...JS_HEADERS,
            "cache-control": "private, max-age=60",
            "x-afs-version": String(e.version ?? "draft"),
            ...bannerHeader(g.cfg, req.geo),
          },
        });
      }
    }
    const live = await serveLive(env, runtime, req, ctx, ui);
    if (live.status !== 200) return live;
    const warn = `console.warn("[afst] environment snippet token is invalid or was reauthorized; loading the live container. GET /v1/containers/${id}/environments has the current snippet.");\n`;
    return new Response(warn + (await live.text()), { headers: { ...JS_HEADERS, "cache-control": "no-store" } });
  }
  if (req.preview) {
    const tok = await previewToken(env, req.preview);
    const cfg0 = tok?.container_id === id ? await previewConfig(env, id, tok.version) : null;
    if (tok && cfg0) {
      const g = await gated(cfg0, "preview");
      if (g && "suspended" in g) return suspendedScript();
      if (g) {
        const boot: BootConfig = {
          id,
          v: tok.version ?? "draft",
          d: g.row.domain,
          cfg: g.cfg,
          preview: req.preview,
          ab: env.ANALYTICS_BASE_URL || undefined,
          base: req.origin,
          ...(ui && bannerOn(g) ? { ui } : {}),
        };
        return new Response(compileScript(pickRuntime(runtime, g.cfg), boot, req.geo, g.prelude), {
          headers: { ...JS_HEADERS, "cache-control": "no-store", ...bannerHeader(g.cfg, req.geo) },
        });
      }
    }
    // Expired/invalid token: clear the preview flag and fall through to the live container. The tab
    // was previewing, so it stays test traffic (sessionStorage afsa_debug, the flag the runtime and
    // the analytics tracker share): its clicks never become real conversions.
    const prelude = `try{sessionStorage.removeItem(${JSON.stringify(`_afst_preview_${id}`)});sessionStorage.setItem("afsa_debug","1")}catch(e){}console.warn("[afst] preview link expired or invalid; loading the live container as test traffic for this tab (?afsa_debug=0 ends that). Create a new link with POST /v1/containers/${id}/preview.");\n`;
    const live = await serveLive(env, runtime, req, ctx, ui);
    if (live.status !== 200) return live;
    return new Response(prelude + (await live.text()), { headers: { ...JS_HEADERS, "cache-control": "no-store" } });
  }
  return serveLive(env, runtime, req, ctx, ui);
}

async function serveLive(
  env: Bindings,
  runtimes: Runtimes | string,
  req: ScriptRequest,
  ctx: { waitUntil(p: Promise<unknown>): void },
  ui?: string,
): Promise<Response> {
  const cache = defaultCache();
  const key = cacheKey(req.cacheOrigin, req.id);
  let cached: CachedBoot | null = null;
  const hit = cache ? await cache.match(key).catch(() => undefined) : undefined;
  if (hit) cached = (await hit.json()) as CachedBoot;
  if (!cached) {
    cached = await loadBoot(env, req.id);
    if (!cached) {
      return new Response(
        `/* AgentFirstStack tags: unknown container ${req.id.replace(/[^a-z0-9_]/g, "")}. Check the id in your snippet (GET /v1/containers). */\n`,
        {
          status: 404,
          headers: { ...JS_HEADERS, "cache-control": "no-store" },
        },
      );
    }
    if (cache) {
      const res = new Response(JSON.stringify(cached), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${EDGE_TTL_SECONDS}` },
      });
      ctx.waitUntil(cache.put(key, res).catch(() => undefined));
    }
  }
  if (cached.account_id && (await accountStanding(env, cached.account_id)).suspended) return suspendedScript();
  // Custom code paused for the account (a strong match at publish, or the operator): the live
  // script runs without it until the pause is lifted.
  let cfg = cached.boot.cfg;
  let prelude = "";
  if (cached.account_id && hasCustomCode(cfg, env)) {
    const pause = await capabilityPaused(env, cached.account_id, "tags.custom_code");
    if (pause) {
      cfg = stripCustomCode(cfg, env);
      // No reason here: every visitor reads this script. GET /v1/containers/:id tells the owner.
      prelude = `console.warn(${JSON.stringify(`[afst] custom code is paused for this project; custom code tags are left out (GET /v1/containers/${req.id} says why).`)});\n`;
    }
  }
  const boot: BootConfig = { ...cached.boot, cfg, base: req.origin, ...(ui && bannerOn(cached.boot) ? { ui } : {}) };
  const runtime = pickRuntime(runtimes, boot.cfg);
  const etag = `W/"${req.id}-v${cached.live_version}${prelude ? "-p" : ""}-${await runtimeVersion(runtime)}${boot.ui ? `-${boot.ui}` : ""}-${req.geo?.country ?? "xx"}${req.geo?.region ? `-${req.geo.region}` : ""}"`;
  const headers = {
    ...JS_HEADERS,
    "cache-control": `${dependsOnCountry(boot.cfg) ? "private" : "public"}, max-age=${BROWSER_TTL_SECONDS}`,
    etag,
    "x-afs-version": String(cached.live_version),
    ...bannerHeader(boot.cfg, req.geo),
  };
  if (req.ifNoneMatch && req.ifNoneMatch.split(/\s*,\s*/).includes(etag)) return new Response(null, { status: 304, headers });
  return new Response(compileScript(runtime, boot, req.geo, prelude), { headers });
}
