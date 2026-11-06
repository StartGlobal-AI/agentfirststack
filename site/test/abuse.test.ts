import { capabilityPaused, forgetPauses, recordCapabilityPause } from "@afs/shared";
import { describe, expect, it } from "vitest";
import { buildDigest, digestText, needsAttention } from "../src/operator-digest";
import { notifyPendingPauses } from "../src/pauses";
import { reputationChecks } from "../src/reputation";
import { BASE, Browser, E, call, csrfOf, emailsTo as allEmailsTo, nextIp, signup, testEnv, uniqueEmail } from "./helpers";

/** The emails to an address, without the welcome and claim emails every new owner gets. */
const emailsTo = (address: string) => allEmailsTo(address).filter((m) => !/^Welcome|^You now own/.test(m.subject));

const ADMIN = "test-admin-token-0123456789";
const TOKEN = "test-internal-token-0123456789";
const PAUSES = "https://site.internal/v1/internal/pauses";

/** A project claimed by a signed-in owner; returns the owner's address too. */
async function owned(label: string) {
  const agent = await signup(`${label}.test`);
  const link = (await call("POST", "/v1/claim-link", { key: agent.key })).json.url as string;
  const owner = new Browser();
  const email = uniqueEmail(label);
  const path = new URL(link).pathname;
  await owner.signIn(email, path);
  const claim = await owner.get(path);
  expect((await owner.post(path, { csrf: csrfOf(claim.text) })).status).toBe(303);
  return { agent, owner, email };
}

const internal = (json: unknown, headers: Record<string, string> = { "x-afs-internal": TOKEN }, env = testEnv()) =>
  call("POST", PAUSES, { env, json, headers });

describe("capability pauses: the internal route", () => {
  it("only answers the deployment's own Workers, over a service binding, with the token", async () => {
    const agent = await signup("pause-auth");
    const body = { account_id: agent.accountId, capability: "mail.send", reason: "bounces", paused_by: "mail" };
    expect((await internal(body, {})).status).toBe(401);
    expect((await internal(body, { "x-afs-internal": "wrong" })).status).toBe(401);
    // The right token from the internet (not a .internal host) is refused too.
    expect((await call("POST", "/v1/internal/pauses", { json: body, headers: { "x-afs-internal": TOKEN } })).status).toBe(401);
    expect((await internal({ ...body, capability: "mail.everything" })).json.error).toMatchObject({
      code: "bad_request",
      hint: expect.stringContaining("mail.send"),
    });
    expect((await internal({ ...body, account_id: "acct_doesnotexist000" })).status).toBe(404);
    expect(await capabilityPaused(E, agent.accountId, "mail.send")).toBeNull();
  });

  it("pauses one capability, emails the project's people and the operator once, and the services see it", async () => {
    const { agent, email } = await owned("paused");
    const env = testEnv({ OPERATOR_EMAIL: "ops@pause.test", PUBLIC_BASE_URL: BASE });
    const r = await internal(
      { capability: "mail.send", reason: "12 of the last hour's 30 sends bounced", paused_by: "mail", details: { sent: 30, bounced: 12 } },
      { "x-afs-internal": TOKEN, "x-afs-account": agent.accountId },
      env,
    );
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ paused: true, pause: { capability: "mail.send", paused_by: "mail", until: null } });
    expect(r.json.notify).toBeUndefined();

    const pause = await capabilityPaused(E, agent.accountId, "mail.send");
    expect(pause?.reason).toBe("12 of the last hour's 30 sends bounced");
    expect(await capabilityPaused(E, agent.accountId, "mail.inbox_create")).toBeNull();

    const [mail] = emailsTo(email);
    expect(mail!.subject).toBe("Sending email is paused for paused.test");
    expect(mail!.text).toContain("Why: 12 of the last hour's 30 sends bounced.");
    expect(mail!.text).toContain("support@afs.test");
    expect(mail!.text).toContain("Account and security emails like this one are always sent.");
    const [op] = emailsTo("ops@pause.test");
    expect(op!.subject).toBe(`Paused mail.send for paused.test (${agent.accountId})`);
    expect(op!.text).toContain('"bounced":12');
    expect(op!.text).toContain(`pnpm afs unpause <profile> ${agent.accountId} mail.send`);
    expect(op!.text).toContain("the operator of this deployment");

    // Retries are safe: the pause stays as it was and nobody is emailed again.
    const again = await internal(
      { account_id: agent.accountId, capability: "mail.send", reason: "again", paused_by: "mail" },
      undefined,
      env,
    );
    expect(again.json).toMatchObject({ paused: true, existing: true, pause: { reason: "12 of the last hour's 30 sends bounced" } });
    expect(emailsTo(email)).toHaveLength(1);
    expect(emailsTo("ops@pause.test")).toHaveLength(1);
  });

  it("emails pauses a service wrote directly from the hourly cron", async () => {
    const { agent, email } = await owned("direct");
    await recordCapabilityPause(E.DB, { accountId: agent.accountId, capability: "tags.custom_code", reason: "a crypto miner", by: "tags" });
    expect(emailsTo(email)).toHaveLength(0);
    const n = await notifyPendingPauses(testEnv(), BASE);
    expect(n.pauses).toBeGreaterThanOrEqual(1);
    expect(emailsTo(email).map((m) => m.subject)).toEqual(["Custom code in tag containers is paused for direct.test"]);
    expect(
      await E.DB.prepare("SELECT notified_at FROM capability_pauses WHERE account_id = ?").bind(agent.accountId).first("notified_at"),
    ).not.toBeNull();
    await notifyPendingPauses(testEnv(), BASE);
    expect(emailsTo(email)).toHaveLength(1);
  });
});

