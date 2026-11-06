import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../src/env";
import { purgeExpiredInboxes } from "../../src/service/inboxes";
import { ingestRaw } from "../../src/service/ingest";
import { checkReservedNames, findReservedInboxes } from "../../src/service/reserved";
import { E, acctOf, call, claimAs, deliver, eml, hosted, mcp, signup, sleep, uniq } from "./helpers";

// One group per finding of the account-takeover review (pure parts: test/unit/takeover-pure.test.ts).

const code = (from: string, to: string, n: string, subject = "Your verification code") =>
  eml({ from, to, subject, body: `Your verification code is ${n}` });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("1a. latest-code without from cannot be fed a stranger's code silently", () => {
  it("one sender still works: sender_domain comes first, with a warning and a hint to pass from", async () => {
    const s = await signup();
    await deliver("noreply@github.com", s.inbox.address, code("noreply@github.com", s.inbox.address, "135790"));
    const lc = await call("GET", `/v1/inboxes/${s.inbox.id}/latest-code?timeout=0`, { key: s.key });
    expect(lc.status).toBe(200);
    expect(lc.json).toMatchObject({ code: "135790", sender_domain: "github.com", from: "noreply@github.com", auth_verdict: "pass" });
    const keys = Object.keys(lc.json);
    expect(keys.indexOf("sender_domain")).toBeLessThan(keys.indexOf("code"));
    expect(lc.json.warning).toMatch(/github\.com/);
    expect(lc.json.hint).toMatch(/from=github\.com/);
    // With from: no warning.
    const strict = await call("GET", `/v1/inboxes/${s.inbox.id}/latest-code?from=github.com&timeout=0`, { key: s.key });
    expect(strict.json).toMatchObject({ code: "135790", sender_domain: "github.com" });
    expect(strict.json).not.toHaveProperty("warning");
    expect(strict.json).not.toHaveProperty("hint");
  });

  it("two sender domains in the window: 409 ambiguous_sender with the candidates (REST and MCP); from picks the right one", async () => {
    const s = await signup();
    const to = s.inbox.address;
    await deliver("noreply@github.com", to, code("noreply@github.com", to, "135790"));
    await sleep(5);
    // A stranger with a domain of its own (DKIM, SPF and DMARC pass) races the real mail.
    await deliver("verify@evil.example", to, code("verify@evil.example", to, "999111", "Verify your account"));
    const lc = await call("GET", `/v1/inboxes/${s.inbox.id}/latest-code?timeout=0`, { key: s.key });
    expect(lc.status).toBe(409);
    expect(lc.json.error.code).toBe("ambiguous_sender");
    expect(lc.json.error.message).toMatch(/evil\.example/);
    expect(lc.json.error.hint).toMatch(/from=/);
    const cands = lc.json.error.details.candidates as { sender_domain: string; auth_verdict: string; message_id: string }[];
    expect(cands.map((c) => c.sender_domain)).toEqual(["evil.example", "github.com"]);
    expect(cands.every((c) => c.auth_verdict === "pass" && c.message_id.startsWith("msg_"))).toBe(true);

    const ok = await call("GET", `/v1/inboxes/${s.inbox.id}/latest-code?from=github.com&timeout=0`, { key: s.key });
    expect(ok.json).toMatchObject({ code: "135790", sender_domain: "github.com" });
    expect((await mcp(s.key, "get_latest_code", { inbox_id: s.inbox.id, timeout: 0 })).error.code).toBe("ambiguous_sender");
    expect((await mcp(s.key, "get_latest_code", { inbox_id: s.inbox.id, from: "github.com", timeout: 0 })).code).toBe("135790");
  });

  it("one site's subdomains are one sender; mail before `after`, unauthenticated mail and other tags don't count", async () => {
    const s = await signup();
    const to = s.inbox.address;
    const [user, domain] = to.split("@");
    // Unauthenticated (anyone can forge it) and to another tag: neither makes it ambiguous.
    await deliver(
      "verify@forged.example",
      to,
      eml({ from: "verify@forged.example", to, subject: "x", body: "Your verification code is 111222", auth: null }),
    );
    await deliver("noreply@slack.com", `${user}+slack@${domain}`, code("noreply@slack.com", `${user}+slack@${domain}`, "333444"));
    await sleep(5);
    await deliver("noreply@github.com", to, code("noreply@github.com", to, "135790"));
    await sleep(5);
    await deliver("noreply@mail.github.com", to, code("noreply@mail.github.com", to, "246810"));
    const tagged = await call("GET", `/v1/inboxes/${s.inbox.id}/latest-code?timeout=0&after=0&tag=slack`, { key: s.key });
    expect(tagged.json).toMatchObject({ code: "333444", sender_domain: "slack.com" });
    // Without a tag, slack.com and github.com are both in the window...
    expect((await call("GET", `/v1/inboxes/${s.inbox.id}/latest-code?timeout=0&after=0`, { key: s.key })).status).toBe(409);
    // ... but not after the slack mail: github.com and mail.github.com are one sender.
    const list = await call("GET", `/v1/inboxes/${s.inbox.id}/messages?tag=slack`, { key: s.key });
    const after = list.json.messages[0].received_at;
    const lc = await call("GET", `/v1/inboxes/${s.inbox.id}/latest-code?timeout=0&after=${after}`, { key: s.key });
    expect(lc.status).toBe(200);
    expect(lc.json).toMatchObject({ code: "246810", sender_domain: "github.com" });
    expect(lc.json.warning).toBeTruthy();
  });

  it("signup and create-inbox next steps, the MCP instructions and llms.txt all pass from", async () => {
    const s = await signup();
    expect(s.json.next_steps.join("\n")).toMatch(/latest-code\?from=/);
    const c = await call("POST", "/v1/inboxes", { key: s.key, body: { username: uniq("nx") } });
    expect(c.json.next_steps[0]).toMatch(/latest-code\?from=/);
    const llms = await call("GET", "/llms.txt");
    expect(llms.text).toMatch(/latest-code\?from=github\.com&timeout=60/);
    expect(llms.text).toMatch(/ambiguous_sender/);
    expect(llms.text).not.toMatch(/It is strict about the sender, so a forged mail cannot feed you a code/);
    const { MCP_INSTRUCTIONS } = await import("../../src/mcp");
    expect(MCP_INSTRUCTIONS).toMatch(/get_latest_code with from=/);
  });
});

