import { forgetPauses } from "@afs/shared";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../src/env";
import { handleQueue } from "../../src/index";
import { E, call, hosted, mcp, signup, uniq } from "./helpers";

// Automatic capability pauses (src/service/pauses.ts): mail.send on bounce/complaint rates,
// mail.inbox_create on a burst of creation attempts. Tests have no site Worker (SITE answers 503),
// so a pause is written to AUTH_DB directly, as when the site can't be reached.

type Signed = Awaited<ReturnType<typeof signup>>;
const acct = (s: Signed) => s.json.account_id as string;

const pauseOf = (accountId: string, capability: string) =>
  E.AUTH_DB!.prepare("SELECT * FROM capability_pauses WHERE account_id = ? AND capability = ? AND lifted_at IS NULL")
    .bind(accountId, capability)
    .first<{ reason: string; paused_by: string; until: number | null; details: string }>();

async function lift(accountId: string, capability: string) {
  await E.AUTH_DB!.prepare("UPDATE capability_pauses SET lifted_at = ?, lifted_by = 'operator' WHERE account_id = ? AND capability = ?")
    .bind(Date.now() - 48 * 3_600_000, accountId, capability)
    .run();
  forgetPauses(accountId);
}

async function feed(env: AppEnv, ...bodies: unknown[]) {
  const st = bodies.map(() => ({ acked: false, retried: false }));
  const messages = bodies.map((body, i) => ({
    id: crypto.randomUUID(),
    timestamp: new Date(),
    attempts: 1,
    body,
    ack: () => void (st[i]!.acked = true),
    retry: () => void (st[i]!.retried = true),
  }));
  await handleQueue({ queue: "afs-mail-webhooks", messages, ackAll() {}, retryAll() {} } as never, env);
  return st;
}

const event = (type: string, messageId: string, recipient: string) => ({
  type: `cf.email.sending.message.${type}`,
  source: { type: "email.sending", domain: "mail.example.com" },
  payload: {
    eventId: crypto.randomUUID(),
    messageId,
    recipient,
    terminal: true,
    bounce: type === "bounced" ? { type: "hard" } : undefined,
  },
  metadata: { eventTimestamp: new Date().toISOString() },
});

const RCPTS = ["a@example.org", "b@example.org", "c@example.org", "d@example.org"];

async function sendTo(s: Signed, env: AppEnv, to: string | string[] = RCPTS) {
  const r = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, { key: s.key, env, body: { to, subject: "Hello", text: "Hi" } });
  return r;
}

const base = { DELIVERY_EVENTS_QUEUE: "afs-mail-webhooks", SEND_DAILY_LIMIT: "50", SEND_PAUSE_MIN_SENDS: "4" };

