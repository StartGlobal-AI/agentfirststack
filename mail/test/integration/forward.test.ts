import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { forgetStanding } from "@afs/shared";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../src/env";
import worker, { app } from "../../src/index";
import { FORWARD_GRACE_MS, forwardEach, runForwards } from "../../src/service/forward";
import { E, acctOf, call, claimAs, deliver, eml, hosted, mcp, signup, sleep, uniq } from "./helpers";

// Forwarding an inbox's mail to the project's members (src/service/forward.ts; pure parts in
// test/unit/forward-pure.test.ts). Every test uses its own account and member addresses, and reads
// only the sends addressed to its own members, since the cron walks every inbox in the database.

interface Sent {
  from: { email: string; name: string } | string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: unknown[];
}

function spyEnv(vars: Partial<AppEnv> = {}) {
  const sent: Sent[] = [];
  const env = hosted({
    AUTH_ISSUER: "https://platform.example",
    EMAIL: {
      send: async (m: Sent) => {
        sent.push(m);
        return { messageId: `<spy-${sent.length}@mail.example.com>` };
      },
    } as unknown as SendEmail,
    ...vars,
  });
  return { env, sent, to: (addr: string) => sent.filter((m) => m.to.includes(addr)) };
}

const member = () => `${uniq("owner")}@people.example`;

async function setup(forward?: Record<string, unknown>, opts: { members?: number } = {}) {
  const s = await signup();
  const emails = Array.from({ length: opts.members ?? 0 }, member);
  for (const e of emails) await claimAs(acctOf(s), e);
  if (forward) {
    const r = await call("PATCH", `/v1/inboxes/${s.inbox.id}`, { key: s.key, body: { forward } });
    expect(r.status).toBe(200);
  }
  return { ...s, account: acctOf(s), emails };
}

const queued = async (inboxId: string) =>
  (await E.DB.prepare("SELECT COUNT(*) AS n FROM forward_queue WHERE inbox_id = ?").bind(inboxId).first<{ n: number }>())?.n ?? 0;

const mail = (to: string, subject = "Verify your email", extra: Partial<Parameters<typeof eml>[0]> = {}) =>
  eml({ from: "noreply@github.com", to, subject, body: `Your verification code is 482913.\n\nThanks, GitHub`, ...extra });

