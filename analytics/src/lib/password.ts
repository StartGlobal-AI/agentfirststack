/**
 * Share link passwords: PBKDF2-SHA256 with a random salt ("pbkdf2$<iterations>$<salt b64>$<hash b64>"),
 * compared in constant time. The unlock cookie is an HMAC of the token and its expiry.
 */

import { hmacSha256Hex, timingSafeEqual } from "@afs/shared";

export const PBKDF2_ITERATIONS = 100_000;
const enc = new TextEncoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(await derive(password, salt, iterations))}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, it, salt, hash] = stored.split("$");
  const iterations = Number(it);
  if (scheme !== "pbkdf2" || !salt || !hash || !Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) return false;
  return timingSafeEqual(b64(await derive(password, unb64(salt), iterations)), hash);
}

/** A cookie value proving the password was given for this token until `exp` (unix s). */
export async function unlockCookie(secret: string, token: string, exp: number): Promise<string> {
  return `${exp}.${await hmacSha256Hex(secret, `share-unlock|${token}|${exp}`)}`;
}

export async function checkUnlockCookie(secret: string, token: string, value: string | undefined, nowMs: number): Promise<boolean> {
  const [e, sig] = (value ?? "").split(".");
  const exp = Number(e);
  if (!sig || !Number.isFinite(exp) || exp * 1000 < nowMs) return false;
  return timingSafeEqual(sig, await hmacSha256Hex(secret, `share-unlock|${token}|${exp}`));
}
