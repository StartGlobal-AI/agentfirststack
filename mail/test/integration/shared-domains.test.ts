import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../src/env";
import { forwardEach } from "../../src/service/forward";
import { purgeOldSharedMessages } from "../../src/service/inboxes";
import { findReservedInboxes } from "../../src/service/reserved";
import { E, acctOf, call, claimAs, deliver, eml, hosted, mcp, uniq } from "./helpers";

// A second shared domain (SHARED_INBOX_DOMAIN): new inboxes go there, every inbox on the old
// MAIL_DOMAIN keeps working, and both are shared for every rule (src/lib/shared-domains.ts).

const OLD = "mail.example.com"; // MAIL_DOMAIN in vitest.config.ts
const NEW = "inbox.example.net";

interface Sent {
  from: { email: string } | string;
  to: string[];
}

/** The moved deployment, with Email Sending stubbed (sent mail is recorded, never leaves). */
function moved(vars: Partial<AppEnv> = {}) {
  const sent: Sent[] = [];
  const env = hosted({
    SHARED_INBOX_DOMAIN: NEW,
    EMAIL: {
      send: async (m: Sent) => {
        sent.push(m);
        return { messageId: `<spy-${sent.length}@${NEW}>` };
      },
    } as unknown as SendEmail,
    ...vars,
  });
  return { env, sent };
}

let ip = 0;
/** A new account on this deployment, with its default inbox. */
async function signupOn(env: AppEnv) {
  const r = await call("POST", "/v1/signup", { body: {}, ip: `203.0.113.${(ip++ % 250) + 1}`, env });
  expect(r.status).toBe(201);
  return { key: r.json.api_key as string, inbox: r.json.inbox as { id: string; address: string; domain: string }, json: r.json };
}

const create = (key: string, body: Record<string, unknown>, env: AppEnv) => call("POST", "/v1/inboxes", { key, body, env });
const sends = async (account: string) =>
  (await E.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM send_counters WHERE account_id = ?").bind(account).first<{ n: number }>())
    ?.n ?? 0;
const codeMail = (from: string, to: string, n: string) => eml({ from, to, subject: "Your code", body: `Your verification code is ${n}` });

describe("new inboxes go on SHARED_INBOX_DOMAIN", () => {
  it("signup's default inbox, a named inbox and the discovery documents name the new domain first", async () => {
    const { env } = moved();
    const s = await signupOn(env);
    expect(s.inbox.address.endsWith(`@${NEW}`)).toBe(true);
    const name = uniq("acme-signups");
    const c = await create(s.key, { username: name }, env);
    expect(c.status).toBe(201);
    expect(c.json.inbox).toMatchObject({ address: `${name}@${NEW}`, domain: NEW });
    expect((await create(s.key, { username: name, domain: NEW }, env)).json).toMatchObject({ existing: true });

    const list = await call("GET", "/v1/inboxes", { key: s.key, env });
    expect(list.json).toMatchObject({ shared_domain: NEW, shared_domains: [NEW, OLD] });
    expect((await call("GET", "/", { env })).json).toMatchObject({ shared_domain: NEW, shared_domains: [NEW, OLD] });
    const llms = await call("GET", "/llms.txt", { env });
    expect(llms.text).toContain(`Shared domain (works instantly for every account): ${NEW}`);
    expect(llms.text).toContain(`Earlier shared domain: ${OLD}`);
    expect((await mcp(s.key, "list_inboxes", {}, env)).shared_domains).toEqual([NEW, OLD]);
  });

  it("without the var nothing changes: one shared domain", async () => {
    const s = await signupOn(E);
    expect(s.inbox.address.endsWith(`@${OLD}`)).toBe(true);
    expect((await call("GET", "/v1/inboxes", { key: s.key })).json).toMatchObject({ shared_domain: OLD, shared_domains: [OLD] });
    expect((await call("GET", "/llms.txt")).text).not.toContain("Earlier shared domain");
  });

  it("reserved names apply on the new domain; it and its subdomains can't be added as custom domains", async () => {
    const { env } = moved();
    const s = await signupOn(env);
    const r = await create(s.key, { username: "postmaster" }, env);
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/reserved/);
    for (const domain of [NEW, `mx.${NEW}`, OLD]) {
      const d = await call("POST", "/v1/domains", { key: s.key, body: { domain }, env });
      expect(d.status, domain).toBe(400);
      expect(d.json.error.message).toMatch(/shared domain/);
    }
  });
});