describe("capability pauses: the operator", () => {
  const env = testEnv({ ADMIN_TOKEN: ADMIN });
  const admin = (method: string, path: string, json?: unknown) => call(method, path, { env, key: ADMIN, json });

  it("lists, pauses by hand and lifts; a lifted pause isn't re-paused automatically right away", async () => {
    const { agent, email } = await owned("lift");
    expect((await call("GET", "/v1/admin/pauses", { env, key: agent.key })).status).toBe(401);

    const p = await admin("POST", `/v1/admin/accounts/${agent.accountId}/pauses`, {
      capability: "replay.share_links",
      reason: "a phishing page",
    });
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({ paused: true, pause: { paused_by: "operator" }, next_steps: expect.any(Array) });
    expect(emailsTo(email).map((m) => m.subject)).toEqual(["Session replay sharing is paused for lift.test"]);
    expect((await admin("GET", "/v1/admin/pauses")).json.pauses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_id: agent.accountId, capability: "replay.share_links", name: "lift.test" }),
      ]),
    );
    expect((await admin("GET", `/v1/admin/accounts/${agent.accountId}`)).json.pauses).toHaveLength(1);
    expect((await admin("POST", `/v1/admin/accounts/${agent.accountId}/pauses`, { capability: "nope", reason: "x" })).status).toBe(400);

    const lifted = await admin("DELETE", `/v1/admin/accounts/${agent.accountId}/pauses/replay.share_links`);
    expect(lifted.json).toMatchObject({ lifted: true, capability: "replay.share_links" });
    forgetPauses(agent.accountId);
    expect(await capabilityPaused(E, agent.accountId, "replay.share_links")).toBeNull();
    expect(emailsTo(email).map((m) => m.subject)).toContain("Session replay sharing works again in lift.test");
    // Lifting again changes nothing.
    expect((await admin("DELETE", `/v1/admin/accounts/${agent.accountId}/pauses/replay.share_links`)).json).toMatchObject({
      lifted: false,
      existing: true,
    });

    // The service sees the same signal again: ignored during the grace period after a lift.
    const re = await internal({ account_id: agent.accountId, capability: "replay.share_links", reason: "again", paused_by: "replay" });
    expect(re.json).toMatchObject({ paused: false, skipped: "recently_lifted" });
    const graceOff = await internal(
      { account_id: agent.accountId, capability: "replay.share_links", reason: "again", paused_by: "replay" },
      undefined,
      testEnv({ PAUSE_LIFT_GRACE_HOURS: "0" }),
    );
    expect(graceOff.json).toMatchObject({ paused: true });
  });
});

