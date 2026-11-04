import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../src/env";
import { MAX_EXTRACT_CHARS, extractAll } from "../../src/extract";
import { extractAuth } from "../../src/extract/auth";
import { emphasisSet, extractCodes } from "../../src/extract/codes";
import { MAX_RAW_LINKS, extractLinks } from "../../src/extract/links";
import { parseIcs } from "../../src/extract/calendar";
import { extractReply } from "../../src/extract/reply";
import { htmlToText, makePreview, stripTags, tidyText } from "../../src/extract/text";
import { UNAUTHENTICATED_SENDER, senderKeyFor } from "../../src/lib/sender";
import { DEFAULT_MAX_BLOB_BYTES, DEFAULT_UNCLAIMED_MAX_BLOB_BYTES, headerBlock, maxBlobBytes } from "../../src/service/ingest";
import { apexOf, webhookUrlProblem } from "../../src/service/webhooks";

// Pure parts of the pre-public review of mail (integration side: test/integration/hardening.test.ts).

const ar = (value: string) => ({ key: "authentication-results", value });

// ---------------------------------------------------------------------------------------------
// 1. Extraction runs in linear time on sender-controlled input.

const SIZE = 300_000;
const rep = (s: string, len = SIZE) => s.repeat(Math.ceil(len / s.length)).slice(0, len);
/** Inputs that made a backtracking regex rescan the rest of the body from every repeat. */
const HOSTILE: Record<string, string> = {
  "unclosed <style": rep("<style "),
  "unclosed comments": rep("<!--"),
  "unclosed doctype": rep("<!doctype"),
  "<p without >": rep("<p"),
  "bare <": rep("<"),
  "img alt without quote": rep('<img alt="'),
  "unclosed anchors": rep("<a href=x>"),
  "anchor without >": rep('<a href="'),
  "entity prefixes": rep("&#"),
  "one long word": rep("a"),
  "digit groups": rep("1,"),
  "many tokens on one line": rep("123456 "),
  "code cells": rep("<td>Code</td><td>482913</td>\n"),
  "many urls on one line": rep("http://x.example/a "),
  "markdown brackets": `${rep("[")}]x(http://x.example/`,
  "trailing punctuation": `http://x.example/${rep(".")}a`,
  "keyword after keyword": rep("your ") + rep("b"),
  "long line above codes": rep(`${rep("verification ", 5000)}\n123456\n`),
  "letter-spaced codes": rep("1 2 3 4 5 6\n"),
  "email-ish": `${rep("a.")}@${rep("b.")}`,
  // Reply extraction: quote headers, near-misses and look-ahead triggers, repeated.
  "attribution near-misses": rep("On 3 Nov 2026 someone <a@b> said:\n"),
  "wrapped attribution starts": rep("On 3 Nov 2026 at 10:00, Jane <\n"),
  "outlook From: lines": rep("From: a@b.example\n"),
  "quoted lines": rep("> > > quoted\n"),
  "one long attribution line": `On 1 ${rep("x ")} wrote:`,
  dashes: rep("-----"),
  "separator near-misses": rep("----- not the original message -----\n"),
  // Calendar parsing: nesting, folding, quoted parameters, attendee floods, one huge line.
  "ics nested components": `BEGIN:VEVENT\n${rep("BEGIN:VALARM\n")}`,
  "ics folded continuation": `BEGIN:VEVENT\nDESCRIPTION:${rep("x\r\n ")}`,
  "ics unterminated quotes": `BEGIN:VEVENT\n${rep('ATTENDEE;CN="')}`,
  "ics attendee flood": `BEGIN:VEVENT\n${rep("ATTENDEE;CN=a;ROLE=b:mailto:a@b.example\n")}`,
  "ics escapes": `BEGIN:VEVENT\nSUMMARY:${rep("\\n\\,")}`,
};
const BUDGET_MS = 500; // measured 10-60 ms; the old code took minutes on these

function ms(f: () => unknown): number {
  const t = performance.now();
  f();
  return performance.now() - t;
}

