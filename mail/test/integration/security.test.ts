import { hmacSha256Hex } from "@afs/shared";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AppEnv, WebhookJob } from "../../src/env";
import { parkOnInbox } from "../../src/lib/park";
import { app } from "../../src/index";
import { addDomain, ownershipToken, verifyDomain } from "../../src/service/domains";
import { createInbox, getInboxRow, purgeExpiredInboxes, purgeOldSharedMessages } from "../../src/service/inboxes";
import { MAX_TEXT_BYTES, ingestRaw } from "../../src/service/ingest";
import { assertReplyOnly } from "../../src/service/send";
import { waitForEmail } from "../../src/service/wait";
import { createWebhook, deliverBatch, emitEvent } from "../../src/service/webhooks";
import quotedReply from "../fixtures/quoted-reply.eml?raw";
import { E, call, deliver, eml, hosted, signup } from "./helpers";

// One test group per finding of the pre-open-source security review.

async function errorOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { status: number; code: string; message: string; hint?: string; details?: any };
  }
  throw new Error("expected the call to fail");
}

const uniq = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;
const acctOf = (s: { json: { account_id: string } }) => s.json.account_id;

async function mcp(key: string, name: string, args: unknown, opts: { env?: AppEnv; headers?: Record<string, string> } = {}) {
  const res = await app.fetch(
    new Request("http://mail.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...opts.headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    opts.env ?? E,
    createExecutionContext(),
  );
  const body = (await res.json()) as any;
  return JSON.parse(body.result.content[0].text);
}

/** DNS-over-HTTPS stand-in serving `zone` ("TYPE name" -> answers). */
function doh(zone: Record<string, string[]>) {
  return async (url: string) => {
    const u = new URL(url);
    const type = u.searchParams.get("type")!;
    const name = u.searchParams.get("name")!;
    const data = zone[`${type} ${name}`];
    return Response.json(
      data ? { Status: 0, Answer: data.map((d) => ({ name, type: type === "MX" ? 15 : 16, TTL: 60, data: d })) } : { Status: 3 },
    );
  };
}

/** Every record a domain needs, passing; the challenge carries `token`. */
function fullZone(d: string, token: string): Record<string, string[]> {
  const mx = ["10 route1.mx.cloudflare.net.", "20 route2.mx.cloudflare.net.", "30 route3.mx.cloudflare.net."];
  const spf = ['"v=spf1 include:_spf.mx.cloudflare.net ~all"'];
  const dkim = ['"v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC"'];
  return {
    [`TXT _afs-verify.${d}`]: [`"afs-verify=${token}"`],
    [`MX ${d}`]: mx,
    [`TXT ${d}`]: spf,
    [`TXT cf2024-1._domainkey.${d}`]: dkim,
    [`MX cf-bounce.${d}`]: mx,
    [`TXT cf-bounce.${d}`]: spf,
    [`TXT cf-bounce._domainkey.${d}`]: dkim,
    [`TXT _dmarc.${d}`]: ['"v=DMARC1; p=none"'],
  };
}

const note = (from: string, to: string, subject = "hello", body = "hello there") => eml({ from, to, subject, body });

// ---------------------------------------------------------------------------------------------

describe("1. auto_configure and force need the operator (x-admin-token)", () => {
  const op = hosted({ CF_API_TOKEN: "cf-test-token", ADMIN_TOKEN: "operator-secret" });

  it("without the header: 403 admin_required with the records to add by hand, on REST and MCP, and nothing changes", async () => {
    const { key } = await signup();
    const d = `${uniq("auto")}.example`;
    const r = await call("POST", "/v1/domains", { key, env: op, body: { domain: d, auto_configure: true } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("admin_required");
    expect(r.json.error.hint).toMatch(/by hand/);
    expect(r.json.error.details.records).toHaveLength(12);
    expect(r.json.error.details.records[0].name).toBe(`_afs-verify.${d}`);
    expect((await call("GET", `/v1/domains/${d}`, { key, env: op })).status).toBe(404); // nothing registered

    // force alone, and a wrong token, are refused too
    expect((await call("POST", "/v1/domains", { key, env: op, body: { domain: d, force: true } })).json.error.code).toBe("admin_required");
    const wrong = await call("POST", "/v1/domains", {
      key,
      env: op,
      headers: { "x-admin-token": "operator-secreT" },
      body: { domain: d, auto_configure: true },
    });
    expect(wrong.status).toBe(403);

    // PATCH is refused before it changes anything (catch_all_inbox_id in the same request is not applied)
    expect((await call("POST", "/v1/domains", { key, env: op, body: { domain: d } })).status).toBe(201);
    const p = await call("PATCH", `/v1/domains/${d}`, { key, env: op, body: { auto_configure: true, catch_all_inbox_id: null } });
    expect(p.json.error.code).toBe("admin_required");

    const m = await mcp(key, "add_domain", { domain: d, auto_configure: true }, { env: op });
    expect(m.error.code).toBe("admin_required");
    const mu = await mcp(key, "update_domain", { domain: d, force: true }, { env: op });
    expect(mu.error.code).toBe("admin_required");
  });

  it("with the operator's token it runs (against a fake Cloudflare API), passing force through", async () => {
    const s = await signup();
    const d = `${uniq("op")}.example`;
    const calls: string[] = [];
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
    const fetcher = async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      expect(u.origin).toBe("https://api.cloudflare.com"); // never the real API: this fake answers
      const path = u.pathname.replace("/client/v4", "");
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);
      if (path === "/zones") return ok(u.searchParams.get("name") === d ? [{ id: "z1", name: d }] : []);
      if (path === "/zones/z1/email/routing") return ok({ enabled: true, status: "ready" });
      if (path === "/zones/z1/email/routing/dns") return ok([]);
      if (path === "/zones/z1/email/routing/rules/catch_all" && method === "GET")
        return ok({ enabled: true, actions: [{ type: "forward", value: ["boss@corp.example"] }] });
      if (path === "/zones/z1/email/routing/rules/catch_all") return ok({ enabled: true });
      if (path === "/zones/z1/email/sending/subdomains" && method === "GET") return ok([{ tag: "t1", name: d, enabled: true }]);
      if (path.startsWith("/zones/z1/email/sending/subdomains/t1/dns")) return ok([]);
      return Response.json({ success: false, errors: [{ code: 7000, message: "No route" }] }, { status: 404 });
    };
    const r = await addDomain(op, acctOf(s), { domain: d, auto_configure: true, force: true }, { adminToken: "operator-secret", fetcher });
    expect(r.auto_configure?.ok).toBe(true);
    expect(calls).toContain("PUT /zones/z1/email/routing/rules/catch_all"); // force replaced the forward rule
    // still needs the ownership challenge before it can be used
    expect(r.domain.ownership).toBe("pending");
    expect(r.next_steps[0]).toMatch(/_afs-verify/);
  });
});

describe("2. custom domains need a per-account ownership challenge", () => {
  it("POST /v1/domains lists the challenge first; the token is HMAC(ENCRYPTION_KEY, account|domain) and stable", async () => {
    const s = await signup();
    const d = `${uniq("rec")}.example`;
    const r = await call("POST", "/v1/domains", { key: s.key, body: { domain: d } });
    expect(r.status).toBe(201);
    const token = (await hmacSha256Hex(E.ENCRYPTION_KEY!, `${acctOf(s)}|${d}`)).slice(0, 32);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(r.json.domain.records[0]).toMatchObject({
      id: "ownership_txt",
      purpose: "ownership",
      type: "TXT",
      name: `_afs-verify.${d}`,
      host: "_afs-verify",
      value: `afs-verify=${token}`,
    });
    expect(r.json.domain.ownership).toBe("pending");
    expect(r.json.next_steps[0]).toContain(`_afs-verify.${d}`);
    const again = await call("POST", "/v1/domains", { key: s.key, body: { domain: d } });
    expect(again.status).toBe(200);
    expect(again.json.domain.records[0].value).toBe(`afs-verify=${token}`);
    const viaMcp = await mcp(s.key, "get_domain", { domain: d });
    expect(viaMcp.domain.records[0].value).toBe(`afs-verify=${token}`);
  });

  it("falls back to ADMIN_TOKEN as the key, and refuses custom domains with neither secret", async () => {
    const s = await signup();
    const d = `${uniq("fb")}.example`;
    const fb = hosted({ ENCRYPTION_KEY: undefined, ADMIN_TOKEN: "admin-fallback" });
    const r = await addDomain(fb, acctOf(s), { domain: d });
    expect(r.domain.records[0]!.value).toBe(`afs-verify=${(await hmacSha256Hex("admin-fallback", `${acctOf(s)}|${d}`)).slice(0, 32)}`);
    const none = hosted({ ENCRYPTION_KEY: undefined, ADMIN_TOKEN: undefined });
    const e = await errorOf(addDomain(none, acctOf(s), { domain: `${uniq("none")}.example` }));
    expect(e).toMatchObject({ status: 400, code: "custom_domains_unavailable" });
    expect(e.hint).toMatch(/ENCRYPTION_KEY/);
    expect((await errorOf(verifyDomain(none, acctOf(s), d))).code).toBe("custom_domains_unavailable");
  });

  it("an unproven claim gets no inboxes, no mail (address or catch-all) and no sending", async () => {
    const s = await signup();
    const d = `${uniq("legacy")}.example`;
    await call("POST", "/v1/domains", { key: s.key, body: { domain: d } });
    const ib = await call("POST", "/v1/inboxes", { key: s.key, body: { username: "hello", domain: d } });
    expect(ib.status).toBe(403);
    expect(ib.json.error.code).toBe("ownership_not_verified");
    expect(ib.json.error.hint).toMatch(/_afs-verify/);
    // An inbox and catch-all from before challenges existed (DNS "verified" the old way).
    const id = `inb_${uniq("legacy").replace("-", "")}`;
    await E.DB.prepare("INSERT INTO inboxes (id, account_id, address, username, domain, created_at) VALUES (?, ?, ?, 'hello', ?, 1)")
      .bind(id, acctOf(s), `hello@${d}`, d)
      .run();
    await E.DB.prepare("UPDATE domains SET catch_all_inbox_id = ?, receiving_verified = 1, sending_verified = 1 WHERE domain = ?")
      .bind(id, d)
      .run();
    expect((await deliver("x@sender.example", `hello@${d}`, note("x@sender.example", `hello@${d}`))).rejected).toBe(
      "Address does not exist",
    );
    expect((await deliver("x@sender.example", `any@${d}`, note("x@sender.example", `any@${d}`))).rejected).toBe("Address does not exist");
    const send = await call("POST", `/v1/inboxes/${id}/send`, { key: s.key, body: { to: "x@example.org", subject: "s", text: "t" } });
    expect(send.json.error.code).toBe("ownership_not_verified");
    // Once the challenge has passed, the same inbox receives and sends.
    await E.DB.prepare("UPDATE domains SET owner_verified_at = 1 WHERE domain = ?").bind(d).run();
    expect((await deliver("x@sender.example", `hello@${d}`, note("x@sender.example", `hello@${d}`))).rejected).toBeNull();
    expect((await deliver("x@sender.example", `any@${d}`, note("x@sender.example", `any@${d}`))).rejected).toBeNull();
    expect(
      (await call("POST", `/v1/inboxes/${id}/send`, { key: s.key, body: { to: "x@example.org", subject: "s", text: "t" } })).status,
    ).toBe(201);
  });

  it("several accounts may claim a domain; whoever passes the challenge owns it, and then others get 409", async () => {
    const a = await signup();
    const b = await signup();
    const d = `${uniq("claim")}.example`;
    expect((await call("POST", "/v1/domains", { key: a.key, body: { domain: d } })).status).toBe(201);
    expect((await call("POST", "/v1/domains", { key: b.key, body: { domain: d } })).status).toBe(201); // A's claim is unproven
    const tokA = await ownershipToken(E, acctOf(a), d);
    expect(await ownershipToken(E, acctOf(b), d)).not.toBe(tokA);
    const zone = fullZone(d, tokA);

    // B: every email record passes, but the challenge carries A's token -> no ownership.
    const vb = await verifyDomain(E, acctOf(b), d, { fetcher: doh(zone) });
    expect(vb).toMatchObject({ ownership: "fail", receiving: "pass", sending: "pass", status: "partial" });
    expect(vb.records[0]).toMatchObject({ id: "ownership_txt", status: "fail" });
    expect((await call("POST", "/v1/inboxes", { key: b.key, body: { username: "hello", domain: d } })).json.error.code).toBe(
      "ownership_not_verified",
    );

    // A passes and owns it; B's claim lapses and cannot be made again.
    const va = await verifyDomain(E, acctOf(a), d, { fetcher: doh(zone) });
    expect(va).toMatchObject({ ownership: "pass", receiving: "pass", sending: "pass", status: "verified" });
    expect((await call("GET", `/v1/domains/${d}`, { key: b.key })).status).toBe(404);
    const late = await call("POST", "/v1/domains", { key: b.key, body: { domain: d } });
    expect(late.status).toBe(409);
    expect(late.json.error.hint).toBeTruthy();
    expect((await mcp(b.key, "add_domain", { domain: d })).error.code).toBe("conflict");

    // A can use it: inboxes, address + catch-all mail, sending.
    const ib = await call("POST", "/v1/inboxes", { key: a.key, body: { username: "hello", domain: d } });
    expect(ib.status).toBe(201);
    await call("PATCH", `/v1/domains/${d}`, { key: a.key, body: { catch_all_inbox_id: ib.json.inbox.id } });
    expect((await deliver("x@sender.example", `hello@${d}`, note("x@sender.example", `hello@${d}`))).rejected).toBeNull();
    expect((await deliver("x@sender.example", `whoever@${d}`, note("x@sender.example", `whoever@${d}`))).rejected).toBeNull();
    expect(
      (await call("POST", `/v1/inboxes/${ib.json.inbox.id}/send`, { key: a.key, body: { to: "x@example.org", subject: "s", text: "t" } }))
        .status,
    ).toBe(201);

    // Ownership is kept: later verifies no longer need (or check) the TXT record.
    const { [`TXT _afs-verify.${d}`]: _gone, ...rest } = zone;
    const later = await verifyDomain(E, acctOf(a), d, { fetcher: doh(rest) });
    expect(later.ownership).toBe("pass");
    expect(later.records.some((r) => r.id === "ownership_txt")).toBe(false);
    expect((await call("GET", `/v1/domains/${d}`, { key: a.key })).json.domain).toMatchObject({
      ownership: "verified",
      status: "verified",
    });
  });
});

describe("3. one tenant cannot fill D1", () => {
  it("text_body in D1 is capped at 64 KB and flagged; the raw MIME keeps everything", async () => {
    const { key, inbox } = await signup();
    const body = `${"é".repeat(50_000)}\n${"z".repeat(40_000)}`; // ~140 KB of UTF-8
    expect(
      (await deliver("a@sender.example", inbox.address, eml({ from: "a@sender.example", to: inbox.address, subject: "big", body })))
        .rejected,
    ).toBeNull();
    const id = (await call("GET", `/v1/inboxes/${inbox.id}/messages`, { key })).json.messages[0].id;
    const m = (await call("GET", `/v1/messages/${id}`, { key })).json.message;
    expect(m.text_truncated).toBe(true);
    expect(new TextEncoder().encode(m.text).byteLength).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect((await call("GET", `/v1/messages/${id}/raw`, { key })).text).toContain("z".repeat(40_000));
    // MCP carries the flag too
    expect((await mcp(key, "get_message", { message_id: id })).message.text_truncated).toBe(true);
    // small mail is not flagged
    await deliver("a@sender.example", inbox.address, note("a@sender.example", inbox.address, "small"));
    const small = (await call("GET", `/v1/inboxes/${inbox.id}/messages?limit=1`, { key })).json.messages[0];
    expect((await call("GET", `/v1/messages/${small.id}`, { key })).json.message.text_truncated).toBe(false);
  });

  it("MAX_MESSAGES_PER_INBOX: a full inbox makes room by evicting the oldest mail instead of rejecting", async () => {
    const env = hosted({ MAX_MESSAGES_PER_INBOX: "2" });
    const s = await signup();
    const { key, inbox } = s;
    for (const n of [1, 2, 3])
      expect((await deliver("a@sender.example", inbox.address, note("a@sender.example", inbox.address, `m${n}`), env)).rejected).toBeNull();
    const msgs = (await call("GET", `/v1/inboxes/${inbox.id}/messages`, { key })).json.messages;
    expect(msgs.map((m: { subject: string }) => m.subject)).toEqual(["m3", "m2"]); // m1 was evicted
    expect((await getInboxRow(E, acctOf(s), inbox.id)).inbound_count).toBe(2);
    const blobs = await E.BLOBS.list({ prefix: `inbox/${inbox.id}/` });
    expect(blobs.objects).toHaveLength(2); // the evicted message's blob went with it
  });

  it("MAX_INBOUND_PER_ACCOUNT_PER_DAY caps an account across inboxes; redeliveries are not counted", async () => {
    const env = hosted({ MAX_INBOUND_PER_ACCOUNT_PER_DAY: "2" });
    const s = await signup();
    const other = await createInbox(E, acctOf(s), { username: uniq("day") });
    const once = eml({
      from: "a@sender.example",
      to: s.inbox.address,
      subject: "once",
      body: "x",
      messageId: `<${uniq("once")}@sender.example>`,
    });
    expect((await deliver("a@sender.example", s.inbox.address, once, env)).rejected).toBeNull();
    expect((await deliver("a@sender.example", s.inbox.address, once, env)).rejected).toBeNull(); // duplicate: refunded
    // (one sender may use at most half of the daily quota, so the next ones come from elsewhere)
    expect((await deliver("b@other.example", other.inbox.address, note("b@other.example", other.inbox.address), env)).rejected).toBeNull();
    const over = await deliver("c@third.example", other.inbox.address, note("c@third.example", other.inbox.address), env);
    expect(over.rejected).toMatch(/^Daily limit reached: .* maximum of 2 messages today \(UTC\)/);
    // another account is unaffected
    const t = await signup();
    expect((await deliver("a@sender.example", t.inbox.address, note("a@sender.example", t.inbox.address), env)).rejected).toBeNull();
  });

  it("the retention purge loops past the old 1,000-per-run cap and stops at its time budget", async () => {
    const s = await signup();
    const tag = uniq("bulk");
    const bulk = (n: number, start: number) =>
      E.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT ?4 UNION ALL SELECT i + 1 FROM n WHERE i < ?5)
         INSERT INTO messages (id, account_id, inbox_id, thread_id, direction, received_at, text_body) SELECT 'msg_' || ?1 || '_' || i, ?2, ?3, 'thr_' || ?1, 'in', 1000 + i, 'old' FROM n`,
      )
        .bind(tag, acctOf(s), s.inbox.id, start, start + n - 1)
        .run();
    await bulk(1250, 1);
    const env = hosted({ SHARED_RETENTION_DAYS: "30" });
    const r = await purgeOldSharedMessages(env);
    expect(r.purged_messages).toBeGreaterThanOrEqual(1250);
    expect(r.more).toBe(false);
    const left = await E.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE inbox_id = ?").bind(s.inbox.id).first<{ n: number }>();
    expect(left!.n).toBe(0);
    expect((await getInboxRow(E, acctOf(s), s.inbox.id)).inbound_count).toBe(0); // the trigger kept the count
    await bulk(5, 5000);
    expect(await purgeOldSharedMessages(env, Date.now(), 0)).toEqual({ purged_messages: 0, more: true });
    expect((await purgeOldSharedMessages(env)).purged_messages).toBeGreaterThanOrEqual(5);
  });

  it("the expiry purge also loops past its old cap of 200 inboxes per run", async () => {
    const s = await signup();
    const tag = uniq("exp").replace("-", "");
    await E.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 205)
       INSERT INTO inboxes (id, account_id, address, username, domain, expires_at, created_at)
       SELECT 'inb_' || ?1 || '_' || i, ?2, ?1 || '-' || i || '@mail.example.com', ?1 || '-' || i, 'mail.example.com', 1, 1 FROM n`,
    )
      .bind(tag, acctOf(s))
      .run();
    const r = await purgeExpiredInboxes(E);
    expect(r.purged).toBeGreaterThanOrEqual(205);
    expect(r.more).toBe(false);
  });
});

