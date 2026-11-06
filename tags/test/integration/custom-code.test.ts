import { createAccount, forgetPauses } from "@afs/shared";
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { type OpCtx, ops } from "../../src/service/api";

const B = "https://tags.test";
const E = env as unknown as Bindings & { SITE: Fetcher };

async function json(res: Response) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

beforeEach(() => {
  // Outbound requests (DNS-over-HTTPS, destination tests) answer here.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://cloudflare-dns.com/")) return Response.json({ Status: 0, Answer: [] });
    return Response.json({ ok: true });
  });
});
afterEach(() => vi.restoreAllMocks());

/** A fresh account (claimed by a person if asked, so it may publish custom code) with an API client. */
async function freshAccount(claimed = true) {
  const { accountId, apiKey } = await createAccount(E.AUTH_DB!, { keyPrefix: "afs" });
  if (claimed) {
    const now = Date.now();
    const userId = `usr_${accountId.slice(5)}`;
    await E.AUTH_DB!.batch([
      E.AUTH_DB!.prepare("INSERT INTO users (id, google_sub, email, created_at) VALUES (?, ?, ?, ?)").bind(
        userId,
        `dev:${userId}`,
        `${userId}@example.test`,
        now,
      ),
      E.AUTH_DB!.prepare("INSERT INTO memberships (user_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(
        userId,
        accountId,
        now,
      ),
    ]);
  }
  const H = { authorization: `Bearer ${apiKey.key}`, "content-type": "application/json" };
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await SELF.fetch(`${B}${path}`, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await json(res) };
  };
  /** A container whose domain is verified (custom code needs that). */
  const container = async (domain: string) => {
    const r = await api("POST", "/v1/containers", { domain });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const C = r.body.container.id as string;
    await E.DB.prepare("UPDATE containers SET verified_at = ?, verified_method = 'dns' WHERE id = ?").bind(Date.now(), C).run();
    return C;
  };
  return { accountId, api, container };
}

const draft = (code: string) => ({
  triggers: [{ id: "all", type: "page_view" }],
  tags: [{ id: "custom", type: "custom_js", params: { code }, triggers: ["all"] }],
});
const MINER = "var m = new CoinHive.Anonymous('KEY'); m.start(); // CLEAN_MARKER_NOT";
const CLEAN = "window.__clean_marker = 1;";

const pauseRow = (accountId: string) =>
  E.AUTH_DB!.prepare("SELECT capability, reason, paused_by, lifted_at FROM capability_pauses WHERE account_id = ?")
    .bind(accountId)
    .all<{ capability: string; reason: string; paused_by: string; lifted_at: number | null }>()
    .then((r) => r.results);