describe("1. extraction is linear on hostile input", () => {
  for (const [name, input] of Object.entries(HOSTILE)) {
    it(`${name}: each extractor handles ${SIZE / 1000} KB well under a second`, () => {
      const runs: Record<string, () => unknown> = {
        htmlToText: () => htmlToText(input),
        "codes (text)": () => extractCodes({ text: input }),
        "codes (html)": () => extractCodes({ html: input }),
        "links (text)": () => extractLinks({ text: input }),
        "links (html)": () => extractLinks({ html: input }),
        "links (List-Unsubscribe)": () => extractLinks({ listUnsubscribe: input }),
        auth: () => extractAuth([ar(`mx.cloudflare.net; dkim=pass ${input}`), { key: "from", value: input }], "a@b.example"),
        "text + preview": () => makePreview(tidyText(input)),
        reply: () => extractReply(input),
        ics: () => parseIcs(input.includes("BEGIN:VEVENT") ? input : `BEGIN:VEVENT\n${input}`),
      };
      for (const [what, f] of Object.entries(runs)) expect(ms(f), what).toBeLessThan(BUDGET_MS);
    });
  }

  it("extractAll reads at most MAX_EXTRACT_CHARS of each body (2 MB in, bounded work)", () => {
    const tail = "\nYour verification code is 482913\n";
    const big = `${rep("<p>filler</p>", 2_000_000)}${tail}`;
    const t = ms(() => extractAll({ subject: "x", text: rep("filler text ", 2_000_000) + tail, html: big, headers: [] }));
    expect(t).toBeLessThan(2 * BUDGET_MS);
    expect(extractAll({ text: rep("x ", MAX_EXTRACT_CHARS + 10) + tail, headers: [] }).codes).toEqual([]); // past the cap
    expect(extractAll({ text: `Your verification code is 482913\n${rep("x ", 2_000_000)}`, headers: [] }).code).toBe("482913");
  });

  it("a code near the top is still found among thousands of numbers (candidate cap)", () => {
    expect(extractCodes({ text: `Your verification code is 482913\n${rep("123456 ", 200_000)}` })).toContain("482913");
  });
});

describe("1. the linear HTML scanner keeps the old output", () => {
  it("drops head/style/script with their content, comments, and keeps an unclosed element's content", () => {
    expect(htmlToText("<p>a<style>x{}</style>b</p><!-- hidden -->c<script>evil()</script>")).toBe("a b\nc");
    expect(htmlToText("<style>body{} hello")).toBe("body{} hello"); // never closed: just a tag
    expect(htmlToText("a <!-- b > c")).toBe("a c"); // unclosed comment: a tag up to the next >
    expect(htmlToText("<STYLE>x</Style >shown")).toBe("shown");
  });
  it("blocks and cells are lines, br with attributes too; alt text is kept; <> and text after a lone < survive", () => {
    expect(htmlToText("<table><tr><td>Code</td><td>123456</td></tr></table>")).toBe("Code\n123456");
    expect(htmlToText("a<br class=x>b<br/>c")).toBe("a\nb\nc");
    expect(htmlToText('<a href="x"><img src="b.png" alt="Verify email"></a>')).toBe("Verify email");
    expect(htmlToText("a <> b")).toBe("a <> b");
    expect(htmlToText("1 &lt; 2 &amp; 3 < 4")).toBe("1 < 2 & 3 < 4");
  });
  it("stripTags matches the old regex", () => {
    for (const s of ["a<b>c", "<<>>", "<>", "a < b > c", "x<y", "<a><b", "<a href='>'>t</a>", ""])
      expect(stripTags(s), s).toBe(s.replace(/<[^>]+>/g, " "));
  });
  it("emphasisSet matches the old per-token regex", () => {
    const html = "<td> 482913 </td><b>K7P-2QX</b><p>code 111111</p>> 222222 <i>4 8 2 9 1 3</i>";
    const set = emphasisSet(html);
    for (const raw of ["482913", "K7P-2QX", "111111", "222222", "4 8 2 9 1 3", "code"])
      expect(set.has(raw), raw).toBe(new RegExp(`>\\s*${raw}\\s*<`).test(html));
  });
});

