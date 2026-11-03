import { accountStanding, sha256Hex } from "@afs/shared";
import type { ContainerConfig } from "../config/schema";
import type { Bindings } from "../env";
import type { BootConfig } from "../runtime/types";
import { customCodeProblem, stripCustomCode } from "./verify";
import { previewContainer } from "./versions";

/**
 * /c/:id.js = `(function(){var __AFST__=<boot config>;__AFST__.geo=<visitor geo>;<runtime>})();`
 * The boot config (live version + domain) is cached at the edge per container; the visitor's
 * country/region is added per request so consent regions work without varying the cache.
 */
export const EDGE_TTL_SECONDS = 60;
export const BROWSER_TTL_SECONDS = 300;

const safeJson = (v: unknown) =>
  JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

export function compileScript(runtime: string, boot: BootConfig, geo?: BootConfig["geo"], prelude = ""): string {
  const v = boot.preview ? "draft (preview)" : `v${boot.v}`;
  return `/* AgentFirstStack tags ${boot.id} ${v} */\n${prelude}(function(){var __AFST__=${safeJson(boot)};__AFST__.geo=${safeJson(geo ?? {})};\n${runtime}\n})();\n`;
}

let runtimeHash: string | null = null;
async function runtimeVersion(runtime: string) {
  runtimeHash ??= (await sha256Hex(runtime)).slice(0, 10);
  return runtimeHash;
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

export async function serveScript(
  env: Bindings,
  runtime: string,
  req: ScriptRequest,
  ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  const id = req.id;
  if (req.preview) {
    const owner = await previewContainer(env, req.preview);
    if (owner === id) {
      const row = await env.DB.prepare("SELECT id, account_id, domain, draft, verified_at FROM containers WHERE id = ?")
        .bind(id)
        .first<{ id: string; account_id: string; domain: string; draft: string; verified_at: number | null }>();
      if (row) {
        const standing = await accountStanding(env, row.account_id);
        if (standing.suspended) return suspendedScript();
        let cfg = JSON.parse(row.draft) as ContainerConfig;
        let prelude = "";
        // A preview link is a public URL too: custom code runs in it only where publish would allow it.
        const custom = customCodeProblem(env, row, cfg, standing);
        if (custom) {
          cfg = stripCustomCode(cfg, env);
          prelude = `console.warn(${JSON.stringify(`[afst] preview: custom code tags are left out (${custom.code}). ${custom.hint}`)});\n`;
        }
        const boot: BootConfig = {
          id,
          v: "draft",
          d: row.domain,
          cfg,
          preview: req.preview,
          ab: env.ANALYTICS_BASE_URL || undefined,
          base: req.origin,
        };
        return new Response(compileScript(runtime, boot, req.geo, prelude), { headers: { ...JS_HEADERS, "cache-control": "no-store" } });
      }
    }
    // Expired/invalid token: clear the preview flag and fall through to the live container.
    const prelude = `try{sessionStorage.removeItem(${JSON.stringify(`_afst_preview_${id}`)})}catch(e){}console.warn("[afst] preview link expired or invalid; loading the live container. Create a new one with POST /v1/containers/${id}/preview.");\n`;
    const live = await serveLive(env, runtime, req, ctx);
    if (live.status !== 200) return live;
    return new Response(prelude + (await live.text()), { headers: { ...JS_HEADERS, "cache-control": "no-store" } });
  }
  return serveLive(env, runtime, req, ctx);
}

async function serveLive(
  env: Bindings,
  runtime: string,
  req: ScriptRequest,
  ctx: { waitUntil(p: Promise<unknown>): void },
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
  const boot = { ...cached.boot, base: req.origin };
  const etag = `W/"${req.id}-v${cached.live_version}-${await runtimeVersion(runtime)}-${req.geo?.country ?? "xx"}${req.geo?.region ? `-${req.geo.region}` : ""}"`;
  const headers = {
    ...JS_HEADERS,
    "cache-control": `public, max-age=${BROWSER_TTL_SECONDS}`,
    etag,
    "x-afs-version": String(cached.live_version),
  };
  if (req.ifNoneMatch && req.ifNoneMatch.split(/\s*,\s*/).includes(etag)) return new Response(null, { status: 304, headers });
  return new Response(compileScript(runtime, boot, req.geo), { headers });
}