describe("inboxes on the old MAIL_DOMAIN keep working", () => {
  it("receive, wait for codes, reply under reply_only, and are refused to strangers as before", async () => {
    const before = await signupOn(E);
    const oldInbox = before.inbox;
    expect(oldInbox.address.endsWith(`@${OLD}`)).toBe(true);
    const { env, sent } = moved({ SHARED_SEND_POLICY: "reply_only" });

    // Receiving (Email Routing's catch-all on the old zone still points here).
    expect(
      (await deliver("noreply@github.com", oldInbox.address, codeMail("noreply@github.com", oldInbox.address, "246810"), env)).rejected,
    ).toBeNull();
    const lc = await call("GET", `/v1/inboxes/${oldInbox.id}/latest-code?from=github.com&timeout=0`, { key: before.key, env });
    expect(lc.json).toMatchObject({ code: "246810", sender_domain: "github.com" });

    // Sending from the old domain (onboarded: MAIL_DOMAIN is the default sending domain).
    const human = `${uniq("jane")}@partner.example`;
    await deliver(human, oldInbox.address, eml({ from: human, to: oldInbox.address, subject: "Hello", body: "Can we talk?" }), env);
    const msgs = await call("GET", `/v1/inboxes/${oldInbox.id}/messages?from=${encodeURIComponent(human)}`, { key: before.key, env });
    const reply = await call("POST", `/v1/messages/${msgs.json.messages[0].id}/reply`, { key: before.key, body: { text: "Sure." }, env });
    expect(reply.status).toBe(201);
    expect(sent.at(-1)).toMatchObject({ to: [human] });
    expect(JSON.stringify(sent.at(-1)!.from)).toContain(oldInbox.address);

    const stranger = await call("POST", `/v1/inboxes/${oldInbox.id}/send`, {
      key: before.key,
      body: { to: `${uniq("cold")}@target.example`, subject: "Hi", text: "Buy now" },
      env,
    });
    expect(stranger.status).toBe(403);
    expect(stranger.json.error.code).toBe("reply_only");
  });

  it("an explicit old domain is for retries of the account's own addresses only", async () => {
    const a = await signupOn(E);
    const name = uniq("legacy");
    const made = await create(a.key, { username: name }, E);
    expect(made.json.inbox.address).toBe(`${name}@${OLD}`);
    const { env } = moved();

    // The owner retrying: the same inbox (rule 7).
    const again = await create(a.key, { username: name, domain: OLD }, env);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ existing: true, inbox: { id: made.json.inbox.id } });

    // Anyone else, a free name or a random one: refused, the same way whether the name is taken.
    const b = await signupOn(env);
    for (const body of [{ username: name, domain: OLD }, { username: uniq("free"), domain: OLD }, { domain: OLD }]) {
      const r = await create(b.key, body, env);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.code).toBe("legacy_shared_domain");
      expect(r.json.error.hint).toContain(NEW);
    }
    // ... and the owner can't make new addresses there either.
    expect((await create(a.key, { username: uniq("fresh"), domain: OLD }, env)).json.error.code).toBe("legacy_shared_domain");
  });

  it("a retired old address: its account may recreate it there; nobody else gets the name on either domain", async () => {
    const a = await signupOn(E);
    const name = uniq("retired");
    const made = await create(a.key, { username: name }, E);
    const del = await call("DELETE", `/v1/inboxes/${made.json.inbox.id}`, { key: a.key });
    expect(del.json.address_reserved).toBe(true);
    const { env } = moved();

    const b = await signupOn(env);
    const onNew = await create(b.key, { username: name }, env);
    expect(onNew.status).toBe(409);
    expect(onNew.json.error.code).toBe("conflict");
    expect((await create(b.key, { username: name, domain: OLD }, env)).status).toBe(400);

    const back = await create(a.key, { username: name, domain: OLD }, env);
    expect(back.status).toBe(201);
    expect(back.json.inbox.address).toBe(`${name}@${OLD}`);
  });
});