describe("1. link extraction keeps its rules", () => {
  it("trailing punctuation goes, a balanced paren stays", () => {
    const links = extractLinks({ text: "Verify: https://x.example/verify?t=abc123def456ghi789. Or https://x.example/wiki/A_(b))." });
    expect(links.map((l) => l.url)).toEqual(["https://x.example/verify?t=abc123def456ghi789", "https://x.example/wiki/A_(b)"]);
  });
  it("markdown labels, and anchors that never close", () => {
    const md = extractLinks({ text: "[Verify your email](https://x.example/verify?token=abc123def456)" });
    expect(md[0]).toMatchObject({ kind: "verify", text: "Verify your email" });
    expect(extractLinks({ html: '<a href="https://x.example/verify?token=abc123def456">Verify' })).toEqual([]);
  });
  it(`looks at most MAX_RAW_LINKS (${MAX_RAW_LINKS}) links per source`, () => {
    const html = Array.from({ length: 2000 }, (_, i) => `<a href="https://x.example/p/${i}">p${i}</a>`).join(" ");
    const links = extractLinks({ html });
    expect(links).toHaveLength(50);
    expect(links.at(-1)!.url).toBe("https://x.example/p/49");
  });
});

// ---------------------------------------------------------------------------------------------
// 1. Admission: headers first, and forged senders share one key.

