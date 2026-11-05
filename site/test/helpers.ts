import { type AuthBindings, type AuthContext, onError, randomString, requireAuth } from "@afs/shared";
import { handleMcp } from "@afs/shared/mcp";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as rawEnv } from "cloudflare:workers";
import { Hono } from "hono";
import type { Bindings } from "../src/env";
import { pkceChallenge } from "../src/google";
import { app } from "../src/index";

export const BASE = "https://afs.test";
/** The session cookie's name (https, so the __Host- prefixed one). */
export const SESSION = "__Host-afs_session";
export const E = rawEnv as unknown as Bindings;

// ---------- the services behind ANALYTICS / TAGS / MAIL / REPLAY ----------

/** Resources each stub service lists, per account. */
export const fixtures = new Map<
  string,
  {
    sites?: { id: string; domain: string; name: string | null; created_at: number }[];
    containers?: { id: string; domain: string; name: string | null; live_version: number | null; created_at: number }[];
    inboxes?: { id: string; address: string; display_name: string | null; last_message_at: number | null; created_at: number }[];
    replaySites?: { id: string; domain: string; name: string | null; enabled: boolean; created_at: number }[];
  }
>();

/** Every request the site made to a service. */
export const serviceCalls: {
  service: string;
  path: string;
  account: string | null;
  internal: string | null;
  authorization: string | null;
  /** The request body, for anything but GET and HEAD. */
  body: string | null;
}[] = [];

/**
 * A stand-in for one service: the real requireAuth() (internal auth and API keys, against the
 * same identity DB) and the real handleMcp() with two tools, so tokens are checked as for real.
 */
function stubService(service: "analytics" | "tags" | "mail" | "replay"): Fetcher {
  const svc = new Hono<{ Bindings: AuthBindings; Variables: { auth: AuthContext } }>();
  svc.onError(onError);
  svc.all("/mcp", (c) =>
    handleMcp(c.req.raw, c.env, {
      name: service,
      version: "test",
      register: (t, auth) => {
        t.read("whoami", { description: `Who ${service} thinks you are.` }, async () => ({ service, account_id: auth.accountId }));
        t.write("create_thing", { description: "A write tool, hidden from read-only keys." }, async () => ({ ok: true }));
      },
    }),
  );
  svc.use("/v1/*", requireAuth());
  if (service === "analytics") {
    svc.get("/v1/sites", (c) => c.json({ sites: fixtures.get(c.var.auth.accountId)?.sites ?? [] }));
    svc.post("/v1/sites/:id/events", (c) => c.json({ accepted: 1, rejected: 0 }, 202));
    // Reports for the analytics dashboard's proxy (test/analytics-dashboard.test.ts): only sites
    // whose id starts site_dash, echoing the query; other tests keep getting 404s here.
    const own = (c: { var: { auth: AuthContext } }, id: string) =>
      id.startsWith("site_dash") ? fixtures.get(c.var.auth.accountId)?.sites?.find((x) => x.id === id) : undefined;
    svc.get("/v1/rollup", (c) => c.json({ sites: [], totals: { sites: 0 }, query: c.req.query() }));
    svc.get("/v1/sites/:id", (c) => {
      const site = own(c, c.req.param("id"));
      return site
        ? c.json({ site: { ...site, currency: null, timezone: "UTC" } })
        : c.json({ error: { code: "not_found", message: "Site not found." } }, 404);
    });
    svc.get("/v1/sites/:id/*", (c) =>
      own(c, c.req.param("id"))
        ? c.json({ report: new URL(c.req.url).pathname, query: c.req.query() })
        : c.json({ error: { code: "not_found", message: "Site not found." } }, 404),
    );
  }
  if (service === "tags") svc.get("/v1/containers", (c) => c.json({ containers: fixtures.get(c.var.auth.accountId)?.containers ?? [] }));
  if (service === "mail") svc.get("/v1/inboxes", (c) => c.json({ inboxes: fixtures.get(c.var.auth.accountId)?.inboxes ?? [] }));
  if (service === "replay") svc.get("/v1/sites", (c) => c.json({ sites: fixtures.get(c.var.auth.accountId)?.replaySites ?? [] }));
  // Reports for the dashboard's data route (test/dashboard-views.test.ts): only ids with "dash" in
  // them answer, echoing the path and query; everything else keeps getting 404s here.
  const echo = (c: { req: { url: string; query: () => Record<string, string> }; json: (b: unknown) => Response }) =>
    c.json({ report: new URL(c.req.url).pathname, query: c.req.query() });
  if (service !== "analytics") svc.get("/v1/*", (c, next) => (new URL(c.req.url).pathname.includes("_dash") ? echo(c) : next()));
  if (service === "replay")
    svc.post("/v1/sites/:id/links", async (c) =>
      c.req.param("id").startsWith("rsite_dash")
        ? c.json(
            { link: { url: `https://replay.afs.test/play/rpt_${(await c.req.json<{ session_id: string }>()).session_id}`, expires_at: 1 } },
            201,
          )
        : c.json({ error: { code: "not_found", message: "Site not found." } }, 404),
    );

  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const body = req.method === "GET" || req.method === "HEAD" ? null : await req.clone().text();
      serviceCalls.push({
        service,
        path: new URL(req.url).pathname,
        account: req.headers.get("x-afs-account"),
        internal: req.headers.get("x-afs-internal"),
        authorization: req.headers.get("authorization"),
        body,
      });
      return svc.fetch(req, { DB: E.DB, INTERNAL_TOKEN: E.INTERNAL_TOKEN } as AuthBindings);
    },
  } as unknown as Fetcher;
}

