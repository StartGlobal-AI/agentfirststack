import { describe, expect, it } from "vitest";
import { buildDigest, digestText, emailOperatorDigest } from "../src/operator-digest";
import { BASE, E, call, emailsTo, signup, testEnv } from "./helpers";

const ADMIN = "test-admin-token-0123456789";

describe("operator's daily summary", () => {
  it("counts the last 24 hours, flags what needs a look, and sends once a day to OPERATOR_EMAIL", async () => {
    const agent = await signup("digest.test");
    const now = Date.now();
    await E.DB.prepare("INSERT INTO limit_warnings (account_id, item, level, warned_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)")
      .bind(
        agent.accountId,
        "analytics.events_per_site_per_day:site_dg",
        "near",
        now - 1000,
        agent.accountId,
        "analytics.attack:site_dg:1700000000000",
        "under_attack",
        now - 500,
      )
      .run();
    const d = await buildDigest(testEnv(), now);
    expect(d.projects.created).toBeGreaterThanOrEqual(1);
    expect(d.warnings.some((w) => w.item.startsWith("analytics.events_per_site_per_day"))).toBe(true);
    expect(d.attacks).toEqual(expect.arrayContaining([expect.objectContaining({ level: "under_attack" })]));
    // The services aren't wired in this test run: they show as not answering.
    expect(d.services.map((s) => s.service)).toEqual(["analytics", "tags", "mail", "replay"]);

    const text = digestText(d, BASE);
    expect(text.subject).toMatch(/^Needs a look: AgentFirstStack \d{4}-\d\d-\d\d: /);
    expect(text.subject).toContain("1 attack episode");
    expect(text.body.join("\n")).toContain("Suspicious traffic (projects emailed): ");
    expect(text.body.join("\n")).toContain("Limit warnings sent: ");

    // Off without OPERATOR_EMAIL; with it, one email a UTC day.
    expect(await emailOperatorDigest(testEnv(), BASE, now)).toMatchObject({ sent: 0 });
    const env = testEnv({ OPERATOR_EMAIL: "ops@digest.test, second@digest.test" });
    expect(await emailOperatorDigest(env, BASE, now)).toMatchObject({ sent: 2 });
    expect(await emailOperatorDigest(env, BASE, now + 1000)).toMatchObject({ sent: 0 });
    const [mail] = emailsTo("ops@digest.test");
    expect(mail!.subject).toBe(text.subject);
    expect(mail!.text).toContain("the operator of this deployment (OPERATOR_EMAIL on the site)");
    expect(emailsTo("second@digest.test")).toHaveLength(1);
  });

  it("is sent on demand through the admin API, which needs ADMIN_TOKEN", async () => {
    const env = testEnv({ ADMIN_TOKEN: ADMIN, OPERATOR_EMAIL: "now@digest.test" });
    expect((await call("POST", "/v1/admin/digest", { env, key: "afs_not_the_admin_token" })).status).toBe(401);
    const r = await call("POST", "/v1/admin/digest", { env, key: ADMIN });
    expect(r.status).toBe(200);
    expect(r.json.digest.projects).toBeDefined();
    expect(r.json.email).toMatchObject({ sent: 1 });
    // Manual sends aren't limited to one a day.
    expect((await call("POST", "/v1/admin/digest", { env, key: ADMIN })).json.email).toMatchObject({ sent: 1 });
    expect(emailsTo("now@digest.test")).toHaveLength(2);
  });
});
