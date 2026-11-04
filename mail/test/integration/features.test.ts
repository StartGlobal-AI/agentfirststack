import { toBase64 } from "@afs/shared";
import { describe, expect, it } from "vitest";
import { receivedEventData } from "../../src/service/ingest";
import quotedReply from "../fixtures/quoted-reply.eml?raw";
import { E, acctOf, call, claimAs, deliver, eml, hosted, mcp, signup, uniq } from "./helpers";

// The mail feature build, P1 (docs/parity/mail.md "Prioritised build list").

const sendBody = (to: string | string[], extra: Record<string, unknown> = {}) => ({ to, subject: "Hello", text: "Hi there", ...extra });
const outRows = async (inboxId: string) =>
  (await E.DB.prepare("SELECT id FROM messages WHERE inbox_id = ? AND direction = 'out'").bind(inboxId).all()).results.length;

describe("1. send idempotency (Idempotency-Key)", () => {
  it("a retry with the same key and body replays the first response: one email, one stored copy, one quota unit", async () => {
    const s = await signup();
    const key = crypto.randomUUID();
    const headers = { "idempotency-key": key };
    const first = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, { key: s.key, body: sendBody("x@example.org"), headers });
    expect(first.status).toBe(201);
    const again = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, { key: s.key, body: sendBody("x@example.org"), headers });
    expect(again.status).toBe(200);
    expect(again.json.idempotent_replay).toBe(true);
    expect(again.json.message.id).toBe(first.json.message.id);
    expect(await outRows(s.inbox.id)).toBe(1);
    const usage = await call("GET", "/v1/usage", { key: s.key });
    expect(usage.json.limits.sends_per_day.used).toBe(1);

    const other = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, { key: s.key, body: sendBody("y@example.org"), headers });
    expect(other.status).toBe(409);
    expect(other.json.error.code).toBe("idempotency_conflict");
    // The same key on another route (reply) is another request too.
    const reply = await call("POST", `/v1/messages/${first.json.message.id}/reply`, { key: s.key, body: { text: "x" }, headers });
    expect(reply.json.error.code).toBe("idempotency_conflict");
    expect(
      (
        await call("POST", `/v1/inboxes/${s.inbox.id}/send`, {
          key: s.key,
          body: sendBody("x@example.org"),
          headers: { "idempotency-key": "bad key" },
        })
      ).status,
    ).toBe(400);
  });

  it("a send that fails releases the key; MCP takes idempotency_key", async () => {
    const s = await signup();
    const key = crypto.randomUUID();
    const many = Array.from({ length: 7 }, (_, i) => `r${i}@example.org`); // SEND_DAILY_LIMIT is 6 in tests
    const over = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, {
      key: s.key,
      body: sendBody(many),
      headers: { "idempotency-key": key },
    });
    expect(over.status).toBe(429);
    const ok = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, {
      key: s.key,
      body: sendBody("x@example.org"),
      headers: { "idempotency-key": key },
    });
    expect(ok.status).toBe(201);

    const k2 = crypto.randomUUID();
    const a = await mcp(s.key, "send_email", { inbox_id: s.inbox.id, ...sendBody("z@example.org"), idempotency_key: k2 });
    const b = await mcp(s.key, "send_email", { inbox_id: s.inbox.id, ...sendBody("z@example.org"), idempotency_key: k2 });
    expect(b.idempotent_replay).toBe(true);
    expect(b.message.id).toBe(a.message.id);
    expect(await outRows(s.inbox.id)).toBe(2);
  });
});