describe("mail.send auto-pause on bounces and complaints", () => {
  it("pauses once the last hour's bounce rate passes the threshold; own inboxes still work; usage shows it", async () => {
    const env = hosted({ ...base, SEND_PAUSE_BOUNCE_PERCENT: "25" });
    const s = await signup();
    const m = await sendTo(s, env);
    expect(m.status).toBe(201);
    const pid = m.json.provider_message_id as string;

    // 1 of 4 = 25%: not above the limit.
    expect((await feed(env, event("bounced", pid, RCPTS[0]!)))[0]).toMatchObject({ acked: true, retried: false });
    expect(await pauseOf(acct(s), "mail.send")).toBeNull();
    expect((await sendTo(s, env, "e@example.org")).status).toBe(201);

    // 2 of 5 = 40%: paused, by mail, until the operator lifts it.
    await feed(env, event("bounced", pid, RCPTS[1]!));
    const p = await pauseOf(acct(s), "mail.send");
    expect(p).toMatchObject({ paused_by: "mail", until: null });
    expect(p!.reason).toMatch(/2 of the 5 recipients .* bounced \(40%, above the 25% limit\)/);
    expect(JSON.parse(p!.details)).toMatchObject({ sent: 5, bounced: 2, bounce_percent_limit: 25, min_sends: 4 });

    const refused = await sendTo(s, env, "f@example.org");
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("capability_paused");
    expect(refused.json.error.hint).toMatch(/bounced/);
    expect(refused.json.error.details).toMatchObject({ capability: "mail.send", paused_by: "mail" });
    // Scheduling to an outsider is refused too; reply/forward share the same check.
    const later = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, {
      key: s.key,
      env,
      body: { to: "g@example.org", subject: "Later", text: "x", send_at: Date.now() + 3_600_000 },
    });
    expect(later.json.error.code).toBe("capability_paused");
    // MCP answers the same error.
    const viaMcp = await mcp(s.key, "send_email", { inbox_id: s.inbox.id, to: "h@example.org", subject: "x", text: "y" }, env).catch(
      (e: Error) => e.message,
    );
    expect(JSON.stringify(viaMcp)).toMatch(/capability_paused|paused/);

    // Mail to the account's own inboxes never leaves the Worker: still allowed.
    const other = await call("POST", "/v1/inboxes", { key: s.key, env, body: { username: uniq("own") } });
    expect((await sendTo(s, env, other.json.inbox.address)).status).toBe(201);

    const u = await call("GET", "/v1/usage", { key: s.key, env });
    expect(u.json.paused).toEqual([expect.objectContaining({ capability: "mail.send", paused_by: "mail" })]);
    expect(u.json.send_health).toMatchObject({
      window_s: 3600,
      sent: 5,
      bounced: 2,
      auto_pause: { bounce_percent_above: 25, min_sends: 4 },
    });
    expect(u.json.next_steps.join(" ")).toMatch(/mail\.send is paused/);

    // Lifted by the operator: sending works again.
    await lift(acct(s), "mail.send");
    expect((await sendTo(s, env, "i@example.org")).status).toBe(201);
  });

  it("complaints have their own threshold", async () => {
    const env = hosted({ ...base, SEND_PAUSE_COMPLAINT_PERCENT: "10" });
    const s = await signup();
    const pid = (await sendTo(s, env)).json.provider_message_id as string;
    await feed(env, event("delivered", pid, RCPTS[0]!), event("complained", pid, RCPTS[0]!));
    const p = await pauseOf(acct(s), "mail.send");
    expect(p!.reason).toMatch(/1 of the 4 recipients .* reported it as spam \(25%, above the 10% limit\)/);
    expect((await sendTo(s, env, "z@example.org")).json.error.code).toBe("capability_paused");
  });

  it("needs the minimum number of sends, uses UNCLAIMED_ values, and is off when unset", async () => {
    // Under the minimum: 2 of 2 bounced, nothing paused.
    const few = await signup();
    const envFew = hosted({ ...base, SEND_PAUSE_BOUNCE_PERCENT: "10" });
    const pidFew = (await sendTo(few, envFew, RCPTS.slice(0, 2))).json.provider_message_id as string;
    await feed(envFew, event("bounced", pidFew, RCPTS[0]!), event("bounced", pidFew, RCPTS[1]!));
    expect(await pauseOf(acct(few), "mail.send")).toBeNull();

    // Unclaimed accounts read UNCLAIMED_SEND_PAUSE_*: a stricter minimum applies to them.
    const envU = hosted({ ...base, SEND_PAUSE_BOUNCE_PERCENT: "10", UNCLAIMED_SEND_PAUSE_MIN_SENDS: "2" });
    const u = await signup();
    const pidU = (await sendTo(u, envU, RCPTS.slice(0, 2))).json.provider_message_id as string;
    await feed(envU, event("bounced", pidU, RCPTS[0]!));
    expect(await pauseOf(acct(u), "mail.send")).not.toBeNull();

    // No thresholds set: every recipient bounces, nothing is paused.
    const off = await signup();
    const envOff = hosted({ DELIVERY_EVENTS_QUEUE: "afs-mail-webhooks", SEND_DAILY_LIMIT: "50" });
    const pidOff = (await sendTo(off, envOff)).json.provider_message_id as string;
    await feed(envOff, ...RCPTS.map((r) => event("bounced", pidOff, r)));
    expect(await pauseOf(acct(off), "mail.send")).toBeNull();
    expect((await sendTo(off, envOff, "x@example.org")).status).toBe(201);
  });

  it("asks the site over the SITE binding when it is there (internal auth), with the numbers", async () => {
    const seen: { url: string; headers: Headers; body: any }[] = [];
    const SITE = {
      fetch: async (url: string, init: RequestInit) => {
        seen.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
        return Response.json({ paused: true, notify: true });
      },
    } as unknown as Fetcher;
    const env = hosted({ ...base, SEND_PAUSE_BOUNCE_PERCENT: "25", SITE, INTERNAL_TOKEN: "internal-secret" } as Partial<AppEnv>);
    const s = await signup();
    const pid = (await sendTo(s, env)).json.provider_message_id as string;
    await feed(env, event("bounced", pid, RCPTS[0]!), event("bounced", pid, RCPTS[1]!));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://site.internal/v1/internal/pauses");
    expect(seen[0]!.headers.get("x-afs-internal")).toBe("internal-secret");
    expect(seen[0]!.body).toMatchObject({
      account_id: acct(s),
      capability: "mail.send",
      paused_by: "mail",
      details: { sent: 4, bounced: 2 },
    });
  });

  it("the operator reads the deployment's rates; nobody else can", async () => {
    const env = hosted({ ...base, ADMIN_TOKEN: "op-secret" } as Partial<AppEnv>);
    const s = await signup();
    const pid = (await sendTo(s, env)).json.provider_message_id as string;
    await feed(env, event("bounced", pid, RCPTS[0]!), event("delivered", pid, RCPTS[1]!));
    expect((await call("GET", "/v1/admin/delivery-health", { key: s.key, env })).status).toBe(403);
    const r = await call("GET", "/v1/admin/delivery-health?hours=1", { key: s.key, env, headers: { "x-admin-token": "op-secret" } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ hours: 1, tracking: true });
    expect(r.json.bounced).toBeGreaterThanOrEqual(1);
    expect(r.json.accounts.find((a: { account_id: string }) => a.account_id === acct(s))).toMatchObject({
      sent: 4,
      bounced: 1,
      bounce_percent: 25,
    });
  });
});

