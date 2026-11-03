import { describe, expect, it } from "vitest";
import {
  checkUsername,
  formatAddress,
  normalizeDomain,
  normalizeOutgoingAddress,
  normalizeRecipient,
  randomUsername,
  USERNAME_RE,
} from "../../src/lib/address";
import { buildReferences, hasReplyPrefix, normalizeSubject, parseMessageIds, replySubject, threadLookupIds } from "../../src/lib/threading";

describe("usernames", () => {
  it("normalises case and whitespace", () => {
    expect(checkUsername("  Acme.Signups ", { sharedDomain: true })).toEqual({ ok: true, username: "acme.signups" });
  });
  it.each(["", "-acme", "acme-", ".acme", "a..b", "a b", "a+b", "ä", "x".repeat(65), "a@b"])("rejects %j", (u) => {
    expect(checkUsername(u, { sharedDomain: false }).ok).toBe(false);
  });
  it.each(["a", "a1", "acme_signups", "acme-ads.2026", "x".repeat(64)])("accepts %j", (u) => {
    expect(checkUsername(u, { sharedDomain: false }).ok).toBe(true);
  });
  it("reserves CA-validation and role addresses on the shared domain only", () => {
    for (const u of ["admin", "administrator", "hostmaster", "postmaster", "webmaster", "abuse"]) {
      expect(checkUsername(u, { sharedDomain: true }).ok).toBe(false);
      expect(checkUsername(u, { sharedDomain: false }).ok).toBe(true);
    }
  });
  it("random usernames are valid and distinct", () => {
    const set = new Set(Array.from({ length: 200 }, randomUsername));
    expect(set.size).toBe(200);
    for (const u of set) expect(USERNAME_RE.test(u)).toBe(true);
  });
});

describe("domains and recipients", () => {
  it("normalises domains", () => {
    expect(normalizeDomain("Example.COM.")).toBe("example.com");
    expect(normalizeDomain("mail.example.co.uk")).toBe("mail.example.co.uk");
    expect(normalizeDomain("bücher.de")).toBe("xn--bcher-kva.de");
    for (const bad of ["localhost", "example", "-a.com", "a-.com", "1.2.3.4", "https://x.com", "a b.com", "x.com/path", ""]) {
      expect(normalizeDomain(bad)).toBeNull();
    }
  });
  it("maps RCPT TO to the inbox address: lowercase, no brackets, +tag stripped", () => {
    expect(normalizeRecipient("<Acme+Meta@Mail.Example.com>")).toEqual({ address: "acme@mail.example.com", tag: "meta" });
    expect(normalizeRecipient("acme@mail.example.com")).toEqual({ address: "acme@mail.example.com", tag: null });
    expect(normalizeRecipient("+x@mail.example.com")).toBeNull();
    expect(normalizeRecipient("not-an-address")).toBeNull();
  });
  it("validates outgoing addresses", () => {
    expect(normalizeOutgoingAddress("Jane <Jane.Doe@Example.com>")).toBe("Jane.Doe@example.com");
    expect(normalizeOutgoingAddress("a+b@x.io")).toBe("a+b@x.io");
    for (const bad of ["a@b", "a b@x.com", "a..b@x.com", ".a@x.com", "a@x.com, b@y.com", "@x.com"])
      expect(normalizeOutgoingAddress(bad)).toBeNull();
  });
  it("formats display names safely", () => {
    expect(formatAddress("a@x.com", "Acme Bot")).toBe("Acme Bot <a@x.com>");
    expect(formatAddress("a@x.com", 'Evil "Q"\r\nBcc: x')).toBe('"Evil \\"Q\\"  Bcc: x" <a@x.com>');
  });
});

describe("threading", () => {
  it("parses message ids", () => {
    expect(parseMessageIds("<a@x> <b@y>\r\n <a@x>")).toEqual(["<a@x>", "<b@y>"]);
    expect(parseMessageIds("bare@host")).toEqual(["<bare@host>"]);
    expect(parseMessageIds(null)).toEqual([]);
  });
  it("looks up In-Reply-To first, then References newest-first", () => {
    expect(threadLookupIds("<c@x>", "<a@x> <b@x> <c@x>")).toEqual(["<c@x>", "<b@x>", "<a@x>"]);
  });
  it("normalises subjects across languages and list tags", () => {
    expect(normalizeSubject("Re: RE: Fwd: [team] Re:  Hello   World")).toBe("hello world");
    expect(normalizeSubject("AW: WG: Angebot")).toBe("angebot");
    expect(normalizeSubject("Re[2]: Quote")).toBe("quote");
    expect(hasReplyPrefix("Re: hi")).toBe(true);
    expect(hasReplyPrefix("Your code")).toBe(false);
    expect(hasReplyPrefix("Reset your password")).toBe(false);
  });
  it("builds reply subjects without stacking", () => {
    expect(replySubject("Hello")).toBe("Re: Hello");
    expect(replySubject("RE: Hello")).toBe("RE: Hello");
    expect(replySubject(null)).toBe("Re:");
  });
  it("builds References and trims long chains under the header limit, keeping root and newest", () => {
    expect(buildReferences("<a@x> <b@x>", "<c@x>")).toBe("<a@x> <b@x> <c@x>");
    expect(buildReferences(null, "c@x")).toBe("<c@x>");
    expect(buildReferences(null, null)).toBeNull();
    const chain = Array.from({ length: 200 }, (_, i) => `<msg-${i}-${"x".repeat(20)}@example.com>`).join(" ");
    const out = buildReferences(chain, "<last@example.com>")!;
    expect(out.length).toBeLessThanOrEqual(1900);
    expect(out.startsWith("<msg-0-")).toBe(true);
    expect(out.endsWith("<last@example.com>")).toBe(true);
  });
});
