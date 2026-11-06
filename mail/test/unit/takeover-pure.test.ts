import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../src/env";
import { RESERVED_USERNAMES, checkUsername, reservedKey, reservedKeys, reservedReason } from "../../src/lib/address";
import {
  DEFAULT_UNCLAIMED_MAX_MESSAGE_BYTES,
  MAX_MESSAGE_BYTES,
  SMALL_MESSAGE_BYTES,
  maxInboundMessageBytes,
  storageThresholds,
  storageVerdict,
} from "../../src/service/ingest";
import { groupBySenderDomain, senderDomainOf } from "../../src/service/wait";

// The pure parts of the account-takeover review fixes (test/integration/takeover.test.ts has the rest).

describe("1a. latest-code sender domains", () => {
  it("reports the registrable domain of the From address", () => {
    expect(senderDomainOf("noreply@github.com")).toBe("github.com");
    expect(senderDomainOf("NoReply@Mail.GitHub.com")).toBe("github.com");
    expect(senderDomainOf("x@mail.example.co.uk")).toBe("example.co.uk");
    expect(senderDomainOf("not-an-address")).toBeNull();
    expect(senderDomainOf(null)).toBeNull();
  });

  it("groups matches by sender domain, newest first, counting each domain's messages", () => {
    const row = (id: string, from: string, at: number) => ({ id, from_address: from, received_at: at, auth_json: '{"verdict":"pass"}' });
    const g = groupBySenderDomain([
      row("m3", "noreply@github.com", 3),
      row("m2", "verify@evil.example", 2),
      row("m1", "noreply@mail.github.com", 1),
    ]);
    expect(g).toEqual([
      { sender_domain: "github.com", from: "noreply@github.com", message_id: "m3", received_at: 3, auth_verdict: "pass", messages: 2 },
      { sender_domain: "evil.example", from: "verify@evil.example", message_id: "m2", received_at: 2, auth_verdict: "pass", messages: 1 },
    ]);
    // One site's subdomains are one sender: never ambiguous on their own.
    expect(groupBySenderDomain([row("a", "a@github.com", 2), row("b", "b@mail.github.com", 1)])).toHaveLength(1);
  });
});