describe("mail.inbox_create auto-pause on a creation burst", () => {
  it("defaults to 3 x MAX_INBOX_CREATES_PER_DAY attempts an hour, counting refused ones; owned addresses still return", async () => {
    const env = hosted({ MAX_INBOX_CREATES_PER_DAY: "2" });
    const s = await signup();
    const names = [uniq("b1"), uniq("b2")];
    for (const n of names) expect((await call("POST", "/v1/inboxes", { key: s.key, env, body: { username: n } })).status).toBe(201);
    // Attempts 3-6 hit the daily cap (429); the 7th passes 6 an hour and pauses.
    for (let i = 0; i < 4; i++) expect((await call("POST", "/v1/inboxes", { key: s.key, env, body: {} })).status).toBe(429);
    const seventh = await call("POST", "/v1/inboxes", { key: s.key, env, body: {} });
    expect(seventh.status).toBe(403);
    expect(seventh.json.error).toMatchObject({ code: "capability_paused", details: { capability: "mail.inbox_create" } });
    const p = await pauseOf(acct(s), "mail.inbox_create");
    expect(p!.reason).toMatch(/tried to create 7 inboxes within one hour, more than the 6/);
    expect(JSON.parse(p!.details)).toMatchObject({ attempts_this_hour: 7, burst_limit: 6, daily_limit: 2 });

    // Rule 7: an address the account owns is still returned (nothing is created).
    const again = await call("POST", "/v1/inboxes", { key: s.key, env, body: { username: names[0] } });
    expect(again.status).toBe(200);
    expect(again.json.existing).toBe(true);
    expect((await call("POST", "/v1/inboxes", { key: s.key, env, body: { username: uniq("new") } })).json.error.code).toBe(
      "capability_paused",
    );
    // The rest of mail keeps working.
    expect((await call("GET", "/v1/inboxes", { key: s.key, env })).status).toBe(200);
    expect((await call("GET", "/v1/usage", { key: s.key, env })).json.paused[0]).toMatchObject({ capability: "mail.inbox_create" });
  });

  it("an explicit (UNCLAIMED_) limit; taken addresses count; '0' turns it off", async () => {
    const owner = await signup();
    const takenName = uniq("taken");
    expect((await call("POST", "/v1/inboxes", { key: owner.key, body: { username: takenName } })).status).toBe(201);

    const env = hosted({ INBOX_CREATE_BURST_PER_HOUR: "100", UNCLAIMED_INBOX_CREATE_BURST_PER_HOUR: "2" });
    const s = await signup();
    expect((await call("POST", "/v1/inboxes", { key: s.key, env, body: { username: uniq("ok") } })).status).toBe(201);
    expect((await call("POST", "/v1/inboxes", { key: s.key, env, body: { username: takenName } })).status).toBe(409);
    const third = await call("POST", "/v1/inboxes", { key: s.key, env, body: {} });
    expect(third.json.error.code).toBe("capability_paused");

    const offEnv = hosted({ MAX_INBOX_CREATES_PER_DAY: "1", INBOX_CREATE_BURST_PER_HOUR: "0" });
    const o = await signup();
    for (let i = 0; i < 8; i++) await call("POST", "/v1/inboxes", { key: o.key, env: offEnv, body: {} });
    expect(await pauseOf(acct(o), "mail.inbox_create")).toBeNull();
    expect((await call("POST", "/v1/inboxes", { key: o.key, env: offEnv, body: {} })).json.error.code).toBe("daily_limit");
  });

  it("a pause the operator set is honoured by MCP create_inbox too", async () => {
    const s = await signup();
    await E.AUTH_DB!.prepare(
      "INSERT INTO capability_pauses (account_id, capability, reason, paused_at, paused_by) VALUES (?, 'mail.inbox_create', 'a test', ?, 'operator')",
    )
      .bind(acct(s), Date.now())
      .run();
    forgetPauses(acct(s));
    const r = await mcp(s.key, "create_inbox", { username: uniq("m") }).catch((e: Error) => e.message);
    expect(JSON.stringify(r)).toMatch(/capability_paused|paused/);
  });
});

