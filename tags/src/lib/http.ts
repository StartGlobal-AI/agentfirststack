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
