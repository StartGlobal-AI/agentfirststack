import { forgetStanding, toBase64 } from "@afs/shared";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AppEnv, WebhookJob } from "../../src/env";
import { app } from "../../src/index";
import { createInbox, deleteInbox, purgeOldSharedMessages } from "../../src/service/inboxes";
import { ingestRaw } from "../../src/service/ingest";
import { deliverBatch } from "../../src/service/webhooks";
import { E, call, deliver, eml, hosted, signup } from "./helpers";

// One group per finding of the pre-public review of mail (pure side: test/unit/hardening-pure.test.ts).

const uniq = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;
const acctOf = (s: { json: { account_id: string } }) => s.json.account_id;
const note = (from: string, to: string, subject = "hello", body = "hello there") => eml({ from, to, subject, body });

async function mcp(key: string, name: string, args: unknown, env: AppEnv = E) {
  const res = await app.fetch(
    new Request("http://mail.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    createExecutionContext(),
  );
  const body = (await res.json()) as any;
  return JSON.parse(body.result.content[0].text);
}

/** A person claims the account, so the UNCLAIMED_* caps stop applying. */
async function claim(accountId: string) {
  const user = `usr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await E.AUTH_DB!.batch([
    E.AUTH_DB!.prepare("INSERT INTO users (id, google_sub, email, created_at) VALUES (?, ?, ?, ?)").bind(
      user,
      `dev:${user}`,
      `${user}@example.org`,
      Date.now(),
    ),
    E.AUTH_DB!.prepare("INSERT INTO memberships (user_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(
      user,
      accountId,
      Date.now(),
    ),
  ]);
  forgetStanding(accountId);
}

const todayCount = async (accountId: string) =>
  (
    await E.DB.prepare("SELECT count FROM inbound_counters WHERE account_id = ? AND day = ?")
      .bind(accountId, new Date().toISOString().slice(0, 10))
      .first<{ count: number }>()
  )?.count ?? 0;

const usage = async (accountId: string) =>
  (await E.DB.prepare("SELECT blob_bytes FROM account_usage WHERE account_id = ?").bind(accountId).first<{ blob_bytes: number }>())
    ?.blob_bytes ?? 0;

/** What the account's current rows say it stores, and what R2 really holds under its inboxes. */
async function stored(accountId: string) {
  const rows = await E.DB.prepare("SELECT COALESCE(SUM(blob_bytes), 0) AS n FROM messages WHERE account_id = ?")
    .bind(accountId)
    .first<{ n: number }>();
  const { results } = await E.DB.prepare("SELECT id FROM inboxes WHERE account_id = ?").bind(accountId).all<{ id: string }>();
  let r2 = 0;
  for (const { id } of results) for (const o of (await E.BLOBS.list({ prefix: `inbox/${id}/` })).objects) r2 += o.size;
  return { rows: rows!.n, r2 };
}

const failingCommit = (env: AppEnv): AppEnv => ({
  ...env,
  DB: new Proxy(E.DB, {
    get(target, prop) {
      if (prop === "batch") return async () => Promise.reject(new Error("D1 unavailable"));
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database,
});

// ---------------------------------------------------------------------------------------------

describe("1. hostile mail cannot use up an account's daily quota", () => {
  it("only stored mail counts: per-sender rejections, duplicates and failed commits never do", async () => {
    const s = await signup();
    const env = hosted({ MAX_INBOUND_PER_ACCOUNT_PER_DAY: "3", MAX_INBOUND_PER_SENDER_PER_DAY: "1" });
    const first = eml({ from: "a@one.example", to: s.inbox.address, subject: "first", body: "x", messageId: `<${uniq("m")}@one.example>` });
    expect((await deliver("a@one.example", s.inbox.address, first, env)).rejected).toBeNull();
    expect(await todayCount(acctOf(s))).toBe(1);
    // Same sender again: refused after the headers, before the body; not counted.
    const again = await deliver("a@one.example", s.inbox.address, note("a@one.example", s.inbox.address, "again"), env);
    expect(again.rejected).toMatch(/^Too much mail from one.example/);
    // A redelivery is a duplicate: not counted.
    expect((await deliver("a@one.example", s.inbox.address, first, env)).rejected).toBeNull();
    // A commit that fails (an invocation that dies before storing behaves the same): not counted.
    const raw = new TextEncoder().encode(note("b@two.example", s.inbox.address, "lost"));
    await expect(ingestRaw(failingCommit(env), { envelopeFrom: "b@two.example", envelopeTo: s.inbox.address, raw })).rejects.toThrow(
      /D1 unavailable/,
    );
    expect(await todayCount(acctOf(s))).toBe(1);
    // So the quota is all still there for real mail.
    for (const from of ["b@two.example", "c@three.example"])
      expect((await deliver(from, s.inbox.address, note(from, s.inbox.address), env)).rejected).toBeNull();
    expect(await todayCount(acctOf(s))).toBe(3);
    const over = await deliver("d@four.example", s.inbox.address, note("d@four.example", s.inbox.address), env);
    expect(over.rejected).toMatch(/^Daily limit reached: .* maximum of 3 messages today/);
  });

  it("the quota is re-checked inside the commit: concurrent deliveries cannot pass it", async () => {
    const s = await signup();
    const env = hosted({ MAX_INBOUND_PER_ACCOUNT_PER_DAY: "10" });
    const day = new Date().toISOString().slice(0, 10);
    await E.DB.prepare("INSERT INTO inbound_counters (account_id, day, count) VALUES (?, ?, 9)").bind(acctOf(s), day).run();
    const one = (from: string) =>
      ingestRaw(env, { envelopeFrom: from, envelopeTo: s.inbox.address, raw: new TextEncoder().encode(note(from, s.inbox.address)) });
    const results = await Promise.all([one("a@race-one.example"), one("b@race-two.example"), one("c@race-three.example")]);
    expect(results.filter((r) => r.status === "stored")).toHaveLength(1);
    for (const r of results.filter((r) => r.status !== "stored"))
      expect(r).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^Daily limit/) });
    expect(await todayCount(acctOf(s))).toBe(10);
    expect((await E.BLOBS.list({ prefix: `inbox/${s.inbox.id}/` })).objects).toHaveLength(1); // the refused copies' blobs are gone
  });

  it("forged senders share one allowance: unauthenticated mail is one sender, per inbox and for half the quota", async () => {
    const s = await signup();
    const other = await createInbox(E, acctOf(s), { username: uniq("pool") });
    const env = hosted({ MAX_INBOUND_PER_SENDER_PER_DAY: "2", MAX_INBOUND_PER_ACCOUNT_PER_DAY: "6" });
    const forged = (from: string, to: string) =>
      deliver(
        from,
        to,
        eml({
          from,
          to,
          subject: `from ${from}`,
          body: "x",
          auth: `mx.cloudflare.net; spf=fail smtp.mailfrom=${from}; dkim=none; dmarc=none`,
        }),
        env,
      );
    expect((await forged("x@forged-a.example", s.inbox.address)).rejected).toBeNull();
    expect((await forged("x@forged-b.example", s.inbox.address)).rejected).toBeNull();
    expect((await forged("x@forged-c.example", s.inbox.address)).rejected).toBe(
      `Too much unauthenticated mail (no SPF, DKIM or DMARC pass) to ${s.inbox.address} today (UTC); retry after 00:00 UTC`,
    );
    // Without any Cloudflare header it is the same sender.
    const bare = await deliver(
      "y@forged-d.example",
      s.inbox.address,
      eml({ from: "y@forged-d.example", to: s.inbox.address, subject: "bare", body: "x", auth: null }),
      env,
    );
    expect(bare.rejected).toMatch(/^Too much unauthenticated mail/);
    // Across inboxes it gets at most half of the account's daily quota (3 of 6).
    expect((await forged("x@forged-e.example", other.inbox.address)).rejected).toBeNull();
    expect((await forged("x@forged-f.example", other.inbox.address)).rejected).toMatch(/^Too much unauthenticated mail/);
    // Authenticated senders are untouched.
    expect(
      (await deliver("jane@partner.example", s.inbox.address, note("jane@partner.example", s.inbox.address), env)).rejected,
    ).toBeNull();
    const keys = await E.DB.prepare("SELECT DISTINCT sender_key FROM messages WHERE account_id = ? ORDER BY sender_key")
      .bind(acctOf(s))
      .all();
    expect(keys.results.map((r) => r.sender_key)).toEqual(["partner.example", "unauthenticated"]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("2. stored bytes are budgeted (MAX_BLOB_BYTES_PER_ACCOUNT)", () => {
  const html = (from: string, to: string, subject: string) =>
    eml({ from, to, subject, body: "plain part", html: `<p>${"h".repeat(400)}</p>` });

  it("counts raw MIME + HTML, rejects at SMTP when full, and deleting mail frees the budget", async () => {
    const s = await signup();
    const one = html("a@one.example", s.inbox.address, "one");
    const size = new TextEncoder().encode(one).byteLength;
    const env = hosted({ MAX_BLOB_BYTES_PER_ACCOUNT: String(Math.floor(2.5 * (size + 410))) });
    expect((await deliver("a@one.example", s.inbox.address, one, env)).rejected).toBeNull();
    expect(await usage(acctOf(s))).toBe(size + 407); // raw + "<p>…</p>" (407 bytes of HTML)
    expect(await stored(acctOf(s))).toEqual({ rows: size + 407, r2: size + 407 });
    expect((await deliver("b@two.example", s.inbox.address, html("b@two.example", s.inbox.address, "two"), env)).rejected).toBeNull();
    const full = await deliver("c@three.example", s.inbox.address, html("c@three.example", s.inbox.address, "three"), env);
    expect(full.rejected).toMatch(new RegExp(`^Mailbox full: the account behind ${s.inbox.address} keeps at most [0-9.]+ KB of mail`));
    const ids = (await call("GET", `/v1/inboxes/${s.inbox.id}/messages`, { key: s.key })).json.messages.map((m: { id: string }) => m.id);
    expect(ids).toHaveLength(2);
    await call("DELETE", `/v1/messages/${ids[1]}`, { key: s.key });
    expect(await usage(acctOf(s))).toBeLessThan(2 * size);
    expect((await deliver("c@three.example", s.inbox.address, html("c@three.example", s.inbox.address, "three"), env)).rejected).toBeNull();
    const after = await stored(acctOf(s));
    expect(after.rows).toBe(await usage(acctOf(s)));
    expect(after.r2).toBe(after.rows);
    // The account can see where it stands (REST and MCP).
    const limit = Math.floor(2.5 * (size + 410));
    expect((await call("GET", "/v1/inboxes", { key: s.key, env })).json.storage).toEqual({ used_bytes: after.rows, limit_bytes: limit });
    expect((await mcp(s.key, "list_inboxes", {}, env)).storage).toEqual({ used_bytes: after.rows, limit_bytes: limit });
    expect(
      (await call("GET", "/v1/inboxes", { key: s.key, env: hosted({ MAX_BLOB_BYTES_PER_ACCOUNT: "0" }) })).json.storage.limit_bytes,
    ).toBeNull();
  });

  it("the exact size (raw + HTML) is checked again before storing; UNCLAIMED_ applies until claimed; 0 turns it off", async () => {
    const s = await signup();
    const msg = html("a@one.example", s.inbox.address, "fits raw, not raw + html");
    const size = new TextEncoder().encode(msg).byteLength;
    const tight = hosted({ UNCLAIMED_MAX_BLOB_BYTES_PER_ACCOUNT: String(size + 10), MAX_BLOB_BYTES_PER_ACCOUNT: "10000000" });
    expect((await deliver("a@one.example", s.inbox.address, msg, tight)).rejected).toMatch(/^Mailbox full/); // passed the rawSize check
    expect((await E.BLOBS.list({ prefix: `inbox/${s.inbox.id}/` })).objects).toHaveLength(0);
    expect(
      (
        await deliver(
          "a@one.example",
          s.inbox.address,
          msg,
          hosted({ MAX_BLOB_BYTES_PER_ACCOUNT: "0", UNCLAIMED_MAX_BLOB_BYTES_PER_ACCOUNT: "0" }),
        )
      ).rejected,
    ).toBeNull();
    await claim(acctOf(s));
    const later = html("b@two.example", s.inbox.address, "claimed");
    expect((await deliver("b@two.example", s.inbox.address, later, tight)).rejected).toBeNull(); // claimed: the 10 MB cap
  });

  it("eviction, retention and inbox deletion all give the bytes back", async () => {
    const s = await signup();
    const env = hosted({ MAX_MESSAGES_PER_INBOX: "2" });
    for (const n of [1, 2, 3]) await deliver("a@one.example", s.inbox.address, html("a@one.example", s.inbox.address, `m${n}`), env);
    const afterEviction = await stored(acctOf(s));
    expect(await usage(acctOf(s))).toBe(afterEviction.rows);
    expect(afterEviction.r2).toBe(afterEviction.rows);

    const old = Date.now() - 30 * 86_400_000;
    await ingestRaw(
      E,
      {
        envelopeFrom: "b@two.example",
        envelopeTo: s.inbox.address,
        raw: new TextEncoder().encode(html("b@two.example", s.inbox.address, "old")),
      },
      old,
    );
    const before = await usage(acctOf(s));
    await purgeOldSharedMessages(hosted({ SHARED_RETENTION_DAYS: "14" }));
    expect(await usage(acctOf(s))).toBeLessThan(before);
    expect(await usage(acctOf(s))).toBe((await stored(acctOf(s))).rows);

    await deleteInbox(E, acctOf(s), s.inbox.id);
    expect(await usage(acctOf(s))).toBe(0);
  });

  it("received attachments are stored once (inside the raw MIME) and served from it, on REST and MCP", async () => {
    const s = await signup();
    const bin = Uint8Array.from({ length: 256 }, (_, i) => i);
    const raw = [
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=sender.example; dmarc=pass header.from=sender.example",
      "From: a@sender.example",
      `To: ${s.inbox.address}`,
      "Subject: report",
      `Message-ID: <${crypto.randomUUID()}@sender.example>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "see attached",
      "--b",
      'Content-Type: application/octet-stream; name="bytes.bin"',
      "Content-Disposition: attachment",
      "Content-Transfer-Encoding: base64",
      "",
      toBase64(bin),
      "--b",
      'Content-Type: text/plain; name="notes.txt"',
      "Content-Disposition: attachment",
      "",
      "second file",
      "--b--",
      "",
    ].join("\r\n");
    expect((await deliver("a@sender.example", s.inbox.address, raw)).rejected).toBeNull();
    const id = (await call("GET", `/v1/inboxes/${s.inbox.id}/messages`, { key: s.key })).json.messages[0].id;
    const m = (await call("GET", `/v1/messages/${id}`, { key: s.key })).json.message;
    expect(m.attachments.map((a: { filename: string; size: number }) => [a.filename, a.size])).toEqual([
      ["bytes.bin", 256],
      ["notes.txt", 11],
    ]);
    const objects = (await E.BLOBS.list({ prefix: `inbox/${s.inbox.id}/` })).objects;
    expect(objects.map((o) => o.key)).toEqual([`inbox/${s.inbox.id}/${id}/raw.eml`]);
    expect(await usage(acctOf(s))).toBe(objects[0]!.size);

    const res = await app.fetch(
      new Request(`http://mail.test/v1/messages/${id}/attachments/${m.attachments[0].id}`, {
        headers: { authorization: `Bearer ${s.key}` },
      }),
      E,
      createExecutionContext(),
    );
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bin);
    const viaMcp = await mcp(s.key, "get_attachment", { message_id: id, attachment_id: m.attachments[0].id });
    expect(viaMcp.content_base64).toBe(toBase64(bin));
    expect((await mcp(s.key, "get_attachment", { message_id: id, attachment_id: m.attachments[1].id })).content).toContain("second file");
  });

  it("sent mail counts too; over the budget it still goes out, and the copy kept here is text only", async () => {
    const s = await signup();
    const att = { filename: "a.txt", content: toBase64(new TextEncoder().encode("attached")), content_type: "text/plain" };
    const ok = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, {
      key: s.key,
      body: { to: "jane@partner.example", subject: "with html", text: "hi", html: "<p>hi</p>", attachments: [att] },
    });
    expect(ok.status).toBe(201);
    expect(ok.json.stored_copy).toBeUndefined();
    expect(await usage(acctOf(s))).toBe("<p>hi</p>".length + "attached".length);
    const sent = (await call("GET", `/v1/messages/${ok.json.message.id}`, { key: s.key })).json.message;
    expect((await call("GET", `/v1/messages/${sent.id}/attachments/${sent.attachments[0].id}`, { key: s.key })).text).toBe("attached");

    const env = hosted({ MAX_BLOB_BYTES_PER_ACCOUNT: "20", UNCLAIMED_MAX_BLOB_BYTES_PER_ACCOUNT: "20" });
    const over = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, {
      key: s.key,
      env,
      body: { to: "jane@partner.example", subject: "over", text: "hi again", html: "<p>hi again</p>", attachments: [att] },
    });
    expect(over.status).toBe(201);
    expect(over.json).toMatchObject({ stored_copy: "text_only", note: expect.stringMatching(/Sent in full/) });
    const copy = (await call("GET", `/v1/messages/${over.json.message.id}`, { key: s.key })).json.message;
    expect(copy).toMatchObject({ text: "hi again", html: null, attachments: [], attachments_omitted: 1 });
  });
});