describe("4. SHARED_SEND_POLICY=reply_only counts only authenticated, From-aligned mail", () => {
  it("forged From headers do not unlock a recipient; genuine mail does (fixtures)", async () => {
    const s = await signup();
    const row = await getInboxRow(E, acctOf(s), s.inbox.id);
    const env = hosted({ SHARED_SEND_POLICY: "reply_only" });
    const send = (from: string, auth: string | string[] | null) =>
      deliver(from, s.inbox.address, eml({ from, to: s.inbox.address, subject: "hi", body: "hi", auth }));

    // Forged: Cloudflare saw DMARC fail (a forged "pass" header further down does not count) ...
    await send("ceo@bank.example", [
      "mx.cloudflare.net; dkim=pass header.d=evil.example; spf=pass smtp.mailfrom=b@evil.example; dmarc=fail header.from=bank.example",
      "mx.bank.example; dkim=pass header.d=bank.example; spf=pass; dmarc=pass header.from=bank.example",
    ]);
    // ... only a header the sender wrote ...
    await send("ops@victim.example", "mx.victim.example; dmarc=pass header.from=victim.example");
    // ... DMARC pass for a different domain than the From ...
    await send(
      "cfo@corp.example",
      "mx.cloudflare.net; dkim=pass header.d=evil.example; spf=pass smtp.mailfrom=x@evil.example; dmarc=pass header.from=evil.example",
    );
    // ... no authentication at all.
    await send("hr@corp2.example", null);
    for (const r of ["ceo@bank.example", "ops@victim.example", "cfo@corp.example", "hr@corp2.example"]) {
      const e = await errorOf(assertReplyOnly(env, row, [r]));
      expect(e.code).toBe("reply_only");
      expect(e.details.recipients_not_allowed).toEqual([r]);
    }
    // REST reply to the forged message is refused too.
    const forged = (await call("GET", `/v1/inboxes/${s.inbox.id}/messages?from=bank.example`, { key: s.key })).json.messages[0];
    expect(forged.auth_verdict).toBe("fail");
    const reply = await call("POST", `/v1/messages/${forged.id}/reply`, { key: s.key, env, body: { text: "hi" } });
    expect(reply.status).toBe(403);
    expect(reply.json.error.code).toBe("reply_only");

    // Genuine: the partner fixture (DKIM, SPF and DMARC pass for partner.example) ...
    await deliver("jane@partner.example", s.inbox.address, quotedReply.replaceAll("acme-signups@mail.example.com", s.inbox.address));
    await expect(assertReplyOnly(env, row, ["jane@partner.example"])).resolves.toBeUndefined();
    // ... and a sender with only an aligned SPF pass (no DKIM, no DMARC record).
    await send("x@small.example", "mx.cloudflare.net; dkim=none; spf=pass smtp.mailfrom=bounce@mail.small.example; dmarc=none");
    await expect(assertReplyOnly(env, row, ["x@small.example"])).resolves.toBeUndefined();
  });
});

