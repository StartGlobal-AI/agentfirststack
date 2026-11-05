import { describe, expect, it } from "vitest";
import { createClaimLink } from "../src/claims";
import { deliverDue, queueEmail, renderEmail, senderOf, unsubscribeUrl } from "../src/email";
import { emailPurgeReminders } from "../src/email-messages";
import { refreshNotices } from "../src/notices";
import { purgeDeletedProjects } from "../src/project-deletion";
import { CATALOG_VERSION } from "../src/setup-catalog";
import { BASE, Browser, E, call, csrfOf, emailsTo, failingEmailTo, sentEmails, signup, testEnv, uniqueEmail } from "./helpers";

const DAY = 86_400_000;
const outbox = (address: string) =>
  E.DB.prepare(
    "SELECT kind, category, status, attempts, error, next_attempt_at, user_id FROM email_outbox WHERE to_address = ? ORDER BY created_at",
  )
    .bind(address)
    .all<{
      kind: string;
      category: string;
      status: string;
      attempts: number;
      error: string | null;
      next_attempt_at: number | null;
      user_id: string | null;
    }>()
    .then((r) => r.results);
const userId = (email: string) => E.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<string>("id");

/** A project claimed by a signed-in owner, named. */
async function owned(label: string, name = `${label}.test`) {
  const agent = await signup(name);
  const link = (await call("POST", "/v1/claim-link", { key: agent.key })).json.url as string;
  const owner = new Browser();
  const email = uniqueEmail(label);
  const path = new URL(link).pathname;
  await owner.signIn(email, path);
  const claim = await owner.get(path);
  expect((await owner.post(path, { csrf: csrfOf(claim.text) })).status).toBe(303);
  return { agent, owner, email, name, base: `/dashboard/projects/${agent.accountId}` };
}

/** Someone joins the project through an invite link from its owner. */
async function join(accountId: string, label: string) {
  const ownerId = await E.DB.prepare("SELECT user_id FROM memberships WHERE account_id = ? AND role = 'owner'")
    .bind(accountId)
    .first<string>("user_id");
  const link = await createClaimLink(E.DB, BASE, accountId, { userId: ownerId! });
  const b = new Browser();
  const email = uniqueEmail(label);
  const path = new URL(link.url).pathname;
  await b.signIn(email, path);
  const page = await b.get(path);
  expect((await b.post(path, { csrf: csrfOf(page.text) })).status).toBe(303);
  return { b, email };
}

