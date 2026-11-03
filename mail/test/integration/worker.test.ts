import { describe, expect, it } from "vitest";
import githubLaunchCode from "../fixtures/github-launch-code.eml?raw";
import newsletter from "../fixtures/newsletter-numbers.eml?raw";
import { E, call, deliver, eml, signup } from "./helpers";

const fixture = (raw: string, to: string) => raw.replaceAll("acme-signups@mail.example.com", to);

describe("signup and inboxes", () => {
  it("signup returns a key and a working default inbox", async () => {
    const { key, inbox, json } = await signup();
    expect(key).toMatch(/^(mail|afs)_/);
    expect(inbox.address).toMatch(/^[0-9a-z]{10}@mail\.example\.com$/);
    expect(json.next_steps.length).toBeGreaterThan(0);
    const r = await call("GET", `/v1/inboxes/${inbox.id}`, { key });
    expect(r.status).toBe(200);
    expect(r.json.inbox.message_count).toBe(0);
  });

  it("creating an address you own is idempotent; someone else's is a 409", async () => {
    const a = await signup();
    const b = await signup();
    const name = `team-${crypto.randomUUID().slice(0, 8)}`;
    expect((await call("POST", "/v1/inboxes", { key: a.key, body: { username: name } })).status).toBe(201);
    const again = await call("POST", "/v1/inboxes", { key: a.key, body: { username: name.toUpperCase() } });
    expect(again.status).toBe(200);
    expect(again.json.existing).toBe(true);
    const other = await call("POST", "/v1/inboxes", { key: b.key, body: { username: name } });
    expect(other.status).toBe(409);
    expect(other.json.error.hint).toBeTruthy();
  });

  it("unknown routes and missing auth answer with hints", async () => {
    expect((await call("GET", "/v1/inboxes")).json.error.code).toBe("unauthorized");
    expect((await call("GET", "/nope")).json.error.hint).toMatch(/llms.txt/);
  });
});

describe("email() handler", () => {
  it("stores, extracts, threads and indexes inbound mail", async () => {
    const { key, inbox } = await signup();
    const st = await deliver("noreply@github.com", inbox.address, fixture(githubLaunchCode, inbox.address));
    expect(st.rejected).toBeNull();
    const list = await call("GET", `/v1/inboxes/${inbox.id}/messages`, { key });
    expect(list.json.messages).toHaveLength(1);
    const m = list.json.messages[0];
    expect(m.code).toBe("61873352");
    expect(m.verify_link_kind).toBe("verify");
    const full = await call("GET", `/v1/messages/${m.id}`, { key });
    expect(full.json.message.html).toContain("<table");
    expect(full.json.message.auth.verdict).toBe("pass");
    const raw = await call("GET", `/v1/messages/${m.id}/raw`, { key });
    expect(raw.text).toContain("Subject: =?UTF-8?Q?");
    const s = await call("GET", "/v1/search?q=launch", { key });
    expect(s.json.messages.map((x: { id: string }) => x.id)).toEqual([m.id]);
  });

  it("rejects unknown addresses without reading the body", async () => {
    const st = await deliver(
      "x@y.com",
      "nobody-here@mail.example.com",
      eml({ from: "x@y.com", to: "nobody-here@mail.example.com", subject: "hi", body: "hi" }),
    );
    expect(st.rejected).toBe("Address does not exist");
  });

  it("is idempotent on Message-ID (Email Routing retries)", async () => {
    const { key, inbox } = await signup();
    const raw = eml({ from: "a@sender.example", to: inbox.address, subject: "Once", body: "hello", messageId: "<dup-1@sender.example>" });
    await deliver("a@sender.example", inbox.address, raw);
    await deliver("a@sender.example", inbox.address, raw);
    const list = await call("GET", `/v1/inboxes/${inbox.id}/messages`, { key });
    expect(list.json.messages).toHaveLength(1);
  });

  it("delivers plus-addresses to the base inbox and ignores expired inboxes", async () => {
    const { key, inbox } = await signup();
    const [user, domain] = inbox.address.split("@");
    await deliver(
      "a@sender.example",
      `${user}+meta@${domain}`,
      eml({ from: "a@sender.example", to: inbox.address, subject: "Your verification code", body: "Your verification code is 552018" }),
    );
    const lc = await call("GET", `/v1/inboxes/${inbox.id}/latest-code?after=0&timeout=1`, { key });
    expect(lc.json.code).toBe("552018");
    await E.DB.prepare("UPDATE inboxes SET expires_at = 1 WHERE id = ?").bind(inbox.id).run();
    const st = await deliver(
      "a@sender.example",
      inbox.address,
      eml({ from: "a@sender.example", to: inbox.address, subject: "late", body: "late" }),
    );
    expect(st.rejected).toBe("Address does not exist");
  });
});