describe("custom code checks at publish and the tags.custom_code pause", () => {
  it("a crypto miner is refused (422) and pauses custom code: the live script drops it, later publishes answer 403", async () => {
    const a = await freshAccount();
    const C = await a.container("pause.test");
    // A clean version with custom code goes live first.
    expect((await a.api("PUT", `/v1/containers/${C}/draft`, draft(CLEAN))).status).toBe(200);
    expect((await a.api("POST", `/v1/containers/${C}/publish`, {})).status).toBe(201);
    expect(await (await SELF.fetch(`${B}/c/${C}.js`)).text()).toContain("__clean_marker");

    // The draft shows the finding before anyone publishes.
    expect((await a.api("PUT", `/v1/containers/${C}/draft`, draft(MINER))).status).toBe(200);
    const v = (await a.api("POST", `/v1/containers/${C}/draft/validate`, {})).body;
    expect(v.errors).toContainEqual(expect.objectContaining({ code: "custom_code_blocked", path: "tags.0.params.code" }));

    const pub = await a.api("POST", `/v1/containers/${C}/publish`, {});
    expect(pub.status).toBe(422);
    expect(pub.body.error).toMatchObject({
      code: "custom_code_blocked",
      message: expect.stringMatching(/a crypto miner \(tags\.0\.params\.code\)/),
    });
    expect(pub.body.error.hint).toMatch(/custom code is now paused for this project/);
    expect(pub.body.error.details).toEqual([expect.objectContaining({ rule: "miner", strong: true, path: "tags.0.params.code" })]);

    // The pause went to the site's internal route (the stub refuses, so it was written directly).
    const asked = (await (await E.SITE.fetch("https://site.internal/__test/pauses")).json()) as {
      requests: { url: string; internal: boolean; account: string; body: { capability: string; paused_by: string } }[];
    };
    expect(asked.requests.filter((r) => r.account === a.accountId)).toEqual([
      expect.objectContaining({
        url: "https://site.internal/v1/internal/pauses",
        internal: true,
        body: expect.objectContaining({ account_id: a.accountId, capability: "tags.custom_code", paused_by: "tags" }),
      }),
    ]);
    expect(await pauseRow(a.accountId)).toEqual([
      expect.objectContaining({ capability: "tags.custom_code", paused_by: "tags", lifted_at: null, reason: expect.stringContaining(C) }),
    ]);

    // The live script runs without its custom code; the reason stays out of the public script.
    const js = await (await SELF.fetch(`${B}/c/${C}.js`)).text();
    expect(js).not.toContain("__clean_marker");
    expect(js).toContain("custom code is paused for this project");
    expect(js).not.toContain("tried to publish");

    // Publishing custom code (or putting v1 back) now answers 403 capability_paused with a hint.
    expect((await a.api("PUT", `/v1/containers/${C}/draft`, draft(CLEAN))).status).toBe(200);
    const again = await a.api("POST", `/v1/containers/${C}/publish`, {});
    expect(again.status).toBe(403);
    expect(again.body.error).toMatchObject({ code: "capability_paused", hint: expect.stringMatching(/Paused automatically because/) });
    expect((await a.api("POST", `/v1/containers/${C}/rollback`, { version: 1 })).status).toBe(403);
    // A config without custom code still publishes: only custom code is paused.
    expect((await a.api("PUT", `/v1/containers/${C}/draft`, { triggers: [], tags: [] })).status).toBe(200);
    expect((await a.api("POST", `/v1/containers/${C}/publish`, {})).status).toBe(201);

    const got = (await a.api("GET", `/v1/containers/${C}`)).body;
    expect(got.warnings.join(" ")).toMatch(/Custom code in tag containers is paused/);
    const usage = (await a.api("GET", "/v1/usage")).body;
    expect(usage.policy).toMatchObject({ custom_code_allowed: false, custom_code_paused: { reason: expect.stringContaining(C) } });

    // The operator lifts it: custom code publishes again.
    await E.AUTH_DB!.prepare("UPDATE capability_pauses SET lifted_at = ?, lifted_by = 'operator' WHERE account_id = ?")
      .bind(Date.now(), a.accountId)
      .run();
    forgetPauses(a.accountId);
    expect((await a.api("PUT", `/v1/containers/${C}/draft`, draft(CLEAN))).status).toBe(200);
    expect((await a.api("POST", `/v1/containers/${C}/publish`, {})).status).toBe(201);
  });

  it("a weaker match (the polyfill.io host, eval of a decoded string) is refused without a pause", async () => {
    const a = await freshAccount();
    const C = await a.container("weak.test");
    for (const code of [
      "var s=document.createElement('script');s.src='https://cdn.polyfill.io/v3/polyfill.min.js';",
      "eval(atob('YWxlcnQoMSk='))",
    ]) {
      expect((await a.api("PUT", `/v1/containers/${C}/draft`, draft(code))).status).toBe(200);
      const pub = await a.api("POST", `/v1/containers/${C}/publish`, {});
      expect(pub.status).toBe(422);
      expect(pub.body.error.code).toBe("custom_code_blocked");
      expect(pub.body.error.hint).not.toMatch(/paused/);
    }
    expect(await pauseRow(a.accountId)).toEqual([]);
    // Previews leave the blocked code out.
    const prv = (await a.api("POST", `/v1/containers/${C}/preview`, {})).body;
    const js = await (await SELF.fetch(prv.script_url)).text();
    expect(js).not.toContain("YWxlcnQoMSk");
    expect(js).toContain("custom_code_blocked");
  });

  it("a dom_value variable reading a password field is refused even without custom code", async () => {
    const a = await freshAccount(false);
    const C = (await a.api("POST", "/v1/containers", { domain: "dom-pw.test" })).body.container.id as string;
    const cfg = { variables: [{ name: "pw", type: "dom_value", selector: "input[type=password]" }], triggers: [], tags: [] };
    expect((await a.api("PUT", `/v1/containers/${C}/draft`, cfg)).status).toBe(200);
    const pub = await a.api("POST", `/v1/containers/${C}/publish`, {});
    expect(pub.status).toBe(422);
    expect(pub.body.error.details).toEqual([expect.objectContaining({ rule: "skimmer", strong: false, path: "variables.0.selector" })]);
  });
});

