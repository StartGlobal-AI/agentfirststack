import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  type AuthBindings,
  type AuthContext,
  accountRoutes,
  assertCapability,
  capabilityPaused,
  capabilityPausedError,
  createAccount,
  difficultyFor,
  forgetPauses,
  issueChallenge,
  leadingZeroBits,
  onError,
  recordCapabilityPause,
  requestCapabilityPause,
  reserveNewAccount,
  solvers,
  verifySolution,
} from "../src/index";
import { memoryD1 } from "./d1";

const IDENTITY = new URL("../../site/migrations/", import.meta.url);
const TEMPLATE = new URL("../migrations/", import.meta.url);

const enc = new TextEncoder();
async function solve(challenge: string, difficulty: number): Promise<string> {
  for (let n = 0; ; n++) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`${challenge}:${n}`)));
    if (leadingZeroBits(h) >= difficulty) return String(n);
  }
}

describe("capability pauses", () => {
  it("reads nothing paused until a pause is recorded, then the pause (cached a minute, forgotten on change)", async () => {
    const db = memoryD1(IDENTITY);
    const { accountId } = await createAccount(db, { keyPrefix: "afs" });
    const env = { DB: db } as AuthBindings;
    expect(await capabilityPaused(env, accountId, "mail.send")).toBeNull();
    const r = await recordCapabilityPause(db, { accountId, capability: "mail.send", reason: "40% of 50 sends bounced", by: "mail" });
    expect(r).toMatchObject({ paused: true, notify: true, pause: { capability: "mail.send", paused_by: "mail", until: null } });
    // recordCapabilityPause forgets this isolate's cache, so the pause shows at once here.
    const p = await capabilityPaused(env, accountId, "mail.send");
    expect(p).toMatchObject({ capability: "mail.send", reason: "40% of 50 sends bounced", paused_by: "mail" });
    // Other capabilities and accounts keep working.
    expect(await capabilityPaused(env, accountId, "mail.inbox_create")).toBeNull();
    // Idempotent: a second pause leaves the first as it was.
    const again = await recordCapabilityPause(db, { accountId, capability: "mail.send", reason: "other", by: "mail" });
    expect(again).toMatchObject({ paused: true, existing: true, pause: { reason: "40% of 50 sends bounced" } });

    // A change made elsewhere is seen after the cache expires (or forgetPauses in this isolate).
    await db.prepare("UPDATE capability_pauses SET lifted_at = ? WHERE account_id = ?").bind(Date.now(), accountId).run();
    expect(await capabilityPaused(env, accountId, "mail.send")).not.toBeNull();
    forgetPauses(accountId);
    expect(await capabilityPaused(env, accountId, "mail.send")).toBeNull();
  });

  it("ends by itself at `until`, and the error tells the agent why and what to do", async () => {
    const db = memoryD1(IDENTITY);
    const { accountId } = await createAccount(db, { keyPrefix: "afs" });
    const env = { DB: db } as AuthBindings;
    const until = Date.now() + 60_000;
    await recordCapabilityPause(db, {
      accountId,
      capability: "tags.custom_code",
      reason: "a crypto miner in custom code",
      by: "tags",
      until,
    });
    const p = await capabilityPaused(env, accountId, "tags.custom_code");
    expect(p?.until).toBe(until);
    const e = capabilityPausedError(p!);
    expect(e.status).toBe(403);
    expect(e.toJSON().error).toMatchObject({
      code: "capability_paused",
      message: expect.stringContaining("Custom code"),
      hint: expect.stringMatching(/because a crypto miner in custom code.*operator were emailed.*support@/s),
      details: { capability: "tags.custom_code", until },
    });
    await expect(assertCapability(env, accountId, "tags.custom_code")).rejects.toMatchObject({ code: "capability_paused" });
    await db
      .prepare("UPDATE capability_pauses SET until = ? WHERE account_id = ?")
      .bind(Date.now() - 1, accountId)
      .run();
    forgetPauses(accountId);
    expect(await capabilityPaused(env, accountId, "tags.custom_code")).toBeNull();
    await assertCapability(env, accountId, "tags.custom_code");
  });

  it("skips an automatic re-pause right after the operator lifted it, but not the operator's own", async () => {
    const db = memoryD1(IDENTITY);
    const { accountId } = await createAccount(db, { keyPrefix: "afs" });
    await recordCapabilityPause(db, { accountId, capability: "mail.send", reason: "bounces", by: "mail" });
    await db.prepare("UPDATE capability_pauses SET lifted_at = ?, lifted_by = 'operator'").bind(Date.now()).run();
    expect(await recordCapabilityPause(db, { accountId, capability: "mail.send", reason: "bounces", by: "mail" })).toEqual({
      paused: false,
      skipped: "recently_lifted",
    });
    expect(
      await recordCapabilityPause(db, { accountId, capability: "mail.send", reason: "bounces", by: "mail" }, { graceMs: 0 }),
    ).toMatchObject({
      paused: true,
      notify: true,
    });
    await db.prepare("UPDATE capability_pauses SET lifted_at = ?").bind(Date.now()).run();
    expect(await recordCapabilityPause(db, { accountId, capability: "mail.send", reason: "spam", by: "operator" })).toMatchObject({
      paused: true,
    });
  });

  it("reads as nothing paused without the table (a single app self-hosted), and fails open on errors", async () => {
    const db = memoryD1(TEMPLATE);
    const { accountId } = await createAccount(db, { keyPrefix: "afs" });
    expect(await capabilityPaused({ DB: db } as AuthBindings, accountId, "mail.send")).toBeNull();
    const broken = {
      prepare: () => ({ bind: () => ({ all: async () => Promise.reject(new Error("D1 is down")) }) }),
    } as unknown as D1Database;
    expect(await capabilityPaused({ DB: broken } as AuthBindings, "acct_x1", "mail.send")).toBeNull();
  });

  it("requestCapabilityPause posts to the site's internal route, else writes the row itself", async () => {
    const db = memoryD1(IDENTITY);
    const { accountId } = await createAccount(db, { keyPrefix: "afs" });
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const SITE = {
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
        return Response.json({
          paused: true,
          pause: { capability: "mail.send", reason: "r", paused_at: 1, paused_by: "mail", until: null },
        });
      },
    } as unknown as Fetcher;
    const viaSite = await requestCapabilityPause({ DB: db, SITE, INTERNAL_TOKEN: "tok" } as AuthBindings & { SITE: Fetcher }, {
      accountId,
      capability: "mail.send",
      reason: "r",
      by: "mail",
      details: { sent: 50, bounced: 20 },
    });
    expect(viaSite).toMatchObject({ paused: true, pause: { capability: "mail.send" } });
    expect(calls[0]).toMatchObject({
      url: "https://site.internal/v1/internal/pauses",
      headers: { "x-afs-internal": "tok", "x-afs-account": accountId },
      body: { account_id: accountId, capability: "mail.send", reason: "r", paused_by: "mail", details: { sent: 50, bounced: 20 } },
    });
    // Not written here: the site does that.
    expect(await db.prepare("SELECT count(*) AS n FROM capability_pauses").first("n")).toBe(0);

    // The site refuses (or isn't bound): the row is written directly, for the site's cron to email.
    const down = { fetch: async () => new Response("down", { status: 503 }) } as unknown as Fetcher;
    const direct = await requestCapabilityPause({ DB: db, SITE: down, INTERNAL_TOKEN: "tok" } as AuthBindings & { SITE: Fetcher }, {
      accountId,
      capability: "mail.inbox_create",
      reason: "60 inboxes in an hour",
      by: "mail",
    });
    expect(direct).toMatchObject({ paused: true, notify: true });
    expect(await db.prepare("SELECT paused_by, notified_at FROM capability_pauses WHERE capability = 'mail.inbox_create'").first()).toEqual(
      { paused_by: "mail", notified_at: null },
    );
    expect(await capabilityPaused({ DB: db } as AuthBindings, accountId, "mail.inbox_create")).not.toBeNull();
  });
});