describe("wait_for_email", () => {
  it("parks on the InboxDO and wakes when mail lands", async () => {
    const { key, inbox } = await signup();
    const started = Date.now();
    const waiting = call("GET", `/v1/inboxes/${inbox.id}/wait?from=sender.example&timeout=20`, { key });
    await new Promise((r) => setTimeout(r, 800));
    // Mail that does not match the filter wakes the DO but must not satisfy the wait.
    await deliver(
      "other@else.example",
      inbox.address,
      eml({ from: "other@else.example", to: inbox.address, subject: "noise", body: "unrelated" }),
    );
    await new Promise((r) => setTimeout(r, 300));
    await deliver(
      "a@sender.example",
      inbox.address,
      eml({ from: "a@sender.example", to: inbox.address, subject: "Your login code", body: "Your login code is 908172" }),
    );
    const r = await waiting;
    expect(r.status).toBe(200);
    expect(r.json.message.code).toBe("908172");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  });

  it("counts mail that landed just before the call (grace window) and honours explicit after", async () => {
    const { key, inbox } = await signup();
    await deliver(
      "a@sender.example",
      inbox.address,
      eml({ from: "a@sender.example", to: inbox.address, subject: "Security code", body: "Security code: 4417" }),
    );
    const r = await call("GET", `/v1/inboxes/${inbox.id}/wait?timeout=1`, { key });
    expect(r.json.message.code).toBe("4417");
    const later = await call("GET", `/v1/inboxes/${inbox.id}/wait?timeout=1&after=${r.json.message.received_at}`, { key });
    expect(later.status).toBe(408);
    expect(later.json.error.code).toBe("timeout");
    expect(later.json.error.details.after).toBe(r.json.message.received_at);
  });

  it("latest-code skips mail without a code or link", async () => {
    const { key, inbox } = await signup();
    await deliver("hello@devweekly.example", inbox.address, fixture(newsletter, inbox.address));
    const r = await call("GET", `/v1/inboxes/${inbox.id}/latest-code?after=0&timeout=1`, { key });
    expect(r.status).toBe(408);
    const w = await call("GET", `/v1/inboxes/${inbox.id}/wait?after=0&timeout=1`, { key });
    expect(w.json.message.codes).toEqual([]);
  });
});

