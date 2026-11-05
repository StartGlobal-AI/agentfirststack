import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORWARD,
  DIGEST_MAX_LISTED,
  type DigestItem,
  canonicalTimezone,
  digestDue,
  digestEmail,
  eachForwardEmail,
  forwardEligibility,
  forwardFooter,
  forwardFromName,
  localParts,
  mergeForward,
  previewOf,
  stripActiveHtml,
} from "../../src/lib/forwarding";
import { type InboxRow, forwardJson, inboxJson } from "../../src/service/format";
import { dashboardUrl } from "../../src/service/forward";

// Pure parts of forwarding to the project's members (integration side: test/integration/forward.test.ts).

const ok = {
  headers: [],
  envelopeFrom: "bounce@github.com",
  fromAddress: "noreply@github.com",
  authVerdict: "pass",
  tag: null,
  internal: false,
};
const h = (key: string, value: string) => ({ key, value });

describe("forwardEligibility: what may be forwarded", () => {
  it("authenticated mail from a service is forwarded; newsletters too", () => {
    expect(forwardEligibility(ok)).toEqual({ kind: "forward" });
    expect(forwardEligibility({ ...ok, headers: [h("List-Unsubscribe", "<https://x>"), h("Precedence", "bulk")] })).toEqual({
      kind: "forward",
    });
    expect(forwardEligibility({ ...ok, headers: [h("Auto-Submitted", "no")] })).toEqual({ kind: "forward" });
  });

  it("machine notices (auto-generated) are listed in digests only", () => {
    expect(forwardEligibility({ ...ok, headers: [h("Auto-Submitted", "auto-generated")] })).toEqual({ kind: "list" });
    expect(forwardEligibility({ ...ok, headers: [h("Auto-Submitted", "Auto-Notified; owner-email=x")] })).toEqual({ kind: "list" });
  });

  it("never: unauthenticated, internal, our own forwards, the setup test, bounces, auto-replies", () => {
    for (const verdict of ["fail", "unknown", "none", null, undefined])
      expect(forwardEligibility({ ...ok, authVerdict: verdict })).toEqual({ skip: "unauthenticated" });
    expect(forwardEligibility({ ...ok, internal: true })).toEqual({ skip: "internal" });
    expect(forwardEligibility({ ...ok, headers: [h("X-AFS-Forwarded", "msg_1")] })).toEqual({ skip: "forwarded_marker" });
    expect(forwardEligibility({ ...ok, headers: [h("x-afs-forwarded", "digest inb_1")] })).toEqual({ skip: "forwarded_marker" });
    expect(forwardEligibility({ ...ok, tag: "afs-test" })).toEqual({ skip: "setup_test" });
    expect(forwardEligibility({ ...ok, tag: "AFS-TEST" })).toEqual({ skip: "setup_test" });
    expect(forwardEligibility({ ...ok, tag: "github" })).toEqual({ kind: "forward" });
    expect(forwardEligibility({ ...ok, envelopeFrom: "" })).toEqual({ skip: "bounce" });
    expect(forwardEligibility({ ...ok, envelopeFrom: "<>" })).toEqual({ skip: "bounce" });
    expect(forwardEligibility({ ...ok, fromAddress: "MAILER-DAEMON@mx.example" })).toEqual({ skip: "bounce" });
    expect(forwardEligibility({ ...ok, fromAddress: "postmaster@mx.example" })).toEqual({ skip: "bounce" });
    expect(forwardEligibility({ ...ok, headers: [h("Content-Type", "multipart/report; report-type=delivery-status")] })).toEqual({
      skip: "bounce",
    });
    expect(forwardEligibility({ ...ok, headers: [h("X-Failed-Recipients", "a@b.c")] })).toEqual({ skip: "bounce" });
    expect(forwardEligibility({ ...ok, headers: [h("Auto-Submitted", "auto-replied")] })).toEqual({ skip: "auto_reply" });
    expect(forwardEligibility({ ...ok, headers: [h("Auto-Submitted", "something-else")] })).toEqual({ skip: "auto_reply" });
    expect(forwardEligibility({ ...ok, headers: [h("X-Autoreply", "yes")] })).toEqual({ skip: "auto_reply" });
    expect(forwardEligibility({ ...ok, headers: [h("X-Autorespond", "1")] })).toEqual({ skip: "auto_reply" });
    expect(forwardEligibility({ ...ok, headers: [h("Precedence", "auto_reply")] })).toEqual({ skip: "auto_reply" });
  });
});