// ---------------------------------------------------------------------------------------------

describe("3. webhooks cannot call the platform's own hosts", () => {
  const platform = { PUBLIC_BASE_URL: "https://mail.agentfirststack.com", AUTH_ISSUER: "https://agentfirststack.com" };

  it("REST and MCP refuse the apex and every subdomain, and http://localhost outside DEV_MODE", async () => {
    const { key } = await signup();
    const env = hosted(platform);
    for (const url of [
      "https://agentfirststack.com/x",
      "https://tags.agentfirststack.com/x",
      "https://mail.agentfirststack.com/v1/signup",
    ]) {
      const r = await call("POST", "/v1/webhooks", { key, env, body: { url } });
      expect(r.status, url).toBe(400);
      expect(r.json.error.message).toMatch(/points at this deployment/);
    }
    expect((await mcp(key, "create_webhook", { url: "https://site.agentfirststack.com/h" }, env)).error.message).toMatch(/deployment/);
    expect((await call("POST", "/v1/webhooks", { key, env, body: { url: "https://hooks.example.com/ok" } })).status).toBe(201);
    expect((await call("POST", "/v1/webhooks", { key, env, body: { url: "http://localhost:9999/h" } })).status).toBe(400);
    expect(
      (await call("POST", "/v1/webhooks", { key, env: hosted({ DEV_MODE: "true" }), body: { url: "http://localhost:9999/h" } })).status,
    ).toBe(201);
  });

  it("deliveries re-check the URL: a webhook saved before (or under other settings) is not called", async () => {
    const s = await signup();
    const whId = `wh_${crypto.randomUUID().slice(0, 12)}`;
    await E.DB.prepare(
      "INSERT INTO webhooks (id, account_id, url, events, inbox_id, secret_sealed, enabled, created_at) VALUES (?, ?, ?, 'message.received', NULL, 'plain:x', 1, ?)",
    )
      .bind(whId, acctOf(s), "https://tags.agentfirststack.com/hook", Date.now())
      .run();
    const job: WebhookJob = {
      delivery_id: `whd_${crypto.randomUUID().slice(0, 12)}`,
      webhook_id: whId,
      event: { id: "evt_1", type: "message.received", created_at: Date.now(), data: {} },
    };
    await E.DB.prepare(
      "INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, status, attempts, created_at, updated_at) VALUES (?, ?, 'evt_1', 'message.received', 'pending', 0, ?, ?)",
    )
      .bind(job.delivery_id, whId, Date.now(), Date.now())
      .run();
    let fetched = false;
    let acked = false;
    const batch = {
      queue: "afs-mail-webhooks",
      messages: [{ id: "q1", timestamp: new Date(), body: job, attempts: 1, ack: () => (acked = true), retry: () => {} }],
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<WebhookJob>;
    await deliverBatch(batch, hosted(platform), async () => {
      fetched = true;
      return new Response("ok");
    });
    expect(fetched).toBe(false);
    expect(acked).toBe(true);
    const d = await E.DB.prepare("SELECT status, error FROM webhook_deliveries WHERE id = ?")
      .bind(job.delivery_id)
      .first<{ status: string; error: string }>();
    expect(d).toMatchObject({ status: "failed", error: expect.stringMatching(/webhook URL not allowed: points at this deployment/) });
  });
});

// ---------------------------------------------------------------------------------------------

describe("4. a connected app's OAuth token cannot leave durable access behind", () => {
  it("webhook create (and re-enable) needs a permanent key, on REST and MCP; reading and deleting still work", async () => {
    const s = await signup();
    const made = await call("POST", "/v1/webhooks", { key: s.key, body: { url: "https://hooks.example.com/existing" } });
    expect(made.status).toBe(201);
    // Turn the key into what the site's OAuth server mints: an expiring key tied to a grant.
    await E.AUTH_DB!.prepare("UPDATE api_keys SET expires_at = ?, oauth_grant_id = ? WHERE account_id = ?")
      .bind(Date.now() + 3_600_000, `grant_${crypto.randomUUID().slice(0, 8)}`, acctOf(s))
      .run();
    for (const url of ["https://hooks.example.com/new", "https://hooks.example.com/existing"]) {
      const r = await call("POST", "/v1/webhooks", { key: s.key, body: { url } });
      expect(r.status, url).toBe(403);
      expect(r.json.error).toMatchObject({
        code: "temporary_credential",
        message: "A connected app's access token can't create webhooks.",
      });
    }
    expect((await mcp(s.key, "create_webhook", { url: "https://hooks.example.com/mcp" })).error.code).toBe("temporary_credential");
    const list = await call("GET", "/v1/webhooks", { key: s.key });
    expect(list.json.webhooks.map((w: { url: string }) => w.url)).toEqual(["https://hooks.example.com/existing"]);
    expect((await call("DELETE", `/v1/webhooks/${made.json.webhook.id}`, { key: s.key })).status).toBe(200);
    // Everything that ends with the token still works.
    expect((await call("POST", "/v1/inboxes", { key: s.key, body: { username: uniq("oauth") } })).status).toBe(201);
  });
});
