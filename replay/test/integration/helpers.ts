import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { Bindings } from "../../src/env";
import { app } from "../../src/index";

export const E = env as unknown as Bindings;
export const B = "http://replay.test";
export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
export const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** Env with some vars or bindings changed (fair-use controls, ANALYTICS stub, ...). */
export const hosted = (vars: Partial<Bindings>): Bindings => ({ ...E, ...vars });

export interface Res {
  status: number;
  json: any;
  text: string;
  headers: Headers;
  bytes: Uint8Array;
}

export async function call(
  method: string,
  path: string,
  opts: { key?: string; body?: unknown; raw?: BodyInit; ip?: string; headers?: Record<string, string>; env?: Bindings } = {},
): Promise<Res> {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${B}${path}`, {
      method,
      headers: {
        ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.ip ? { "cf-connecting-ip": opts.ip } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    }),
    opts.env ?? E,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text, headers: res.headers, bytes };
}

let ipSeq = 0;
const nextIp = () => `198.51.${100 + Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

export async function signup() {
  const r = await call("POST", "/v1/signup", { body: {}, ip: nextIp() });
  return { key: r.json.api_key as string, account: r.json.account_id as string };
}

export async function newSite(domain: string, settings: Record<string, unknown> = {}, envOverride?: Bindings) {
  const { key, account } = await signup();
  const r = await call("POST", "/v1/sites", { key, body: { domain, ...settings }, env: envOverride });
  return { key, account, site: r.json.site.id as string, created: r };
}

export async function gzipText(s: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([s]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

export async function gunzip(b: Uint8Array): Promise<string> {
  return new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

/** POST /i as the recorder does: gzip (z=1) by default, or plain JSON (z=0, the pagehide beacon). */
export async function sendChunk(
  site: string,
  sid: string,
  seq: number,
  ev: unknown[],
  opts: {
    plain?: boolean;
    origin?: string | null;
    ua?: string;
    extra?: Record<string, unknown>;
    env?: Bindings;
    ip?: string;
    path?: string;
    t?: number;
  } = {},
) {
  const last = ev.reduce<number>((m, e) => Math.max(m, Number((e as { timestamp?: number }).timestamp) || 0), 0);
  // The client's send time: now, like a real browser (the server corrects skews over a minute with it).
  const body = JSON.stringify({ v: 1, sid, seq, t: opts.t ?? Math.max(Date.now(), last + 10), ev, ...opts.extra });
  const z = opts.plain ? 0 : 1;
  return call("POST", `${opts.path ?? "/i"}?s=${site}&sid=${sid}&q=${seq}&z=${z}`, {
    raw: opts.plain ? body : await gzipText(body),
    headers: {
      "content-type": "text/plain",
      "user-agent": opts.ua ?? UA,
      ...(opts.origin === null ? {} : { origin: opts.origin ?? "https://shop.test" }),
    },
    env: opts.env,
    ip: opts.ip ?? "203.0.113.9",
  });
}

export async function mcp(key: string, method: string, params: unknown = {}, envOverride?: Bindings) {
  const r = await call("POST", "/mcp", {
    key,
    body: { jsonrpc: "2.0", id: 1, method, params },
    headers: { accept: "application/json, text/event-stream" },
    env: envOverride,
  });
  return r.json;
}

/** tools/call, with the tool's JSON text parsed. */
export async function tool(key: string, name: string, args: Record<string, unknown>, envOverride?: Bindings) {
  const r = await mcp(key, "tools/call", { name, arguments: args }, envOverride);
  const text = r.result?.content?.[0]?.text as string;
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { isError: !!r.result?.isError, data, raw: r };
}

let sidSeq = 0;
/** A fresh session id (rs_ + 16 base32 characters). */
export const newSid = () => `rs_${(Date.now().toString(32) + (sidSeq++).toString(32).padStart(4, "0")).slice(-16).padStart(16, "0")}`;