const services = {
  ANALYTICS: stubService("analytics"),
  TAGS: stubService("tags"),
  MAIL: stubService("mail"),
  REPLAY: stubService("replay"),
};

/** The Worker's env with the service stubs, plus any overrides (e.g. DEV_MODE off). */
export const testEnv = (overrides: Partial<Bindings> = {}): Bindings => ({ ...E, ...services, ...overrides }) as Bindings;

// ---------- requests ----------

export interface Res {
  status: number;
  headers: Headers;
  text: string;
  json: any;
  location: string | null;
  cookies: string[];
}

export interface CallOptions {
  env?: Bindings;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  key?: string;
  cookie?: string;
  ip?: string;
  body?: BodyInit;
  /** Cloudflare's request.cf, as the edge would attach it (e.g. { asn }). */
  cf?: Record<string, unknown>;
}

export async function call(method: string, path: string, opts: CallOptions = {}): Promise<Res> {
  const headers = new Headers(opts.headers);
  let body = opts.body;
  if (opts.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(opts.json);
  }
  if (opts.form) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(opts.form).toString();
  }
  if (opts.key) headers.set("authorization", `Bearer ${opts.key}`);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  headers.set("cf-connecting-ip", opts.ip ?? "192.0.2.1");
  const ctx = createExecutionContext();
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const init = { method, headers, body, ...(opts.cf ? { cf: opts.cf } : {}) } as RequestInit;
  const res = await app.fetch(new Request(url, init), opts.env ?? testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML or empty */
  }
  return {
    status: res.status,
    headers: res.headers,
    text,
    json,
    location: res.headers.get("location"),
    cookies: res.headers.getSetCookie(),
  };
}

let ipSeq = 0;
/** A fresh client IP, so the per-IP burst limit (SIGNUP_LIMITER, 5/min) stays out of the way. */
export const nextIp = () => `198.51.${100 + Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

export async function signup(name?: string) {
  const r = await call("POST", "/v1/signup", { json: name ? { name } : {}, ip: nextIp() });
  if (r.status !== 201) throw new Error(`signup failed: ${r.status} ${r.text}`);
  return { key: r.json.api_key as string, accountId: r.json.account_id as string, keyId: r.json.key_id as string };
}

/** The CSRF token in a rendered page. */
export function csrfOf(html: string): string {
  const m = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
  if (!m?.[1]) throw new Error("no csrf field in page");
  return m[1];
}

/** A cookie jar on top of call(): what a browser would do with Set-Cookie. */
export class Browser {
  jar = new Map<string, string>();
  constructor(readonly env?: Bindings) {}

  private absorb(res: Res) {
    for (const c of res.cookies) {
      const [pair = "", ...attrs] = c.split(";").map((s) => s.trim());
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (attrs.some((a) => /^max-age=0$/i.test(a)) || !value) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }

  get cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async get(path: string, opts: CallOptions = {}) {
    return this.absorb(await call("GET", path, { env: this.env, ...opts, cookie: this.cookie }));
  }

  async post(path: string, form: Record<string, string>, opts: CallOptions = {}) {
    return this.absorb(await call("POST", path, { env: this.env, ...opts, form, cookie: this.cookie }));
  }

  /** GET a page, then submit one of its forms with the page's CSRF token. */
  async submit(pagePath: string, action: string, fields: Record<string, string> = {}) {
    const pageRes = await this.get(pagePath);
    return this.post(action, { csrf: csrfOf(pageRes.text), ...fields });
  }

  async signIn(email: string, next = "/dashboard") {
    const r = await this.get(`/auth/dev-login?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`);
    if (r.status !== 302 || !this.jar.has(SESSION)) throw new Error(`dev login failed: ${r.status} ${r.text}`);
    return r;
  }
}

export const uniqueEmail = (label: string) => `${label}-${randomString(8)}@example.com`;

export async function pkce() {
  const verifier = randomString(64);
  return { verifier, challenge: await pkceChallenge(verifier) };
}

export async function registerClient(meta: Record<string, unknown>, ip = nextIp()) {
  return call("POST", "/oauth/register", { json: meta, ip });
}

/** Query params of a redirect Location. */
export const paramsOf = (location: string | null) => new URL(location ?? "about:blank").searchParams;
