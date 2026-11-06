import type { AttackItem } from "@afs/shared";
import { describe, expect, it } from "vitest";
import { createClaimLink } from "../src/claims";
import { deliverDue } from "../src/email";
import { attackHeadline, attackLine, limitLine } from "../src/email-messages";
import { type UsageItem, attackItems, checkProjectLimits, checkQuietSites, limitHits, quietSpell } from "../src/project-health";
import {
  BASE,
  Browser,
  E,
  alertFixtures,
  call,
  csrfOf,
  emailsTo,
  fixtures,
  serviceCalls,
  signup,
  testEnv,
  timeseriesFixtures,
  uniqueEmail,
  usageFixtures,
} from "./helpers";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** A project claimed by a signed-in owner, with one member. */
async function team(label: string) {
  const agent = await signup(`${label}.test`);
  const link = (await call("POST", "/v1/claim-link", { key: agent.key })).json.url as string;
  const owner = new Browser();
  const ownerEmail = uniqueEmail(`${label}-owner`);
  const path = new URL(link).pathname;
  await owner.signIn(ownerEmail, path);
  expect((await owner.post(path, { csrf: csrfOf((await owner.get(path)).text) })).status).toBe(303);
  const ownerId = await E.DB.prepare("SELECT user_id FROM memberships WHERE account_id = ?").bind(agent.accountId).first<string>("user_id");
  const invite = await createClaimLink(E.DB, BASE, agent.accountId, { userId: ownerId! });
  const member = new Browser();
  const memberEmail = uniqueEmail(`${label}-member`);
  const invitePath = new URL(invite.url).pathname;
  await member.signIn(memberEmail, invitePath);
  expect((await member.post(invitePath, { csrf: csrfOf((await member.get(invitePath)).text) })).status).toBe(303);
  return { agent, owner, ownerEmail, member, memberEmail, name: `${label}.test` };
}

const item = (o: Partial<UsageItem>): UsageItem => ({
  used: null,
  limit: null,
  remaining: null,
  resets_at: null,
  unit: "things",
  var: "MAX_THINGS",
  ...o,
});

/** Daily page views ending today: `week` steady days, then `quiet` days of none (today included). */
function days(perDay: number, quiet: number, total = 30) {
  const today = Date.UTC(2026, 10, 20);
  return Array.from({ length: total }, (_, i) => {
    const date = new Date(today - (total - 1 - i) * DAY).toISOString().slice(0, 10);
    return { date, pageviews: i >= total - quiet ? 0 : perDay };
  });
}

describe("health: the rules", () => {
  it("calls a site quiet after two whole days without page views, only when it was working", () => {
    expect(quietSpell(days(20, 3))).toEqual({ last_date: "2026-11-17", per_day: 20 });
    expect(quietSpell(days(20, 2))).toBeNull(); // today and yesterday: not two whole days yet
    expect(quietSpell(days(5, 3))).toBeNull(); // 35 a week: too few to tell
    expect(quietSpell(days(20, 10))).toBeNull(); // quiet for longer than 8 days: reported back then
    expect(quietSpell(days(0, 0))).toBeNull(); // never had any
    const patchy = days(60, 3).map((d, i) => (i % 3 ? { ...d, pageviews: 0 } : d)); // a page view every third day
    expect(quietSpell(patchy)).toBeNull();
  });

  it("finds the caps at 80% or past them, per site, most urgent first", () => {
    const hits = limitHits({
      analytics: {
        limits: {
          events_per_site_per_day: item({
            label: "Events a day on one site",
            used: 950,
            limit: 1000,
            resets_at: 1,
            drops_data: true,
            per: [
              { id: "site_a", label: "a.com", used: 950, remaining: 50 },
              { id: "site_b", label: "b.com", used: 100, remaining: 900 },
            ],
          }),
          goals_per_site: item({ label: "Goals on one site", used: 10, limit: 10 }),
        },
      },
      mail: {
        limits: {
          storage_bytes: item({
            label: "Mail storage",
            used: 900 * 1024 ** 2,
            limit: 1024 ** 3,
            unit: "bytes of mail kept",
            drops_data: true,
          }),
          inbound_per_day: item({ label: "Inbound mail a day", used: 100, limit: 100, resets_at: 1, drops_data: true }),
          webhooks: item({ label: "Webhooks", used: 1, limit: null }),
        },
      },
      tags: null,
      replay: null,
    });
    expect(hits.map((h) => [h.item, h.level])).toEqual([
      ["analytics.goals_per_site", "reached"],
      ["mail.inbound_per_day", "reached"],
      ["analytics.events_per_site_per_day:site_a", "near"],
      ["mail.storage_bytes", "near"],
    ]);
    const onlyData = limitHits({ analytics: { limits: { goals_per_site: item({ used: 10, limit: 10 }) } } }, { dropsDataOnly: true });
    expect(onlyData).toEqual([]);
    expect(limitLine(hits[2]!)).toBe("Events a day on one site (a.com): 950 of 1,000 today (95%).");
    expect(limitLine(hits[3]!)).toBe("Mail storage: 900 MB of 1 GB (87%).");
  });
});

