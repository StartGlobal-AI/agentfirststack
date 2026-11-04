import { hmacSha256Hex, randomString } from "@afs/shared";
import { isPublicSuffix } from "./url";

/**
 * Outbound delivery of alerts and reports: where a URL may point, how a webhook body is signed,
 * and the one HTTP call. Shared by the destinations service (checked at create) and the sender
 * (checked again before every delivery, so a deployment change can't turn an old URL into a call
 * to the platform itself).
 *
 * Rules (no SSRF): https on the default port only; no credentials; a public DNS name with a dot
 * (no IP literals, localhost, .local, .internal, .localhost, .arpa or single labels); never the
 * deployment's own registrable domain (PUBLIC_BASE_URL / AUTH_ISSUER) or anything under it.
 * Slack destinations must be Slack incoming-webhook URLs. Redirects are never followed. DEV_MODE
 * also allows http://localhost and 127.0.0.1 (local development).
 */

export const DESTINATION_TYPES = ["webhook", "slack", "email"] as const;
export type DestinationType = (typeof DESTINATION_TYPES)[number];

export const DELIVERY_TIMEOUT_MS = 10_000;
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".arpa", ".home", ".lan", ".corp", ".intranet"];
const SLACK_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);

/** example.com for analytics.example.com; example.co.uk for a.b.example.co.uk. */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, "").split(".");
  for (let n = 2; n <= parts.length; n++) {
    const tail = parts.slice(-n).join(".");
    if (!isPublicSuffix(tail)) return tail;
  }
  return parts.join(".");
}

export interface DeploymentHosts {
  PUBLIC_BASE_URL?: string;
  AUTH_ISSUER?: string;
  DEV_MODE?: string;
}

function ownDomains(env: DeploymentHosts): string[] {
  const out: string[] = [];
  for (const v of [env.PUBLIC_BASE_URL, env.AUTH_ISSUER]) {
    if (!v) continue;
    try {
      const h = new URL(v).hostname.toLowerCase();
      if (h && !LOCAL.has(h) && h.includes(".")) out.push(registrableDomain(h));
    } catch {
      /* not a URL: nothing to protect */
    }
  }
  return out;
}

const isIp = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[") || h.includes(":");

/** Why `raw` can't be a destination URL of this type, or null when it can. */
export function destinationUrlProblem(raw: string, type: "webhook" | "slack", env: DeploymentHosts): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const dev = env.DEV_MODE === "true";
  if (dev && u.protocol === "http:" && LOCAL.has(host) && type === "webhook") return null;
  if (u.protocol !== "https:") return "must use https";
  if (u.username || u.password) return "credentials in the URL are not allowed";
  if (u.port && u.port !== "443") return "only the default https port (443) is allowed";
  if (type === "slack") return SLACK_HOSTS.has(host) && u.pathname.startsWith("/services/") ? null : "is not a Slack incoming-webhook URL";
  if (LOCAL.has(host) || isIp(host)) return "IP addresses and localhost are not allowed";
  if (!host.includes(".") || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return "must be a public hostname";
  if (ownDomains(env).some((d) => host === d || host.endsWith(`.${d}`))) return `points at this deployment (${host})`;
  return null;
}

/** A label that identifies a URL without revealing it: host + the last 4 characters. */
export function urlHint(raw: string): string {
  try {
    const u = new URL(raw);
    const tail = `${u.pathname}${u.search}`.slice(-4);
    return `${u.protocol}//${u.host}/…${tail}`;
  } catch {
    return "(invalid)";
  }
}

export const newSigningSecret = () => `whsec_${randomString(40)}`;

/** x-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")> (the mail and tags apps' scheme). */
export async function signBody(secret: string, body: string, timestampSec: number): Promise<string> {
  return `t=${timestampSec},v1=${await hmacSha256Hex(secret, `${timestampSec}.${body}`)}`;
}

/**
 * Slack mrkdwn treats <...> as links and mentions (<!channel>, <@U123>) and & as an entity:
 * visitor-sent text (a referrer, a page path) must not become one.
 */
export const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface SendResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/** One POST, no redirects, a 10 s timeout; the response body is never read past a little. */
export async function postJson(fetcher: Fetcher, url: string, body: string, headers: Record<string, string>): Promise<SendResult> {
  try {
    const res = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "afs-analytics-alerts/1", ...headers },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, error: null };
    if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, error: `redirect (${res.status}) not followed` };
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    const name = (e as Error)?.name;
    return { ok: false, status: null, error: name === "TimeoutError" || name === "AbortError" ? "timed out after 10 s" : "request failed" };
  }
}
