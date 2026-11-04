import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import { extractAll } from "../../src/extract";
import { extractReply, findQuoteStart } from "../../src/extract/reply";
import { cleanTag, normalizeRecipient } from "../../src/lib/address";
import { buildMime, encodeWord } from "../../src/lib/mime";
import { secondsToUtcMidnight } from "../../src/service/budgets";
import { canonicalJson, parseIdempotencyKey } from "../../src/service/idempotency";
import { parseAfterCursor, parseHas } from "../../src/service/messages";
import { forwardHeader, forwardSubject } from "../../src/service/send";
import quotedReply from "../fixtures/quoted-reply.eml?raw";

// Pure parts of the mail feature build (integration side: test/integration/features.test.ts).

describe("reply_text: quoted history is cut, the new part stays", () => {
  it("Gmail attribution, one line and wrapped over two", () => {
    expect(extractReply("Sounds good.\n\nJane\n\nOn Mon, Nov 3, 2026 at 9:00 AM Acme <a@x.example> wrote:\n> Hi\n> there")).toBe(
      "Sounds good.\n\nJane",
    );
    expect(extractReply("Yes.\n\nOn Mon, Nov 3, 2026 at 9:00 AM Acme <\na@x.example> wrote:\n> Hi")).toBe("Yes.");
  });

  it("other languages", () => {
    for (const header of [
      "Le lun. 3 nov. 2026 à 09:00, Acme <a@x.example> a écrit :",
      "Am 03.11.2026 um 09:00 schrieb Acme <a@x.example>:",
      "El lun, 3 nov 2026 a las 09:00, Acme (<a@x.example>) escribió:",
      "Il giorno lun 3 nov 2026 alle ore 09:00 Acme <a@x.example> ha scritto:",
      "Op ma 3 nov. 2026 om 09:00 schreef Acme <a@x.example>:",
      "Em seg., 3 de nov. de 2026 às 09:00, Acme <a@x.example> escreveu:",
      "W dniu 3.11.2026 o 09:00 Acme <a@x.example> pisze:",
      "пн, 3 нояб. 2026 г. в 09:00, Acme <a@x.example>: написал(а):",
      "在 2026年11月3日 09:00，Acme <a@x.example> 写道：",
    ]) {
      expect(extractReply(`Merci.\n\n${header}\n> Bonjour`), header).toBe("Merci.");
    }
  });

  it("Outlook header blocks and -----Original Message----- separators", () => {
    const outlook =
      "Approved.\n\n________________________________\nFrom: Acme <a@x.example>\nSent: Monday, November 3, 2026 9:00 AM\nTo: Jane\nSubject: Budget\n\nPlease approve.";
    expect(extractReply(outlook)).toBe("Approved.");
    expect(extractReply("Done.\n-----Original Message-----\nFrom: x\nplease")).toBe("Done.");
    expect(extractReply("FYI\n\n---------- Forwarded message ---------\nFrom: a@x.example\n\nbody")).toBe("FYI");
  });

  it("drops > lines and a trailing mobile signature, keeps the signature", () => {
    expect(extractReply("> earlier line\nMy answer\n\n-- \nJane Doe, Partner Inc\n\nSent from my iPhone")).toBe(
      "My answer\n\n-- \nJane Doe, Partner Inc",
    );
  });

  it("bottom-posted replies keep what follows the history; a plain message is unchanged", () => {
    expect(extractReply("On Mon, Nov 3, 2026, Acme <a@x.example> wrote:\n> question?\n\nMy answer below.")).toBe("My answer below.");
    expect(extractReply("Hello,\nyour code is 123456.\nThanks")).toBe("Hello,\nyour code is 123456.\nThanks");
    // Prose that merely says "wrote:" without a date or address is not a quote header.
    expect(extractReply("On the other hand, she wrote:\nthe plan.")).toBe("On the other hand, she wrote:\nthe plan.");
    expect(findQuoteStart(["no quotes here"])).toBeNull();
  });

  it("extractAll gives reply_text on the fixture: the quoted code is not in it", async () => {
    const p = await PostalMime.parse(quotedReply);
    const ex = extractAll({ subject: p.subject, text: p.text, html: p.html, headers: p.headers, fromAddress: "jane@partner.example" });
    expect(ex.reply_text).toBe("Thanks, Thursday at 3pm works for us. I'll send an invite.\n\nJane");
    expect(ex.text).toContain("449120");
    expect(ex.reply_text).not.toContain("449120");
  });
});