describe("health: usage", () => {
  it("answers GET /v1/usage and afs_get_usage with every service's caps", async () => {
    const agent = await signup("usage.test");
    usageFixtures.set(`mail:${agent.accountId}`, {
      limits: { inbound_per_day: item({ label: "Inbound mail a day", used: 90, limit: 100, resets_at: 1, drops_data: true }) },
    });
    const rest = await call("GET", "/v1/usage", { key: agent.key });
    expect(rest.status).toBe(200);
    expect(rest.json.close_to_limits).toMatchObject([{ item: "mail.inbound_per_day", level: "near", percent: 90, drops_data: true }]);
    expect(Object.keys(rest.json.services)).toEqual(["analytics", "tags", "mail", "replay"]);
    expect(rest.json.unavailable).toEqual([]);
    const viaMcp = await call("POST", "/mcp", {
      key: agent.key,
      json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "afs_get_usage", arguments: {} } },
    });
    expect(JSON.parse(viaMcp.json.result.content[0].text).close_to_limits[0].item).toBe("mail.inbound_per_day");
    expect((await call("GET", "/v1/usage")).status).toBe(401);
    const read = (await call("POST", "/v1/keys", { key: agent.key, json: { scope: "read" } })).json.api_key as string;
    expect((await call("GET", "/v1/usage", { key: read })).status).toBe(200);
  });

  it("warns the project's people about caps that drop data, once a week per level, and not unclaimed projects", async () => {
    const t = await team("limits");
    const unclaimed = await signup("nobody.test");
    const near = {
      limits: {
        inbound_per_day: item({ label: "Inbound mail a day", used: 85, limit: 100, resets_at: Date.now() + 10 * HOUR, drops_data: true }),
        sends_per_day: item({ label: "Recipients sent a day", used: 20, limit: 20, resets_at: Date.now() + 10 * HOUR }),
      },
    };
    usageFixtures.set(`mail:${t.agent.accountId}`, near);
    usageFixtures.set(`mail:${unclaimed.accountId}`, near);
    const env = testEnv();
    const now = Date.now();
    serviceCalls.length = 0;
    expect((await checkProjectLimits(env, BASE, now)).warned).toBeGreaterThanOrEqual(1);
    expect(serviceCalls.some((s) => s.path === "/v1/usage" && s.account === unclaimed.accountId)).toBe(false);
    await deliverDue(env, BASE, Date.now());
    const subject = `${t.name} is close to a fair-use limit`;
    for (const address of [t.ownerEmail, t.memberEmail]) {
      const mail = emailsTo(address).filter((m) => m.subject === subject);
      expect(mail).toHaveLength(1);
      expect(mail[0]?.text).toContain("Inbound mail a day: 85 of 100 today (85%).");
      expect(mail[0]?.text).not.toContain("Recipients sent"); // the agent gets a 429 for that one
      expect(mail[0]?.text).toContain("afs_get_usage");
      expect(mail[0]?.text).toContain("Turn off these alerts:");
      expect(mail[0]?.headers["List-Unsubscribe"]).toContain("&c=alerts");
    }

    // An hour later it's still at 85%: nobody is told again this week. Reaching it is news.
    await checkProjectLimits(env, BASE, now + 2 * HOUR);
    await deliverDue(env, BASE, now + 2 * HOUR);
    expect(emailsTo(t.ownerEmail).filter((m) => m.subject === subject)).toHaveLength(1);
    usageFixtures.set(`mail:${t.agent.accountId}`, {
      limits: {
        inbound_per_day: item({ label: "Inbound mail a day", used: 100, limit: 100, resets_at: now + 10 * HOUR, drops_data: true }),
      },
    });
    await checkProjectLimits(env, BASE, now + 4 * HOUR);
    await deliverDue(env, BASE, now + 4 * HOUR);
    const reached = emailsTo(t.ownerEmail).filter((m) => m.subject === `${t.name} reached a fair-use limit`);
    expect(reached).toHaveLength(1);
    expect(reached[0]?.text).toContain("100 of 100 today (100%, reached)");

    // The member turns alerts off with the link; the next warning skips them.
    const alert = emailsTo(t.memberEmail).find((m) => m.subject === subject);
    const url = /^<(.+)>$/.exec(alert?.headers["List-Unsubscribe"] ?? "")?.[1] ?? "";
    const path = new URL(url).pathname + new URL(url).search;
    expect((await call("GET", path)).text).toContain("Turn off alerts?");
    expect((await call("POST", path.replace("c=alerts", "c=updates"))).status).toBe(400); // signed for alerts only
    expect((await call("POST", path)).status).toBe(200);
    usageFixtures.set(`mail:${t.agent.accountId}`, {
      limits: { storage_bytes: item({ label: "Mail storage", used: 950, limit: 1000, unit: "bytes", drops_data: true }) },
    });
    await checkProjectLimits(env, BASE, now + 6 * HOUR);
    await deliverDue(env, BASE, now + 6 * HOUR);
    const storage = (address: string) => emailsTo(address).filter((m) => m.text.includes("Mail storage: 950 bytes of 1,000 bytes"));
    expect(storage(t.ownerEmail)).toHaveLength(1);
    expect(storage(t.memberEmail)).toHaveLength(0);
  });
});

