import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker, { app } from "../../src/index";
import type { AppEnv } from "../../src/env";

export const E = env as unknown as AppEnv;

/** Env with some vars changed (the hosted fair-use controls, secrets, bindings). */
export const hosted = (vars: Partial<AppEnv>): AppEnv => ({ ...E, ...vars });

export async function call(
  method: string,
  path: string,
  opts: { key?: string; body?: unknown; ip?: string; headers?: Record<string, string>; env?: AppEnv } = {},
) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://mail.test${path}`, {
      method,
      headers: {
        ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.ip ? { "cf-connecting-ip": opts.ip } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    opts.env ?? E,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text, headers: res.headers };
}

let ipSeq = 0;
const nextIp = () => `198.51.${100 + Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

export async function signup() {
  // A fresh client IP per signup, so the hosted per-IP burst limit (SIGNUP_LIMITER) stays out of the way.
  const r = await call("POST", "/v1/signup", { body: {}, ip: nextIp() });
  return { key: r.json.api_key as string, inbox: r.json.inbox as { id: string; address: string }, json: r.json };
}

/** A ForwardableEmailMessage stand-in, as Email Routing would hand it to email(). */
export function fakeMessage(from: string, to: string, raw: string) {
  const bytes = new TextEncoder().encode(raw);
  const state: { rejected: string | null } = { rejected: null };
  const msg = {
    from,
    to,
    raw: new Response(bytes).body!,
    rawSize: bytes.byteLength,
    headers: new Headers(),
    setReject(reason: string) {
      state.rejected = reason;
    },
    forward: async () => ({ messageId: "x" }),
    reply: async () => ({ messageId: "x" }),
    canBeForwarded: false,
  } as unknown as ForwardableEmailMessage;
  return { msg, state };
}

export async function deliver(from: string, to: string, raw: string, env: AppEnv = E) {
  const { msg, state } = fakeMessage(from, to, raw);
  await worker.email(msg, env);
  return state;
}

/**
 * A test message. By default it carries a genuine Cloudflare Authentication-Results header for the
 * From domain; `auth` replaces it (a string, or several headers), `auth: null` omits it.
 */
export function eml(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  html?: string;
  auth?: string | string[] | null;
}) {
  const id = opts.messageId ?? `<${crypto.randomUUID()}@sender.example>`;
  const fromDomain = opts.from.split("@")[1]!.toLowerCase();
  const auth =
    opts.auth === undefined
      ? [`mx.cloudflare.net; dkim=pass header.d=${fromDomain}; spf=pass smtp.mailfrom=${opts.from}; dmarc=pass header.from=${fromDomain}`]
      : opts.auth === null
        ? []
        : [opts.auth].flat();
  const head = [
    ...auth.map((a) => `Authentication-Results: ${a}`),
    `From: Sender <${opts.from}>`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Message-ID: ${id}`,
    "Date: Tue, 03 Nov 2026 10:00:00 +0000",
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    ...(opts.references ? [`References: ${opts.references}`] : []),
    "MIME-Version: 1.0",
  ];
  if (opts.html) {
    return [
      ...head,
      'Content-Type: multipart/alternative; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain; charset=utf-8",
      "",
      opts.body,
      "--b",
      "Content-Type: text/html; charset=utf-8",
      "",
      opts.html,
      "--b--",
      "",
    ].join("\r\n");
  }
  return [...head, "Content-Type: text/plain; charset=utf-8", "", opts.body, ""].join("\r\n");
}
