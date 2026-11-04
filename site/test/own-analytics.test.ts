import { describe, expect, it } from "vitest";
import { Browser, call, csrfOf, nextIp, serviceCalls, testEnv, uniqueEmail } from "./helpers";

// The deployment's own analytics (src/own-analytics.ts): signups and claims as server events.
const OWN = { OWN_ANALYTICS_ACCOUNT_ID: "acct_ownsite0000000", OWN_ANALYTICS_SITE_ID: "site_ownsite0000000" };
const EVENTS_PATH = `/v1/sites/${OWN.OWN_ANALYTICS_SITE_ID}/events`;
const sentSince = (n: number) => serviceCalls.slice(n).filter((s) => s.service === "analytics" && s.path === EVENTS_PATH);

async function claimFlow(env: ReturnType<typeof testEnv>, headers: Record<string, string>) {
  const s = await call("POST", "/v1/signup", { json: {}, ip: nextIp(), env });
  expect(s.status).toBe(201);
  const link = await call("POST", "/v1/claim-link", { key: s.json.api_key, env });
  expect(link.status).toBe(201);
  const path = new URL(link.json.url).pathname;
  const b = new Browser(env);
  await b.signIn(uniqueEmail("own"), path);
  const page = await b.get(path);
  const before = serviceCalls.length;
  const claimed = await b.post(path, { csrf: csrfOf(page.text) }, { headers });
  expect(claimed.status).toBe(303);
  return { accountId: s.json.account_id as string, token: path.split("/").pop() as string, sent: sentSince(before) };
}

describe("own analytics", () => {
  it("sends nothing unless both vars are set", async () => {
    const before = serviceCalls.length;
    const env = testEnv({ OWN_ANALYTICS_ACCOUNT_ID: OWN.OWN_ANALYTICS_ACCOUNT_ID });
    expect((await call("POST", "/v1/signup", { json: {}, ip: nextIp(), env })).status).toBe(201);
    expect((await call("POST", "/v1/signup", { json: {}, ip: nextIp() })).status).toBe(201);
    expect(sentSince(before)).toHaveLength(0);
  });

  it("sends a signup as the deployment's own project over internal auth", async () => {
    const env = testEnv(OWN);
    const before = serviceCalls.length;
    const s = await call("POST", "/v1/signup", { json: { name: "acme" }, ip: nextIp(), env });
    expect(s.status).toBe(201);
    const sent = sentSince(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.account).toBe(OWN.OWN_ANALYTICS_ACCOUNT_ID);
    expect(sent[0]?.internal).toBe(env.INTERNAL_TOKEN);
    expect(sent[0]?.authorization).toBeNull();
    expect(JSON.parse(sent[0]?.body ?? "{}")).toEqual({
      events: [{ name: "signup", user_id: s.json.account_id, url: "https://afs.test/v1/signup", visit: false }],
    });
    // A refused signup is not a conversion.
    const n = serviceCalls.length;
    const bad = await call("POST", "/v1/signup", { json: { name: 42 }, ip: nextIp(), env });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(sentSince(n)).toHaveLength(0);
  });

  it("sends a claim joined to the visit, without the token or anything personal", async () => {
    const { accountId, token, sent } = await claimFlow(testEnv(OWN), { "user-agent": "Mozilla/5.0 (Test)" });
    expect(sent).toHaveLength(1);
    const body = sent[0]?.body ?? "";
    expect(JSON.parse(body).events[0]).toEqual({
      name: "project_claimed",
      user_id: accountId,
      url: "https://afs.test/claim",
      props: { role: "owner" },
      ip: "192.0.2.1",
      user_agent: "Mozilla/5.0 (Test)",
    });
    expect(body).not.toContain(token);
    expect(body).not.toContain("@");
  });

  it("doesn't count a claim from a browser that sends Global Privacy Control or Do Not Track", async () => {
    expect((await claimFlow(testEnv(OWN), { "sec-gpc": "1", "user-agent": "Mozilla/5.0 (Test)" })).sent).toHaveLength(0);
    expect((await claimFlow(testEnv(OWN), { dnt: "1", "user-agent": "Mozilla/5.0 (Test)" })).sent).toHaveLength(0);
  });
});