describe("health: the dashboard", () => {
  it("shows the caps a project is close to on its overview, with the prompt", async () => {
    const t = await team("panel");
    const page = (path: string) => t.owner.get(path).then((r) => r.text);
    const overview = `/dashboard/projects/${t.agent.accountId}`;
    expect(await page(overview)).not.toContain('id="limits"');
    usageFixtures.set(`mail:${t.agent.accountId}`, {
      limits: { storage_bytes: item({ label: "Mail storage", used: 900, limit: 1000, unit: "bytes", drops_data: true }) },
    });
    const html = await page(overview);
    expect(html).toContain('id="limits"');
    expect(html).toContain("This project is close to a fair-use limit");
    expect(html).toContain("Mail storage: 900 bytes of 1,000 bytes (90%).");
    expect(html).toContain("/v1/usage (MCP afs_get_usage)");
  });
});

describe("health: quiet sites", () => {
  it("tells the project's people once when a working site stops sending page views", async () => {
    const t = await team("quiet");
    fixtures.set(t.agent.accountId, {
      sites: [
        { id: "site_quietone", domain: "quiet.example", name: null, created_at: 1 },
        { id: "site_alerted", domain: "alerted.example", name: null, created_at: 1 },
        { id: "site_busy", domain: "busy.example", name: null, created_at: 1 },
      ],
    });
    timeseriesFixtures.set("site_quietone", days(40, 3));
    timeseriesFixtures.set("site_alerted", days(40, 3));
    alertFixtures.set("site_alerted", [{ type: "no_data", enabled: true }]); // its own alert covers it
    timeseriesFixtures.set("site_busy", days(40, 0));
    const env = testEnv();
    const now = Date.now();
    expect((await checkQuietSites(env, BASE, now)).quiet).toBe(1);
    await deliverDue(env, BASE, Date.now());
    for (const address of [t.ownerEmail, t.memberEmail]) {
      const mail = emailsTo(address).filter((m) => m.subject.endsWith("stopped sending analytics data"));
      expect(mail.map((m) => m.subject)).toEqual(["quiet.example stopped sending analytics data"]);
      expect(mail[0]?.text).toContain("since 17 November 2026");
      expect(mail[0]?.text).toContain("about 40 a day");
      expect(mail[0]?.text).toContain("/v1/sites/site_quietone/verify");
      expect(mail[0]?.text).toContain(`/dashboard/projects/${t.agent.accountId}/analytics`);
    }
    // The next day it's still quiet: the same outage isn't reported twice.
    await checkQuietSites(env, BASE, now + DAY);
    await deliverDue(env, BASE, now + DAY);
    expect(emailsTo(t.ownerEmail).filter((m) => m.subject.endsWith("stopped sending analytics data"))).toHaveLength(1);
  });
});