describe("1b. a deleted address is never given to another account", () => {
  it("never mailed, deleted: the same 409 as a taken address for everyone else, for good; its owner can have it back", async () => {
    const a = await signup();
    const b = await signup();
    const live = uniq("live");
    const gone = uniq("gone");
    expect((await call("POST", "/v1/inboxes", { key: a.key, body: { username: live } })).status).toBe(201);
    const g = await call("POST", "/v1/inboxes", { key: a.key, body: { username: gone } });
    const del = await call("DELETE", `/v1/inboxes/${g.json.inbox.id}`, { key: a.key });
    expect(del.json).toMatchObject({ address_reserved: true });

    const taken = await call("POST", "/v1/inboxes", { key: b.key, body: { username: live } });
    const retired = await call("POST", "/v1/inboxes", { key: b.key, body: { username: gone } });
    expect([taken.status, retired.status]).toEqual([409, 409]);
    expect(JSON.stringify(retired.json).replaceAll(gone, "NAME")).toBe(JSON.stringify(taken.json).replaceAll(live, "NAME"));
    expect(retired.json.error.hint).toBeTruthy();
    // MCP answers the same; mail to it is refused like any unknown address.
    expect((await mcp(b.key, "create_inbox", { username: gone })).error.code).toBe("conflict");
    expect((await deliver("x@sender.example", g.json.inbox.address, code("x@sender.example", g.json.inbox.address, "1234"))).rejected).toBe(
      "Address does not exist",
    );
    // Its old account gets it back.
    expect((await call("POST", "/v1/inboxes", { key: a.key, body: { username: gone } })).status).toBe(201);
  });

  it("an inbox that expired (ttl_days) before any mail arrived is retired too", async () => {
    const a = await signup();
    const b = await signup();
    const name = uniq("ttl");
    const c = await call("POST", "/v1/inboxes", { key: a.key, body: { username: name, ttl_days: 1 } });
    await E.DB.prepare("UPDATE inboxes SET expires_at = 1 WHERE id = ?").bind(c.json.inbox.id).run();
    await purgeExpiredInboxes(E);
    expect((await call("GET", `/v1/inboxes/${c.json.inbox.id}`, { key: a.key })).status).toBe(404);
    const t = await E.DB.prepare("SELECT account_id, permanent FROM address_tombstones WHERE address = ?")
      .bind(c.json.inbox.address)
      .first();
    expect(t).toEqual({ account_id: acctOf(a), permanent: 1 });
    expect((await call("POST", "/v1/inboxes", { key: b.key, body: { username: name } })).status).toBe(409);
    expect((await call("POST", "/v1/inboxes", { key: a.key, body: { username: name } })).status).toBe(201);
  });
});