describe("sending and threading", () => {
  it("reply sets threading headers, inbound answer joins the thread, daily limit applies", async () => {
    const { key, inbox } = await signup();
    await deliver(
      "jane@sender.example",
      inbox.address,
      eml({
        from: "jane@sender.example",
        to: inbox.address,
        subject: "Partnership",
        body: "Shall we talk?",
        messageId: "<orig-1@sender.example>",
      }),
    );
    const orig = (await call("GET", `/v1/inboxes/${inbox.id}/messages`, { key })).json.messages[0];
    const reply = await call("POST", `/v1/messages/${orig.id}/reply`, { key, body: { text: "Yes, Thursday?" } });
    expect(reply.status).toBe(201);
    expect(reply.json.message.thread_id).toBe(orig.thread_id);
    expect(reply.json.message.subject).toBe("Re: Partnership");
    const sentId = reply.json.provider_message_id as string;
    const out = await call("GET", `/v1/messages/${reply.json.message.id}`, { key });
    expect(out.json.message.in_reply_to).toBe("<orig-1@sender.example>");
    expect(out.json.message.references).toBe("<orig-1@sender.example>");

    // Jane answers our reply: In-Reply-To = our Message-ID -> same thread.
    await deliver(
      "jane@sender.example",
      inbox.address,
      eml({
        from: "jane@sender.example",
        to: inbox.address,
        subject: "Re: Partnership",
        body: "Thursday works.",
        inReplyTo: sentId,
        references: `<orig-1@sender.example> ${sentId}`,
      }),
    );
    const thread = await call("GET", `/v1/threads/${orig.thread_id}`, { key });
    expect(thread.json.thread.messages.map((m: { direction: string }) => m.direction)).toEqual(["in", "out", "in"]);

    // SEND_DAILY_LIMIT is 6 in this test config; 1 used by the reply.
    const many = ["a", "b", "c", "d", "e"].map((x) => `${x}@example.org`);
    expect((await call("POST", `/v1/inboxes/${inbox.id}/send`, { key, body: { to: many, subject: "Hi", text: "Hi" } })).status).toBe(201);
    const over = await call("POST", `/v1/inboxes/${inbox.id}/send`, { key, body: { to: "z@example.org", subject: "Hi", text: "Hi" } });
    expect(over.status).toBe(429);
    expect(over.json.error.code).toBe("daily_limit");
  });

  it("refuses to send from a custom domain that has not passed verify", async () => {
    const { key } = await signup();
    const d = `acme-${crypto.randomUUID().slice(0, 8)}.example`;
    const add = await call("POST", "/v1/domains", { key, body: { domain: d } });
    expect(add.status).toBe(201);
    expect(add.json.domain.records).toHaveLength(12); // ownership challenge + 11 email records
    // Simulate a passed ownership challenge (tested end to end in security.test.ts).
    await E.DB.prepare("UPDATE domains SET owner_verified_at = 1 WHERE domain = ?").bind(d).run();
    const ib = await call("POST", "/v1/inboxes", { key, body: { username: "hello", domain: d } });
    expect(ib.status).toBe(201);
    const r = await call("POST", `/v1/inboxes/${ib.json.inbox.id}/send`, { key, body: { to: "x@example.org", subject: "s", text: "t" } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("domain_not_verified");
    // Simulate a passed verify: then sending is allowed.
    await E.DB.prepare("UPDATE domains SET sending_verified = 1 WHERE domain = ?").bind(d).run();
    expect(
      (await call("POST", `/v1/inboxes/${ib.json.inbox.id}/send`, { key, body: { to: "x@example.org", subject: "s", text: "t" } })).status,
    ).toBe(201);
  });
});

describe("webhooks and MCP", () => {
  it("message.received creates a pending signed delivery", async () => {
    const { key, inbox } = await signup();
    const w = await call("POST", "/v1/webhooks", { key, body: { url: "https://hooks.example.com/mail", inbox_id: inbox.id } });
    expect(w.status).toBe(201);
    expect(w.json.secret).toMatch(/^whsec_/);
    const sealed = await E.DB.prepare("SELECT secret_sealed FROM webhooks WHERE id = ?")
      .bind(w.json.webhook.id)
      .first<{ secret_sealed: string }>();
    expect(sealed!.secret_sealed.startsWith("v1.")).toBe(true); // sealed with ENCRYPTION_KEY, not plaintext
    await deliver("a@sender.example", inbox.address, eml({ from: "a@sender.example", to: inbox.address, subject: "hi", body: "hello" }));
    const d = await E.DB.prepare("SELECT event_type FROM webhook_deliveries WHERE webhook_id = ?")
      .bind(w.json.webhook.id)
      .all<{ event_type: string }>();
    expect(d.results.map((x) => x.event_type)).toEqual(["message.received"]);
    const again = await call("POST", "/v1/webhooks", { key, body: { url: "https://hooks.example.com/mail", inbox_id: inbox.id } });
    expect(again.status).toBe(200);
    expect(again.json.secret).toBeUndefined();
  });

  it("MCP tools/list and tools/call get_latest_code", async () => {
    const { key, inbox } = await signup();
    await deliver(
      "a@sender.example",
      inbox.address,
      eml({ from: "a@sender.example", to: inbox.address, subject: "Your Acme code", body: "Your code is 771204" }),
    );
    const rpc = async (body: unknown) => {
      const { createExecutionContext } = await import("cloudflare:test");
      const { app } = await import("../../src/index");
      const res = await app.fetch(
        new Request("http://mail.test/mcp", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify(body),
        }),
        E,
        createExecutionContext(),
      );
      return (await res.json()) as any;
    };
    const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(list.result.tools.length).toBeGreaterThanOrEqual(20);
    const r = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_latest_code", arguments: { inbox_id: inbox.id, after: 0, timeout: 1 } },
    });
    expect(JSON.parse(r.result.content[0].text).code).toBe("771204");
    const msg = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_messages", arguments: { inbox_id: inbox.id } },
    });
    const body = JSON.parse(msg.result.content[0].text);
    expect(body.messages[0].untrusted.subject).toBe("Your Acme code");
    expect(body.messages[0].subject).toBeUndefined();
  });
});
