import { hmacSha256Hex } from "@afs/shared";
import { z } from "zod";
import { deploymentOrigins, MAX_RESPONSE_BYTES, readTextBounded, targetsDeployment } from "../lib/http";
import { type Connector, type DispatchEvent, type SendContext } from "./types";

/**
 * Signed webhook. POST <url> with JSON:
 *   { "type": "conversion", "test": false, "container_id": "ctr_...", "destination_id": "dst_...", "event": DispatchEvent }
 * Headers:
 *   x-signature: sha256=<hex HMAC-SHA256(secret, `${x-signature-timestamp}.${raw body}`)>
 *   x-signature-timestamp: unix seconds      x-event-id: the event_id (stable across retries)
 * Verify by recomputing the HMAC over the timestamp, a dot and the raw body; reject old timestamps.
 * Redirects are not followed (a 3xx is a failed delivery) and the URL can't point at this
 * deployment's own hosts.
 */
export const webhookCredentials = z.strictObject({
  url: z
    .url()
    .describe("https URL (http://localhost allowed only when DEV_MODE=true). Not this deployment's own host; redirects aren't followed."),
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

const selfTarget = (u: URL, env: SendContext["env"], origins: string[] = []) =>
  targetsDeployment(u, deploymentOrigins(env, origins), String(env.DEV_MODE) === "true");
const SELF_TARGET = "Webhook url points at this deployment itself; use your own endpoint.";

export const webhook: Connector<WebhookCredentials> = {
  type: "webhook",
  label: "Signed webhook",
  api: "POST <url> (JSON, x-signature HMAC-SHA256)",
  credentials: webhookCredentials,
  publicFields: [],
  naturalKey: (c) => c.url,
  requiredConsent: [],
  needsMapping: false,
  testMode: 'Sends a sample event with "test": true.',
  example: { url: "https://example.com/hooks/conversions", secret: "a-long-random-shared-secret" },
  docs: "Verify: hex(HMAC_SHA256(secret, timestamp + '.' + rawBody)) == x-signature minus the 'sha256=' prefix.",
  check(c, env, origins) {
    const u = new URL(c.url);
    if (selfTarget(u, env, origins)) throw new Error(SELF_TARGET);
    if (u.protocol === "https:") return;
    if (u.protocol === "http:" && isLocalUrl(u) && String(env.DEV_MODE) === "true") return;
    throw new Error("Webhook url must be https (http://localhost is allowed only when DEV_MODE=true).");
  },
  async send(e, c, ctx) {
    const test = ctx.test || !!e.test;
    const body = JSON.stringify(webhookPayload(e, { containerId: ctx.containerId, destinationId: ctx.destinationId, test }));
    const ts = Math.floor(Date.now() / 1000);
    const headers = {
      "content-type": "application/json",
      "user-agent": "afs-tags-webhook/1",
      "x-signature": await signWebhook(c.secret, ts, body),
      "x-signature-timestamp": String(ts),
      "x-event-id": e.event_id,
    };
    const url = c.url.replace(/\?.*$/, "?...");
    // Re-checked at send time: PUBLIC_BASE_URL may have changed since the destination was saved.
    if (selfTarget(new URL(c.url), ctx.env)) return { ok: false, retryable: false, error: SELF_TARGET, request: { url } };
    try {
      const res = await ctx.fetch(c.url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(15_000) });
      const read = await readTextBounded(res, MAX_RESPONSE_BYTES);
      const text = read.text.slice(0, 2000);
      let response: unknown = text;
      try {
        response = text && !read.truncated && read.text.length <= 2000 ? JSON.parse(text) : text || null;
      } catch {
        /* keep text */
      }
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