describe("the forward setting", () => {
  it("merges partial updates and canonicalises the time zone", () => {
    const a = mergeForward(DEFAULT_FORWARD, { mode: "digest", digest_hour: 7, timezone: "europe/berlin" });
    expect(a).toEqual({ mode: "digest", digest_hour: 7, timezone: "Europe/Berlin" });
    expect(mergeForward(a, { mode: "each" })).toEqual({ mode: "each", digest_hour: 7, timezone: "Europe/Berlin" });
    expect(mergeForward(a, {})).toEqual(a);
    expect(mergeForward(a, undefined)).toEqual(a);
    expect(DEFAULT_FORWARD).toEqual({ mode: "off", digest_hour: 8, timezone: "UTC" });
  });

  it("refuses a bad time zone, hour or mode with a hint (400)", () => {
    const err = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e as { status: number; hint?: string };
      }
      throw new Error("expected a throw");
    };
    for (const tz of ["Mars/Base", "", "UTC+5", "+05:00", "Europe/Berlin; DROP", "x".repeat(80)]) {
      const e = err(() => mergeForward(DEFAULT_FORWARD, { timezone: tz }));
      expect(e.status, tz).toBe(400);
      expect(e.hint).toMatch(/IANA/);
    }
    for (const hour of [-1, 24, 7.5]) expect(err(() => mergeForward(DEFAULT_FORWARD, { digest_hour: hour })).status).toBe(400);
    expect(err(() => mergeForward(DEFAULT_FORWARD, { mode: "weekly" as never })).status).toBe(400);
    expect(canonicalTimezone("UTC")).toBe("UTC");
    expect(canonicalTimezone("America/New_York")).toBe("America/New_York");
  });
});

describe("time zones and when a digest is due", () => {
  // 2026-11-05 07:30 UTC = 08:30 in Berlin (CET, UTC+1) = 02:30 in New York (EST) = 16:30 in Tokyo.
  const t = Date.UTC(2026, 10, 5, 7, 30);

  it("local hour and day in the inbox's time zone", () => {
    expect(localParts(t, "UTC")).toMatchObject({ day: "2026-11-05", hour: 7, time: "07:30", weekday: "Thu" });
    expect(localParts(t, "Europe/Berlin")).toMatchObject({ day: "2026-11-05", hour: 8, time: "08:30" });
    expect(localParts(t, "America/New_York")).toMatchObject({ day: "2026-11-05", hour: 2 });
    expect(localParts(Date.UTC(2026, 10, 5, 23, 30), "Asia/Tokyo")).toMatchObject({ day: "2026-11-06", hour: 8 });
    // Summer time: 07:30 UTC in July is 09:30 in Berlin (CEST).
    expect(localParts(Date.UTC(2026, 6, 1, 7, 30), "Europe/Berlin").hour).toBe(9);
    expect(localParts(Date.UTC(2026, 10, 5, 0, 5), "UTC")).toMatchObject({ hour: 0, time: "00:05" });
  });

  const base = {
    setting: { mode: "digest" as const, digest_hour: 8, timezone: "Europe/Berlin" },
    digestDay: null,
    lastForwardedAt: null,
    lastDigestAt: t - 86_400_000,
    oldestWaiting: t - 3_600_000,
    claimedAt: t - 10 * 86_400_000,
    now: t,
    graceMs: 600_000,
  };

  it("digest: at digest_hour local time, once per local day", () => {
    expect(digestDue(base)).toBe("digest");
    expect(digestDue({ ...base, setting: { ...base.setting, timezone: "UTC" } })).toBeNull(); // 07:xx in UTC
    expect(digestDue({ ...base, setting: { ...base.setting, timezone: "UTC", digest_hour: 7 } })).toBe("digest");
    expect(digestDue({ ...base, digestDay: "2026-11-05" })).toBeNull(); // already sent today
    expect(digestDue({ ...base, digestDay: "2026-11-04" })).toBe("digest");
    expect(digestDue({ ...base, oldestWaiting: null })).toBeNull(); // nothing new: nothing sent
    expect(digestDue({ ...base, setting: { ...base.setting, mode: "off" } })).toBeNull();
  });

  it("catch-up: never sent anything and mail waited since before the claim, at any hour", () => {
    const fresh = { ...base, lastDigestAt: null, claimedAt: t - 60_000, oldestWaiting: t - 3_600_000, now: t + 5 * 3_600_000 };
    expect(digestDue(fresh)).toBe("catch_up");
    expect(digestDue({ ...fresh, setting: { ...fresh.setting, mode: "each" } })).toBe("catch_up");
    // Claimed before the mail arrived: no catch-up, the normal mode applies.
    expect(digestDue({ ...fresh, claimedAt: t - 7_200_000 })).toBeNull();
    expect(digestDue({ ...fresh, lastForwardedAt: t })).toBeNull();
  });

  it("each: only what the live forward left for longer than the grace period", () => {
    const each = { ...base, setting: { ...base.setting, mode: "each" as const }, lastForwardedAt: t - 1000 };
    expect(digestDue({ ...each, oldestWaiting: t - 60_000 })).toBeNull();
    expect(digestDue({ ...each, oldestWaiting: t - 700_000 })).toBe("leftover");
  });
});