describe("1c. reserved usernames", () => {
  it("covers the names a platform uses for itself, on the shared domain only", () => {
    const names = [
      "notifications",
      "privacy",
      "conduct",
      "alerts",
      "billing",
      "legal",
      "hello",
      "dmarc",
      "security",
      "abuse",
      "support",
      "signups",
      "operator",
      "team",
      "contact",
      "help",
      "press",
      "status",
      "verify",
      "verification",
      "account",
      "accounts",
      "login",
      "register",
      "owner",
      "staff",
      "official",
      "noreply",
      "no-reply",
      "donotreply",
      "mailer",
      "bounce",
      "bounces",
      "postmaster",
      "mailer-daemon",
    ];
    for (const u of names) {
      expect(checkUsername(u, { sharedDomain: true }), u).toMatchObject({ ok: false, reserved: true });
      expect(checkUsername(u, { sharedDomain: false }).ok, u).toBe(true);
    }
    for (const u of RESERVED_USERNAMES) expect(checkUsername(u, { sharedDomain: true }).ok, u).toBe(false);
  });

  it('ignores ".", "_" and "-" and case, so look-alike spellings are reserved too', () => {
    for (const u of [
      "No.Reply",
      "no_reply",
      "do.not.reply",
      "post-master",
      "post_master",
      "mailer.daemon",
      "Notifi-cations",
      "dmarc_reports",
    ])
      expect(checkUsername(u, { sharedDomain: true }).ok, u).toBe(false);
    expect(reservedKey(" No.Re_ply ")).toBe("noreply");
  });

  it("does not reserve names that only contain a reserved word", () => {
    for (const u of ["acme-signups", "helper", "billing-acme", "support-desk-42", "teamwork", "k3x9mq2v7d"])
      expect(checkUsername(u, { sharedDomain: true }).ok, u).toBe(true);
  });

  it("EXTRA_RESERVED_USERNAMES is matched the same way and joins the list", () => {
    const extra = " AgentFirstStack, acme-brand ,";
    expect(reservedReason("agent-first-stack", extra)).toBe("extra");
    expect(reservedReason("Acme.Brand", extra)).toBe("extra");
    expect(reservedReason("billing", extra)).toBe("built_in");
    expect(reservedReason("acme-signups", extra)).toBeNull();
    expect(checkUsername("acme_brand", { sharedDomain: true, extraReserved: extra })).toMatchObject({ ok: false, reserved: true });
    const keys = reservedKeys(extra);
    expect(keys).toContain("agentfirststack");
    expect(keys).toContain("acmebrand");
    expect(keys).toContain("noreply");
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("2e. storage one sender cannot fill", () => {
  const MiB = 1024 * 1024;
  const cap = 100 * MiB;

  it("small mail fits until the storage is completely full", () => {
    expect(storageVerdict(cap, cap - 10_000, 10_000, 99 * MiB)).toBeNull();
    expect(storageVerdict(cap, cap - 9_999, 10_000, 0)).toBe("full");
    expect(storageVerdict(cap, 99 * MiB, SMALL_MESSAGE_BYTES, 99 * MiB)).toBeNull();
  });

  it("larger mail keeps out of the last 5%, and past 80% the senders that keep 10% are refused first", () => {
    const t = storageThresholds(cap);
    expect(t).toEqual({ largeLimit: 95 * MiB, nearFull: 80 * MiB, heavySender: 10 * MiB });
    const big = SMALL_MESSAGE_BYTES + 1;
    // Below 80%: anyone, however much they keep.
    expect(storageVerdict(cap, 50 * MiB, big, 50 * MiB)).toBeNull();
    // Past 80%: a heavy sender is refused, a light one is not; before the headers (no sender) only the hard rules apply.
    expect(storageVerdict(cap, 85 * MiB, big, 40 * MiB)).toBe("heavy_sender");
    expect(storageVerdict(cap, 85 * MiB, big, 1 * MiB)).toBeNull();
    expect(storageVerdict(cap, 85 * MiB, big)).toBeNull();
    // The last 5% is for small mail only, whoever sends it.
    expect(storageVerdict(cap, 95 * MiB, big, 0)).toBe("reserved_for_small_mail");
    expect(storageVerdict(cap, 95 * MiB, big)).toBe("reserved_for_small_mail");
    expect(storageVerdict(Number.POSITIVE_INFINITY, 10 ** 12, 25 * MiB, 10 ** 12)).toBeNull();
  });

  it("MAX_INBOUND_MESSAGE_BYTES: 25 MiB, 10 MiB unclaimed, never above Email Routing's limit, 0 = 25 MiB", () => {
    const claimed = { suspended: false, claimed: true };
    const unclaimed = { suspended: false, claimed: false };
    const env = (vars: Record<string, string>) => vars as unknown as AppEnv;
    expect(maxInboundMessageBytes(env({}), claimed)).toBe(MAX_MESSAGE_BYTES);
    expect(maxInboundMessageBytes(env({}), unclaimed)).toBe(DEFAULT_UNCLAIMED_MAX_MESSAGE_BYTES);
    expect(DEFAULT_UNCLAIMED_MAX_MESSAGE_BYTES).toBe(10 * MiB);
    expect(maxInboundMessageBytes(env({ MAX_INBOUND_MESSAGE_BYTES: String(5 * MiB) }), claimed)).toBe(5 * MiB);
    expect(maxInboundMessageBytes(env({ UNCLAIMED_MAX_INBOUND_MESSAGE_BYTES: String(2 * MiB) }), unclaimed)).toBe(2 * MiB);
    expect(maxInboundMessageBytes(env({ MAX_INBOUND_MESSAGE_BYTES: String(100 * MiB) }), claimed)).toBe(MAX_MESSAGE_BYTES);
    expect(maxInboundMessageBytes(env({ MAX_INBOUND_MESSAGE_BYTES: "0" }), claimed)).toBe(MAX_MESSAGE_BYTES);
  });
});
