import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type ToolRegistrar, handleMcp } from "../src/mcp";
import {
  type AuthBindings,
  type AuthContext,
  MCP_NOTICE_PREFIX,
  NOTICE_CACHE_MS,
  accountRoutes,
  createAccount,
  createApiKey,
  forgetNotice,
  headerSafeNotice,
  notFound,
  onError,
  ownerNotice,
  pendingNotice,
  requireAuth,
  takeNotice,
} from "../src/index";
import { memoryD1 } from "./d1";

const IDENTITY = new URL("../../site/migrations/", import.meta.url);
const DAY = 86_400_000;

// The site's migration 0005_project_notices.sql (the contract); the site owns it, so tests create it.
const PROJECT_NOTICES = `CREATE TABLE IF NOT EXISTS project_notices (
  account_id   TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  notice       TEXT NOT NULL,
  owner_notice TEXT,
  created_at   INTEGER NOT NULL,
  shown_at     INTEGER
)`;

/** The identity DB (with or without the notices table), counting the statements that touch it. */
function identity(withTable = true) {
  const db = memoryD1(IDENTITY);
  const sql: string[] = [];
  const counted = new Proxy(db, {
    get(target, k) {
      if (k === "prepare")
        return (q: string) => {
          sql.push(q);
          return target.prepare(q);
        };
      return Reflect.get(target, k);
    },
  }) as D1Database;
  const ready = withTable ? db.exec(PROJECT_NOTICES) : Promise.resolve();
  // Statements the code under test sends; the tests' own writes and reads go to `raw`.
  return { db: counted, raw: db, ready, noticeQueries: () => sql.filter((q) => q.includes("project_notices")).length };
}

async function project(db: D1Database) {
  return createAccount(db, { keyPrefix: "afs", name: "test" });
}

const NOTICE =
  "New: forward the project's inbox to its owner. Run the setup check: GET https://agentfirststack.com/v1/setup (MCP afs_check_setup).";

async function addNotice(db: D1Database, accountId: string, notice = NOTICE, owner: string | null = null) {
  await db
    .prepare("INSERT OR REPLACE INTO project_notices (account_id, notice, owner_notice, created_at) VALUES (?, ?, ?, ?)")
    .bind(accountId, notice, owner, Date.now())
    .run();
}

// biome-ignore lint/suspicious/noExplicitAny: test bodies
const json = async (r: Response | Promise<Response>): Promise<any> => (await r).json();

const shownAt = async (db: D1Database, accountId: string) =>
  (await db.prepare("SELECT shown_at FROM project_notices WHERE account_id = ?").bind(accountId).first<{ shown_at: number | null }>())
    ?.shown_at ?? null;

const app = new Hono<{ Bindings: AuthBindings; Variables: { auth: AuthContext } }>();
app.onError(onError);
app.route("/", accountRoutes({ keyPrefix: "afs", appName: "t", mcpName: "t" }));
app.use("/v1/*", requireAuth());
app.get("/v1/thing", (c) => c.json({ ok: true, items: [1, 2] }));
app.post("/v1/thing", (c) => c.json({ ok: true }, 201));
app.get("/v1/list", (c) => c.json([1, 2, 3]));
app.get("/v1/ndjson", (c) => c.body('{"a":1}\n{"a":2}\n', 200, { "content-type": "application/x-ndjson" }));
app.get("/v1/csv", (c) => c.body("a,b\n1,2\n", 200, { "content-type": "text/csv; charset=utf-8" }));
app.get("/v1/download", (c) =>
  c.body('{"a":1}', 200, { "content-type": "application/json", "content-disposition": 'attachment; filename="a.json"' }),
);
app.get("/v1/big", (c) => c.json({ blob: "x".repeat(300 * 1024) }));
app.get("/v1/theirs", (c) => c.json({ notice: "the route's own field" }));
app.get("/v1/missing", () => {
  throw notFound("Thing");
});
app.get("/v1/moved", () => Response.redirect("https://example.com/elsewhere", 302)); // immutable headers
app.get("/v1/setup", (c) => c.json({ ready: false }));