describe("abuse reports", () => {
  const report = { url_or_resource: "https://replay.afs.test/play/rpt_abc", kind: "phishing", details: "A fake bank login page." };

  it("stores a report, answers with an id and what happens next, and emails phishing to the operator at once", async () => {
    const env = testEnv({ OPERATOR_EMAIL: "ops@abuse.test" });
    const ip = nextIp();
    const r = await call("POST", "/v1/abuse-reports", { env, ip, json: { ...report, contact: "me@reporter.test" } });
    expect(r.status).toBe(201);
    expect(r.json.report).toMatchObject({ id: expect.stringMatching(/^abr_/), kind: "phishing", status: "new" });
    expect(r.json.what_happens_next[0]).toMatch(/at once/);
    expect(r.json.next_steps).toEqual(expect.any(Array));
    const [op] = emailsTo("ops@abuse.test");
    expect(op!.subject).toBe("Abuse report (phishing): https://replay.afs.test/play/rpt_abc");
    expect(op!.text).toContain("A fake bank login page.");
    expect(op!.text).toContain("me@reporter.test");
    expect(
      await E.DB.prepare("SELECT emailed_at FROM abuse_reports WHERE id = ?").bind(r.json.report.id).first("emailed_at"),
    ).not.toBeNull();

    // The same report again is the same report.
    const again = await call("POST", "/v1/abuse-reports", { env, ip, json: report });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ existing: true, report: { id: r.json.report.id } });
    expect(emailsTo("ops@abuse.test")).toHaveLength(1);

    // Spam waits for the daily summary.
    const spam = await call("POST", "/v1/abuse-reports", { env, ip, json: { ...report, kind: "spam", url_or_resource: "x@afs.test" } });
    expect(spam.status).toBe(201);
    expect(emailsTo("ops@abuse.test")).toHaveLength(1);

    expect((await call("POST", "/v1/abuse-reports", { env, json: { ...report, kind: "rude" } })).status).toBe(400);
    expect((await call("POST", "/v1/abuse-reports", { env, json: { kind: "spam" } })).status).toBe(400);
  });

  it("limits reports per network", async () => {
    const env = testEnv({ ABUSE_REPORTS_HOURLY_LIMIT: "2" });
    const ip = nextIp();
    for (const n of [1, 2])
      expect(
        (await call("POST", "/v1/abuse-reports", { env, ip, json: { ...report, url_or_resource: `https://x.test/${n}` } })).status,
      ).toBe(201);
    const over = await call("POST", "/v1/abuse-reports", { env, ip, json: { ...report, url_or_resource: "https://x.test/3" } });
    expect(over.status).toBe(429);
    expect(over.json.error.hint).toMatch(/one report/);
    expect(
      (await call("POST", "/v1/abuse-reports", { env, ip: nextIp(), json: { ...report, url_or_resource: "https://x.test/3" } })).status,
    ).toBe(201);
  });

  it("has a form for people, prefilled from ?url=, that escapes what it echoes", async () => {
    const form = await call("GET", `/report-abuse?url=${encodeURIComponent('https://a.test/"><script>x</script>')}&kind=malware`);
    expect(form.status).toBe(200);
    expect(form.headers.get("x-robots-tag")).toContain("noindex");
    expect(form.text).toContain('value="https://a.test/&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
    expect(form.text).not.toContain("<script>x</script>");
    expect(form.text).toContain('<option value="malware" selected>');
    expect(form.text).toContain('href="/acceptable-use"');

    const bad = await call("POST", "/report-abuse", { form: { url_or_resource: "https://a.test", kind: "", details: "" } });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("Fill in the URL");
    const ok = await call("POST", "/report-abuse", {
      ip: nextIp(),
      form: { url_or_resource: "https://a.test/form", kind: "impersonation", details: "Pretends to be us.", contact: "" },
    });
    expect(ok.status).toBe(200);
    expect(ok.text).toMatch(/We got your report \(abr_[0-9a-z]+\)/);
  });

  it("is an MCP tool on the gateway and listed for the operator", async () => {
    const agent = await signup("reporter");
    const tools = await call("POST", "/mcp", { key: agent.key, json: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(tools.json.result.tools.map((t: { name: string }) => t.name)).toContain("afs_report_abuse");
    const res = await call("POST", "/mcp", {
      key: agent.key,
      json: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "afs_report_abuse", arguments: { url_or_resource: "spammer@afs.test", kind: "spam", details: "Sends me ads." } },
      },
    });
    const out = JSON.parse(res.json.result.content[0].text);
    expect(out.report.id).toMatch(/^abr_/);

    const env = testEnv({ ADMIN_TOKEN: ADMIN });
    const list = await call("GET", "/v1/admin/abuse-reports?status=new", { env, key: ADMIN });
    const mine = list.json.reports.find((r: { id: string }) => r.id === out.report.id);
    expect(mine).toMatchObject({ kind: "spam", target: "spammer@afs.test", status: "new" });
    expect(mine.network).toBeUndefined();
    const done = await call("PATCH", `/v1/admin/abuse-reports/${out.report.id}`, {
      env,
      key: ADMIN,
      json: { status: "reviewed", note: "paused mail.send" },
    });
    expect(done.json.report).toMatchObject({ status: "reviewed", note: "paused mail.send" });
    expect((await call("PATCH", "/v1/admin/abuse-reports/abr_nope", { env, key: ADMIN, json: { status: "reviewed" } })).status).toBe(404);
  });
});

