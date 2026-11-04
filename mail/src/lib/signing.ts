import { fromBase64, hmacSha256Hex, randomString, timingSafeEqual, toBase64 } from "@afs/shared";

/**
 * Webhook signatures, Stripe-style:
 *
 *   x-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * Receivers recompute the HMAC over the exact raw body and reject timestamps older than 5 min.
 */

export function newWebhookSecret(): string {
  return `whsec_${randomString(40)}`;
}

export async function signPayload(secret: string, body: string, timestampSec: number): Promise<string> {
  const v1 = await hmacSha256Hex(secret, `${timestampSec}.${body}`);
  return `t=${timestampSec},v1=${v1}`;
}

export function parseSignatureHeader(header: string): { t: number; v1: string[] } | null {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (!k || !v) continue;
    if (k === "t" && /^\d+$/.test(v)) t = Number(v);
    if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
  }
  return t === null || !v1.length ? null : { t, v1 };
}

export async function verifySignature(
  secret: string,
  body: string,
  header: string,
  opts: { toleranceSec?: number; nowSec?: number } = {},
): Promise<boolean> {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.t) > (opts.toleranceSec ?? 300)) return false;
  const expected = await hmacSha256Hex(secret, `${parsed.t}.${body}`);
  return parsed.v1.some((v) => timingSafeEqual(v, expected));
}

/**
 * Standard Webhooks signature (standardwebhooks.com): "v1,<base64 HMAC-SHA256(key, "<id>.<ts>.<body>")>"
 * where the key is the base64-decoded secret after its "whsec_" prefix. Our secrets are 40
 * characters of [0-9a-z], valid base64, so stock verifiers (Svix, standardwebhooks libraries)
 * accept the same secret. A secret that is not valid base64 is used as UTF-8 bytes.
 */
export async function standardSignature(secret: string, id: string, timestampSec: number, body: string): Promise<string> {
  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let keyBytes: Uint8Array;
  try {
    keyBytes = fromBase64(raw);
  } catch {
    keyBytes = new TextEncoder().encode(raw);
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestampSec}.${body}`));
  return `v1,${toBase64(new Uint8Array(mac))}`;
}