describe("2. reply_only exemptions: the account's own inboxes and its members", () => {
  const env = hosted({ SHARED_SEND_POLICY: "reply_only" });

  it("own inboxes are delivered internally (authenticated, with tag); strangers are refused with a claim hint", async () => {
    const s = await signup();
    const other = await call("POST", "/v1/inboxes", { key: s.key, body: { username: uniq("peer") } });
    const [user, domain] = other.json.inbox.address.split("@");
    const r = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, {
      key: s.key,
      body: sendBody(`${user}+test@${domain}`, { subject: "Your login code", text: "Your login code is 551234" }),
      env,
    });
    expect(r.status).toBe(201);
    expect(r.json.provider_message_id).toBeNull(); // nothing went through Email Service
    expect(r.json.internal).toEqual([expect.objectContaining({ status: "delivered", inbox_id: other.json.inbox.id })]);
    const got = await call("GET", `/v1/inboxes/${other.json.inbox.id}/latest-code?after=0&timeout=0&tag=test&from=${s.inbox.address}`, {
      key: s.key,
    });
    expect(got.json).toMatchObject({ code: "551234", auth_verdict: "pass", tag: "test" });
    // The answer back is allowed too, and threads.
    const back = await call("POST", `/v1/messages/${got.json.message_id}/reply`, { key: s.key, body: { text: "thanks" }, env });
    expect(back.status).toBe(201);
    expect(back.json.internal[0].status).toBe("delivered");

    const stranger = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, { key: s.key, body: sendBody("nobody@example.org"), env });
    expect(stranger.status).toBe(403);
    expect(stranger.json.error.code).toBe("reply_only");
    expect(stranger.json.error.hint).toMatch(/claim-link/);
    // Every recipient counts toward the daily limit, internal ones too.
    expect((await call("GET", "/v1/usage", { key: s.key })).json.limits.sends_per_day.used).toBe(2);
  });

  it("members' Google-verified emails are allowed; DEV_MODE sign-ins only on a DEV_MODE deployment", async () => {
    const s = await signup();
    const person = `${uniq("owner")}@people.example`;
    const devPerson = `${uniq("dev")}@people.example`;
    await claimAs(acctOf(s), person);
    await claimAs(acctOf(s), devPerson, `dev:${devPerson}`);
    const ok = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, { key: s.key, body: sendBody(person.toUpperCase()), env });
    expect(ok.status).toBe(201);
    expect(ok.json.provider_message_id).toBeTruthy();
    const dev = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, { key: s.key, body: sendBody(devPerson), env });
    expect(dev.status).toBe(403);
    expect(dev.json.error.hint).not.toMatch(/nobody has claimed/);
    expect(
      (
        await call("POST", `/v1/inboxes/${s.inbox.id}/send`, {
          key: s.key,
          body: sendBody(devPerson),
          env: hosted({ SHARED_SEND_POLICY: "reply_only", DEV_MODE: "true" }),
        })
      ).status,
    ).toBe(201);
  });
});

describe("3. plus-address tags", () => {
  it("are stored, shown and filter list, wait and latest-code", async () => {
    const s = await signup();
    const [user, domain] = s.inbox.address.split("@");
    for (const t of ["github", "stripe"])
      await deliver(
        `noreply@${t}.example`,
        `${user}+${t}@${domain}`,
        eml({
          from: `noreply@${t}.example`,
          to: `${user}+${t}@${domain}`,
          subject: `Your ${t} code`,
          body: `Your verification code is ${t === "github" ? "111222" : "333444"}`,
        }),
      );
    const list = await call("GET", `/v1/inboxes/${s.inbox.id}/messages?tag=github`, { key: s.key });
    expect(list.json.messages.map((m: { tag: string }) => m.tag)).toEqual(["github"]);
    const w = await call("GET", `/v1/inboxes/${s.inbox.id}/wait?after=0&timeout=0&tag=STRIPE`, { key: s.key });
    expect(w.json.message.tag).toBe("stripe");
    const lc = await call("GET", `/v1/inboxes/${s.inbox.id}/latest-code?after=0&timeout=0&tag=github`, { key: s.key });
    expect(lc.json.code).toBe("111222");
    const none = await call("GET", `/v1/inboxes/${s.inbox.id}/latest-code?after=0&timeout=0&tag=nope`, { key: s.key });
    expect(none.status).toBe(408);
    expect(none.json.error.details.filters.tag).toBe("nope");
    const m = await mcp(s.key, "list_messages", { inbox_id: s.inbox.id, tag: "stripe" });
    expect(m.messages.map((x: { tag: string }) => x.tag)).toEqual(["stripe"]);
  });
});