describe("health: settings", () => {
  it("lets a person turn alerts off and on in Account", async () => {
    const b = new Browser();
    const email = uniqueEmail("alerts");
    await b.signIn(email);
    const page = await b.get("/dashboard/account");
    expect(page.text).toContain('name="alerts" value="on" checked');
    await b.post("/dashboard/account/emails", { csrf: csrfOf(page.text), updates: "on" });
    const prefs = () =>
      E.DB.prepare("SELECT email_updates, email_alerts FROM users WHERE email = ?")
        .bind(email)
        .first<{ email_updates: number; email_alerts: number }>();
    expect(await prefs()).toEqual({ email_updates: 1, email_alerts: 0 });
    await b.post("/dashboard/account/emails", { csrf: csrfOf(page.text), alerts: "on" });
    expect(await prefs()).toEqual({ email_updates: 0, email_alerts: 1 });
  });
});

// ---------- attacks ----------

/** One entry of a service's `attacks` (the contract in @afs/shared). */
const attack = (o: Partial<AttackItem> & Pick<AttackItem, "service" | "resource_id">): AttackItem => ({
  resource_label: "attack.test",
  state: "under_attack",
  mode: "auto",
  since: Date.now() - HOUR,
  last_seen_at: Date.now() - 60_000,
  ended_at: null,
  reasons: [{ kind: "spike", detail: "9,800 events in 15 minutes, about 40 times the usual" }],
  quarantined: 4200,
  next_steps: [`Review: GET https://analytics.afs.test/v1/sites/${o.resource_id}/quarantine`],
  ...o,
});

/** The attack emails one address got, by subject. */
const attackMail = (address: string, subject: string) => emailsTo(address).filter((m) => m.subject === subject);

describe("health: attacks, the rules", () => {
  it("merges analytics and tags attacks, checked, active first, and drops what it can't use", () => {
    const now = Date.now();
    const items = attackItems(
      {
        analytics: {
          attacks: [
            attack({ service: "analytics", resource_id: "site_ended", state: "ended", ended_at: now - HOUR }),
            attack({ service: "analytics", resource_id: "site_old", state: "ended", ended_at: now - 2 * DAY }), // ended too long ago
            attack({ service: "analytics", resource_id: "site_net", state: "contained", reasons: [{ kind: "network_share", detail: "" }] }),
            { resource_id: "ctr_wrongservice", state: "under_attack", since: 1 },
            { resource_id: "site_nostate", since: 1 },
            { resource_id: "site_proto", state: "toString", since: 1 },
            "nonsense",
          ],
        },
        tags: { attacks: [attack({ service: "tags", resource_id: "ctr_spike", mode: "bogus" as AttackItem["mode"] })] },
        mail: { attacks: [attack({ service: "analytics", resource_id: "site_mail" })] }, // only analytics and tags have them
      },
      now,
    );
    expect(items.map((a) => [a.service, a.resource_id, a.state])).toEqual([
      ["tags", "ctr_spike", "under_attack"],
      ["analytics", "site_net", "contained"],
      ["analytics", "site_ended", "ended"],
    ]);
    expect(items[0]?.mode).toBe("auto");

    const [spike, contained, ended] = items as [AttackItem, AttackItem, AttackItem];
    expect(attackLine(spike)).toContain("Tags on attack.test, since ");
    expect(attackLine(spike)).toContain(
      "9,800 events in 15 minutes, about 40 times the usual. 4,200 events set aside so far, none of them sent anywhere;",
    );
    expect(attackLine(spike)).toContain("traffic from data-centre networks is set aside too");
    expect(attackLine(spike)).toContain("Conversions from data-centre traffic and anything set aside aren't sent to your ad platforms");
    expect(attackLine(spike)).toContain("conversions from other visitors' browsers");
    expect(attackLine({ ...spike, mode: "strict" })).toContain("With protection strict, conversions from visitors' browsers aren't sent");
    expect(attackLine(contained)).toContain("One network sent more than its daily share. 4,200 events set aside so far.");
    expect(attackLine(contained)).not.toContain("data-centre");
    expect(attackLine(ended)).toContain("It ended at ");
    expect(attackLine({ ...spike, service: "analytics", mode: "off" })).toContain("Protection is off here, so nothing was set aside");
    expect(attackHeadline([contained], "Acme")).toBe("attack.test: traffic from one network was set aside");
    expect(attackHeadline([spike, contained], "Acme")).toBe("attack.test is getting suspicious traffic");
    expect(attackHeadline([ended], "Acme")).toBe("Suspicious traffic to attack.test has ended");
    expect(attackHeadline([spike, { ...contained, resource_label: "b.test" }], "Acme")).toBe(
      "attack.test and b.test are getting suspicious traffic",
    );
  });
});

