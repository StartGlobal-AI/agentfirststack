import { hmacSha256Hex } from "@afs/shared";
import { z } from "zod";
import { fetchableHost } from "../lib/domain";
import { readTextBounded, targetsPlatform } from "../lib/http";
import { summarizeResponse } from "../service/sanitize";
import { renderTemplate } from "../service/transform";
import { type Connector, type DispatchEvent, type SendContext } from "./types";

/**
 * Signed webhook. POST <url> with JSON:
 *   { "type": "conversion", "test": false, "container_id": "ctr_...", "destination_id": "dst_...", "event": DispatchEvent }
 * Headers:
 *   x-signature: sha256=<hex HMAC-SHA256(secret, `${x-signature-timestamp}.${raw body}`)>
 *   x-signature-timestamp: unix seconds      x-event-id: the event_id (stable across retries)
 * Verify by recomputing the HMAC over the timestamp, a dot and the raw body; reject old timestamps.
 * Redirects are not followed (a 3xx is a failed delivery) and the URL must be https on a public
 * host name, never this platform (its hosts, the domain they share or any subdomain). Only events that matched a conversion in the config are sent (every
 * server event with settings.all_events), with 3 attempts at most, and only a short sanitized
 * summary of the answer is kept: the URL is the account's choice, so this is not a proxy.
 */
export const WEBHOOK_MAX_ATTEMPTS = 3;
/** Bytes of a webhook's answer read (the summary keeps far less). */
const WEBHOOK_READ_BYTES = 4096;
export const webhookCredentials = z.strictObject({
  url: z
    .url()
    .describe(
      "https URL on a public host name (http://localhost allowed only when DEV_MODE=true). Not this platform's domain or any subdomain of it; redirects aren't followed.",
    ),
  secret: z.string().min(16).max(200).describe("Shared secret for x-signature. Generate one: openssl rand -hex 32."),
});
export type WebhookCredentials = z.infer<typeof webhookCredentials>;

export async function signWebhook(secret: string, timestamp: number, body: string) {
  return `sha256=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

export function webhookPayload(e: DispatchEvent, meta: { containerId: string; destinationId: string; test: boolean }) {
  return { type: "conversion", test: meta.test, container_id: meta.containerId, destination_id: meta.destinationId, event: e };
}

export function isLocalUrl(u: URL) {
  return ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(u.hostname) || u.hostname.endsWith(".localhost");
}

/**
 * Why a webhook URL can't be used, or null. Checked when it's saved and again before every send
 * (the platform's hosts can change after a destination was saved).
 */
export function webhookUrlProblem(raw: string, env: SendContext["env"], origins: string[] = []): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Webhook url is not a URL.";
  }
  const dev = String(env.DEV_MODE) === "true";
  if (targetsPlatform(u, env, origins, dev))
    return "Webhook url points at this deployment (its domain or a subdomain of it); use your own endpoint.";
  if (dev && isLocalUrl(u) && (u.protocol === "http:" || u.protocol === "https:")) return null;
  if (u.protocol !== "https:") return "Webhook url must be https (http://localhost is allowed only when DEV_MODE=true).";
  if (!fetchableHost(u.hostname))
    return "Webhook url must use a public host name: not an IP address, localhost, a local-only name or a bare public suffix.";
  return null;
}

export const webhook: Connector<WebhookCredentials> = {
  type: "webhook",
  label: "Signed webhook",
  api: "POST <url> (JSON, x-signature HMAC-SHA256)",
  credentials: webhookCredentials,
  publicFields: [],
  naturalKey: (c) => c.url,
  requiredConsent: [],
  needsMapping: false,
  matchedOnly: true,
  maxAttempts: WEBHOOK_MAX_ATTEMPTS,
  testMode: 'Sends a sample event with "test": true; returns the HTTP status and a short summary of your endpoint\'s answer.',
  example: { url: "https://example.com/hooks/conversions", secret: "a-long-random-shared-secret" },
  docs: "Verify: hex(HMAC_SHA256(secret, timestamp + '.' + rawBody)) == x-signature minus the 'sha256=' prefix.",
  check(c, env, origins) {
    const problem = webhookUrlProblem(c.url, env, origins);
    if (problem) throw new Error(problem);
  },
  async send(e, c, ctx) {
    const test = ctx.test || !!e.test;
    const tpl = ctx.settings?.template;
    // settings.template: the account's body shape ({{event.*}}); the URL, its checks and signing stay as they are.
    const body = JSON.stringify(
      tpl?.body !== undefined
        ? renderTemplate(tpl.body, { event: e, container_id: ctx.containerId, destination_id: ctx.destinationId, test })
        : webhookPayload(e, { containerId: ctx.containerId, destinationId: ctx.destinationId, test }),
    );
    if (body.length > 65_536)
      return { ok: false, retryable: false, error: "The rendered webhook body is over 64 KB; trim settings.template.body." };
    const ts = Math.floor(Date.now() / 1000);
    const headers = {
      ...(tpl?.headers ?? {}),
      "content-type": "application/json",
      "user-agent": "afs-tags-webhook/1",
      "x-signature": await signWebhook(c.secret, ts, body),
      "x-signature-timestamp": String(ts),
      "x-event-id": e.event_id,
    };
    const url = c.url.replace(/\?.*$/, "?...");
    // Re-checked at send time: the platform's hosts may have changed since the destination was saved.
    const problem = webhookUrlProblem(c.url, ctx.env);
    if (problem) return { ok: false, retryable: false, error: problem, request: { url } };
    try {
      const res = await ctx.fetch(c.url, {
        method: tpl?.method ?? "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const read = await readTextBounded(res, WEBHOOK_READ_BYTES);
      let parsed: unknown = read.text;
      try {
        if (read.text && !read.truncated) parsed = JSON.parse(read.text);
      } catch {
        /* keep text */
      }
      const response = summarizeResponse(parsed);
      const redirected = res.status >= 300 && res.status < 400;
      return {
        ok: res.ok,
        retryable: res.status === 429 || res.status >= 500 || res.status === 408,
        http_status: res.status,
        response,
        ...(redirected ? { error: `Redirect (${res.status}) not followed; point the webhook at the final URL.` } : {}),
        request: { url, body: JSON.parse(body) },
      };
    } catch (err) {
      return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err), request: { url } };
    }
  },
};
