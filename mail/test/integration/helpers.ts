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

/** Hand a message to the email() handler and wait for what it left running (the live forward). */
export async function deliver(from: string, to: string, raw: string, env: AppEnv = E) {
  const { msg, state } = fakeMessage(from, to, raw);
  const ctx = createExecutionContext();
  await worker.email(msg, env, ctx);
  await waitOnExecutionContext(ctx);
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
  /** Extra header lines, e.g. "Auto-Submitted: auto-replied". */
  headers?: string[];
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
    ...(opts.headers ?? []),
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

// ---- shared by the feature tests ------------------------------------------------------------

export const uniq = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;
export const acctOf = (s: { json: { account_id: string } }) => s.json.account_id;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function errorOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { status: number; code: string; message: string; hint?: string; details?: any };
  }
  throw new Error("expected the call to fail");
}

/** One MCP tools/call; returns the parsed tool result (or the error object for tool errors). */
export async function mcp(key: string, name: string, args: unknown, env: AppEnv = E) {
  const res = await app.fetch(
    new Request("http://mail.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    createExecutionContext(),
  );
  const body = (await res.json()) as any;
  if (!body.result) throw new Error(`MCP ${name}: ${JSON.stringify(body)}`);
  return JSON.parse(body.result.content[0].text);
}

/** MCP tools/list names for a key. */
export async function mcpTools(key: string, env: AppEnv = E): Promise<string[]> {
  const res = await app.fetch(
    new Request("http://mail.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    env,
    createExecutionContext(),
  );
  return ((await res.json()) as any).result.tools.map((t: { name: string }) => t.name);
}

/**
 * A person claims the account (a membership). `sub` defaults to a Google subject; "dev:<email>" is
 * what DEV_MODE sign-ins write (not Google-verified).
 */
export async function claimAs(accountId: string, email: string, sub = `google-${crypto.randomUUID().slice(0, 12)}`) {
  const { forgetStanding } = await import("@afs/shared");
  const user = `usr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await E.AUTH_DB!.batch([
    E.AUTH_DB!.prepare("INSERT INTO users (id, google_sub, email, created_at) VALUES (?, ?, ?, ?)").bind(user, sub, email, Date.now()),
    E.AUTH_DB!.prepare("INSERT INTO memberships (user_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(
      user,
      accountId,
      Date.now(),
    ),
  ]);
  forgetStanding(accountId);
}

/** Turn every key of the account into an OAuth access token (expiring, tied to a grant). */
export async function makeOauth(accountId: string) {
  await E.AUTH_DB!.prepare("UPDATE api_keys SET expires_at = ?, oauth_grant_id = ? WHERE account_id = ?")
    .bind(Date.now() + 3_600_000, `grant_${crypto.randomUUID().slice(0, 8)}`, accountId)
    .run();
}