describe("emails: rendering and sending", () => {
  it("renders one escaped column with the button, the agent prompt and the footer", () => {
    const r = renderEmail(
      {
        subject: "Hello <b>there</b>\nBcc: x@y.z",
        body: ['A "quoted" <script>alert(1)</script> paragraph.'],
        action: { label: "Open", url: "https://afs.test/dashboard?a=1&b=2" },
        ask: "Do the <thing>.",
      },
      ["Footer line"],
    );
    expect(r.subject).toBe("Hello <b>there</b> Bcc: x@y.z"); // one line: no header injection
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.html).toContain('href="https://afs.test/dashboard?a=1&amp;b=2"');
    expect(r.text).toContain("Open: https://afs.test/dashboard?a=1&b=2");
    expect(r.text).toContain('Ask your agent:\n"Do the <thing>."');
    expect(r.text.endsWith("--\nFooter line")).toBe(true);
    expect(senderOf("AgentFirstStack <notifications@afs.test>")).toEqual({ email: "notifications@afs.test", name: "AgentFirstStack" });
    expect(senderOf("notifications@afs.test")).toBe("notifications@afs.test");
    expect(senderOf("not an address")).toBeNull();
  });

  it("sends once per event, retries failures twice, and caps each address per day", async () => {
    const env = testEnv();
    const to = { userId: null, email: uniqueEmail("retry") };
    const e = { kind: "test", category: "account" as const, dedupeKey: `test:${to.email}`, to, content: { subject: "Hi", body: ["One."] } };
    failingEmailTo.add(to.email);
    const now = Date.now();
    expect(await queueEmail(env, BASE, e, { now })).toBe("failed");
    expect(await queueEmail(env, BASE, e, { now })).toBe("duplicate");
    let [row] = await outbox(to.email);
    expect(row).toMatchObject({ status: "pending", attempts: 1 });
    expect(row?.error).toContain("E_DELIVERY_FAILED");
    expect(row?.next_attempt_at).toBe(now + 15 * 60_000);
    // Not due yet; then due, fails again; then the third attempt is the last.
    expect((await deliverDue(env, BASE, now + 60_000)).failed).toBe(0);
    await deliverDue(env, BASE, now + 16 * 60_000);
    [row] = await outbox(to.email);
    expect(row).toMatchObject({ status: "pending", attempts: 2 });
    failingEmailTo.delete(to.email);
    await deliverDue(env, BASE, now + 3 * 60 * 60_000);
    [row] = await outbox(to.email);
    expect(row).toMatchObject({ status: "sent", attempts: 3 });
    expect(emailsTo(to.email)).toHaveLength(1);
    expect(emailsTo(to.email)[0]?.from).toEqual({ email: "notifications@afs.test", name: "AgentFirstStack" });

    const capped = testEnv({ MAX_EMAILS_PER_PERSON_PER_DAY: "2" });
    const one = (n: number) => ({ ...e, dedupeKey: `cap:${to.email}:${n}` });
    expect(await queueEmail(capped, BASE, one(1))).toBe("sent"); // the earlier one counts too: 2 today
    expect(await queueEmail(capped, BASE, one(2))).toBe("skipped");
    expect((await outbox(to.email)).at(-1)).toMatchObject({ status: "skipped", error: expect.stringContaining("daily email limit") });

    // Without a sender (or the binding), nothing is queued.
    expect(await queueEmail(testEnv({ NOTIFY_EMAIL_FROM: "" }), BASE, one(3))).toBe("off");
    expect(await queueEmail(testEnv({ EMAIL: undefined }), BASE, one(4))).toBe("off");
  });
});