const item = (n: number, extra: Partial<DigestItem> = {}): DigestItem => ({
  id: `msg_${n}`,
  from_address: `noreply${n}@service.example`,
  from_name: `Service ${n}`,
  subject: `Subject ${n}`,
  received_at: Date.UTC(2026, 10, 5, 7, n % 60),
  code: null,
  verify_link: null,
  snippet: `Body of message ${n}`,
  ...extra,
});

const footer = forwardFooter({
  inboxAddress: "shop-signups@agentfirststack.com",
  project: "acme.com",
  dashboardUrl: "https://agentfirststack.com/dashboard/projects/acct_1",
  mode: "digest",
});

describe("the digest email", () => {
  const digest = (items: DigestItem[], extra: Partial<Parameters<typeof digestEmail>[0]> = {}) =>
    digestEmail({
      inboxAddress: "shop-signups@agentfirststack.com",
      items,
      timezone: "Europe/Berlin",
      reason: "digest",
      mode: "digest",
      digestHour: 8,
      unauthenticated: 0,
      pausedAt: null,
      dailyLimit: 100,
      footer,
      ...extra,
    });

  it("lists every message newest first with sender, subject, local time, code, link and a preview", () => {
    const d = digest([
      item(2, { code: "482913", snippet: "Your code is 482913.   Use it within 10 minutes." }),
      item(1, { verify_link: "https://example.com/verify?t=abc" }),
    ]);
    expect(d.subject).toBe("2 new emails at shop-signups@agentfirststack.com");
    expect(digest([item(1)]).subject).toBe("1 new email at shop-signups@agentfirststack.com");
    expect(d.text.indexOf("Subject 2")).toBeLessThan(d.text.indexOf("Subject 1"));
    expect(d.text).toContain("From: Service 2 <noreply2@service.example>");
    expect(d.text).toContain("Received: Thu 2026-11-05 08:02 Europe/Berlin");
    expect(d.text).toContain("Code: 482913");
    expect(d.text).toContain("Link: https://example.com/verify?t=abc");
    expect(d.text).toContain("Your code is 482913. Use it within 10 minutes.");
    expect(d.text).toContain(footer);
    expect(d.html).toContain("482913");
    expect(d.more).toBe(0);
  });

  it(`caps the list at ${DIGEST_MAX_LISTED} with "and N more"; total counts what was not loaded`, () => {
    const many = Array.from({ length: 63 }, (_, i) => item(63 - i));
    const d = digest(many);
    expect(d.subject).toBe("63 new emails at shop-signups@agentfirststack.com");
    expect(d.listed).toBe(50);
    expect(d.text).toContain("...and 13 more.");
    expect(digest(many, { total: 70 }).text).toContain("...and 20 more.");
  });

  it("counts unauthenticated mail, explains a pause and a catch-up", () => {
    const d = digest([item(1)], { unauthenticated: 3, pausedAt: Date.UTC(2026, 10, 4, 15), reason: "catch_up", mode: "each" });
    expect(d.text).toContain("Not listed: 3 emails that failed sender authentication");
    expect(d.text).toContain("Forwarding paused on 2026-11-04 (UTC) at the project's daily limit of 100 forwarded emails");
    expect(d.text).toContain("before anyone claimed the project. From now on each email is forwarded as it arrives.");
    expect(digest([item(1)], { reason: "catch_up" }).text).toContain("one digest a day at 08:00 (Europe/Berlin)");
  });

  it("escapes third-party text in HTML and caps previews", () => {
    const d = digest([item(1, { subject: "<script>alert(1)</script>", from_name: 'Evil "x" <y>', snippet: "a".repeat(1000) })]);
    expect(d.html).not.toContain("<script>");
    expect(d.html).toContain("&lt;script&gt;");
    expect(previewOf("a".repeat(1000))).toHaveLength(300);
    expect(previewOf("  a \n\n b  ")).toBe("a b");
  });
});