describe("4. reply_text", () => {
  it("is on the message, the wait result and webhook data; MCP fences it first", async () => {
    const s = await signup();
    const raw = quotedReply.replaceAll("acme-signups@mail.example.com", s.inbox.address);
    await deliver("jane@partner.example", s.inbox.address, raw);
    const w = await call("GET", `/v1/inboxes/${s.inbox.id}/wait?after=0&timeout=0`, { key: s.key });
    const expected = "Thanks, Thursday at 3pm works for us. I'll send an invite.\n\nJane";
    expect(w.json.message.reply_text).toBe(expected);
    expect(w.json.untrusted.fields).toContain("message.reply_text");
    const full = await call("GET", `/v1/messages/${w.json.message.id}`, { key: s.key });
    expect(full.json.message.reply_text).toBe(expected);
    expect(full.json.message.text).toContain("449120");
    const tool = await mcp(s.key, "get_message", { message_id: w.json.message.id });
    expect(Object.keys(tool.message.untrusted)).toEqual(["notice", "from_name", "subject", "preview", "reply_text", "text"]);
    expect(tool.message.untrusted.reply_text).toMatch(/^<<<UNTRUSTED_EMAIL_REPLY_[a-z0-9]+\nThanks, Thursday/);
    const row = await E.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(w.json.message.id).first<any>();
    const inbox = await E.DB.prepare("SELECT * FROM inboxes WHERE id = ?").bind(s.inbox.id).first<any>();
    const data = receivedEventData(inbox, row, [], JSON.parse(row.auth_json));
    expect(data.message.reply_text).toBe(expected);
    expect(data.message.text_excerpt).toContain("449120");
    expect(data.untrusted.fields).toContain("data.message.reply_text");
  });

  it("a message without quoted history stores no extra copy (reply_text = text)", async () => {
    const s = await signup();
    await deliver(
      "a@sender.example",
      s.inbox.address,
      eml({ from: "a@sender.example", to: s.inbox.address, subject: "hi", body: "Just one line." }),
    );
    const row = await E.DB.prepare("SELECT reply_text, text_body FROM messages WHERE inbox_id = ?").bind(s.inbox.id).first<any>();
    expect(row.reply_text).toBeNull();
    const w = await call("GET", `/v1/inboxes/${s.inbox.id}/wait?after=0&timeout=0`, { key: s.key });
    expect(w.json.message.reply_text).toBe("Just one line.");
  });
});