describe("5. shared-domain addresses are never recycled", () => {
  it("a deleted address answers exactly like a taken one, except to its old owner", async () => {
    const a = await signup();
    const b = await signup();
    const live = uniq("live");
    const gone = uniq("gone");
    expect((await call("POST", "/v1/inboxes", { key: a.key, body: { username: live } })).status).toBe(201);
    const g = await call("POST", "/v1/inboxes", { key: a.key, body: { username: gone } });
    // Only addresses that received mail are reserved (they may have been used to sign up somewhere).
    await deliver("x@sender.example", g.json.inbox.address, note("x@sender.example", g.json.inbox.address));
    const del = await call("DELETE", `/v1/inboxes/${g.json.inbox.id}`, { key: a.key });
    expect(del.status).toBe(200);
    expect(del.json.address_reserved_until).toBeGreaterThan(Date.now() + 89 * 86_400_000);

    const taken = await call("POST", "/v1/inboxes", { key: b.key, body: { username: live } });
    const recycled = await call("POST", "/v1/inboxes", { key: b.key, body: { username: gone } });
    expect(taken.status).toBe(409);
    expect(recycled.status).toBe(409);
    expect(JSON.stringify(recycled.json).replaceAll(gone, "NAME")).toBe(JSON.stringify(taken.json).replaceAll(live, "NAME"));
    expect((await mcp(b.key, "create_inbox", { username: gone })).error.code).toBe("conflict");
    // Mail to it is refused like any unknown address.
    expect((await deliver("x@sender.example", g.json.inbox.address, note("x@sender.example", g.json.inbox.address))).rejected).toBe(
      "Address does not exist",
    );

    const back = await call("POST", "/v1/inboxes", { key: a.key, body: { username: gone } });
    expect(back.status).toBe(201);
    expect(back.json.inbox.id).not.toBe(g.json.inbox.id);
  });

  it("inboxes removed by ttl expiry are tombstoned too", async () => {
    const a = await signup();
    const b = await signup();
    const name = uniq("ttl");
    const c = await call("POST", "/v1/inboxes", { key: a.key, body: { username: name, ttl_days: 1 } });
    await deliver("x@sender.example", c.json.inbox.address, note("x@sender.example", c.json.inbox.address));
    await E.DB.prepare("UPDATE inboxes SET expires_at = 1 WHERE id = ?").bind(c.json.inbox.id).run();
    await purgeExpiredInboxes(E);
    expect((await call("GET", `/v1/inboxes/${c.json.inbox.id}`, { key: a.key })).status).toBe(404);
    expect((await call("POST", "/v1/inboxes", { key: b.key, body: { username: name } })).status).toBe(409);
    expect((await call("POST", "/v1/inboxes", { key: a.key, body: { username: name } })).status).toBe(201);
  });
});