describe("health: attacks in usage", () => {
  it("passes the merged attacks through GET /v1/usage and afs_get_usage", async () => {
    const agent = await signup("attackusage.test");
    usageFixtures.set(`analytics:${agent.accountId}`, {
      limits: {},
      attacks: [attack({ service: "analytics", resource_id: "site_usage1", state: "contained" })],
    });
    usageFixtures.set(`tags:${agent.accountId}`, { limits: {}, attacks: [attack({ service: "tags", resource_id: "ctr_usage1" })] });
    const rest = await call("GET", "/v1/usage", { key: agent.key });
    expect(rest.status).toBe(200);
    expect(rest.json.attacks.map((a: AttackItem) => [a.service, a.resource_id, a.state])).toEqual([
      ["tags", "ctr_usage1", "under_attack"],
      ["analytics", "site_usage1", "contained"],
    ]);
    expect(rest.json.attacks[1]).toMatchObject({
      quarantined: 4200,
      resource_label: "attack.test",
      next_steps: [expect.stringContaining("/quarantine")],
    });
    expect(rest.json.next_steps.some((s: string) => s.startsWith("Suspicious traffic was set aside"))).toBe(true);
    const viaMcp = await call("POST", "/mcp", {
      key: agent.key,
      json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "afs_get_usage", arguments: {} } },
    });
    expect(JSON.parse(viaMcp.json.result.content[0].text).attacks).toHaveLength(2);

    // No attacks: an empty list, and no next step about them.
    const calm = await signup("calm.test");
    const quiet = await call("GET", "/v1/usage", { key: calm.key });
    expect(quiet.json.attacks).toEqual([]);
    expect(quiet.json.next_steps).toEqual([]);
  });
});