describe("emails: account events", () => {
  it("tells the new owner they own it, and the owner when someone joins or is removed", async () => {
    const { agent, owner, email, name, base } = await owned("claimer");
    const [claimed] = emailsTo(email);
    expect(claimed?.subject).toBe(`You now own ${name} on AgentFirstStack`);
    expect(claimed?.text).toContain(`${BASE}${base}`);
    expect(claimed?.text).toContain("Account and security emails like this one are always sent.");
    expect(claimed?.headers["List-Unsubscribe"]).toBeUndefined();
    expect((await outbox(email))[0]).toMatchObject({ kind: "project_claimed", category: "account", status: "sent" });

    const member = await join(agent.accountId, "joiner");
    const joined = emailsTo(email).find((m) => m.subject === `${member.email} joined ${name}`);
    expect(joined?.text).toContain(`${BASE}${base}/members`);
    expect(emailsTo(member.email)).toHaveLength(0); // the person who joined gets nothing

    const page = await owner.get(`${base}/members`);
    const uid = await userId(member.email);
    expect((await owner.post(`${base}/members/${uid}/remove`, { csrf: csrfOf(page.text) })).status).toBe(303);
    expect(emailsTo(member.email).map((m) => m.subject)).toEqual([`You no longer have access to ${name}`]);
  });

  it("deletion: the owner gets the restore date and the cleanup, members are told, and hear when it's back", async () => {
    const { agent, owner, email, name, base } = await owned("delmail");
    const member = await join(agent.accountId, "delmember");
    const settings = await owner.get(`${base}/settings`);
    expect((await owner.post(`${base}/delete`, { csrf: csrfOf(settings.text), confirm: name })).status).toBe(303);
    const deleted = emailsTo(email).find((m) => m.subject === `${name} is deleted`);
    expect(deleted?.text).toContain("You can restore it until");
    expect(deleted?.text).toContain("Remove it from this codebase");
    expect(deleted?.html).toContain("Restore it");
    expect(emailsTo(member.email).map((m) => m.subject)).toContain(`${name} was deleted`);

    const home = await owner.get("/dashboard");
    expect((await owner.post(`${base}/restore`, { csrf: csrfOf(home.text) })).status).toBe(303);
    expect(emailsTo(member.email).map((m) => m.subject)).toContain(`${name} is back`);
    expect(emailsTo(email).map((m) => m.subject)).not.toContain(`${name} is back`); // they did it
  });

  it("reminds the owner the day before the purge, once, and tells them when it's erased", async () => {
    const { agent, owner, email, name, base } = await owned("purgemail");
    const settings = await owner.get(`${base}/settings`);
    await owner.post(`${base}/delete`, { csrf: csrfOf(settings.text), confirm: name });
    const { purge_after } = (await E.DB.prepare("SELECT purge_after FROM accounts WHERE id = ?")
      .bind(agent.accountId)
      .first<{ purge_after: number }>())!;
    const env = testEnv();
    expect(await emailPurgeReminders(env, BASE, purge_after - 2 * DAY)).toBe(0);
    expect(await emailPurgeReminders(env, BASE, purge_after - DAY / 2)).toBeGreaterThanOrEqual(1);
    expect(await emailPurgeReminders(env, BASE, purge_after - DAY / 3)).toBe(0); // once
    await deliverDue(env, BASE, Date.now());
    expect(emailsTo(email).map((m) => m.subject)).toContain(`${name} will be erased tomorrow`);

    expect((await purgeDeletedProjects(env, purge_after + 1)).purged).toContain(agent.accountId);
    await deliverDue(env, BASE, Date.now());
    expect(emailsTo(email).map((m) => m.subject)).toContain(`${name} is erased`);
  });

  it("tells the owner about a suspension and its end", async () => {
    const ADMIN = "test-admin-token-0123456789";
    const env = testEnv({ ADMIN_TOKEN: ADMIN });
    const { agent, email, name } = await owned("suspmail");
    const path = `/v1/admin/accounts/${agent.accountId}`;
    await call("POST", `${path}/suspend`, { env, key: ADMIN, json: { reason: "internal note" } });
    await call("POST", `${path}/suspend`, { env, key: ADMIN, json: { reason: "again" } }); // retry: no second email
    const suspended = emailsTo(email).filter((m) => m.subject === `${name} is suspended`);
    expect(suspended).toHaveLength(1);
    expect(suspended[0]?.text).not.toContain("internal note"); // the operator's reason stays private
    await call("POST", `${path}/unsuspend`, { env, key: ADMIN, json: {} });
    expect(emailsTo(email).map((m) => m.subject)).toContain(`${name} works again`);
  });

  it("confirms an account deletion and keeps none of the person's emails", async () => {
    const { owner, email } = await owned("accdel");
    const page = await owner.get("/dashboard/account");
    expect(page.text).toContain("Emails we sent you recently");
    expect((await owner.post("/dashboard/account/delete", { csrf: csrfOf(page.text), confirm: "delete" })).status).toBe(200);
    expect(emailsTo(email).map((m) => m.subject)).toContain("Your AgentFirstStack account is deleted");
    expect(await outbox(email)).toEqual([]);
  });

  it("sends a security notice when a chat app is connected", async () => {
    const reg = await call("POST", "/oauth/register", {
      json: { client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" },
      ip: "198.51.100.77",
    });
    const b = new Browser();
    const email = uniqueEmail("oauthmail");
    await b.signIn(email);
    const params = {
      response_type: "code",
      client_id: reg.json.client_id as string,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
      state: "st",
      resource: "https://afs.test/mcp",
    };
    const consent = await b.get(`/oauth/authorize?${new URLSearchParams(params)}`);
    expect(consent.status).toBe(200);
    const r = await b.post("/oauth/authorize", {
      ...params,
      csrf: csrfOf(consent.text),
      project: "new",
      project_name: "Chat project",
      access: "read",
      decision: "allow",
    });
    expect(r.status).toBe(303);
    const [m] = emailsTo(email);
    expect(m?.subject).toBe("Claude can now use Chat project");
    expect(m?.text).toContain("with read-only access");
    expect(m?.text).toContain("claude.ai");
  });
});

describe("emails: updates", () => {
  it("tells owners about new setup items once, with a one-click unsubscribe that sticks", async () => {
    const { agent, email, name } = await owned("notice");
    // Its agent checked the setup at an older catalog version and used its key lately.
    await E.DB.batch([
      E.DB.prepare("INSERT INTO setup_state (account_id, checked_at, catalog_version, seen) VALUES (?, ?, 1, '[]')").bind(
        agent.accountId,
        Date.now(),
      ),
      E.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE account_id = ?").bind(Date.now(), agent.accountId),
    ]);
    const env = testEnv();
    const first = await refreshNotices(env, BASE);
    expect(first.emails).toBeGreaterThanOrEqual(1);
    expect((await refreshNotices(env, BASE)).emails).toBe(0); // once per catalog version
    expect(emailsTo(email).filter((m) => m.subject === `New in AgentFirstStack for ${name}`)).toHaveLength(0); // queued, not sent yet
    await deliverDue(env, BASE, Date.now());
    const [m] = emailsTo(email).filter((x) => x.subject === `New in AgentFirstStack for ${name}`);
    expect(m?.text).toContain("/v1/setup");
    expect(m?.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const url = /^<(.+)>$/.exec(m?.headers["List-Unsubscribe"] ?? "")?.[1] ?? "";
    expect(url).toContain("/email/unsubscribe?u=usr_");
    expect((await outbox(email)).find((r) => r.kind === "setup_notice")).toMatchObject({ category: "updates", status: "sent" });

    // GET only asks; a forged signature is refused; POST (one-click) turns updates off.
    const path = new URL(url).pathname + new URL(url).search;
    const ask = await call("GET", path);
    expect(ask.status).toBe(200);
    expect(ask.text).toContain("Turn off updates?");
    const uid = (await userId(email))!;
    expect(await E.DB.prepare("SELECT email_updates FROM users WHERE id = ?").bind(uid).first("email_updates")).toBe(1);
    expect((await call("POST", `/email/unsubscribe?u=${uid}&s=${"0".repeat(64)}`)).status).toBe(400);
    expect(
      (await call("POST", path, { body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } }))
        .status,
    ).toBe(200);
    expect(await E.DB.prepare("SELECT email_updates FROM users WHERE id = ?").bind(uid).first("email_updates")).toBe(0);
    const later = await queueEmail(env, BASE, {
      kind: "setup_notice",
      category: "updates",
      dedupeKey: `setup_notice:${agent.accountId}:${CATALOG_VERSION + 1}:${uid}`,
      to: { userId: uid, email },
      content: { subject: "Later", body: ["x"] },
    });
    expect(later).toBe("opted_out");
    // Account emails still go out, and the account page turns updates back on.
    expect(await unsubscribeUrl(env, BASE, uid)).toBe(url);
  });

  it("lets a person turn updates back on in Account", async () => {
    const b = new Browser();
    const email = uniqueEmail("prefs");
    await b.signIn(email);
    const page = await b.get("/dashboard/account");
    expect(page.text).toContain('name="updates" value="on" checked');
    expect((await b.post("/dashboard/account/emails", { csrf: csrfOf(page.text) })).status).toBe(303);
    const uid = (await userId(email))!;
    expect(await E.DB.prepare("SELECT email_updates FROM users WHERE id = ?").bind(uid).first("email_updates")).toBe(0);
    expect((await b.get("/dashboard/account?emails=saved")).text).not.toContain('value="on" checked');
    await b.post("/dashboard/account/emails", { csrf: csrfOf(page.text), updates: "on" });
    expect(await E.DB.prepare("SELECT email_updates FROM users WHERE id = ?").bind(uid).first("email_updates")).toBe(1);
  });
});

it("leaves no email in the outbox for addresses no test expected", () => {
  expect(sentEmails.every((m) => m.to.endsWith("@example.com"))).toBe(true);
});