describe("the operator's summary: abuse and reputation", () => {
  /** A stand-in for Safe Browsing and DNS over HTTPS. */
  const fakeFetch = (o: { flagged?: string[]; dbl?: Record<string, string | null> }) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://safebrowsing.googleapis.com/")) {
        const body = JSON.parse(String(init?.body)) as { threatInfo: { threatEntries: { url: string }[] } };
        const matches = body.threatInfo.threatEntries
          .filter((e) => o.flagged?.some((h) => e.url === `https://${h}/`))
          .map((e) => ({ threatType: "SOCIAL_ENGINEERING", threat: { url: e.url } }));
        return Response.json(matches.length ? { matches } : {});
      }
      if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
        const name = new URL(url).searchParams.get("name") ?? "";
        const domain = Object.keys(o.dbl ?? {}).find((d) => name.startsWith(`${d}.`));
        const ip = domain ? o.dbl?.[domain] : null;
        return Response.json(ip ? { Status: 0, Answer: [{ type: 1, data: ip }] } : { Status: 3 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

  it("checks Safe Browsing and Spamhaus for the deployment's hosts and extra domains", async () => {
    const env = testEnv({
      PUBLIC_BASE_URL: "https://stack.example",
      SAFE_BROWSING_API_KEY: "k",
      REPUTATION_DOMAINS: "usercontent.example, bad entry",
    });
    const checks = await reputationChecks(
      env,
      fakeFetch({ flagged: ["replay.stack.example"], dbl: { "usercontent.example": "127.0.1.4" } }),
    );
    const sb = checks.filter((c) => c.check === "safe_browsing");
    expect(sb.map((c) => c.target)).toEqual([
      "stack.example",
      "analytics.stack.example",
      "tags.stack.example",
      "mail.stack.example",
      "replay.stack.example",
      "usercontent.example",
    ]);
    expect(sb.find((c) => c.target === "replay.stack.example")).toMatchObject({ status: "listed", detail: "flagged: SOCIAL_ENGINEERING" });
    expect(sb.find((c) => c.target === "stack.example")?.status).toBe("ok");
    expect(checks.filter((c) => c.check === "spamhaus_dbl")).toEqual([
      { check: "spamhaus_dbl", target: "stack.example", status: "ok", detail: "not listed" },
      { check: "spamhaus_dbl", target: "usercontent.example", status: "listed", detail: "listed: phishing domain" },
    ]);
    // Public resolvers are refused by Spamhaus: unknown, with what to do.
    const refused = await reputationChecks(
      testEnv({ PUBLIC_BASE_URL: "https://stack.example" }),
      fakeFetch({ dbl: { "stack.example": "127.255.255.254" } }),
    );
    expect(refused.find((c) => c.check === "spamhaus_dbl")).toMatchObject({
      status: "unknown",
      detail: expect.stringContaining("SPAMHAUS_DQS_KEY"),
    });
    // No Safe Browsing key, no Safe Browsing check; the mail stub doesn't report stats.
    expect(refused.some((c) => c.check === "safe_browsing")).toBe(false);
    expect(refused.find((c) => c.check === "mail")).toMatchObject({ status: "unknown" });
  });

  it("reads mail's deployment-wide delivery health over the binding and warns past the thresholds", async () => {
    const agent = await signup("delivery-health.test");
    const seen: { url: string; internal: string | null; account: string | null }[] = [];
    const mail = (body: unknown) =>
      ({
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const req = new Request(input, init);
          seen.push({ url: req.url, internal: req.headers.get("x-afs-internal"), account: req.headers.get("x-afs-account") });
          return Response.json(body);
        },
      }) as unknown as Fetcher;
    const bad = {
      hours: 24,
      tracking: true,
      sent: 200,
      bounced: 30,
      complained: 1,
      accounts: [{ account_id: "acct_spammer", sent: 50, bounced: 25, complained: 1 }],
    };
    const env = testEnv({ MAIL: mail(bad), OWN_ANALYTICS_ACCOUNT_ID: agent.accountId });
    const [check] = (await reputationChecks(env, fakeFetch({}))).filter((c) => c.check === "mail");
    expect(seen[0]).toEqual({ url: "https://mail.internal/v1/admin/delivery-health?hours=24", internal: TOKEN, account: agent.accountId });
    expect(check).toMatchObject({ status: "warning", detail: expect.stringContaining("30 bounced (15.0%)") });
    expect(check?.detail).toContain("worst: acct_spammer 25 bounced, 1 complaints of 50");
    const fine = await reputationChecks(testEnv({ MAIL: mail({ ...bad, bounced: 1, complained: 0, accounts: [] }) }), fakeFetch({}));
    expect(fine.find((c) => c.check === "mail")?.status).toBe("ok");
    const off = await reputationChecks(testEnv({ MAIL: mail({ ...bad, tracking: false }) }), fakeFetch({}));
    expect(off.find((c) => c.check === "mail")).toMatchObject({ status: "unknown", detail: expect.stringContaining("tracking is off") });
  });

  it("lists the day's pauses and abuse reports and flags them", async () => {
    const agent = await signup("digest-abuse.test");
    await recordCapabilityPause(E.DB, {
      accountId: agent.accountId,
      capability: "mail.inbox_create",
      reason: "40 inboxes in an hour",
      by: "mail",
    });
    await call("POST", "/v1/abuse-reports", {
      ip: nextIp(),
      json: { url_or_resource: "https://evil.test/x", kind: "malware", details: "A miner." },
    });
    const env = testEnv({ PUBLIC_BASE_URL: "https://stack.example" });
    const d = await buildDigest(env, Date.now(), { fetch: fakeFetch({}) });
    expect(d.pauses.new).toEqual(
      expect.arrayContaining([expect.objectContaining({ account_id: agent.accountId, capability: "mail.inbox_create", by: "mail" })]),
    );
    expect(d.pauses.active).toBeGreaterThanOrEqual(1);
    expect(d.abuse_reports.urgent).toBeGreaterThanOrEqual(1);
    expect(d.abuse_reports.recent.some((r) => r.target === "https://evil.test/x")).toBe(true);
    expect(d.reputation.find((r) => r.check === "spamhaus_dbl")).toMatchObject({ target: "stack.example", status: "ok" });
    expect(needsAttention(d)).toBe(true);
    const text = digestText(d, BASE).body.join("\n");
    expect(text).toContain("Capability pauses (");
    expect(text).toContain("mail.inbox_create by mail, 40 inboxes in an hour");
    expect(text).toContain("Abuse reports: ");
    expect(text).toContain("Reputation: ");
  });
});

describe("acceptable use", () => {
  it("is a page, linked from the terms, the footers, the manual and the setup prompt", async () => {
    const aup = await call("GET", "/acceptable-use");
    expect(aup.status).toBe(200);
    expect(aup.text).toContain("<h1>Acceptable Use Policy</h1>");
    for (const word of [
      "Phishing",
      "Spam",
      "Malware",
      "Account farming",
      "Scraping",
      "Illegal content",
      "Evading limits",
      "Appeal",
      'href="/report-abuse"',
    ])
      expect(aup.text).toContain(word);
    expect((await call("GET", "/terms")).text).toContain('href="/acceptable-use"');
    expect((await call("GET", "/")).text).toContain('href="/acceptable-use"');
    const manual = (await call("GET", "/llms.txt")).text;
    expect(manual).toContain("https://agentfirststack.com/acceptable-use");
    expect(manual).toContain("POST https://agentfirststack.com/v1/abuse-reports");
    expect((await call("GET", "/")).text).toContain("the Acceptable Use Policy (https://agentfirststack.com/acceptable-use)");
  });
});
