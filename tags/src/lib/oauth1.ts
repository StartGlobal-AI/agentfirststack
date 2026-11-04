/**
 * OAuth 1.0a request signing (RFC 5849, HMAC-SHA1) with WebCrypto, as X's APIs (Ads API included)
 * require for user-context requests:
 *   https://docs.x.com/fundamentals/authentication/oauth-1-0a/creating-a-signature
 *   https://docs.x.com/fundamentals/authentication/oauth-1-0a/authorizing-a-request
 *
 * Signed parameters are the oauth_* values, the URL's query string and, for form-encoded bodies
 * only, the body fields (pass them in `params`). A JSON body is never part of the signature
 * (RFC 5849 3.4.1.3.1), so JSON POSTs pass no `params`.
 */

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

/** RFC 3986 percent-encoding: everything except A-Z a-z 0-9 - . _ ~ (UTF-8 bytes). */
export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The signature base string: METHOD & enc(base URL) & enc(sorted, encoded parameter string). */
export function signatureBaseString(method: string, url: string, params: Record<string, string> = {}): string {
  const u = new URL(url);
  const pairs: [string, string][] = [];
  u.searchParams.forEach((v, k) => {
    pairs.push([percentEncode(k), percentEncode(v)]);
  });
  for (const [k, v] of Object.entries(params)) pairs.push([percentEncode(k), percentEncode(v)]);
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const paramString = pairs.map(([k, v]) => `${k}=${v}`).join("&");
  // URL() lowercases scheme and host and drops the default port, as the spec requires.
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  return `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(paramString)}`;
}

/** Signing key: enc(consumer secret) & enc(token secret). */
export const signingKey = (consumerSecret: string, tokenSecret: string) => `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function hmacSha1Base64(key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return base64(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text))));
}

/** 32 random bytes, base64, non-word characters stripped (X's documented approach). */
export function oauthNonce(): string {
  return base64(crypto.getRandomValues(new Uint8Array(32))).replace(/\W/g, "");
}

export async function oauth1Signature(method: string, url: string, params: Record<string, string>, c: OAuth1Credentials): Promise<string> {
  return hmacSha1Base64(signingKey(c.consumerSecret, c.tokenSecret), signatureBaseString(method, url, params));
}

/**
 * The `Authorization: OAuth ...` header for one request. `params` are extra signed parameters
 * (form body fields); nonce and timestamp are fixed only by tests.
 */
export async function oauth1Header(opts: {
  method: string;
  url: string;
  credentials: OAuth1Credentials;
  params?: Record<string, string>;
  nonce?: string;
  timestamp?: number;
}): Promise<string> {
  const c = opts.credentials;
  const oauth: Record<string, string> = {
    oauth_consumer_key: c.consumerKey,
    oauth_nonce: opts.nonce ?? oauthNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(opts.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: c.token,
    oauth_version: "1.0",
  };
  oauth.oauth_signature = await oauth1Signature(opts.method, opts.url, { ...(opts.params ?? {}), ...oauth }, c);
  return `OAuth ${Object.keys(oauth)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k]!)}"`)
    .join(", ")}`;
}
