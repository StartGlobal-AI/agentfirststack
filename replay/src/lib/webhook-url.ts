/**
 * Webhook URLs and signatures (the mail app's pattern). A webhook makes this service send
 * requests for the caller, so its URL is checked when it is created and again before every
 * delivery: https only (http://localhost only with DEV_MODE), no credentials, no IP literals, and
 * never the deployment itself (its registrable domain from PUBLIC_BASE_URL / AUTH_ISSUER, or a
 * subdomain). Signatures are Stripe-style:
 *
 *   x-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 */

import { hmacSha256Hex, randomString } from "@afs/shared";

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);
const isLocal = (h: string) => LOCAL.has(h) || h.endsWith(".localhost");
const isIp = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[") || h.includes(":");

const SHARED = [
  "workers.dev",
  "pages.dev",
  "trycloudflare.com",
  "herokuapp.com",
  "vercel.app",
  "netlify.app",
  "github.io",
  "fly.dev",
  "onrender.com",
];
const TWO_LEVEL = /\.(co|com|org|net|ac|gov|edu)\.[a-z]{2}$/;

/** The registrable parent of a host: example.com for replay.example.com, acme.workers.dev for x.acme.workers.dev. */
export function apexOf(host: string): string {
  for (const s of SHARED)
    if (host === s || host.endsWith(`.${s}`))
      return host === s
        ? host
        : `${host
            .slice(0, -(s.length + 1))
            .split(".")
            .pop()}.${s}`;
  const parts = host.split(".");
  return parts.slice(TWO_LEVEL.test(host) ? -3 : -2).join(".");
}

export interface UrlEnv {
  PUBLIC_BASE_URL?: string;
  AUTH_ISSUER?: string;
  DEV_MODE?: string;
}

export function webhookUrlProblem(raw: string, env: UrlEnv): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  const dev = env.DEV_MODE === "true";
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  const local = isLocal(h);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local && dev)) return "must use https";
  if (local && !dev) return "localhost is only allowed in local development";
  if (u.username || u.password) return "credentials in the URL are not allowed";
  if (!local && isIp(h)) return "IP addresses are not allowed (use a hostname)";
  if (!local && u.port && u.port !== "443") return "only port 443 is allowed";
  for (const v of [env.PUBLIC_BASE_URL, env.AUTH_ISSUER]) {
    if (!v) continue;
    try {
      const own = new URL(v).hostname.toLowerCase();
      if (isLocal(own) || isIp(own)) {
        if (own === h && new URL(v).port === u.port) return `points at this deployment (${u.host})`;
        continue;
      }
      const apex = apexOf(own);
      if (h === apex || h.endsWith(`.${apex}`)) return `points at this deployment (${h})`;
    } catch {
      /* ignore a malformed var */
    }
  }
  return null;
}

export const newWebhookSecret = () => `whsec_${randomString(40)}`;

export async function signPayload(secret: string, body: string, timestampSec: number): Promise<string> {
  return `t=${timestampSec},v1=${await hmacSha256Hex(secret, `${timestampSec}.${body}`)}`;
}
