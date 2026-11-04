import { accountStanding, sha256Hex } from "@afs/shared";
import LOADER from "../../dist/loader.txt";
import PLAYER_CSS from "../../dist/player-css.txt";
import PLAYER from "../../dist/player.txt";
import RECORDER from "../../dist/recorder.txt";
import type { Bindings } from "../env";
import { SITE_ID_RE } from "../lib/protocol";
import { siteById } from "./context";
import { loaderConfig } from "./sites";

/**
 * Browser code: the per-site loader (config inlined, short cache), and the content-hashed
 * recorder and player assets (immutable). Hashes are computed once per isolate.
 */

export const LOADER_MARKER = "afs-replay";
export const RECORDER_MARKER = "afs-replay recorder";
export const LOADER_BROWSER_TTL = 300;

const hashes = new Map<string, string>();
async function hashOf(name: string, text: string): Promise<string> {
  let h = hashes.get(name);
  if (!h) {
    h = (await sha256Hex(text)).slice(0, 12);
    hashes.set(name, h);
  }
  return h;
}

export const recorderHash = () => hashOf("recorder", RECORDER);
export const playerHash = async () => hashOf("player", PLAYER + PLAYER_CSS);
/**
 * Under its own directory, so a page's CSP can allow exactly this site's loader and the recorder
 * (script-src https://<replay>/r/<site>.js https://<replay>/rec/) instead of the whole host.
 * /recorder.<hash>.js (the old path, in loaders cached before the change) is still served.
 */
export const recorderPath = async () => `/rec/${await recorderHash()}.js`;

export const JS = {
  "content-type": "application/javascript; charset=utf-8",
  "access-control-allow-origin": "*",
  "x-content-type-options": "nosniff",
};
const IMMUTABLE = "public, max-age=31536000, immutable";

export const safeJson = (v: unknown) =>
  JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

/** GET /r/<site_id>.js (also under a first-party proxy prefix). */
export async function serveLoader(
  env: Bindings,
  siteId: string,
  base: string,
  ifNoneMatch: string | null,
  country: string | null = null,
): Promise<Response> {
  if (!SITE_ID_RE.test(siteId))
    return new Response("/* afs-replay: bad site id in the script URL (expected /r/rsite_....js). */\n", {
      status: 404,
      headers: { ...JS, "cache-control": "no-store" },
    });
  const site = await siteById(env, siteId);
  if (!site)
    return new Response(`/* afs-replay: unknown replay site ${siteId}. GET /v1/sites lists yours. */\n`, {
      status: 404,
      headers: { ...JS, "cache-control": "no-store" },
    });
  if ((await accountStanding(env, site.account_id)).suspended)
    return new Response(`/* afs-replay: replay site ${siteId} is not available. */\n`, {
      status: 403,
      headers: { ...JS, "cache-control": "public, max-age=300" },
    });
  const cfg = loaderConfig(site, env, base, await recorderPath(), country);
  const etag = `W/"${site.id}-${site.updated_at}-${site.verified_at ?? 0}-${site.surveys_rev ?? 0}-${cfg.consent ? 1 : 0}-${await recorderHash()}"`;
  // Consent by region: the config depends on the visitor's country, so no shared caches.
  const regional = site.require_consent === 2;
  const headers = {
    ...JS,
    "cache-control": `${regional ? "private" : "public"}, max-age=${LOADER_BROWSER_TTL}`,
    etag,
    ...(regional ? { vary: "cf-ipcountry" } : {}),
  };
  if (ifNoneMatch && ifNoneMatch.split(/\s*,\s*/).includes(etag)) return new Response(null, { status: 304, headers });
  return new Response(`/*! ${LOADER_MARKER} ${site.id} */\n(function(){var __AFSR__=${safeJson(cfg)};\n${LOADER}\n})();\n`, { headers });
}

/** GET /recorder.<hash>.js: immutable when the hash is current; an old hash still gets today's recorder, briefly cached. */
export async function serveRecorder(hash: string): Promise<Response> {
  const current = await recorderHash();
  return new Response(RECORDER, { headers: { ...JS, "cache-control": hash === current ? IMMUTABLE : "public, max-age=300" } });
}

export async function servePlayerAsset(name: string): Promise<Response | null> {
  const h = await playerHash();
  if (name === `player-${h}.js`) return new Response(PLAYER, { headers: { ...JS, "cache-control": IMMUTABLE } });
  if (name === `player-${h}.css`)
    return new Response(PLAYER_CSS, {
      headers: { "content-type": "text/css; charset=utf-8", "cache-control": IMMUTABLE, "x-content-type-options": "nosniff" },
    });
  return null;
}

export const RECORDER_TEXT = RECORDER;