describe("5. forward", () => {
  async function withAttachment(s: { inbox: { address: string } }) {
    const raw = [
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=sender.example; dmarc=pass header.from=sender.example",
      "From: Ann <ann@sender.example>",
      `To: ${s.inbox.address}`,
      "Subject: Q3 report",
      `Message-ID: <${crypto.randomUUID()}@sender.example>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "Report attached.",
      "--b",
      'Content-Type: application/pdf; name="q3.pdf"',
      "Content-Disposition: attachment",
      "Content-Transfer-Encoding: base64",
      "",
      toBase64(new TextEncoder().encode("%PDF-1.4 fake")),
      "--b--",
      "",
    ].join("\r\n");
    await deliver("ann@sender.example", s.inbox.address, raw);
  }

  it("sends Fwd: with the quoted original and its attachments; include_attachments=false leaves them", async () => {
    const s = await signup();
    await withAttachment(s);
    const orig = (await call("GET", `/v1/inboxes/${s.inbox.id}/messages`, { key: s.key })).json.messages[0];
    const f = await call("POST", `/v1/messages/${orig.id}/forward`, { key: s.key, body: { to: "boss@example.org", text: "FYI" } });
    expect(f.status).toBe(201);
    expect(f.json.message.subject).toBe("Fwd: Q3 report");
    expect(f.json.message.thread_id).toBe(orig.thread_id);
    expect(f.json.forwarded).toEqual({ message_id: orig.id, attachments_included: 1, attachments_skipped: 0 });
    const out = await call("GET", `/v1/messages/${f.json.message.id}`, { key: s.key });
    expect(out.json.message.text).toMatch(/^FYI\n\n---------- Forwarded message ---------\nFrom: Ann <ann@sender\.example>/);
    expect(out.json.message.text).toContain("Report attached.");
    expect(out.json.message.reply_text).toBe("FYI");
    expect(out.json.message.attachments.map((a: { filename: string }) => a.filename)).toEqual(["q3.pdf"]);
    const bare = await mcp(s.key, "forward_message", { message_id: orig.id, to: "boss@example.org", include_attachments: false });
    expect(bare.forwarded.attachments_included).toBe(0);
    expect(bare.message.attachment_count).toBe(0);
  });

  it("follows the send rules: reply_only refuses strangers, own inboxes get it internally with the attachment", async () => {
    const env = hosted({ SHARED_SEND_POLICY: "reply_only" });
    const s = await signup();
    await withAttachment(s);
    const orig = (await call("GET", `/v1/inboxes/${s.inbox.id}/messages`, { key: s.key })).json.messages[0];
    const no = await call("POST", `/v1/messages/${orig.id}/forward`, { key: s.key, body: { to: "boss@example.org" }, env });
    expect(no.json.error.code).toBe("reply_only");
    // Ann wrote first, so forwarding back to her is fine.
    expect((await call("POST", `/v1/messages/${orig.id}/forward`, { key: s.key, body: { to: "ann@sender.example" }, env })).status).toBe(
      201,
    );
    const peer = await call("POST", "/v1/inboxes", { key: s.key, body: { username: uniq("peer") } });
    const f = await call("POST", `/v1/messages/${orig.id}/forward`, { key: s.key, body: { to: peer.json.inbox.address }, env });
    expect(f.json.internal[0].status).toBe("delivered");
    const got = await call("GET", `/v1/messages/${f.json.internal[0].message_id}`, { key: s.key });
    expect(got.json.message.subject).toBe("Fwd: Q3 report");
    expect(got.json.message.attachments.map((a: { filename: string }) => a.filename)).toEqual(["q3.pdf"]);
    const dl = await call("GET", got.json.message.attachments[0].download, { key: s.key });
    expect(dl.text).toBe("%PDF-1.4 fake");
    expect((await call("POST", `/v1/messages/${orig.id}/forward`, { key: s.key, body: {} })).status).toBe(400);
  });
});

describe("6. GET /v1/usage and get_usage", () => {
  it("lists every cap with used / limit / resets_at, with the UNCLAIMED_ value until claimed", async () => {
    const s = await signup();
    const env = hosted({ UNCLAIMED_SEND_DAILY_LIMIT: "2", MAX_INBOXES_PER_ACCOUNT: "10", UNCLAIMED_MAX_INBOXES_PER_ACCOUNT: "3" });
    const u = await call("GET", "/v1/usage", { key: s.key, env });
    expect(u.status).toBe(200);
    expect(u.json.claimed).toBe(false);
    expect(u.json.limits.sends_per_day).toMatchObject({ used: 0, limit: 2, remaining: 2, var: "SEND_DAILY_LIMIT" });
    expect(u.json.limits.sends_per_day.resets_at).toBe(u.json.resets_at);
    expect(u.json.limits.inboxes).toMatchObject({ used: 1, limit: 3, resets_at: null });
    expect(u.json.limits.storage_bytes.limit).toBe(256 * 1024 * 1024); // the code default for unclaimed accounts
    expect(u.json.limits.inbound_per_day.limit).toBeNull(); // not configured here = no cap
    expect(u.json.next_steps.join(" ")).toMatch(/claim-link/);
    await claimAs(acctOf(s), `${uniq("p")}@people.example`);
    const after = await mcp(s.key, "get_usage", {}, env);
    expect(after.claimed).toBe(true);
    expect(after.limits.sends_per_day.limit).toBe(6);
    expect(after.limits.inboxes.limit).toBe(10);
  });
});

describe("7. Retry-After on mail's 429s", () => {
  it("daily limits say when 00:00 UTC is; rate limits say the window", async () => {
    const s = await signup();
    const many = Array.from({ length: 7 }, (_, i) => `r${i}@example.org`);
    const r = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, { key: s.key, body: sendBody(many) });
    expect(r.status).toBe(429);
    const secs = Number(r.headers.get("retry-after"));
    expect(secs).toBe(r.json.error.details.retry_after_s);
    expect(secs).toBeGreaterThan(0);
    expect(secs).toBeLessThanOrEqual(86_400);
    const limited = hosted({ WAIT_LIMITER: { limit: async () => ({ success: false }) } as unknown as RateLimit });
    const w = await call("GET", `/v1/inboxes/${s.inbox.id}/wait?timeout=0`, { key: s.key, env: limited });
    expect(w.status).toBe(429);
    expect(w.headers.get("retry-after")).toBe("60");
    // Other errors carry none.
    expect((await call("GET", "/v1/inboxes/inb_nope", { key: s.key })).headers.get("retry-after")).toBeNull();
  });
});

describe("8. list filters", () => {
  it("after, to, subject, has, auth, order=asc with next_after, also on search", async () => {
    const s = await signup();
    const at = (n: number) => Date.UTC(2026, 10, 3, 10, 0, n);
    const { ingestRaw } = await import("../../src/service/ingest");
    const mails = [
      { from: "a@one.example", subject: "Welcome aboard", body: "hello there friend" },
      { from: "b@two.example", subject: "Your code", body: "Your verification code is 772211" },
      { from: "c@three.example", subject: "Forged code", body: "Your verification code is 998877", auth: null },
    ];
    for (const [i, m] of mails.entries()) {
      const raw = new TextEncoder().encode(eml({ ...m, to: s.inbox.address }));
      expect((await ingestRaw(E, { envelopeFrom: m.from, envelopeTo: s.inbox.address, raw }, at(i))).status).toBe("stored");
    }
    const q = (qs: string) => call("GET", `/v1/inboxes/${s.inbox.id}/messages?${qs}`, { key: s.key }).then((r) => r.json);
    const subjects = (j: any) => j.messages.map((m: { subject: string }) => m.subject);
    expect(subjects(await q("has=code"))).toEqual(["Forged code", "Your code"]);
    expect(subjects(await q("has=code&auth=pass"))).toEqual(["Your code"]);
    expect(subjects(await q("auth=unknown"))).toEqual(["Forged code"]);
    expect(subjects(await q("subject=welcome"))).toEqual(["Welcome aboard"]);
    expect(subjects(await q(`to=${s.inbox.address.split("@")[0]}`))).toHaveLength(3);
    expect(subjects(await q(`after=${at(0)}`))).toEqual(["Forged code", "Your code"]);
    const p1 = await q("order=asc&limit=2");
    expect(subjects(p1)).toEqual(["Welcome aboard", "Your code"]);
    expect(p1.next_before).toBeNull();
    const p2 = await q(`order=asc&limit=2&after=${p1.next_after}`);
    expect(subjects(p2)).toEqual(["Forged code"]);
    expect(p2.next_after).toBeNull();
    expect((await q("has=spam")).error.code).toBe("bad_request");
    const search = await call("GET", "/v1/search?q=verification&auth=pass", { key: s.key });
    expect(subjects(search.json)).toEqual(["Your code"]);
    const tool = await mcp(s.key, "search_messages", { q: "verification", order: "asc" });
    expect(tool.messages.map((m: { untrusted: { subject: string } }) => m.untrusted.subject)).toEqual(["Your code", "Forged code"]);
  });
});
