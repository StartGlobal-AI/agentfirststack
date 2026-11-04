import { describe, expect, it } from "vitest";
import { cleanEvent } from "../../src/lib/ingest-rules";
import { takeDebugFlag } from "../../src/lib/url";
import { cleanProps, stripUrlQuery } from "../../src/service/ingest";
import { ev } from "./fixtures";

describe("props: URL values keep no query string or fragment", () => {
  it("absolute http(s) URLs, protocol-relative URLs and same-site paths are cut at ? or #", () => {
    const cases: [string, string][] = [
      // what the tags manager's {{click_url}} sent as link_href
      ["https://agentfirststack.com/?afst_preview=abc123&afsr=1#how", "https://agentfirststack.com/"],
      ["HTTP://Example.com/a/b?utm_source=x&gclid=123", "HTTP://Example.com/a/b"],
      ["https://example.com?email=jane@example.com", "https://example.com"],
      ["https://example.com/docs#install", "https://example.com/docs"],
      ["//cdn.example.com/a.js?v=3", "//cdn.example.com/a.js"],
      ["/pricing?utm_campaign=launch", "/pricing"],
      ["  /checkout#step-2  ", "/checkout"],
      ["/?token=xyz", "/"],
    ];
    for (const [input, out] of cases) expect(stripUrlQuery(input), input).toBe(out);
  });

  it("anything else is kept as sent", () => {
    for (const v of [
      "https://example.com/plain",
      "pricing?x=1", // relative without a slash: can't tell it from text
      "Is this the price? yes",
      "/ is the home page? maybe",
      "#section",
      "mailto:a@b.example?subject=hi",
      "ftp://files.example/x?y",
      "",
      "plan=pro?",
    ])
      expect(stripUrlQuery(v), v).toBe(v);
  });

  it("cleanProps applies it to string values only, before the 500-character cap", () => {
    const long = `https://example.com/p?${"q=1&".repeat(300)}`;
    expect(JSON.parse(cleanProps({ link_href: long, n: 42, ok: true, url: "https://x.example/a?b=c" })!)).toEqual({
      link_href: "https://example.com/p",
      n: "42",
      ok: "true",
      url: "https://x.example/a",
    });
  });

  it("PII redaction still runs on what is left (an email in a URL's path)", () => {
    const props = cleanProps({ link_href: "https://example.com/u/jane@example.com?ref=mail", phone: "+1 415 555 0123" });
    const out = cleanEvent(ev({ props }), { redact_pii: true }).ev.props;
    expect(JSON.parse(out!)).toEqual({ link_href: "https://example.com/u/[email]", phone: "[phone]" });
  });
});

describe("page URLs: ?afsa_debug", () => {
  it("afsa_debug=1 marks test traffic and is taken out of the URL; =0 is taken out without marking", () => {
    expect(takeDebugFlag("https://example.com/?afsa_debug=1")).toEqual({ url: "https://example.com/", debug: true });
    expect(takeDebugFlag("https://example.com/p?utm_source=x&afsa_debug=1&q=shoes#top")).toEqual({
      url: "https://example.com/p?utm_source=x&q=shoes#top",
      debug: true,
    });
    expect(takeDebugFlag("https://example.com/p?afsa_debug=1&utm_source=x")).toEqual({
      url: "https://example.com/p?utm_source=x",
      debug: true,
    });
    expect(takeDebugFlag("/pricing?afsa_debug=0")).toEqual({ url: "/pricing", debug: false });
    expect(takeDebugFlag("https://example.com/?utm_source=x")).toEqual({ url: "https://example.com/?utm_source=x", debug: false });
    // only a parameter of that name, and only in the query (not the fragment)
    expect(takeDebugFlag("https://example.com/?no_afsa_debug=1").debug).toBe(false);
    expect(takeDebugFlag("https://example.com/#afsa_debug=1").debug).toBe(false);
    expect(takeDebugFlag(null)).toEqual({ url: null, debug: false });
  });
});