describe("6. webhook fan-out is bounded", () => {
  it("MAX_WEBHOOKS_PER_ACCOUNT caps webhooks (default 10); re-creating an existing one still works", async () => {
    const { key } = await signup();
    for (let i = 0; i < 10; i++)
      expect((await call("POST", "/v1/webhooks", { key, body: { url: `https://hooks.example.com/h${i}` } })).status).toBe(201);
    const over = await call("POST", "/v1/webhooks", { key, body: { url: "https://hooks.example.com/h10" } });
    expect(over.status).toBe(403);
    expect(over.json.error).toMatchObject({ code: "quota_exceeded", details: { limit: 10 } });
    expect((await call("POST", "/v1/webhooks", { key, body: { url: "https://hooks.example.com/h3" } })).status).toBe(200);
    expect((await mcp(key, "create_webhook", { url: "https://hooks.example.com/h11" })).error.code).toBe("quota_exceeded");

    const other = await signup();
    const env = hosted({ MAX_WEBHOOKS_PER_ACCOUNT: "1" });
    expect((await call("POST", "/v1/webhooks", { key: other.key, env, body: { url: "https://hooks.example.com/a" } })).status).toBe(201);
    expect((await call("POST", "/v1/webhooks", { key: other.key, env, body: { url: "https://hooks.example.com/b" } })).status).toBe(403);
  });

  async function runDelivery(job: WebhookJob, fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
    const state = { acked: false, retried: false };
    const batch = {
      queue: "afs-mail-webhooks",
      messages: [
        { id: "q1", timestamp: new Date(), body: job, attempts: 1, ack: () => (state.acked = true), retry: () => (state.retried = true) },
      ],
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<WebhookJob>;
    await deliverBatch(batch, E, fetcher);
    const row = await E.DB.prepare("SELECT status, error, response_status FROM webhook_deliveries WHERE id = ?")
      .bind(job.delivery_id)
      .first<{ status: string; error: string | null; response_status: number }>();
    return { ...state, row: row! };
  }

  it("deliveries never follow redirects (3xx = failure) and read at most 64 KB of a response", async () => {
    const s = await signup();
    const w = await createWebhook(E, acctOf(s), { url: "https://hooks.example.com/r" });
    const job: WebhookJob = {
      delivery_id: `whd_${uniq("t")}`,
      webhook_id: w.webhook.id,
      event: { id: "evt_t", type: "message.received", created_at: 1, data: {} }, // test events are not retried
    };
    await E.DB.prepare(
      "INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, status, attempts, created_at, updated_at) VALUES (?, ?, 'evt_t', 'webhook.test', 'pending', 0, 1, 1)",
    )
      .bind(job.delivery_id, w.webhook.id)
      .run();

    let init: RequestInit | undefined;
    const redirected = await runDelivery(job, async (_url, i) => {
      init = i;
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    });
    expect(init?.redirect).toBe("manual");
    expect(redirected.retried).toBe(true);
    expect(redirected.row).toMatchObject({ status: "retrying", response_status: 302 });
    expect(redirected.row.error).toMatch(/redirects are not followed/);

    let pulled = 0;
    const huge = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 16_384;
        c.enqueue(new Uint8Array(16_384).fill(65));
      },
    });
    const failed = await runDelivery(job, async () => new Response(huge, { status: 500 }));
    expect(pulled).toBeLessThanOrEqual(64 * 1024 + 2 * 16_384);
    expect(failed.row.error).toMatch(/^HTTP 500: A+$/);
    expect(failed.row.error!.length).toBeLessThanOrEqual(220);

    const ok = await runDelivery(job, async () => new Response("thanks", { status: 200 }));
    expect(ok.acked).toBe(true);
    expect(ok.row.status).toBe("delivered");
  });

  it("fan-out beyond 100 deliveries is sent in queue batches within the platform limit", async () => {
    const s = await signup();
    const tag = uniq("bulk");
    // A deployment may raise MAX_WEBHOOKS_PER_ACCOUNT; insert 250 directly.
    await E.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250)
       INSERT INTO webhooks (id, account_id, url, events, inbox_id, secret_sealed, enabled, created_at)
       SELECT 'wh_' || ?1 || '_' || i, ?2, 'https://hooks.example.com/' || i, 'message.received', NULL, 'plain:x', 1, 1 FROM n`,
    )
      .bind(tag, acctOf(s))
      .run();
    const sizes: number[] = [];
    const queue = {
      send: async () => {},
      sendBatch: async (msgs: unknown[]) => {
        if (msgs.length > 100) throw new Error("sendBatch: more than 100 messages");
        sizes.push(msgs.length);
      },
    } as unknown as Queue<WebhookJob>;
    const n = await emitEvent(hosted({ WEBHOOKS: queue }), acctOf(s), s.inbox.id, "message.received", { hello: "world" });
    expect(n).toBe(250);
    expect(sizes).toEqual([100, 100, 50]);
    const logged = await E.DB.prepare(
      "SELECT COUNT(*) AS n FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE w.account_id = ?",
    )
      .bind(acctOf(s))
      .first<{ n: number }>();
    expect(logged!.n).toBe(250);
  });
});

describe("7. dedupe and wait races", () => {
  it("a concurrent duplicate that slips past the pre-check is dropped by the unique index (insert-or-ignore)", async () => {
    const s = await signup();
    const msgId = `<${uniq("race")}@sender.example>`;
    const raw = eml({ from: "a@sender.example", to: s.inbox.address, subject: "race", body: "Your code is 551177", messageId: msgId });
    const first = await ingestRaw(E, { envelopeFrom: "a@sender.example", envelopeTo: s.inbox.address, raw: new TextEncoder().encode(raw) });
    expect(first.status).toBe("stored");

    // The pre-check SELECT misses once, as it would for two deliveries racing each other.
    let blinded = false;
    const db = new Proxy(E.DB, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (prop !== "prepare") return typeof v === "function" ? v.bind(target) : v;
        return (sql: string) => {
          if (!blinded && sql.startsWith("SELECT id FROM messages WHERE inbox_id = ? AND message_id_header = ?")) {
            blinded = true;
            return { bind: () => ({ first: async () => null }) };
          }
          return target.prepare(sql);
        };
      },
    });
    const second = await ingestRaw(hosted({ DB: db as D1Database }), {
      envelopeFrom: "a@sender.example",
      envelopeTo: s.inbox.address,
      raw: new TextEncoder().encode(raw),
    });
    expect(blinded).toBe(true);
    expect(second).toEqual({ status: "duplicate", message_id: (first as { message_id: string }).message_id, inbox_id: s.inbox.id });

    const msgs = (await call("GET", `/v1/inboxes/${s.inbox.id}/messages`, { key: s.key })).json.messages;
    expect(msgs).toHaveLength(1);
    expect((await getInboxRow(E, acctOf(s), s.inbox.id)).inbound_count).toBe(1);
    const threads = await E.DB.prepare("SELECT COUNT(*) AS n, SUM(message_count) AS m FROM threads WHERE inbox_id = ?")
      .bind(s.inbox.id)
      .first<{ n: number; m: number }>();
    expect(threads).toEqual({ n: 1, m: 1 });
    const blobs = await E.BLOBS.list({ prefix: `inbox/${s.inbox.id}/` });
    expect(blobs.objects.map((o) => o.key)).toEqual([`inbox/${s.inbox.id}/${msgs[0].id}/raw.eml`]); // the dropped copy's blob is gone

    // The index itself refuses a second inbound row; outbound rows may share the id (mail to yourself).
    const insert = (direction: string) =>
      E.DB.prepare(
        "INSERT INTO messages (id, account_id, inbox_id, thread_id, direction, message_id_header, received_at) VALUES (?, ?, ?, 'thr_x', ?, ?, 1)",
      )
        .bind(`msg_${uniq("x")}`, acctOf(s), s.inbox.id, direction, msgId)
        .run();
    await expect(insert("in")).rejects.toThrow(/UNIQUE/);
    await expect(insert("out")).resolves.toBeTruthy();
  });

  it("concurrent deliveries of one message store it once", async () => {
    const s = await signup();
    const raw = new TextEncoder().encode(
      eml({ from: "a@sender.example", to: s.inbox.address, subject: "x", body: "x", messageId: `<${uniq("par")}@sender.example>` }),
    );
    const all = await Promise.all(
      [1, 2, 3, 4].map(() => ingestRaw(E, { envelopeFrom: "a@sender.example", envelopeTo: s.inbox.address, raw })),
    );
    expect(all.filter((r) => r.status === "stored")).toHaveLength(1);
    expect((await call("GET", `/v1/inboxes/${s.inbox.id}/messages`, { key: s.key })).json.messages).toHaveLength(1);
  });

  it("mail that lands between wait's last D1 check and parking wakes it at once", async () => {
    const s = await signup();
    const started = Date.now();
    let delivered = false;
    const r = await waitForEmail(E, acctOf(s), s.inbox.id, { from: "race.example" }, 20, {
      beforePark: async () => {
        if (delivered) return;
        delivered = true;
        await deliver(
          "a@race.example",
          s.inbox.address,
          eml({ from: "a@race.example", to: s.inbox.address, subject: "Your code", body: "Your login code is 314159" }),
        );
      },
    });
    expect(delivered).toBe(true);
    expect(r.message.code).toBe("314159");
    expect(Date.now() - started).toBeLessThan(5_000); // not the 20 s timeout
  });

  it("InboxDO: a notify after version() is never lost, even within the same millisecond", async () => {
    const stub = E.INBOX.get(E.INBOX.idFromName(uniq("do")));
    const v = await stub.version();
    const now = Date.now();
    await stub.notify(now);
    expect(await parkOnInbox(stub, v, 5_000)).toEqual({ woken: true, version: v + 1 }); // answered without parking
    const parked = parkOnInbox(stub, v + 1, 5_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(await stub.waiting()).toBe(1); // parked as a hibernatable WebSocket
    await stub.notify(now); // same received_at as before
    expect(await parked).toEqual({ woken: true, version: v + 2 });
    expect(await parkOnInbox(stub, v + 2, 100)).toEqual({ woken: false, version: v + 2 }); // timeout runs in the Worker
  });
});

describe("8. no header injection", () => {
  const CRLF = String.fromCharCode(13, 10);
  const NUL = String.fromCharCode(0);

  it("display_name loses control characters on create and update, and again before sending", async () => {
    const s = await signup();
    const c = await call("POST", "/v1/inboxes", {
      key: s.key,
      body: { username: uniq("hdr"), display_name: `Evil${CRLF}Bcc: victim@example.org` },
    });
    expect(c.json.inbox.display_name).toBe("Evil Bcc: victim@example.org");
    const u = await call("PATCH", `/v1/inboxes/${s.inbox.id}`, { key: s.key, body: { display_name: `A${CRLF}B${NUL}C` } });
    expect(u.json.inbox.display_name).toBe("A B C");
    const viaMcp = await mcp(s.key, "update_inbox", { inbox_id: s.inbox.id, display_name: `M${CRLF}X-Evil: 1` });
    expect(viaMcp.inbox.display_name).toBe("M X-Evil: 1");

    // A value stored before the fix is cleaned on the way out, and so is an attachment filename.
    await E.DB.prepare("UPDATE inboxes SET display_name = ? WHERE id = ?").bind(`Old${CRLF}X-Evil: 1`, s.inbox.id).run();
    let sent: any;
    const env = hosted({
      EMAIL: { send: async (m: unknown) => ((sent = m), { messageId: "<spy@mail.example.com>" }) } as unknown as SendEmail,
    });
    const r = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, {
      key: s.key,
      env,
      body: {
        to: "x@example.org",
        subject: "s",
        text: "t",
        attachments: [{ filename: `a${CRLF}Content-Type: text/html.txt`, content: btoa("hi"), content_type: "text/plain; charset=utf-8" }],
      },
    });
    expect(r.status).toBe(201);
    expect(sent.from).toEqual({ email: s.inbox.address, name: "Old X-Evil: 1" });
    expect(sent.attachments[0]).toMatchObject({ filename: "a Content-Type: text/html.txt", type: "text/plain; charset=utf-8" });
  });

  it("attachment content_type and content_id with line breaks are rejected (REST and MCP)", async () => {
    const s = await signup();
    const att = (extra: Record<string, string>) => ({
      to: "x@example.org",
      subject: "s",
      text: "t",
      attachments: [{ filename: "a.txt", content: btoa("hi"), ...extra }],
    });
    const badType = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, {
      key: s.key,
      body: att({ content_type: `text/plain${CRLF}X-Evil: 1` }),
    });
    expect(badType.status).toBe(400);
    expect(badType.json.error.message).toMatch(/not a valid MIME type/);
    expect(badType.json.error.hint).toMatch(/No line breaks/);
    const badCid = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, {
      key: s.key,
      body: att({ disposition: "inline", content_id: `logo${CRLF}X-Evil: 1` }),
    });
    expect(badCid.status).toBe(400);
    const m = await mcp(s.key, "send_email", { inbox_id: s.inbox.id, ...att({ content_type: `image/png${CRLF}Bcc: a@b.c` }) });
    expect(m.error.code).toBe("bad_request");
  });
});