describe("1c. role and platform names are reserved; inboxes that already have one are found, not deleted", () => {
  it("refuses the new built-in names and their look-alike spellings (400 with a hint)", async () => {
    const s = await signup();
    for (const u of ["notifications", "No.Reply", "post_master", "Billing", "dmarc", "signups", "verify", "official"]) {
      const r = await call("POST", "/v1/inboxes", { key: s.key, body: { username: u } });
      expect(r.status, u).toBe(400);
      expect(r.json.error.hint, u).toMatch(/Pick another username/);
    }
  });

  it("a name reserved later: its inbox keeps working and a retried create returns it; nobody else can create it; the cron and the operator route list it", async () => {
    const a = await signup();
    const b = await signup();
    const name = uniq("brand");
    const created = await call("POST", "/v1/inboxes", { key: a.key, body: { username: name } });
    expect(created.status).toBe(201);
    const env = hosted({ EXTRA_RESERVED_USERNAMES: `othername, ${name.toUpperCase()}`, ADMIN_TOKEN: "op-secret" } as Partial<AppEnv>);

    const again = await call("POST", "/v1/inboxes", { key: a.key, env, body: { username: name } });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ existing: true, inbox: { id: created.json.inbox.id } });
    expect((await call("POST", "/v1/inboxes", { key: b.key, env, body: { username: name } })).status).toBe(400);
    expect(
      (await deliver("x@sender.example", created.json.inbox.address, code("x@sender.example", created.json.inbox.address, "5555"), env))
        .rejected,
    ).toBeNull();

    const found = await findReservedInboxes(env);
    expect(found.inboxes.map((i) => i.address)).toContain(created.json.inbox.address);
    expect(found.inboxes.find((i) => i.address === created.json.inbox.address)).toMatchObject({
      inbox_id: created.json.inbox.id,
      account_id: acctOf(a),
    });

    // The cron scans when the list changed, logs, and stays quiet until it changes again.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await checkReservedNames(env);
    expect(first).toMatchObject({ reserved_check: "scanned" });
    expect((first as { reserved_conflicts: number }).reserved_conflicts).toBeGreaterThanOrEqual(1);
    const logged = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("mail.reserved_conflicts"));
    expect(logged).toContain(created.json.inbox.address);
    expect(await checkReservedNames(env)).toEqual({ reserved_check: "unchanged" });
    expect((await checkReservedNames(hosted({ EXTRA_RESERVED_USERNAMES: name }))).reserved_check).toBe("scanned");

    // The operator route: x-admin-token required, lists, changes nothing.
    const path = "/v1/admin/reserved-inboxes?limit=1000";
    expect((await call("GET", path, { key: a.key, env })).status).toBe(403);
    expect((await call("GET", path, { key: a.key, env, headers: { "x-admin-token": "wrong" } })).status).toBe(403);
    const op = await call("GET", path, { key: a.key, env, headers: { "x-admin-token": "op-secret" } });
    expect(op.status).toBe(200);
    expect(op.json.inboxes.map((i: { address: string }) => i.address)).toContain(created.json.inbox.address);
    expect(op.json.next_steps[0]).toMatch(/nothing was changed/);
    expect((await call("GET", `/v1/inboxes/${created.json.inbox.id}`, { key: a.key })).status).toBe(200);
  });
});

