import { isIpLiteral, isPublicSuffix } from "./domain";

/** Most bytes read from any destination's response (the event log keeps a snippet anyway). */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Read at most `maxBytes` of a response body as text, then cancel the rest, so a huge (or
 * endless) answer can't hold the Worker's memory or CPU. Invalid UTF-8 at the cut is replaced.
 */
export async function readTextBounded(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - bytes;
      if (value.byteLength > room) {
        text += decoder.decode(value.subarray(0, room), { stream: true });
        bytes = maxBytes;
        truncated = true;
        break;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
  return { text, truncated };
}

/** Hostnames this deployment answers on (PUBLIC_BASE_URL + the origins an API call came in on). */
export function deploymentOrigins(env: { PUBLIC_BASE_URL?: string }, extra: string[] = []): URL[] {
  const out: URL[] = [];
  for (const o of [env.PUBLIC_BASE_URL, ...extra]) {
    if (!o) continue;
    try {
      out.push(new URL(o));
    } catch {
      /* skip */
    }
  }
  return out;
}

const LOCAL = (h: string) => ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(h) || h.endsWith(".localhost");

/**
 * True when `u` points at this deployment (so a destination would call the tags Worker itself:
 * loops and amplification). Compared by hostname; in local dev a different port on localhost is
 * a different service (the smoke test's webhook sink), so it's allowed there.
 */
export function targetsDeployment(u: URL, own: URL[], devMode: boolean): boolean {
  const h = u.hostname.toLowerCase();
  return own.some((o) => o.hostname.toLowerCase() === h && !(devMode && LOCAL(h) && o.port !== u.port));
}

type PlatformEnv = { PUBLIC_BASE_URL?: string; AUTH_ISSUER?: string; ANALYTICS_BASE_URL?: string };

/** This platform's origins: the tags Worker's (deploymentOrigins), the site's (AUTH_ISSUER) and the analytics app's. */
export function platformOrigins(env: PlatformEnv, extra: string[] = []): URL[] {
  return deploymentOrigins(env, [...extra, env.AUTH_ISSUER ?? "", env.ANALYTICS_BASE_URL ?? ""]);
}

const bare = (h: string) => h.toLowerCase().replace(/\.$/, "");
const named = (h: string) => h.includes(".") && !isIpLiteral(h) && !LOCAL(h);

/**
 * The domain the platform's hosts share ("agentfirststack.com" for agentfirststack.com,
 * tags.agentfirststack.com and analytics.agentfirststack.com), or null: fewer than two hosts,
 * hosts on different domains, or only a suffix anyone can register under (com, co.uk, workers.dev).
 */
export function platformApex(hosts: string[]): string | null {
  const names = [...new Set(hosts.map(bare))].filter(named);
  if (names.length < 2) return null;
  let common = names[0]!.split(".");
  for (const n of names.slice(1)) {
    const labels = n.split(".");
    let k = 0;
    while (k < common.length && k < labels.length && common[common.length - 1 - k] === labels[labels.length - 1 - k]) k++;
    common = common.slice(common.length - k);
  }
  const apex = common.join(".");
  return common.length >= 2 && !isPublicSuffix(apex) ? apex : null;
}

/**
 * True when `u` is anywhere on this platform: one of its hosts (port-aware for localhost in dev,
 * like targetsDeployment), a subdomain of one, or the domain they share and every subdomain of it
 * (the site's /v1/signup, mail., replay.). A webhook must never call the platform: its answer
 * comes back to the caller, and the platform's per-network limits would count this Worker.
 */
export function targetsPlatform(u: URL, env: PlatformEnv, extra: string[], devMode: boolean): boolean {
  const own = platformOrigins(env, extra);
  if (targetsDeployment(u, own, devMode)) return true;
  const h = bare(u.hostname);
  const names = own.map((o) => bare(o.hostname));
  const apex = platformApex(names);
  return [...names.filter(named), ...(apex ? [apex] : [])].some((d) => h === d || h.endsWith(`.${d}`));
}