describe("daily budgets of scans and destination tests (per account, lower unclaimed)", () => {
  const opCtx = (accountId: string, over: Record<string, string>): OpCtx => ({
    env: { ...E, ...over } as Bindings,
    auth: { accountId, keyId: "key_test", scopes: ["*"] },
    base: B,
    origins: [B],
  });

  it("scans + verifications share a budget; unclaimed accounts get the UNCLAIMED_ value; GET /v1/usage shows it", async () => {
    const vars = { MAX_SCANS_PER_ACCOUNT_PER_DAY: "3", UNCLAIMED_MAX_SCANS_PER_ACCOUNT_PER_DAY: "1" };
    const u = await freshAccount(false);
    const Cu = (await u.api("POST", "/v1/containers", { domain: "scan-budget-u.test" })).body.container.id as string;
    await expect(ops.verify(opCtx(u.accountId, vars), Cu, { method: "dns" })).resolves.toMatchObject({ verified: false });
    await expect(ops.verify(opCtx(u.accountId, vars), Cu, { method: "dns" })).rejects.toMatchObject({
      status: 429,
      code: "quota_exceeded",
      message: expect.stringMatching(/used its 1 scans and domain verifications for today/),
    });

    const c = await freshAccount(true);
    const Cc = (await c.api("POST", "/v1/containers", { domain: "scan-budget-c.test" })).body.container.id as string;
    for (let n = 0; n < 3; n++) await ops.verify(opCtx(c.accountId, vars), Cc, { method: "dns" });
    await expect(ops.verify(opCtx(c.accountId, vars), Cc, { method: "dns" })).rejects.toMatchObject({ status: 429 });
    const usage = await ops.usage(opCtx(c.accountId, vars));
    expect(usage.limits.scans_per_day).toMatchObject({ used: 4, limit: 3, remaining: 0, var: "MAX_SCANS_PER_ACCOUNT_PER_DAY" });

    // Unset (the default): no budget, no D1 counter.
    await expect(ops.verify(opCtx(c.accountId, {}), Cc, { method: "dns" })).resolves.toMatchObject({ verified: false });
  });

  it("destination tests have their own budget; a platform-wide one refuses without numbers", async () => {
    const a = await freshAccount(true);
    const C = (await a.api("POST", "/v1/containers", { domain: "test-budget.test" })).body.container.id as string;
    const d = await a.api("POST", `/v1/containers/${C}/destinations`, {
      type: "webhook",
      credentials: { url: "https://hooks.test/budget", secret: "integration-secret-123" },
    });
    expect(d.status).toBe(201);
    const D = d.body.destination.id as string;
    const vars = { MAX_DESTINATION_TESTS_PER_ACCOUNT_PER_DAY: "1" };
    await expect(ops.testDestination(opCtx(a.accountId, vars), C, D, {})).resolves.toMatchObject({ result: expect.anything() });
    await expect(ops.testDestination(opCtx(a.accountId, vars), C, D, {})).rejects.toMatchObject({
      status: 429,
      message: expect.stringMatching(/used its 1 destination tests/),
    });
    const platform = { MAX_DESTINATION_TESTS_PER_DAY: "1" };
    const err = await ops.testDestination(opCtx(a.accountId, platform), C, D, {}).catch((e) => e);
    // Earlier tests in this run may already have used the platform counter: either this one or the next is refused.
    const err2 = err?.status ? err : await ops.testDestination(opCtx(a.accountId, platform), C, D, {}).catch((e) => e);
    expect(err2).toMatchObject({ status: 429, message: "This service's daily budget of destination tests is used up; more at 00:00 UTC." });
  });
});