describe("one name across both shared domains", () => {
  it("a live old address keeps its name on the new domain for its account only; a retired new one blocks others too", async () => {
    const a = await signupOn(E);
    const name = uniq("brand");
    await create(a.key, { username: name }, E);
    const { env } = moved();

    const b = await signupOn(env);
    const taken = await create(b.key, { username: name }, env);
    expect(taken.status).toBe(409);
    // The same answer as an address that is taken on the new domain itself.
    const bOwn = uniq("b-own");
    expect((await create(b.key, { username: bOwn }, env)).status).toBe(201);
    const c = await signupOn(env);
    const plain = await create(c.key, { username: bOwn }, env);
    expect(plain.status).toBe(409);
    expect(Object.keys(taken.json.error).sort()).toEqual(Object.keys(plain.json.error).sort());

    // The account that holds the name may take it on the new domain too.
    const mine = await create(a.key, { username: name }, env);
    expect(mine.status).toBe(201);
    expect(mine.json.inbox.address).toBe(`${name}@${NEW}`);

    // Retired on the new domain: still nobody else's.
    const gone = await call("DELETE", `/v1/inboxes/${mine.json.inbox.id}`, { key: a.key, env });
    expect(gone.json.address_reserved).toBe(true);
    expect((await create(c.key, { username: name }, env)).status).toBe(409);
    expect((await create(a.key, { username: name }, env)).status).toBe(201);
  });
});

describe("both domains are shared for every policy", () => {
  it("retention, reserved-name scans and the shared domains list cover both", async () => {
    const { env } = moved({ SHARED_RETENTION_DAYS: "14" });
    const before = await signupOn(E);
    const after = await signupOn(env);
    for (const inbox of [before.inbox, after.inbox])
      await deliver(
        "a@sender.example",
        inbox.address,
        eml({ from: "a@sender.example", to: inbox.address, subject: "old", body: "code 123456" }),
        env,
      );
    await purgeOldSharedMessages(env, Date.now() + 15 * 86_400_000);
    for (const [s, inbox] of [
      [before, before.inbox],
      [after, after.inbox],
    ] as const)
      expect((await call("GET", `/v1/inboxes/${inbox.id}/messages`, { key: s.key, env })).json.messages, inbox.address).toHaveLength(0);

    const name = uniq("zbrand");
    const onOld = await create(before.key, { username: name }, E);
    const onNew = await create(before.key, { username: name }, env);
    expect(onNew.status).toBe(201);
    const found = await findReservedInboxes(hosted({ ...env, EXTRA_RESERVED_USERNAMES: name }));
    expect(found.shared_domains).toEqual([NEW, OLD]);
    expect(found.inboxes.map((i) => i.address).sort()).toEqual([onOld.json.inbox.address, onNew.json.inbox.address].sort());

    const doms = await call("GET", "/v1/domains", { key: after.key, env });
    expect(doms.json.shared_domain).toMatchObject({ domain: NEW, new_inboxes: true, receiving: "verified", sending: "pending" });
    expect(doms.json.shared_domains.map((d: { domain: string }) => d.domain)).toEqual([NEW, OLD]);
    expect(doms.json.shared_domains[1]).toMatchObject({ domain: OLD, new_inboxes: false, sending: "verified" });
  });

  it("mail to an unknown address on the new domain is rejected; there is no catch-all on a shared domain", async () => {
    const { env } = moved();
    const s = await signupOn(env);
    const nobody = `${uniq("nobody")}@${NEW}`;
    expect((await deliver("a@sender.example", nobody, codeMail("a@sender.example", nobody, "1111"), env)).rejected).not.toBeNull();
    const tagged = s.inbox.address.replace("@", "+github@");
    expect((await deliver("noreply@github.com", tagged, codeMail("noreply@github.com", tagged, "2222"), env)).rejected).toBeNull();
  });
});