describe("attachment text budget", () => {
  it("a conversion that throws still counts (one account can't loop on the deployment's AI)", async () => {
    const { deliver } = await import("./helpers");
    const s = await signup();
    const raw = [
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=sender.example; dmarc=pass header.from=sender.example",
      "From: a@sender.example",
      `To: ${s.inbox.address}`,
      "Subject: doc",
      `Message-ID: <${crypto.randomUUID()}@sender.example>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "attached",
      "--b",
      'Content-Type: application/pdf; name="x.pdf"',
      "Content-Disposition: attachment",
      "Content-Transfer-Encoding: base64",
      "",
      btoa("%PDF-1.4 fake"),
      "--b--",
      "",
    ].join("\r\n");
    await deliver("a@sender.example", s.inbox.address, raw);
    const msg = (await call("GET", `/v1/inboxes/${s.inbox.id}/messages`, { key: s.key })).json.messages[0];
    const pdf = (await call("GET", `/v1/messages/${msg.id}`, { key: s.key })).json.message.attachments[0];
    let calls = 0;
    const AI = {
      toMarkdown: async () => {
        calls++;
        throw new Error("AI exploded");
      },
    } as unknown as Ai;
    const env = hosted({ AI, UNCLAIMED_MAX_ATTACHMENT_TEXT_PER_DAY: "1" });
    expect((await call("GET", `/v1/messages/${msg.id}/attachments/${pdf.id}/text`, { key: s.key, env })).status).toBe(500);
    const second = await call("GET", `/v1/messages/${msg.id}/attachments/${pdf.id}/text`, { key: s.key, env });
    expect(second.status).toBe(429);
    expect(calls).toBe(1);
  });
});

describe("llms.txt", () => {
  it("documents automatic pauses with this deployment's thresholds", async () => {
    const env = hosted({
      SEND_PAUSE_BOUNCE_PERCENT: "20",
      SEND_PAUSE_COMPLAINT_PERCENT: "5",
      UNCLAIMED_SEND_PAUSE_MIN_SENDS: "5",
      MAX_INBOX_CREATES_PER_DAY: "20",
      UNCLAIMED_MAX_INBOX_CREATES_PER_DAY: "10",
    });
    const t = (await call("GET", "/llms.txt", { env })).text;
    expect(t).toContain("### Automatic pauses");
    expect(t).toContain("capability_paused");
    expect(t).toContain(
      "sending is paused on bounces > 20% or complaints > 5% of the last hour's recipients (at least 10) (unclaimed: paused on bounces > 20% or complaints > 5% of the last hour's recipients (at least 5))",
    );
    expect(t).toContain(
      "inbox creation is paused past 60 creation attempts in an hour (unclaimed: paused past 30 creation attempts in an hour)",
    );
    expect((await call("GET", "/llms.txt")).text).toContain(
      "sending is never paused (unclaimed: never paused); inbox creation is never paused (unclaimed: never paused)",
    );
  });
});