describe("inbox JSON: forward", () => {
  it("every inbox response carries the forward block, with member counts and never their addresses", async () => {
    const s = await signup();
    expect(s.json.inbox.forward).toEqual({
      mode: "off",
      digest_hour: 8,
      timezone: "UTC",
      recipients: 0,
      waiting_for_owner: false,
      last_forwarded_at: null,
      last_digest_at: null,
      forwarded_today: 0,
      daily_limit: 100,
    });
    const owner = member();
    await claimAs(acctOf(s), owner);
    const responses = [
      await call("GET", "/v1/inboxes", { key: s.key }),
      await call("GET", `/v1/inboxes/${s.inbox.id}`, { key: s.key }),
      await call("POST", "/v1/inboxes", { key: s.key, body: { username: uniq("fwd"), forward: { mode: "each" } } }),
      await call("PATCH", `/v1/inboxes/${s.inbox.id}`, { key: s.key, body: { forward: { mode: "digest" } } }),
    ];
    for (const r of responses) {
      expect(r.status).toBeLessThan(300);
      expect(r.text).not.toContain(owner);
      expect(r.text).not.toContain("people.example");
    }
    expect(responses[0]!.json.inboxes[0].forward.recipients).toBe(1);
    expect(responses[1]!.json.inbox.forward).toMatchObject({ mode: "off", recipients: 1, waiting_for_owner: false });
    expect(responses[2]!.status).toBe(201);
    expect(responses[2]!.json.inbox.forward).toMatchObject({ mode: "each", recipients: 1 });
    expect(responses[3]!.json.inbox.forward).toMatchObject({ mode: "digest", digest_hour: 8, timezone: "UTC" });
    const mcpList = await mcp(s.key, "list_inboxes", {});
    expect(JSON.stringify(mcpList)).not.toContain(owner);
    const usage = await call("GET", "/v1/usage", { key: s.key });
    expect(usage.json.limits.forwards_per_day).toMatchObject({ used: 0, limit: 100, var: "MAX_FORWARDS_PER_ACCOUNT_PER_DAY" });
    expect(usage.text).not.toContain(owner);
  });

  it("create and PATCH: partial updates merge, bad values are 400 with a hint, waiting_for_owner until claimed", async () => {
    const s = await signup();
    const created = await call("POST", "/v1/inboxes", {
      key: s.key,
      body: { username: uniq("shop"), forward: { mode: "digest", digest_hour: 7, timezone: "europe/berlin" } },
    });
    expect(created.status).toBe(201);
    const id = created.json.inbox.id;
    expect(created.json.inbox.forward).toMatchObject({
      mode: "digest",
      digest_hour: 7,
      timezone: "Europe/Berlin",
      waiting_for_owner: true,
    });
    expect(created.json.next_steps.join(" ")).toMatch(/claim-link/);

    const each = await call("PATCH", `/v1/inboxes/${id}`, { key: s.key, body: { forward: { mode: "each" } } });
    expect(each.json.inbox.forward).toMatchObject({ mode: "each", digest_hour: 7, timezone: "Europe/Berlin" });
    expect(each.json.next_steps.length).toBeGreaterThan(0);
    const hour = await call("PATCH", `/v1/inboxes/${id}`, { key: s.key, body: { forward: { digest_hour: 21 } } });
    expect(hour.json.inbox.forward).toMatchObject({ mode: "each", digest_hour: 21, timezone: "Europe/Berlin" });
    // Other fields leave forward alone.
    const renamed = await call("PATCH", `/v1/inboxes/${id}`, { key: s.key, body: { display_name: "Shop" } });
    expect(renamed.json.inbox.forward).toMatchObject({ mode: "each", digest_hour: 21 });
    expect(renamed.json.next_steps).toBeUndefined();

    const badTz = await call("PATCH", `/v1/inboxes/${id}`, { key: s.key, body: { forward: { timezone: "Mars/Olympus_Mons" } } });
    expect(badTz.status).toBe(400);
    expect(badTz.json.error.hint).toMatch(/IANA time zone/);
    expect((await call("PATCH", `/v1/inboxes/${id}`, { key: s.key, body: { forward: { digest_hour: 24 } } })).status).toBe(400);
    expect((await call("PATCH", `/v1/inboxes/${id}`, { key: s.key, body: { forward: { mode: "weekly" } } })).status).toBe(400);
    const badCreate = await call("POST", "/v1/inboxes", { key: s.key, body: { username: uniq("bad"), forward: { timezone: "Nowhere" } } });
    expect(badCreate.status).toBe(400);
    // Unchanged by the refused calls.
    expect((await call("GET", `/v1/inboxes/${id}`, { key: s.key })).json.inbox.forward).toMatchObject({ mode: "each", digest_hour: 21 });

    // An address you already own: returned as it is, its setting kept (retries are safe).
    const again = await call("POST", "/v1/inboxes", {
      key: s.key,
      body: { username: created.json.inbox.username, forward: { mode: "off" } },
    });
    expect(again.status).toBe(200);
    expect(again.json.inbox.forward.mode).toBe("each");
    expect(again.json.next_steps.join(" ")).toMatch(/already existed/);

    // MCP: the same tools take forward.
    const viaMcp = await mcp(s.key, "update_inbox", { inbox_id: id, forward: { mode: "digest", timezone: "Asia/Tokyo" } });
    expect(viaMcp.inbox.forward).toMatchObject({ mode: "digest", digest_hour: 21, timezone: "Asia/Tokyo" });
    const mcpCreate = await mcp(s.key, "create_inbox", { username: uniq("mcp"), forward: { mode: "each" } });
    expect(mcpCreate.inbox.forward.mode).toBe("each");
  });

  it("the site's dashboard (internal auth) can PATCH it like a full-access key", async () => {
    const s = await signup();
    const env = hosted({ INTERNAL_TOKEN: "internal-test-token" } as Partial<AppEnv>);
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`https://mail.internal/v1/inboxes/${s.inbox.id}`, {
        method: "PATCH",
        headers: { "x-afs-internal": "internal-test-token", "x-afs-account": acctOf(s), "content-type": "application/json" },
        body: JSON.stringify({ forward: { mode: "digest", digest_hour: 18 } }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).inbox.forward).toMatchObject({ mode: "digest", digest_hour: 18 });
    // The wrong token is refused.
    const bad = await app.fetch(
      new Request(`https://mail.internal/v1/inboxes/${s.inbox.id}`, {
        method: "PATCH",
        headers: { "x-afs-internal": "nope", "x-afs-account": acctOf(s), "content-type": "application/json" },
        body: JSON.stringify({ forward: { mode: "off" } }),
      }),
      env,
      createExecutionContext(),
    );
    expect(bad.status).toBe(401);
  });
});