describe("sending from a shared domain needs Email Sending onboarding (SHARED_SENDING_DOMAINS)", () => {
  it("not onboarded: outside recipients get 503 domain_not_onboarded before anything is sent or counted; own inboxes still get it", async () => {
    const { env, sent } = moved();
    const s = await signupOn(env);
    const account = acctOf(s);
    const out = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, {
      key: s.key,
      body: { to: `${uniq("x")}@partner.example`, subject: "Hi", text: "Hello" },
      env,
    });
    expect(out.status).toBe(503);
    expect(out.json.error).toMatchObject({ code: "domain_not_onboarded", details: { domain: NEW } });
    expect(out.json.error.hint).toMatch(/POST \/v1\/domains/);
    expect(sent).toHaveLength(0);
    expect(await sends(account)).toBe(0);
    expect(
      (await mcp(s.key, "send_email", { inbox_id: s.inbox.id, to: "y@partner.example", subject: "Hi", text: "x" }, env)).error.code,
    ).toBe("domain_not_onboarded");

    // To another inbox of the same account: delivered internally, Email Service not involved.
    const second = await create(s.key, { username: uniq("second") }, env);
    const own = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, {
      key: s.key,
      body: { to: second.json.inbox.address, subject: "Internal", text: "Hello me" },
      env,
    });
    expect(own.status).toBe(201);
    expect(own.json.internal).toEqual([expect.objectContaining({ status: "delivered" })]);
    expect(sent).toHaveLength(0);

    // create_inbox says so up front.
    expect(second.json.next_steps.join(" ")).toMatch(/domain_not_onboarded/);
  });

  it("listed: the new domain sends; dropping MAIL_DOMAIN from the list stops the old domain's outside mail", async () => {
    const old = await signupOn(E);
    const both = moved({ SHARED_SENDING_DOMAINS: `${OLD},${NEW}` });
    const s = await signupOn(both.env);
    const to = `${uniq("x")}@partner.example`;
    const ok = await call("POST", `/v1/inboxes/${s.inbox.id}/send`, {
      key: s.key,
      body: { to, subject: "Hi", text: "Hello" },
      env: both.env,
    });
    expect(ok.status).toBe(201);
    expect(both.sent).toHaveLength(1);
    expect(JSON.stringify(both.sent[0]!.from)).toContain(`@${NEW}`);
    const doms = await call("GET", "/v1/domains", { key: s.key, env: both.env });
    expect(doms.json.shared_domain.sending).toBe("verified");

    const onlyNew = moved({ SHARED_SENDING_DOMAINS: NEW });
    const refused = await call("POST", `/v1/inboxes/${old.inbox.id}/send`, {
      key: old.key,
      body: { to, subject: "Hi", text: "Hello" },
      env: onlyNew.env,
    });
    expect(refused.status).toBe(503);
    expect(refused.json.error.details.domain).toBe(OLD);
    expect(onlyNew.sent).toHaveLength(0);
  });

  it("forwards to the project's members wait (queued, logged) until the domain is onboarded", async () => {
    const { env, sent } = moved({ AUTH_ISSUER: "https://platform.example" });
    const s = await signupOn(env);
    const owner = `${uniq("owner")}@people.example`;
    await claimAs(acctOf(s), owner);
    expect((await call("PATCH", `/v1/inboxes/${s.inbox.id}`, { key: s.key, body: { forward: { mode: "each" } }, env })).status).toBe(200);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await deliver("noreply@github.com", s.inbox.address, codeMail("noreply@github.com", s.inbox.address, "482913"), env);
    expect(sent.filter((m) => m.to.includes(owner))).toHaveLength(0);
    const logged = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("forward.cannot_send"));
    expect(logged).toContain("domain_not_onboarded");
    warn.mockRestore();
    const msg = (await call("GET", `/v1/inboxes/${s.inbox.id}/messages`, { key: s.key, env })).json.messages[0];
    const queued = await E.DB.prepare("SELECT COUNT(*) AS n FROM forward_queue WHERE message_id = ?").bind(msg.id).first<{ n: number }>();
    expect(queued?.n).toBe(1);

    // Onboarded: the same message goes out.
    const later = moved({ AUTH_ISSUER: "https://platform.example", SHARED_SENDING_DOMAINS: `${OLD},${NEW}` });
    expect(await forwardEach(later.env, msg.id)).toMatchObject({ status: "forwarded", recipients: 1 });
    expect(later.sent.filter((m) => m.to.includes(owner))).toHaveLength(1);
  });
});