describe("health: attack emails", () => {
  it("tells the project's people once per episode, again for a new one or when it grows, and respects alerts off", async () => {
    const t = await team("attack");
    const unclaimed = await signup("attack-nobody.test");
    const id = t.agent.accountId;
    const start = Date.now() - HOUR;
    const spike = {
      analytics: {
        limits: {},
        attacks: [
          attack({
            service: "analytics",
            resource_id: "site_atk1",
            since: start,
            reasons: [
              { kind: "spike", detail: "9,800 events in 15 minutes, about 40 times the usual" },
              { kind: "datacenter", detail: "" },
            ],
          }),
        ],
      },
      tags: { limits: {}, attacks: [attack({ service: "tags", resource_id: "ctr_atk1", since: start, quarantined: 120 })] },
    };
    usageFixtures.set(`analytics:${id}`, spike.analytics);
    usageFixtures.set(`tags:${id}`, spike.tags);
    usageFixtures.set(`analytics:${unclaimed.accountId}`, spike.analytics);
    const env = testEnv();
    const now = Date.now();
    serviceCalls.length = 0;
    expect((await checkProjectLimits(env, BASE, now)).attacks).toBeGreaterThanOrEqual(1);
    expect(serviceCalls.some((s) => s.path === "/v1/usage" && s.account === unclaimed.accountId)).toBe(false);
    await deliverDue(env, BASE, Date.now());
    const subject = "attack.test is getting suspicious traffic";
    for (const address of [t.ownerEmail, t.memberEmail]) {
      const mail = attackMail(address, subject);
      expect(mail).toHaveLength(1); // analytics and tags in one email
      const text = mail[0]!.text;
      expect(text).toContain("Analytics on attack.test, since ");
      expect(text).toContain(
        "9,800 events in 15 minutes, about 40 times the usual; much of it from data-centre networks (hosting and cloud providers).",
      );
      expect(text).toContain("4,200 events set aside so far");
      expect(text).toContain("Tags on attack.test");
      expect(text).toContain("120 events set aside so far, none of them sent anywhere");
      expect(text).toContain("aren't sent to your ad platforms");
      expect(text).toContain("out of your reports and out of the daily budget");
      expect(text).toContain("https://analytics.afs.test/v1/sites/site_atk1/quarantine");
      expect(text).toContain("https://tags.afs.test/v1/containers/ctr_atk1/quarantine");
      expect(text).toContain("POST .../quarantine/release");
      expect(text).toContain(`Open analytics: ${BASE}/dashboard/projects/${id}/analytics/site_atk1`);
      expect(text).toContain("Turn off these alerts:");
      expect(mail[0]?.headers["List-Unsubscribe"]).toContain("&c=alerts");
    }

    // Two hours on, the same episode is still going (more set aside): nobody is told again.
    usageFixtures.set(`analytics:${id}`, {
      limits: {},
      attacks: [attack({ service: "analytics", resource_id: "site_atk1", since: start, quarantined: 9000, last_seen_at: now + HOUR })],
    });
    await checkProjectLimits(env, BASE, now + 2 * HOUR);
    await deliverDue(env, BASE, now + 2 * HOUR);
    expect(attackMail(t.ownerEmail, subject)).toHaveLength(1);

    // A new episode (one network over its share, later a spike in the same episode) is news, twice.
    const later = now + 3 * HOUR;
    const contained = attack({
      service: "analytics",
      resource_id: "site_atk1",
      since: later,
      state: "contained",
      quarantined: 500,
      reasons: [{ kind: "network_share", detail: "One network sent 2,000 events today" }],
    });
    usageFixtures.set(`analytics:${id}`, { limits: {}, attacks: [contained] });
    usageFixtures.set(`tags:${id}`, { limits: {}, attacks: [] });
    await checkProjectLimits(env, BASE, now + 4 * HOUR);
    await deliverDue(env, BASE, now + 4 * HOUR);
    const set = attackMail(t.ownerEmail, "attack.test: traffic from one network was set aside");
    expect(set).toHaveLength(1);
    expect(set[0]?.text).toContain("One network sent 2,000 events today. 500 events set aside so far.");
    expect(set[0]?.text).not.toContain("data-centre");
    usageFixtures.set(`analytics:${id}`, { limits: {}, attacks: [{ ...contained, state: "under_attack" }] });
    await checkProjectLimits(env, BASE, now + 6 * HOUR);
    await deliverDue(env, BASE, now + 6 * HOUR);
    expect(attackMail(t.ownerEmail, subject)).toHaveLength(2);
    // ...and back to contained (or ended) is not.
    usageFixtures.set(`analytics:${id}`, {
      limits: {},
      attacks: [{ ...contained, state: "ended", ended_at: now + 7 * HOUR }],
    });
    await checkProjectLimits(env, BASE, now + 8 * HOUR);
    await deliverDue(env, BASE, now + 8 * HOUR);
    expect(emailsTo(t.ownerEmail).filter((m) => m.subject.startsWith("attack.test") || m.subject.includes("suspicious"))).toHaveLength(3);

    // The member turns alerts off: the next episode reaches the owner only.
    const alert = attackMail(t.memberEmail, subject)[0];
    const url = /^<(.+)>$/.exec(alert?.headers["List-Unsubscribe"] ?? "")?.[1] ?? "";
    expect((await call("POST", new URL(url).pathname + new URL(url).search)).status).toBe(200);
    usageFixtures.set(`tags:${id}`, {
      limits: {},
      attacks: [attack({ service: "tags", resource_id: "ctr_atk1", resource_label: "shop.attack.test", since: now + 9 * HOUR })],
    });
    usageFixtures.set(`analytics:${id}`, { limits: {}, attacks: [] });
    await checkProjectLimits(env, BASE, now + 10 * HOUR);
    await deliverDue(env, BASE, now + 10 * HOUR);
    const tagsOnly = "shop.attack.test is getting suspicious traffic";
    expect(attackMail(t.ownerEmail, tagsOnly)).toHaveLength(1);
    expect(attackMail(t.ownerEmail, tagsOnly)[0]?.text).toContain(`Open tags: ${BASE}/dashboard/projects/${id}/tags/ctr_atk1`);
    expect(attackMail(t.ownerEmail, tagsOnly)[0]?.text).not.toContain("quarantine/release");
    expect(attackMail(t.memberEmail, tagsOnly)).toHaveLength(0);
  });
});