describe("2e. one sender cannot fill an account's storage", () => {
  const MiB = 1024 * 1024;
  /** A plain-text message of about `bytes` (76-character lines). */
  const big = (from: string, to: string, bytes: number, subject = "big") =>
    eml({ from, to, subject, body: `${"x".repeat(74)}\r\n`.repeat(Math.ceil(bytes / 76)) });
  const sizeOf = (raw: string) => new TextEncoder().encode(raw).byteLength;
  const usage = (key: string, env: AppEnv) => call("GET", "/v1/usage", { key, env }).then((r) => r.json.limits);

  it("MAX_INBOUND_BYTES_PER_SENDER_PER_DAY caps one sender across the account's inboxes (UNCLAIMED_ until claimed); refused mail is refunded", async () => {
    const s = await signup();
    const second = (await call("POST", "/v1/inboxes", { key: s.key, body: { username: uniq("second") } })).json.inbox;
    const one = big("a@flood.example", s.inbox.address, 2000, "m1");
    const size = sizeOf(one);
    const env = hosted({
      MAX_INBOUND_BYTES_PER_SENDER_PER_DAY: "1000000",
      UNCLAIMED_MAX_INBOUND_BYTES_PER_SENDER_PER_DAY: String(2 * size + 100),
    });
    expect((await deliver("a@flood.example", s.inbox.address, one, env)).rejected).toBeNull();
    expect((await deliver("a@flood.example", second.address, big("a@flood.example", second.address, 2000, "m2"), env)).rejected).toBeNull();
    const third = await deliver("b@flood.example", second.address, big("b@flood.example", second.address, 2000, "m3"), env);
    expect(third.rejected).toMatch(/^Too much mail from flood\.example to the account behind .* at most [0-9.]+ KB a day from one sender/);
    // Another sender is not affected.
    expect(
      (await deliver("jane@partner.example", s.inbox.address, code("jane@partner.example", s.inbox.address, "4242"), env)).rejected,
    ).toBeNull();
    const u = await usage(s.key, env);
    expect(u.inbound_bytes_per_sender_per_day).toMatchObject({ limit: 2 * size + 100, var: "MAX_INBOUND_BYTES_PER_SENDER_PER_DAY" });
    expect(u.inbound_bytes_per_sender_per_day.used).toBeGreaterThanOrEqual(2 * size - 100);
    // Claimed: the claimed budget applies.
    await claimAs(acctOf(s), `owner-${uniq("o")}@example.com`);
    expect((await deliver("b@flood.example", second.address, big("b@flood.example", second.address, 2000, "m4"), env)).rejected).toBeNull();

    // A message refused after the headers (its raw fits, raw + HTML does not) gives its bytes back.
    const t = await signup();
    const msg = eml({ from: "a@refund.example", to: t.inbox.address, subject: "html", body: "plain", html: `<p>${"h".repeat(4000)}</p>` });
    const tight = hosted({
      MAX_INBOUND_BYTES_PER_SENDER_PER_DAY: "1000000",
      UNCLAIMED_MAX_BLOB_BYTES_PER_ACCOUNT: String(sizeOf(msg) + 10),
    });
    expect((await deliver("a@refund.example", t.inbox.address, msg, tight)).rejected).toMatch(/^Mailbox full/);
    const row = await E.DB.prepare(
      "SELECT COALESCE(SUM(bytes), 0) AS b, COALESCE(SUM(count), 0) AS n FROM sender_counters WHERE account_id = ?",
    )
      .bind(acctOf(t))
      .first();
    expect(row).toEqual({ b: 0, n: 0 });
  });

  it("unclaimed accounts take smaller messages (MAX_INBOUND_MESSAGE_BYTES, default 10 MiB), refused from the SMTP size", async () => {
    const s = await signup();
    expect((await usage(s.key, E)).inbound_message_bytes).toMatchObject({ limit: 10 * MiB, var: "MAX_INBOUND_MESSAGE_BYTES" });
    const env = hosted({ UNCLAIMED_MAX_INBOUND_MESSAGE_BYTES: "2000" });
    const msg = big("a@one.example", s.inbox.address, 3000);
    const r = await deliver("a@one.example", s.inbox.address, msg, env);
    expect(r.rejected).toBe(`Message too large: ${s.inbox.address} accepts messages up to 2 KB`);
    // The same limit holds when ingest is called directly (internal deliveries).
    const direct = await ingestRaw(env, { envelopeFrom: "a@one.example", envelopeTo: s.inbox.address, raw: new TextEncoder().encode(msg) });
    expect(direct).toEqual({ status: "rejected", reason: `Message too large: ${s.inbox.address} accepts messages up to 2 KB` });
    await claimAs(acctOf(s), `owner-${uniq("o")}@example.com`);
    expect((await deliver("a@one.example", s.inbox.address, msg, env)).rejected).toBeNull();
    expect((await usage(s.key, env)).inbound_message_bytes.limit).toBe(25 * MiB);
  });

  it("a nearly full account refuses its heaviest sender's large mail, keeps the last 5% for small mail, and small mail still arrives", async () => {
    const s = await signup();
    const to = s.inbox.address;
    const env = hosted({ UNCLAIMED_MAX_BLOB_BYTES_PER_ACCOUNT: String(10 * MiB), MAX_INBOUND_PER_SENDER_PER_DAY: "100" });
    // One sender fills 70% with 1 MiB messages (allowed: nobody is near full yet).
    for (let i = 0; i < 7; i++)
      expect((await deliver("a@flood.example", to, big("a@flood.example", to, MiB, `f${i}`), env)).rejected, `f${i}`).toBeNull();
    const kept = await E.DB.prepare("SELECT blob_bytes FROM sender_usage WHERE account_id = ? AND sender_key = 'flood.example'")
      .bind(acctOf(s))
      .first<{ blob_bytes: number }>();
    const sum = await E.DB.prepare("SELECT SUM(blob_bytes) AS b FROM messages WHERE account_id = ? AND sender_key = 'flood.example'")
      .bind(acctOf(s))
      .first<{ b: number }>();
    expect(kept?.blob_bytes).toBe(sum?.b);
    // Its 8th would pass 80%, and it keeps far more than 10%: refused, before its allowance is spent.
    const eighth = await deliver("a@flood.example", to, big("a@flood.example", to, MiB, "f7"), env);
    expect(eighth.rejected).toMatch(/^Mailbox nearly full: much of what the account behind .* keeps is mail from flood\.example/);
    const counted = await E.DB.prepare("SELECT SUM(count) AS n FROM sender_counters WHERE account_id = ? AND sender = 'flood.example'")
      .bind(acctOf(s))
      .first<{ n: number }>();
    expect(counted?.n).toBe(7);
    // Its small mail still arrives, and so do other senders' larger messages, up to the last 5%.
    expect((await deliver("a@flood.example", to, code("a@flood.example", to, "7070"), env)).rejected).toBeNull();
    const light = [1, 2, 3, 4].map((n) => `x@light${n}.example`);
    for (const from of light) expect((await deliver(from, to, big(from, to, 600 * 1024, from), env)).rejected, from).toBeNull();
    const fifth = await deliver("x@light5.example", to, big("x@light5.example", to, 600 * 1024), env);
    expect(fifth.rejected).toMatch(/^Mailbox nearly full: the account behind .* keeps its last [0-9.]+ KB for messages up to 256 KB/);
    // The verification code still gets through, and latest-code finds it.
    expect((await deliver("noreply@github.com", to, code("noreply@github.com", to, "135790"), env)).rejected).toBeNull();
    expect((await call("GET", `/v1/inboxes/${s.inbox.id}/latest-code?from=github.com&timeout=0`, { key: s.key, env })).json.code).toBe(
      "135790",
    );
    // A wait that times out says why larger mail may be missing.
    const w = await call("GET", `/v1/inboxes/${s.inbox.id}/wait?from=nobody-sends-this&timeout=0`, { key: s.key, env });
    expect(w.json.error.hint).toMatch(/NOTE: this account keeps .* of its 10 MB of mail storage/);
    // Deleting the flood's mail gives its share back.
    const { messages } = (await call("GET", `/v1/inboxes/${s.inbox.id}/messages?from=flood.example&limit=100`, { key: s.key })).json;
    for (const m of messages) await call("DELETE", `/v1/messages/${m.id}`, { key: s.key });
    const after = await E.DB.prepare("SELECT blob_bytes FROM sender_usage WHERE account_id = ? AND sender_key = 'flood.example'")
      .bind(acctOf(s))
      .first();
    expect(after).toBeNull();
    expect((await deliver("a@flood.example", to, big("a@flood.example", to, MiB, "again"), env)).rejected).toBeNull();
  });
});
