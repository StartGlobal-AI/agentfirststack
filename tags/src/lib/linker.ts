/* Cross-domain linking value (settings.cross_domain). DOM-free so Worker tests can import it. */
import { sha256HexSync } from "./sha256";

/** The URL parameter carrying the visitor and click ids to a linked site. */
export const LINK_PARAM = "_afst";
const minute = (ms: number) => Math.floor(ms / 60_000);
const b64 = (s: string) =>
  btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64 = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));

/**
 * `1.<check>.<base64url JSON>`. The check (like GTM's linker) ties the link to this browser and
 * the current minute, so a copied or shared link stops working after about two minutes.
 */
export function linkerValue(payload: { v: string; c?: Record<string, string> }, ua: string, now: number): string {
  const body = b64(JSON.stringify(payload));
  return `1.${sha256HexSync(`${body}|${ua}|${minute(now)}`).slice(0, 10)}.${body}`;
}

export function readLinker(raw: string, ua: string, now: number): { v?: string; c?: Record<string, string> } | null {
  const m = /^1\.([a-f0-9]{10})\.([A-Za-z0-9_-]{1,3000})$/.exec(raw);
  if (!m) return null;
  for (const k of [0, 1, 2]) {
    if (sha256HexSync(`${m[2]}|${ua}|${minute(now) - k}`).slice(0, 10) !== m[1]) continue;
    try {
      const p = JSON.parse(unb64(m[2]!)) as { v?: unknown; c?: unknown };
      return {
        v: typeof p.v === "string" ? p.v : undefined,
        c: p.c && typeof p.c === "object" ? (p.c as Record<string, string>) : undefined,
      };
    } catch {
      return null;
    }
  }
  return null;
}