describe("health: attacks on the dashboard", () => {
  it("shows a banner on the overview and on the analytics and tags tabs", async () => {
    const t = await team("atkpanel");
    const id = t.agent.accountId;
    const now = Date.now();
    fixtures.set(id, {
      sites: [
        { id: "site_dashatk", domain: "atk.test", name: null, created_at: now },
        { id: "site_dashatk2", domain: "other.atk.test", name: null, created_at: now },
      ],
      containers: [{ id: "ctr_dashatk", domain: "atk.test", name: null, live_version: 1, created_at: now }],
    });
    const page = (path: string) => t.owner.get(path).then((r) => r.text);
    const overview = `/dashboard/projects/${id}`;
    expect(await page(overview)).not.toContain('id="attacks"');
    expect(await page(`${overview}/analytics/site_dashatk`)).not.toContain('id="attacks"');

    usageFixtures.set(`analytics:${id}`, {
      limits: {},
      attacks: [attack({ service: "analytics", resource_id: "site_dashatk", resource_label: "atk.test" })],
    });
    usageFixtures.set(`tags:${id}`, {
      limits: {},
      attacks: [
        attack({
          service: "tags",
          resource_id: "ctr_dashatk",
          resource_label: "atk.test",
          state: "ended",
          ended_at: now - HOUR,
          quarantined: 75,
        }),
      ],
    });
    const html = await page(overview);
    expect(html).toContain('id="attacks"');
    expect(html).toContain("atk.test is getting suspicious traffic");
    expect(html).toContain("4,200 events set aside so far");
    expect(html).toContain(`href="/dashboard/projects/${id}/analytics/site_dashatk">Open analytics</a>`);
    expect(html).toContain(`href="/dashboard/projects/${id}/tags/ctr_dashatk">Open tags</a>`);
    expect(html).toContain("https://analytics.afs.test/v1/sites/site_dashatk/quarantine");
    expect(html).toContain('class="ask-line"');

    // The analytics tab: only analytics, without a link to the page it's on.
    const site = await page(`${overview}/analytics/site_dashatk`);
    expect(site).toContain('id="attacks"');
    expect(site).toContain("atk.test is getting suspicious traffic");
    expect(site).not.toContain("Tags on atk.test");
    expect(site).not.toContain(">Open analytics</a>");
    expect(site.indexOf('id="attacks"')).toBeLessThan(site.indexOf('id="afa"'));
    // Another site of the project links to the one under attack.
    expect(await page(`${overview}/analytics/site_dashatk2`)).toContain(
      `href="/dashboard/projects/${id}/analytics/site_dashatk">Open analytics</a>`,
    );

    // The tags tab: its episode ended an hour ago, so the banner is the quiet kind.
    const tags = await page(`${overview}/tags`);
    expect(tags).toContain('class="tile attack-tile ended"');
    expect(tags).toContain("Suspicious traffic to atk.test has ended");
    expect(tags).toContain("It ended at ");
    expect(tags).toContain("75 events were set aside");
    expect(tags).not.toContain("Analytics on atk.test");

    // A service that fails: the page still renders, without the banner.
    usageFixtures.set(`tags:${id}`, { attacks: "not a list" });
    expect(await page(`${overview}/tags`)).not.toContain('id="attacks"');
  });
});