describe("1. admission", () => {
  it("headerBlock is everything up to the first empty line (CRLF or LF), or all of it", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const dec = (b: Uint8Array) => new TextDecoder().decode(b);
    expect(dec(headerBlock(enc("From: a@b\r\nSubject: x\r\n\r\nbody\r\n\r\nmore")))).toBe("From: a@b\r\nSubject: x\r\n");
    expect(dec(headerBlock(enc("From: a@b\nSubject: x\n\nbody")))).toBe("From: a@b\nSubject: x\n");
    expect(dec(headerBlock(enc("From: a@b\r\nSubject: x")))).toBe("From: a@b\r\nSubject: x");
  });
  it("mail nothing authenticates shares one sender key, whatever domain it claims", () => {
    const forged = (from: string, auth: string | null) => {
      const a = extractAuth(auth ? [ar(auth), { key: "from", value: from }] : [{ key: "from", value: from }], from);
      return senderKeyFor({ fromAddress: from, envelopeFrom: from, auth: a });
    };
    expect(forged("x@forged-a.example", "mx.cloudflare.net; spf=fail smtp.mailfrom=x@forged-a.example; dkim=none; dmarc=none")).toBe(
      UNAUTHENTICATED_SENDER,
    );
    expect(forged("y@forged-b.example", "mx.cloudflare.net; spf=softfail smtp.mailfrom=y@forged-b.example")).toBe(UNAUTHENTICATED_SENDER);
    expect(forged("z@forged-c.example", null)).toBe(UNAUTHENTICATED_SENDER); // no Cloudflare header at all
    expect(forged("z@forged-c.example", "evil.example; spf=pass smtp.mailfrom=z@forged-c.example")).toBe(UNAUTHENTICATED_SENDER);
    // Authenticated mail keeps its own key.
    expect(
      forged(
        "a@sub.legit.example",
        "mx.cloudflare.net; spf=pass smtp.mailfrom=a@sub.legit.example; dmarc=pass header.from=sub.legit.example",
      ),
    ).toBe("legit.example");
    expect(forged("b@x.example", "mx.cloudflare.net; spf=fail smtp.mailfrom=b@x.example; dkim=pass header.d=signer.example")).toBe(
      "signer.example",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Stored-bytes budget.

describe("2. MAX_BLOB_BYTES_PER_ACCOUNT", () => {
  const claimed = { suspended: false, claimed: true };
  const unclaimed = { suspended: false, claimed: false };
  const env = (vars: Record<string, string>) => vars as unknown as AppEnv;
  it("defaults to 1 GiB (256 MiB unclaimed); explicit values and UNCLAIMED_ follow capFor; 0 = off", () => {
    expect(maxBlobBytes(env({}), claimed)).toBe(DEFAULT_MAX_BLOB_BYTES);
    expect(maxBlobBytes(env({}), unclaimed)).toBe(DEFAULT_UNCLAIMED_MAX_BLOB_BYTES);
    expect(maxBlobBytes(env({ MAX_BLOB_BYTES_PER_ACCOUNT: "5000" }), unclaimed)).toBe(5000);
    expect(maxBlobBytes(env({ MAX_BLOB_BYTES_PER_ACCOUNT: "5000", UNCLAIMED_MAX_BLOB_BYTES_PER_ACCOUNT: "100" }), unclaimed)).toBe(100);
    expect(maxBlobBytes(env({ MAX_BLOB_BYTES_PER_ACCOUNT: "5000", UNCLAIMED_MAX_BLOB_BYTES_PER_ACCOUNT: "100" }), claimed)).toBe(5000);
    expect(maxBlobBytes(env({ MAX_BLOB_BYTES_PER_ACCOUNT: "0" }), claimed)).toBe(Number.POSITIVE_INFINITY);
    expect(maxBlobBytes(env({ UNCLAIMED_MAX_BLOB_BYTES_PER_ACCOUNT: "0" }), unclaimed)).toBe(Number.POSITIVE_INFINITY);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Webhooks never call the platform itself.

describe("3. webhook URLs", () => {
  const hosted = { PUBLIC_BASE_URL: "https://mail.agentfirststack.com", AUTH_ISSUER: "https://agentfirststack.com" };
  it("apexOf: the registrable parent, one label below shared hosting suffixes", () => {
    expect(apexOf("mail.agentfirststack.com")).toBe("agentfirststack.com");
    expect(apexOf("mail.example.co.uk")).toBe("example.co.uk");
    expect(apexOf("afs-mail.acme.workers.dev")).toBe("acme.workers.dev");
    expect(apexOf("acme.github.io")).toBe("acme.github.io");
  });
  it("blocks the deployment's apex and every subdomain, nothing else", () => {
    for (const u of [
      "https://agentfirststack.com/hook",
      "https://tags.agentfirststack.com/x",
      "https://MAIL.AgentFirstStack.com./v1/signup",
      "https://a.b.agentfirststack.com:8443/",
    ])
      expect(webhookUrlProblem(u, hosted), u).toMatch(/points at this deployment/);
    for (const u of ["https://hooks.example.com/x", "https://agentfirststack.co/x", "https://notagentfirststack.com/x"])
      expect(webhookUrlProblem(u, hosted), u).toBeNull();
    // Either var alone is enough.
    expect(webhookUrlProblem("https://site.agentfirststack.com/", { AUTH_ISSUER: hosted.AUTH_ISSUER })).toMatch(/deployment/);
    // On workers.dev only the operator's own account subdomain is blocked.
    const wd = { PUBLIC_BASE_URL: "https://afs-mail.acme.workers.dev" };
    expect(webhookUrlProblem("https://afs-site.acme.workers.dev/", wd)).toMatch(/deployment/);
    expect(webhookUrlProblem("https://hooks.someone.workers.dev/", wd)).toBeNull();
  });
  it("http://localhost only in DEV_MODE, and never this Worker's own local origin", () => {
    const dev = { PUBLIC_BASE_URL: "http://localhost:8789", DEV_MODE: "true" };
    expect(webhookUrlProblem("http://localhost:8789/v1/signup", dev)).toMatch(/deployment/);
    expect(webhookUrlProblem("http://localhost:9999/hook", dev)).toBeNull();
    expect(webhookUrlProblem("http://127.0.0.1:9999/hook", dev)).toBeNull();
    expect(webhookUrlProblem("http://127.0.0.1:9999/hook", { ...dev, DEV_MODE: "false" })).toMatch(/https/);
    expect(webhookUrlProblem("https://localhost/hook", {})).toMatch(/localhost/);
    expect(webhookUrlProblem("http://hooks.example.com/x", dev)).toMatch(/https/);
  });
});