describe("a forwarded message", () => {
  it("subject, header block, text, sanitized HTML and the footer", () => {
    const f = eachForwardEmail({
      inboxAddress: "shop-signups@agentfirststack.com",
      subject: "Verify your email",
      headerLines: ["---------- Forwarded message ---------", "From: GitHub <noreply@github.com>", "Subject: Verify your email"],
      text: "Your code is 123456",
      html: '<p onclick="steal()">Hi</p><script>bad()</script><a href="javascript:alert(1)">x</a><iframe src="https://evil"></iframe><form action="https://evil"><input name=a></form><img src="cid:logo">',
      footer: forwardFooter({ inboxAddress: "shop-signups@agentfirststack.com", project: "acct_1", dashboardUrl: null, mode: "each" }),
      note: "2 attachment(s) not included",
    });
    expect(f.subject).toBe("[shop-signups@agentfirststack.com] Verify your email");
    expect(f.text).toMatch(/^---------- Forwarded message ---------\nFrom: GitHub <noreply@github.com>/);
    expect(f.text).toContain("Your code is 123456");
    expect(f.text).toContain("[2 attachment(s) not included]");
    expect(f.text).toContain(
      "Forwarded by AgentFirstStack from shop-signups@agentfirststack.com (project acct_1) to the project's members. To get a daily digest instead or stop: ask your agent.",
    );
    expect(f.html).not.toMatch(/onclick|<script|javascript:|<iframe|<form|<input/i);
    expect(f.html).toContain('<img src="cid:logo">');
    expect(f.html).toContain("<p>Hi</p>");
    expect(eachForwardEmail({ inboxAddress: "a@b.c", subject: null, headerLines: [], text: "t", html: null, footer: "f" })).toMatchObject({
      subject: "[a@b.c] (no subject)",
      html: undefined,
    });
  });

  it("from name, footer with the dashboard link, and a subject without line breaks", () => {
    expect(forwardFromName({ address: "a@b.c", display_name: null })).toBe("a@b.c via AgentFirstStack");
    expect(forwardFromName({ address: "a@b.c", display_name: "Acme\r\nBcc: x" })).toBe("Acme Bcc: x via AgentFirstStack");
    expect(footer).toBe(
      "Forwarded by AgentFirstStack from shop-signups@agentfirststack.com (project acme.com) to the project's members. To get each email as it arrives instead, change the time or stop: ask your agent, or open https://agentfirststack.com/dashboard/projects/acct_1.",
    );
    expect(
      eachForwardEmail({ inboxAddress: "a@b.c", subject: "x\r\nBcc: y", headerLines: [], text: "t", html: null, footer: "f" }).subject,
    ).toBe("[a@b.c] x Bcc: y");
    expect(dashboardUrl({ AUTH_ISSUER: "https://agentfirststack.com/" }, "acct_1")).toBe(
      "https://agentfirststack.com/dashboard/projects/acct_1",
    );
    expect(dashboardUrl({ AUTH_ISSUER: "" }, "acct_1")).toBeNull();
    expect(dashboardUrl({}, "acct_1")).toBeNull();
  });

  it("stripActiveHtml keeps ordinary markup", () => {
    expect(stripActiveHtml('<div style="color:red"><b>Bold</b> <a href="https://x.example/a?b=1">link</a></div>')).toBe(
      '<div style="color:red"><b>Bold</b> <a href="https://x.example/a?b=1">link</a></div>',
    );
    expect(stripActiveHtml('<a href="data:text/html,evil">x</a>')).not.toContain("data:");
  });
});

describe("the contract: inbox JSON forward", () => {
  const row: InboxRow = {
    id: "inb_1",
    account_id: "acct_1",
    address: "a@b.c",
    username: "a",
    domain: "b.c",
    display_name: null,
    expires_at: null,
    last_message_at: null,
    created_at: 1,
  };

  it("has exactly the contract's fields, counts only", () => {
    const f = forwardJson(row, { recipients: 0, forwarded_today: 0, daily_limit: 100 });
    expect(f).toEqual({
      mode: "off",
      digest_hour: 8,
      timezone: "UTC",
      recipients: 0,
      waiting_for_owner: false,
      last_forwarded_at: null,
      last_digest_at: null,
      forwarded_today: 0,
      daily_limit: 100,
    });
    const on = forwardJson(
      { ...row, forward_mode: "each", forward_digest_hour: 9, forward_timezone: "Europe/Berlin", forward_last_forwarded_at: 5 },
      { recipients: 0, forwarded_today: 3, daily_limit: null },
    );
    expect(on).toMatchObject({
      mode: "each",
      digest_hour: 9,
      timezone: "Europe/Berlin",
      waiting_for_owner: true,
      last_forwarded_at: 5,
      daily_limit: null,
    });
    expect(forwardJson({ ...row, forward_mode: "digest" }, { recipients: 2, forwarded_today: 0, daily_limit: 100 }).waiting_for_owner).toBe(
      false,
    );
    expect(inboxJson(row, { recipients: 1, forwarded_today: 0, daily_limit: 100 }).forward.recipients).toBe(1);
  });
});