const B = "https://analytics.example.com";
const get = (env: AuthBindings, key: string, path = "/v1/thing", init: RequestInit = {}) =>
  app.request(`${B}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) } }, env);

beforeEach(() => forgetNotice());
afterEach(() => vi.useRealTimers());

describe("project notices over REST (requireAuth)", () => {
  it("without a notice: no header, the body unchanged, and no notice query once cached", async () => {
    const { db, raw, ready, noticeQueries } = identity();
    await ready;
    const { apiKey } = await project(db);
    const env = { DB: db };
    const first = await get(env, apiKey.key);
    expect(first.status).toBe(200);
    expect(first.headers.get("afs-notice")).toBeNull();
    expect(await json(first)).toEqual({ ok: true, items: [1, 2] });
    expect(noticeQueries()).toBe(1);
    for (let i = 0; i < 3; i++) {
      const again = await get(env, apiKey.key);
      expect(again.headers.get("afs-notice")).toBeNull();
      expect(await json(again)).toEqual({ ok: true, items: [1, 2] });
    }
    expect(noticeQueries()).toBe(1); // "no notice" is cached for the account
  });

  it("with a notice: the header on every answer, the field in the first JSON answer only, again after 24 h", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.UTC(2026, 10, 5, 9);
    vi.setSystemTime(t0);
    const { db, raw, ready, noticeQueries } = identity();
    await ready;
    const { accountId, apiKey } = await project(db);
    await addNotice(raw, accountId);
    const env = { DB: db };

    const first = await get(env, apiKey.key);
    expect(first.headers.get("afs-notice")).toBe(NOTICE);
    const body = await json(first);
    expect(body).toEqual({ notice: NOTICE, ok: true, items: [1, 2] });
    expect(Object.keys(body)[0]).toBe("notice");
    expect(await shownAt(raw, accountId)).toBe(t0);
    const queries = noticeQueries(); // the lookup and the UPDATE ... RETURNING
    expect(queries).toBe(2);

    vi.setSystemTime(t0 + 60_000);
    const second = await get(env, apiKey.key);
    expect(second.headers.get("afs-notice")).toBe(NOTICE);
    expect(await json(second)).toEqual({ ok: true, items: [1, 2] });
    expect(noticeQueries()).toBe(queries); // "shown until" is cached too

    // Within 24 h (the cache re-reads after 10 minutes): header only.
    vi.setSystemTime(t0 + 23 * 3_600_000);
    const later = await get(env, apiKey.key);
    expect(later.headers.get("afs-notice")).toBe(NOTICE);
    expect((await json(later)).notice).toBeUndefined();

    vi.setSystemTime(t0 + DAY + 1);
    const nextDay = await get(env, apiKey.key);
    expect((await json(nextDay)).notice).toBe(NOTICE);
    expect(await shownAt(raw, accountId)).toBe(t0 + DAY + 1);
  });

  it("takeNotice: once per 24 h with an injected clock, once across concurrent callers, null without a row", async () => {
    const { db, raw, ready } = identity();
    await ready;
    const { accountId } = await project(db);
    const env = { DB: db };
    const now = Date.UTC(2026, 10, 5, 12);
    expect(await takeNotice(env, accountId, now)).toBeNull();
    forgetNotice(accountId); // the site writes a row; this isolate re-reads
    await addNotice(raw, accountId);
    const both = await Promise.all([takeNotice(env, accountId, now), takeNotice(env, accountId, now)]);
    expect(both.filter(Boolean)).toEqual([NOTICE]);
    forgetNotice(accountId); // another isolate, same minute: already shown
    expect(await takeNotice(env, accountId, now + 1000)).toBeNull();
    expect(await takeNotice(env, accountId, now + DAY)).toBeNull();
    expect(await takeNotice(env, accountId, now + DAY + 1)).toBe(NOTICE);
    expect(await pendingNotice(env, accountId, now + DAY + 1)).toBe(NOTICE);
  });

  it("leaves arrays, NDJSON, CSV, downloads, big bodies, errors, redirects and POST answers alone (header only)", async () => {
    const { db, raw, ready } = identity();
    await ready;
    const { accountId, apiKey } = await project(db);
    await addNotice(raw, accountId);
    const env = { DB: db };
    const list = await get(env, apiKey.key, "/v1/list");
    expect(list.headers.get("afs-notice")).toBe(NOTICE);
    expect(await json(list)).toEqual([1, 2, 3]);
    expect(await (await get(env, apiKey.key, "/v1/ndjson")).text()).toBe('{"a":1}\n{"a":2}\n');
    expect(await (await get(env, apiKey.key, "/v1/csv")).text()).toBe("a,b\n1,2\n");
    expect(await (await get(env, apiKey.key, "/v1/download")).text()).toBe('{"a":1}');
    const big = await get(env, apiKey.key, "/v1/big");
    expect((await json(big)).notice).toBeUndefined();
    expect((await json(get(env, apiKey.key, "/v1/theirs"))).notice).toBe("the route's own field");
    const missing = await get(env, apiKey.key, "/v1/missing");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("afs-notice")).toBe(NOTICE);
    expect(await json(missing)).toMatchObject({ error: { code: "not_found" } });
    const moved = await get(env, apiKey.key, "/v1/moved", { redirect: "manual" });
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe("https://example.com/elsewhere");
    expect(moved.headers.get("afs-notice")).toBe(NOTICE);
    const posted = await get(env, apiKey.key, "/v1/thing", { method: "POST" });
    expect(posted.status).toBe(201);
    expect(await json(posted)).toEqual({ ok: true });
    // None of those used up the day's notice: the next JSON answer to a GET carries it.
    expect(await shownAt(raw, accountId)).toBeNull();
    expect((await json(get(env, apiKey.key))).notice).toBe(NOTICE);
  });

  it("never reaches internal callers, the setup check or signup; OAuth access tokens get it", async () => {
    const { db, raw, ready, noticeQueries } = identity();
    await ready;
    const { accountId, apiKey } = await project(db);
    await addNotice(raw, accountId);
    const env = { DB: db, INTERNAL_TOKEN: "s3cret-internal" };
    const internal = await app.request(
      "https://analytics.internal/v1/thing",
      { headers: { "x-afs-internal": "s3cret-internal", "x-afs-account": accountId } },
      env,
    );
    expect(internal.status).toBe(200);
    expect(internal.headers.get("afs-notice")).toBeNull();
    expect(await json(internal)).toEqual({ ok: true, items: [1, 2] });
    const setup = await get(env, apiKey.key, "/v1/setup");
    expect(setup.headers.get("afs-notice")).toBeNull();
    expect(await json(setup)).toEqual({ ready: false });
    const signup = await app.request(`${B}/v1/signup`, { method: "POST", headers: { authorization: `Bearer ${apiKey.key}` } }, env);
    expect(signup.status).toBe(201);
    expect(signup.headers.get("afs-notice")).toBeNull();
    expect((await json(signup)).notice).toBeUndefined();
    expect(noticeQueries()).toBe(0);

    const oauth = await createApiKey(db, accountId, { keyPrefix: "afs", expiresAt: Date.now() + 3_600_000, oauthGrantId: "grant_x" });
    const viaApp = await get(env, oauth.key);
    expect(viaApp.headers.get("afs-notice")).toBe(NOTICE);
    expect((await json(viaApp)).notice).toBe(NOTICE);
  });

  it("caches for 10 minutes: a new row shows up after the cache expires (or forgetNotice)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.UTC(2026, 10, 5, 9);
    vi.setSystemTime(t0);
    const { db, raw, ready } = identity();
    await ready;
    const { accountId, apiKey } = await project(db);
    const env = { DB: db };
    expect((await get(env, apiKey.key)).headers.get("afs-notice")).toBeNull();
    await addNotice(raw, accountId);
    vi.setSystemTime(t0 + NOTICE_CACHE_MS - 1);
    expect((await get(env, apiKey.key)).headers.get("afs-notice")).toBeNull();
    vi.setSystemTime(t0 + NOTICE_CACHE_MS);
    expect((await get(env, apiKey.key)).headers.get("afs-notice")).toBe(NOTICE);
    await db.prepare("DELETE FROM project_notices WHERE account_id = ?").bind(accountId).run();
    forgetNotice(accountId);
    expect((await get(env, apiKey.key)).headers.get("afs-notice")).toBeNull();
  });

  it("without the table (a standalone app) or a database: no notice, no error, logged once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = identity(false);
    const { apiKey, accountId } = await project(db);
    const env = { DB: db };
    for (let i = 0; i < 2; i++) {
      const res = await get(env, apiKey.key);
      expect(res.status).toBe(200);
      expect(res.headers.get("afs-notice")).toBeNull();
      expect(await json(res)).toEqual({ ok: true, items: [1, 2] });
    }
    forgetNotice();
    expect(await takeNotice(env, accountId)).toBeNull();
    expect(await pendingNotice({} as AuthBindings, accountId)).toBeNull();
    expect(await ownerNotice({} as AuthBindings, accountId)).toBeNull();
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    warn.mockRestore();
  });

  it("makes the header value safe: one line of ASCII, at most 500 characters", async () => {
    expect(headerSafeNotice("New:\r\nforward \u201cinbox\u201d \u2014 now\u2026 caf\u00e9 \u{1f680}")).toBe(
      'New: forward "inbox" - now... cafe',
    );
    const long = headerSafeNotice("word ".repeat(200));
    expect(long.length).toBeLessThanOrEqual(500);
    expect(long.endsWith("...")).toBe(true);
    const { db, raw, ready } = identity();
    await ready;
    const { accountId, apiKey } = await project(db);
    await addNotice(raw, accountId, "Line one.\r\nX-Evil: 1\nLine two.");
    const res = await get({ DB: db }, apiKey.key);
    expect(res.headers.get("afs-notice")).toBe("Line one. X-Evil: 1 Line two.");
    expect(res.headers.get("x-evil")).toBeNull();
  });
});

describe("ownerNotice (reports, emails)", () => {
  it("reads owner_notice, else notice, and never marks the row shown", async () => {
    const { db, raw, ready } = identity();
    await ready;
    const a = await project(db);
    const b = await project(db);
    const env = { DB: db };
    expect(await ownerNotice(env, a.accountId)).toBeNull();
    await addNotice(raw, a.accountId, NOTICE, "Your inbox can now forward to you. Ask your agent to set it up.");
    await addNotice(raw, b.accountId, NOTICE, null);
    expect(await ownerNotice(env, a.accountId)).toBe("Your inbox can now forward to you. Ask your agent to set it up.");
    expect(await ownerNotice(env, b.accountId)).toBe(NOTICE);
    expect(await shownAt(raw, a.accountId)).toBeNull();
    expect(await shownAt(raw, b.accountId)).toBeNull();
  });
});

describe("project notices over MCP (handleMcp)", () => {
  const opts = {
    name: "t",
    version: "0",
    register: (t: ToolRegistrar) => {
      t.read("echo", { description: "echo", input: { say: z.string() } }, async ({ say }) => ({ said: say }));
      t.read("fail", { description: "fails" }, async () => {
        throw notFound("Thing");
      });
    },
  };
  const rpc = (key: string, method: string, params: unknown = {}) =>
    new Request("https://mail.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  const call = async (env: AuthBindings | D1Database, key: string, name: string, args: unknown = {}) =>
    (
      (await (await handleMcp(rpc(key, "tools/call", { name, arguments: args }), env, opts)).json()) as {
        result: { content: { type: string; text: string }[]; isError?: boolean };
      }
    ).result;

  it("adds one text item after the tool's own content, once a day; never on errors or tools/list", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.UTC(2026, 10, 5, 9);
    vi.setSystemTime(t0);
    const { db, raw, ready, noticeQueries } = identity();
    await ready;
    const { accountId, apiKey } = await project(db);
    await addNotice(raw, accountId);
    const env = { DB: db };

    const list = await (await handleMcp(rpc(apiKey.key, "tools/list"), env, opts)).json();
    expect(JSON.stringify(list)).not.toContain(MCP_NOTICE_PREFIX);
    expect(noticeQueries()).toBe(0);

    const failed = await call(env, apiKey.key, "fail");
    expect(failed.isError).toBe(true);
    expect(failed.content).toHaveLength(1);

    const first = await call(env, apiKey.key, "echo", { say: "hi" });
    expect(first.isError).toBeUndefined();
    expect(first.content).toHaveLength(2);
    expect(JSON.parse(first.content[0]!.text)).toEqual({ said: "hi" });
    expect(first.content[1]).toEqual({ type: "text", text: `AgentFirstStack notice for this project: ${NOTICE}` });

    const second = await call(env, apiKey.key, "echo", { say: "again" });
    expect(second.content).toHaveLength(1);

    // REST shares the day: no body field either, until 24 h later.
    expect((await json(get(env, apiKey.key))).notice).toBeUndefined();
    vi.setSystemTime(t0 + DAY + 1);
    expect((await call(env, apiKey.key, "echo", { say: "tomorrow" })).content).toHaveLength(2);
  });

  it("works with a bare D1 database, and without the table", async () => {
    const withTable = identity();
    await withTable.ready;
    const a = await project(withTable.db);
    await addNotice(withTable.db, a.accountId);
    expect((await call(withTable.db, a.apiKey.key, "echo", { say: "x" })).content).toHaveLength(2);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bare = identity(false);
    const b = await project(bare.db);
    const r = await call({ DB: bare.db }, b.apiKey.key, "echo", { say: "x" });
    expect(r.content).toHaveLength(1);
    expect(r.isError).toBeUndefined();
    warn.mockRestore();
  });
});