describe("signup proof of work", () => {
  it("counts leading zero bits and raises the difficulty as the breaker is exceeded", () => {
    expect(leadingZeroBits(new Uint8Array([0, 0, 0x0f]))).toBe(20);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0, 1]))).toBe(15);
    expect(difficultyFor(20, 31, 30)).toBe(20);
    expect(difficultyFor(20, 60, 30)).toBe(21);
    expect(difficultyFor(20, 130, 30)).toBe(22);
    expect(difficultyFor(20, 100_000, 30)).toBe(24);
  });

  it("verifies only solved, unexpired challenges this deployment signed", async () => {
    const { challenge } = await issueChallenge("s3cret", 8);
    const solution = await solve(challenge, 8);
    expect(await verifySolution("s3cret", challenge, solution)).toEqual({ ok: true, difficulty: 8 });
    expect(await verifySolution("other", challenge, solution)).toMatchObject({ ok: false, why: "forged" });
    expect(await verifySolution("s3cret", challenge.replace(".8.", ".1."), solution)).toMatchObject({ ok: false, why: "forged" });
    expect(await verifySolution("s3cret", challenge, solution, Date.now() + 11 * 60_000)).toMatchObject({ ok: false, why: "expired" });
    expect(await verifySolution("s3cret", "v1.nope", "1")).toMatchObject({ ok: false, why: "malformed" });
    expect(await verifySolution("s3cret", challenge, "x".repeat(65))).toMatchObject({ ok: false, why: "malformed" });
    // The ready-made commands carry the challenge.
    expect(solvers(challenge, 8).node).toContain(`'${challenge}' 8`);
  });

  const app = new Hono<{ Bindings: AuthBindings; Variables: { auth: AuthContext } }>();
  app.onError(onError);
  app.route("/", accountRoutes<AuthBindings>({ keyPrefix: "afs", appName: "Test", mcpName: "t" }));
  let ip = 0;
  const signup = (env: AuthBindings, body: unknown = {}, from = `198.19.0.${++ip}`) =>
    app.fetch(
      new Request("https://site.example/v1/signup", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": from },
        body: JSON.stringify(body),
      }),
      env,
    );

  it("answers the tripped breaker with a challenge; a solved one signs up once, the per-network limit still applies", async () => {
    const db = memoryD1(IDENTITY);
    const env = {
      DB: db,
      INTERNAL_TOKEN: "tok",
      SIGNUP_GLOBAL_HOURLY_LIMIT: "2",
      SIGNUP_HOURLY_LIMIT: "2",
      SIGNUP_POW_DIFFICULTY: "6",
    } as AuthBindings;
    expect((await signup(env)).status).toBe(201);
    expect((await signup(env)).status).toBe(201);
    const asked = await signup(env);
    expect(asked.status).toBe(429);
    const j = (await asked.json()) as {
      error: { code: string; hint: string };
      challenge: string;
      difficulty: number;
      solve: { node: string };
    };
    expect(j.error.code).toBe("proof_of_work_required");
    expect(j.error.hint).toMatch(/"challenge":"<challenge>","solution":"<solution>"/);
    expect(j.difficulty).toBe(6);
    expect(j.solve.node).toContain(j.challenge);
    // Unsolved attempts took their rows back out: they don't raise the count.
    expect(await db.prepare("SELECT count(*) AS n FROM signup_log").first("n")).toBe(4);

    const solution = await solve(j.challenge, j.difficulty);
    const net = "198.19.9.9";
    expect((await signup(env, { name: "a", challenge: j.challenge, solution }, net)).status).toBe(201);
    // One signup per challenge.
    const reused = await signup(env, { challenge: j.challenge, solution }, net);
    expect(reused.status).toBe(429);
    expect(((await reused.json()) as { error: { message: string } }).error.message).toMatch(/already used/);
    // A wrong solution gets a fresh challenge, saying why.
    const wrong = await signup(env, { challenge: j.challenge, solution: "not-it" });
    expect(((await wrong.json()) as { error: { message: string } }).error.message).toMatch(/doesn.t give enough zero bits/);

    // The per-network limit applies to solved signups too.
    const second = (await (await signup(env, {}, net)).json()) as { challenge: string; difficulty: number };
    expect(
      (await signup(env, { challenge: second.challenge, solution: await solve(second.challenge, second.difficulty) }, net)).status,
    ).toBe(201);
    const third = (await (await signup(env, {}, "198.19.9.10")).json()) as { challenge: string; difficulty: number };
    const capped = await signup(env, { challenge: third.challenge, solution: await solve(third.challenge, third.difficulty) }, net);
    expect(capped.status).toBe(429);
    expect(((await capped.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
  });

  it("keeps the old 429 signups_paused without a secret to sign challenges", async () => {
    const env = { DB: memoryD1(IDENTITY), SIGNUP_GLOBAL_HOURLY_LIMIT: "1" } as AuthBindings;
    expect((await signup(env)).status).toBe(201);
    const paused = await signup(env);
    expect(paused.status).toBe(429);
    expect(((await paused.json()) as { error: { code: string } }).error.code).toBe("signups_paused");
  });

  it("doesn't hold signed-in people creating projects to the breaker (they have their own daily cap)", async () => {
    const db = memoryD1(IDENTITY);
    const env = { DB: db, INTERNAL_TOKEN: "tok", SIGNUP_GLOBAL_HOURLY_LIMIT: "1", PROJECTS_PER_USER_DAILY_LIMIT: "2" } as AuthBindings;
    expect((await signup(env)).status).toBe(201);
    expect((await signup(env)).status).toBe(429);
    const req = new Request("https://site.example/oauth/authorize", { headers: { "cf-connecting-ip": "198.19.5.5" } });
    await reserveNewAccount(env, req, "usr_a");
    await reserveNewAccount(env, req, "usr_a");
    await expect(reserveNewAccount(env, req, "usr_a")).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });
});
