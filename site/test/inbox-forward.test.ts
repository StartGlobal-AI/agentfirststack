import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import type { InboxForward } from "../src/services";
import { Browser, E, call, csrfOf, signup, testEnv, uniqueEmail } from "./helpers";

/** A mail service with one inbox whose forwarding setting the dashboard can change. */
function mailWith(forward: InboxForward | undefined) {
  const patches: { path: string; body: unknown; internal: string | null }[] = [];
  const state = { forward };
  const MAIL = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (req.headers.get("x-afs-internal") !== E.INTERNAL_TOKEN)
        return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
      if (req.method === "GET" && url.pathname === "/v1/inboxes")
        return Response.json({
          inboxes: [
            {
              id: "inb_shop0000000",
              address: "shop-signups@afs.test",
              display_name: null,
              last_message_at: null,
              created_at: 1,
              ...(state.forward ? { forward: state.forward } : {}),
            },
          ],
        });
      if (req.method === "PATCH" && url.pathname === "/v1/inboxes/inb_shop0000000") {
        const body = (await req.json()) as { forward: Partial<InboxForward> };
        if (body.forward.timezone === "Mars/Base")
          return Response.json(
            { error: { code: "bad_request", message: "Unknown time zone Mars/Base.", hint: "An IANA name, e.g. Europe/Berlin." } },
            { status: 400 },
          );
        patches.push({ path: url.pathname, body, internal: req.headers.get("x-afs-internal") });
        state.forward = { ...state.forward!, ...body.forward };
        return Response.json({ inbox: { id: "inb_shop0000000", forward: state.forward } });
      }
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    },
  } as unknown as Fetcher;
  return { MAIL, patches, state };
}

const OFF: InboxForward = { mode: "off", digest_hour: 8, timezone: "UTC", recipients: 0, waiting_for_owner: false };

async function claimAs(agentKey: string, env: Bindings, email: string) {
  const link = (await call("POST", "/v1/claim-link", { key: agentKey, env })).json.url as string;
  const b = new Browser(env);
  const path = new URL(link).pathname;
  await b.signIn(email, path);
  const page = await b.get(path);
  expect((await b.post(path, { csrf: csrfOf(page.text) })).status).toBe(303);
  return b;
}

describe("inbox forwarding", () => {
  it("the setup check says when nobody gets the inbox's mail, and the table says where it goes", async () => {
    const agent = await signup("shop.test");
    const off = mailWith(OFF);
    const r = await call("GET", "/v1/setup?services=mail", { key: agent.key, env: testEnv({ MAIL: off.MAIL } as Partial<Bindings>) });
    const fwd = r.json.checks.find((c: { id: string }) => c.id === "mail.forwarding");
    expect(fwd).toMatchObject({ status: "warning", detail: expect.stringContaining("Not forwarded: shop-signups@afs.test") });
    expect(fwd.fix).toContain('{"forward":{"mode":"each"}}');
    expect(r.json.rows.find((x: { part: string }) => x.part === "Inbox")).toMatchObject({ status: "warning" });

    const each = mailWith({ ...OFF, mode: "each", waiting_for_owner: true });
    const r2 = await call("GET", "/v1/setup?services=mail", { key: agent.key, env: testEnv({ MAIL: each.MAIL } as Partial<Bindings>) });
    expect(r2.json.rows.find((x: { part: string }) => x.part === "Inbox")).toMatchObject({
      status: "ok",
      details: "shop-signups@afs.test: forwarded to the owner as each email arrives (starts when the owner claims the project).",
    });
    const digest = mailWith({ ...OFF, mode: "digest", digest_hour: 7, timezone: "Asia/Kolkata", recipients: 1 });
    const r3 = await call("GET", "/v1/setup?services=mail", { key: agent.key, env: testEnv({ MAIL: digest.MAIL } as Partial<Bindings>) });
    expect(r3.json.report_markdown).toContain(
      "| ✅ | Inbox | shop-signups@afs.test: forwarded to the owner as a daily digest at 07:00 (Asia/Kolkata). |",
    );
  });

  it("the owner changes it in the dashboard; members see it but can't", async () => {
    const agent = await signup("shop.test");
    const mail = mailWith({ ...OFF, mode: "each", recipients: 1 });
    const env = testEnv({ MAIL: mail.MAIL } as Partial<Bindings>);
    const owner = await claimAs(agent.key, env, uniqueEmail("owner"));
    const projectPath = `/dashboard/projects/${agent.accountId}`;
    const page = await owner.get(projectPath);
    expect(page.text).toContain("Email from your inbox");
    expect(page.text).toContain("Each email is forwarded as it arrives.");
    expect(page.text).toMatch(/<option value="each" selected>Each email as it arrives<\/option>/);

    const action = `/dashboard/projects/${agent.accountId}/inboxes/inb_shop0000000/forward`;
    const saved = await owner.submit(projectPath, action, { mode: "digest", digest_hour: "9", timezone: "Europe/Berlin" });
    expect(saved.status).toBe(303);
    expect(saved.location).toBe(projectPath);
    expect(mail.patches).toEqual([
      {
        path: "/v1/inboxes/inb_shop0000000",
        body: { forward: { mode: "digest", digest_hour: 9, timezone: "Europe/Berlin" } },
        internal: E.INTERNAL_TOKEN,
      },
    ]);
    expect((await owner.get(projectPath)).text).toContain("One digest a day at 09:00 (Europe/Berlin).");
    // The mail service's own validation comes back to the owner.
    const bad = await owner.submit(projectPath, action, { mode: "digest", digest_hour: "9", timezone: "Mars/Base" });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("Unknown time zone Mars/Base.");
    expect((await owner.submit(projectPath, action, { mode: "weekly", digest_hour: "9", timezone: "UTC" })).status).toBe(400);

    // A second person joins as a member: they see the setting, without the form.
    const member = await claimAs(agent.key, env, uniqueEmail("member"));
    const theirs = await member.get(projectPath);
    expect(theirs.text).toContain("Only the project's owner can change it.");
    expect(theirs.text).not.toContain(action);
    const tried = await member.post(action, { csrf: csrfOf(theirs.text), mode: "off", digest_hour: "8", timezone: "UTC" });
    expect(tried.status).toBe(403);
    expect(mail.patches.length).toBe(1);
  });

  it("shows nothing about forwarding when the mail service doesn't have the setting", async () => {
    const agent = await signup("shop.test");
    const mail = mailWith(undefined);
    const env = testEnv({ MAIL: mail.MAIL } as Partial<Bindings>);
    const owner = await claimAs(agent.key, env, uniqueEmail("owner"));
    expect((await owner.get(`/dashboard/projects/${agent.accountId}`)).text).not.toContain("Email from your inbox");
  });
});
