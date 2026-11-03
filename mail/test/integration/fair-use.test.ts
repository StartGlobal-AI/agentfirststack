import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../src/env";
import { createInbox, getInboxRow, purgeOldSharedMessages } from "../../src/service/inboxes";
import { assertReplyOnly } from "../../src/service/send";
import { E, call, deliver, eml, signup } from "./helpers";

// The hosted platform's abuse controls. Each is off unless its var is set, so these tests turn
// them on for one call at a time with a modified env.
const hosted = (vars: Partial<AppEnv>): AppEnv => ({ ...E, ...vars });

async function errorOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { status: number; code: string; hint?: string };
  }
  throw new Error("expected the call to fail");
}

describe("hosted fair-use controls", () => {
  it("MAX_INBOXES_PER_ACCOUNT caps new inboxes but still returns existing ones", async () => {
    const { json } = await signup(); // creates the default inbox: 1 of 2
    const env = hosted({ MAX_INBOXES_PER_ACCOUNT: "2" });
    const second = await createInbox(env, json.account_id, { username: `cap-${crypto.randomUUID().slice(0, 6)}` });
    const err = await errorOf(createInbox(env, json.account_id, {}));
    expect(err.status).toBe(403);
    expect(err.code).toBe("quota_exceeded");
    expect(err.hint).toBeTruthy();
    // Retrying the create for an address you already own is still fine.
    const again = await createInbox(env, json.account_id, { username: second.inbox.username });
    expect(again.existing).toBe(true);
  });

  it("EXTRA_RESERVED_USERNAMES blocks operator brand/role names on the shared domain", async () => {
    const { json } = await signup();
    const env = hosted({ EXTRA_RESERVED_USERNAMES: "hello, billing,AgentFirstStack" });
    for (const u of ["hello", "billing", "agentfirststack"]) {
      const err = await errorOf(createInbox(env, json.account_id, { username: u }));
      expect(err.status).toBe(400);
    }
    // The built-in CA-validation addresses stay reserved regardless.
    const ca = await call("POST", "/v1/inboxes", { key: json.api_key, body: { username: "postmaster" } });
    expect(ca.status).toBe(400);
  });

  it("SHARED_SEND_POLICY=reply_only only allows writing to people who wrote first", async () => {
    const { json, inbox } = await signup();
    const row = await getInboxRow(E, json.account_id, inbox.id);
    const env = hosted({ SHARED_SEND_POLICY: "reply_only" });

    const err = await errorOf(assertReplyOnly(env, row, ["stranger@example.org"]));
    expect(err.status).toBe(403);
    expect(err.code).toBe("reply_only");

    await deliver(
      "Friend@Example.org",
      inbox.address,
      eml({ from: "Friend@Example.org", to: inbox.address, subject: "hi", body: "hello" }),
    );
    await expect(assertReplyOnly(env, row, ["friend@example.org"])).resolves.toBeUndefined();
    // One unknown recipient among known ones still fails, and names it.
    const mixed = await errorOf(assertReplyOnly(env, row, ["friend@example.org", "cold@example.net"]));
    expect(mixed.code).toBe("reply_only");
    // Off by default.
    await expect(assertReplyOnly(E, row, ["stranger@example.org"])).resolves.toBeUndefined();
  });

  it("SHARED_RETENTION_DAYS purges old shared-domain mail", async () => {
    const { key, inbox } = await signup();
    await deliver(
      "a@sender.example",
      inbox.address,
      eml({ from: "a@sender.example", to: inbox.address, subject: "old", body: "code 123456" }),
    );
    expect((await call("GET", `/v1/inboxes/${inbox.id}/messages`, { key })).json.messages).toHaveLength(1);

    expect((await purgeOldSharedMessages(E)).purged_messages).toBe(0); // off without the var
    const env = hosted({ SHARED_RETENTION_DAYS: "30" });
    expect((await purgeOldSharedMessages(env)).purged_messages).toBe(0); // too new
    const r = await purgeOldSharedMessages(env, Date.now() + 31 * 86_400_000);
    expect(r.purged_messages).toBeGreaterThanOrEqual(1);
    expect((await call("GET", `/v1/inboxes/${inbox.id}/messages`, { key })).json.messages).toHaveLength(0);
  });
});