describe("plus-address tags", () => {
  it("are recorded lowercase when plain, dropped when unusual", () => {
    expect(cleanTag(normalizeRecipient("Me+GitHub@mail.example.com")?.tag)).toBe("github");
    expect(cleanTag("stripe.test-1")).toBe("stripe.test-1");
    expect(cleanTag(null)).toBeNull();
    expect(cleanTag("a b")).toBeNull();
    expect(cleanTag("x".repeat(65))).toBeNull();
  });
});

describe("idempotency keys", () => {
  it("accepts 1-256 safe characters and refuses others", () => {
    expect(parseIdempotencyKey(undefined)).toBeNull();
    expect(parseIdempotencyKey("3f6c1a2e-9b7d-4c1e-8a2b-0d9e8f7a6b5c")).toBe("3f6c1a2e-9b7d-4c1e-8a2b-0d9e8f7a6b5c");
    expect(() => parseIdempotencyKey("has space")).toThrow();
    expect(() => parseIdempotencyKey("x".repeat(257))).toThrow();
  });
  it("hash input is canonical: key order and undefined fields do not matter", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe(canonicalJson({ a: [1, { d: 2 }], b: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});

describe("list filter parsing", () => {
  it("has= takes code, link, attachments and refuses the rest", () => {
    expect(parseHas("code, link")).toEqual(["code", "link"]);
    expect(parseHas(undefined)).toEqual([]);
    expect(() => parseHas("spam")).toThrow();
  });
  it("after= takes a next_after cursor, unix ms or an ISO date", () => {
    expect(parseAfterCursor("1800000000000.42")).toEqual({ at: 1800000000000, seq: 42 });
    expect(parseAfterCursor("2027-01-15T00:00:00Z")?.at).toBe(Date.parse("2027-01-15T00:00:00Z"));
    expect(parseAfterCursor(undefined)).toBeNull();
    expect(() => parseAfterCursor("soon")).toThrow();
  });
});

describe("Retry-After for daily budgets", () => {
  it("counts the seconds to the next 00:00 UTC", () => {
    expect(secondsToUtcMidnight(Date.parse("2026-11-04T23:59:30Z"))).toBe(30);
    expect(secondsToUtcMidnight(Date.parse("2026-11-04T00:00:00Z"))).toBe(86_400);
  });
});

describe("forward and internal MIME", () => {
  it("Fwd: subject without stacking, and the quoted header block", () => {
    expect(forwardSubject("Invoice 42")).toBe("Fwd: Invoice 42");
    expect(forwardSubject("Fwd: Invoice 42")).toBe("Fwd: Invoice 42");
    const h = forwardHeader({
      from_address: "a@x.example",
      from_name: "Ann\r\nBcc: evil@x",
      subject: "Hi",
      to_json: JSON.stringify([{ address: "b@y.example", name: null }]),
      cc_json: "[]",
      sent_at: Date.parse("2026-11-03T10:00:00Z"),
      received_at: 0,
    });
    expect(h[0]).toBe("---------- Forwarded message ---------");
    expect(h[1]).toBe("From: Ann Bcc: evil@x <a@x.example>"); // control characters can't start a line
    expect(h).toContain("To: b@y.example");
  });

  it("buildMime writes a message postal-mime reads back: encoded headers, parts, attachments", async () => {
    const raw = buildMime({
      from: { address: "me@mail.example.com", name: "Agent Ünïcode" },
      to: ["you+t@mail.example.com"],
      cc: [],
      subject: "Grüße ".repeat(20).trim(),
      messageId: "<m1@mail.example.com>",
      date: Date.parse("2026-11-03T10:00:00Z"),
      text: "Hello ✓",
      html: "<p>Hello ✓</p>",
      attachments: [{ filename: "naïve.txt", type: "text/plain", disposition: "attachment", bytes: new TextEncoder().encode("file") }],
    });
    const p = await PostalMime.parse(raw);
    expect(p.subject).toBe("Grüße ".repeat(20).trim());
    expect(p.from?.name).toBe("Agent Ünïcode");
    expect(p.text?.trim()).toBe("Hello ✓");
    expect(p.html).toContain("Hello ✓");
    expect(p.messageId).toBe("<m1@mail.example.com>");
    expect(p.attachments[0]?.filename).toBe("naïve.txt");
    expect(encodeWord("plain")).toBe("plain");
    expect(encodeWord("line\r\nBcc: x")).toBe("line Bcc: x");
  });
});