describe("mode each", () => {
  it("forwards an inbound email to every member, one email each, from the inbox, outside SEND_DAILY_LIMIT", async () => {
    const s = await setup({ mode: "each" }, { members: 2 });
    const { env, sent, to } = spyEnv();
    const state = await deliver(
      "noreply@github.com",
      s.inbox.address,
      mail(s.inbox.address, "Verify your email", { html: "<p onclick='x()'>Your code is <b>482913</b></p><script>steal()</script>" }),
      env,
    );
    expect(state.rejected).toBeNull();
    expect(sent.filter((m) => s.emails.some((e) => m.to.includes(e)))).toHaveLength(2);
    for (const e of s.emails) {
      const [m] = to(e);
      expect(m!.to).toEqual([e]); // never the other member
      expect(m!.from).toEqual({ email: s.inbox.address, name: `${s.inbox.address} via AgentFirstStack` });
      expect(m!.replyTo).toBeUndefined();
      expect(m!.subject).toBe(`[${s.inbox.address}] Verify your email`);
      expect(m!.headers?.["X-AFS-Forwarded"]).toMatch(/^msg_/);
      expect(m!.text).toContain("---------- Forwarded message ---------");
      expect(m!.text).toContain("From: Sender <noreply@github.com>");
      expect(m!.text).toContain("Your verification code is 482913.");
      expect(m!.text).toContain(
        `Forwarded by AgentFirstStack from ${s.inbox.address} (project ${s.account}) to the project's members. To get a daily digest instead or stop: ask your agent, or open https://platform.example/dashboard/projects/${s.account}.`,
      );
      expect(m!.html).toContain("<b>482913</b>");
      expect(m!.html).not.toMatch(/onclick|<script/);
    }
    expect(await queued(s.inbox.id)).toBe(0);

    const inbox = (await call("GET", `/v1/inboxes/${s.inbox.id}`, { key: s.key, env })).json.inbox;
    expect(inbox.forward).toMatchObject({ mode: "each", recipients: 2, forwarded_today: 2 });
    expect(inbox.forward.last_forwarded_at).toBeGreaterThan(0);
    const usage = (await call("GET", "/v1/usage", { key: s.key, env })).json.limits;
    expect(usage.forwards_per_day.used).toBe(2);
    expect(usage.sends_per_day.used).toBe(0);
    // Nothing stored as sent mail (it would show the members' addresses).
    const msgs = (await call("GET", `/v1/inboxes/${s.inbox.id}/messages`, { key: s.key })).json.messages;
    expect(msgs.map((m: { direction: string }) => m.direction)).toEqual(["in"]);
    // message.forwarded: counts only.
    const ev = await call("GET", "/v1/events?types=message.forwarded", { key: s.key });
    expect(ev.json.events).toHaveLength(1);
    expect(ev.json.events[0].data).toMatchObject({ kind: "each", messages: 1, recipients: 2, inbox: { id: s.inbox.id } });
    for (const e of s.emails) expect(ev.text).not.toContain(e);
    // A second call does nothing (the queue row is gone).
    expect((await forwardEach(env, msgs[0].id)).status).toBe("not_queued");
  });

  it("forwards machine notices (Auto-Submitted: auto-generated): codes and password resets carry it", async () => {
    const s = await setup({ mode: "each" }, { members: 1 });
    const { env, to } = spyEnv();
    const state = await deliver(
      "noreply@github.com",
      s.inbox.address,
      mail(s.inbox.address, "Reset your password", { headers: ["Auto-Submitted: auto-generated"] }),
      env,
    );
    expect(state.rejected).toBeNull();
    expect(to(s.emails[0]!)).toHaveLength(1);
    expect(to(s.emails[0]!)[0]!.subject).toBe(`[${s.inbox.address}] Reset your password`);
  });

  it("never forwards unauthenticated mail, the setup test, bounces, auto-replies, its own forwards, members' or own inboxes' mail", async () => {
    const s = await setup({ mode: "each" }, { members: 1 });
    const { env, to } = spyEnv();
    const a = s.inbox.address;
    const [user, dom] = a.split("@");
    const deliveries: [string, string, string][] = [
      [
        "noreply@github.com",
        a,
        mail(a, "forged", { auth: "mx.cloudflare.net; dkim=none; spf=fail smtp.mailfrom=noreply@github.com; dmarc=fail" }),
      ],
      ["noreply@github.com", a, mail(a, "no auth", { auth: null })],
      ["noreply@github.com", `${user}+afs-test@${dom}`, mail(`${user}+afs-test@${dom}`, "setup test")],
      ["", a, eml({ from: "mailer-daemon@mx.example", to: a, subject: "Undelivered", body: "bounce" })],
      ["noreply@github.com", a, mail(a, "Out of office", { headers: ["Auto-Submitted: auto-replied"] })],
      ["noreply@github.com", a, mail(a, "our own forward", { headers: ["X-AFS-Forwarded: msg_123"] })],
      [s.emails[0]!, a, eml({ from: s.emails[0]!, to: a, subject: "Re: [x] reply from the owner", body: "thanks" })],
    ];
    for (const [from, rcpt, raw] of deliveries) expect((await deliver(from, rcpt, raw, env)).rejected, raw.slice(0, 200)).toBeNull();
    // The account's other inbox writes to this one (internal delivery).
    const other = await call("POST", "/v1/inboxes", { key: s.key, body: { username: uniq("other") } });
    const internal = await call("POST", `/v1/inboxes/${other.json.inbox.id}/send`, {
      key: s.key,
      env,
      body: { to: a, subject: "internal", text: "hi" },
    });
    expect(internal.json.internal[0].status).toBe("delivered");
    expect(to(s.emails[0]!)).toHaveLength(0);
    // Only the owner's own mail was queued (dropped when its turn came); the rest never was.
    expect(await queued(s.inbox.id)).toBe(0);
    await runForwards(env, Date.now() + FORWARD_GRACE_MS + 60_000);
    expect(to(s.emails[0]!)).toHaveLength(0);
    // The messages are all there for the agent.
    expect((await call("GET", `/v1/inboxes/${s.inbox.id}`, { key: s.key })).json.inbox.message_count).toBe(deliveries.length + 1);
  });

  it("nothing before anyone claims the project; then one catch-up digest; then each email again", async () => {
    const s = await setup({ mode: "each" });
    const { env, sent, to } = spyEnv();
    await deliver("noreply@github.com", s.inbox.address, mail(s.inbox.address, "First"), env);
    await deliver(
      "noreply@stripe.com",
      s.inbox.address,
      eml({ from: "noreply@stripe.com", to: s.inbox.address, subject: "Second", body: "Receipt" }),
      env,
    );
    expect((await call("GET", `/v1/inboxes/${s.inbox.id}`, { key: s.key })).json.inbox.forward).toMatchObject({
      recipients: 0,
      waiting_for_owner: true,
      last_forwarded_at: null,
    });
    expect(await queued(s.inbox.id)).toBe(2);
    const later = Date.now() + FORWARD_GRACE_MS + 60_000;
    await runForwards(env, later);
    expect(sent.filter((m) => m.subject.includes(s.inbox.address))).toHaveLength(0); // still nobody to send to

    const owner = member();
    await claimAs(s.account, owner);
    await runForwards(env, later);
    const [digest, ...rest] = to(owner);
    expect(rest).toHaveLength(0);
    expect(digest!.subject).toBe(`2 new emails at ${s.inbox.address}`);
    expect(digest!.text).toContain("before anyone claimed the project. From now on each email is forwarded as it arrives.");
    expect(digest!.text!.indexOf("Second")).toBeLessThan(digest!.text!.indexOf("First")); // newest first
    expect(digest!.text).toContain("Code: 482913");
    expect(digest!.headers?.["X-AFS-Forwarded"]).toBe(`digest ${s.inbox.id}`);
    expect(await queued(s.inbox.id)).toBe(0);
    // A cron retry sends nothing more.
    await runForwards(env, later);
    expect(to(owner)).toHaveLength(1);
    const inbox = (await call("GET", `/v1/inboxes/${s.inbox.id}`, { key: s.key })).json.inbox.forward;
    expect(inbox).toMatchObject({ recipients: 1, waiting_for_owner: false });
    expect(inbox.last_digest_at).toBe(later);

    await deliver("noreply@github.com", s.inbox.address, mail(s.inbox.address, "Third"), env);
    expect(to(owner).map((m) => m.subject)).toEqual([`2 new emails at ${s.inbox.address}`, `[${s.inbox.address}] Third`]);
  });

  it("past MAX_FORWARDS_PER_ACCOUNT_PER_DAY it pauses; the rest goes into a digest the next day, with a note", async () => {
    const s = await setup({ mode: "each" }, { members: 1 });
    const owner = s.emails[0]!;
    const { env, to } = spyEnv({ MAX_FORWARDS_PER_ACCOUNT_PER_DAY: "2" });
    for (const subject of ["One", "Two", "Three"])
      await deliver("noreply@github.com", s.inbox.address, mail(s.inbox.address, subject), env);
    expect(to(owner).map((m) => m.subject)).toEqual([`[${s.inbox.address}] One`, `[${s.inbox.address}] Two`]);
    expect(await queued(s.inbox.id)).toBe(1);
    const fwd = (await call("GET", `/v1/inboxes/${s.inbox.id}`, { key: s.key, env })).json.inbox.forward;
    expect(fwd).toMatchObject({ forwarded_today: 2, daily_limit: 2 });

    // Later today: still over the budget, nothing goes out.
    const soon = Date.now() + FORWARD_GRACE_MS + 60_000;
    const res = await runForwards(env, soon);
    expect(res.forward_paused).toBeGreaterThanOrEqual(1);
    expect(to(owner)).toHaveLength(2);
    // The next day's first cron: one digest of what is left, saying why.
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 17, 0, 0);
    await runForwards(env, Math.max(tomorrow.getTime(), soon));
    const digest = to(owner)[2]!;
    expect(digest.subject).toBe(`1 new email at ${s.inbox.address}`);
    expect(digest.text).toContain("Three");
    expect(digest.text).toMatch(/Forwarding paused on \d{4}-\d\d-\d\d \(UTC\) at the project's daily limit of 2 forwarded emails/);
    expect(await queued(s.inbox.id)).toBe(0);
    // SEND_DAILY_LIMIT never moved.
    expect((await call("GET", "/v1/usage", { key: s.key, env })).json.limits.sends_per_day.used).toBe(0);
  });

  it("attachments go along (a broken Content-ID becomes a plain attachment)", async () => {
    const s = await setup({ mode: "each" }, { members: 1 });
    const { env, to } = spyEnv();
    const raw = [
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=stripe.com; spf=pass smtp.mailfrom=receipts@stripe.com; dmarc=pass header.from=stripe.com",
      "From: Stripe <receipts@stripe.com>",
      `To: ${s.inbox.address}`,
      "Subject: Your receipt",
      `Message-ID: <${crypto.randomUUID()}@stripe.com>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="m"',
      "",
      "--m",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Receipt attached.",
      "--m",
      'Content-Type: application/pdf; name="receipt.pdf"',
      'Content-Disposition: attachment; filename="receipt.pdf"',
      "Content-ID: <bad id with spaces>",
      "Content-Transfer-Encoding: base64",
      "",
      btoa("%PDF-1.4 receipt"),
      "--m--",
      "",
    ].join("\r\n");
    await deliver("receipts@stripe.com", s.inbox.address, raw, env);
    const [m] = to(s.emails[0]!);
    expect(m!.subject).toBe(`[${s.inbox.address}] Your receipt`);
    expect(m!.text).toContain("Receipt attached.");
    expect(m!.attachments).toHaveLength(1);
    expect(m!.attachments![0]).toMatchObject({ filename: "receipt.pdf", type: "application/pdf", disposition: "attachment" });
  });

  it("turning forwarding off drops what was waiting; suspended accounts forward nothing", async () => {
    const s = await setup({ mode: "each" });
    const { env } = spyEnv();
    await deliver("noreply@github.com", s.inbox.address, mail(s.inbox.address), env);
    expect(await queued(s.inbox.id)).toBe(1);
    await call("PATCH", `/v1/inboxes/${s.inbox.id}`, { key: s.key, body: { forward: { mode: "off" } } });
    expect(await queued(s.inbox.id)).toBe(0);

    const t = await setup({ mode: "each" }, { members: 1 });
    const spy = spyEnv();
    await E.AUTH_DB!.prepare("UPDATE accounts SET suspended_at = ?, suspended_reason = 'test' WHERE id = ?")
      .bind(Date.now(), t.account)
      .run();
    forgetStanding(t.account);
    await deliver("noreply@github.com", t.inbox.address, mail(t.inbox.address), spy.env); // refused at SMTP time
    expect(spy.to(t.emails[0]!)).toHaveLength(0);
  });
});

describe("mode digest", () => {
  it("the scheduled handler sends one digest per member at digest_hour in the inbox's time zone, once a day", async () => {
    // Tokyo is UTC+9 all year: its local hour is the UTC hour + 9.
    const tokyoHour = (ms: number) => (new Date(ms).getUTCHours() + 9) % 24;
    const hour = tokyoHour(Date.now());
    const s = await setup({ mode: "digest", digest_hour: hour, timezone: "Asia/Tokyo" }, { members: 2 });
    const { env, to } = spyEnv();
    await deliver("noreply@github.com", s.inbox.address, mail(s.inbox.address, "Your code"), env);
    await deliver(
      "noreply@example.com",
      s.inbox.address,
      eml({ from: "noreply@example.com", to: s.inbox.address, subject: "Unauthenticated", body: "x", auth: null }),
      env,
    );
    await deliver(
      "noreply@stripe.com",
      s.inbox.address,
      eml({ from: "noreply@stripe.com", to: s.inbox.address, subject: "Receipt", body: "Paid" }),
      env,
    );
    for (const e of s.emails) expect(to(e)).toHaveLength(0); // nothing is forwarded on its own

    // The cron runs at one pinned instant (its scheduledTime), after the mail arrived; the digest
    // hour follows it, so the test can't straddle an hour boundary.
    const at = Date.now() + 1;
    if (tokyoHour(at) !== hour)
      expect(
        (await call("PATCH", `/v1/inboxes/${s.inbox.id}`, { key: s.key, body: { forward: { digest_hour: tokyoHour(at) } } })).status,
      ).toBe(200);
    const cron = async () => {
      const ctx = createExecutionContext();
      await worker.scheduled({ cron: "17 * * * *", scheduledTime: at, noRetry() {} } as ScheduledController, env, ctx);
      await waitOnExecutionContext(ctx);
    };
    await cron();
    for (const e of s.emails) {
      const got = to(e);
      expect(got).toHaveLength(1);
      expect(got[0]!.to).toEqual([e]);
      expect(got[0]!.subject).toBe(`2 new emails at ${s.inbox.address}`);
      expect(got[0]!.text).toContain("Code: 482913");
      expect(got[0]!.text).toMatch(/Received: \w{3} \d{4}-\d\d-\d\d \d\d:\d\d Asia\/Tokyo/);
      expect(got[0]!.text).toContain("Not listed: 1 email that failed sender authentication");
      expect(got[0]!.text).not.toContain("Unauthenticated");
      expect(got[0]!.text).toContain("To get each email as it arrives instead, change the time or stop");
    }
    // A retry, or new mail later the same day: no second digest until tomorrow.
    await cron();
    await deliver("noreply@github.com", s.inbox.address, mail(s.inbox.address, "Later"), env);
    await cron();
    for (const e of s.emails) expect(to(e)).toHaveLength(1);
    expect(await queued(s.inbox.id)).toBe(1);
    const fwd = (await call("GET", `/v1/inboxes/${s.inbox.id}`, { key: s.key, env })).json.inbox.forward;
    expect(fwd.last_digest_at).toBeGreaterThan(0);
    expect(fwd.forwarded_today).toBe(2);
    const ev = await call("GET", "/v1/events?types=message.forwarded", { key: s.key });
    expect(ev.json.events[0].data).toMatchObject({ kind: "digest", messages: 2, recipients: 2 });
  });

  it("a digest inbox claimed after mail arrived gets the catch-up digest at once, whatever the hour", async () => {
    const offHour = (new Date().getUTCHours() + 12) % 24;
    const s = await setup({ mode: "digest", digest_hour: offHour, timezone: "UTC" });
    const { env, to } = spyEnv();
    await deliver("noreply@github.com", s.inbox.address, mail(s.inbox.address, "Before the claim"), env);
    await sleep(5);
    const owner = member();
    await claimAs(s.account, owner);
    await runForwards(env);
    expect(to(owner).map((m) => m.subject)).toEqual([`1 new email at ${s.inbox.address}`]);
    expect(to(owner)[0]!.text).toMatch(/before anyone claimed the project\. From now on you get one digest a day at \d\d:00 \(UTC\)/);
    // Then the normal schedule: new mail waits for the digest hour.
    await deliver("noreply@github.com", s.inbox.address, mail(s.inbox.address, "After"), env);
    await runForwards(env);
    expect(to(owner)).toHaveLength(1);
    // Deleting the message takes it out of the queue too.
    const msgs = (await call("GET", `/v1/inboxes/${s.inbox.id}/messages`, { key: s.key })).json.messages;
    expect(await queued(s.inbox.id)).toBe(1);
    await call("DELETE", `/v1/messages/${msgs[0].id}`, { key: s.key });
    expect(await queued(s.inbox.id)).toBe(0);
  });
});

describe("docs", () => {
  it("llms.txt documents forwarding, the inbox fields and the budget", async () => {
    const txt = (await call("GET", "/llms.txt")).text;
    expect(txt).toContain("## Forward to the owner");
    for (const f of [
      "waiting_for_owner",
      "digest_hour",
      "forwarded_today",
      "last_digest_at",
      "MAX_FORWARDS_PER_ACCOUNT_PER_DAY",
      "message.forwarded",
    ])
      expect(txt, f).toContain(f);
  });
});
