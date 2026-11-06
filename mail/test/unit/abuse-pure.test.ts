import { describe, expect, it } from "vitest";
import { extractAuth } from "../../src/extract/auth";
import { isAutomated, registrableDomain, senderIdentity, senderKeyOf } from "../../src/lib/sender";
import { trimLinks } from "../../src/service/ingest";
import { parseSenderFilter, senderCondition } from "../../src/service/wait";

// Pure parts of the abuse/cost review fixes (integration side: test/integration/abuse.test.ts).

const ar = (value: string) => ({ key: "authentication-results", value });

describe("sender keys (per-sender caps, eviction)", () => {
  it("registrable domain: last two labels, three under common ccTLD second levels", () => {
    expect(registrableDomain("mail.github.com")).toBe("github.com");
    expect(registrableDomain("github.com")).toBe("github.com");
    expect(registrableDomain("a.b.shop.co.uk")).toBe("shop.co.uk");
    expect(registrableDomain("mail.example.com.au")).toBe("example.com.au");
    expect(registrableDomain("x.y.example.de")).toBe("example.de");
  });
  it("own domains collapse to one key; shared mailbox providers keep the address", () => {
    expect(senderKeyOf("random123@flood.example")).toBe("flood.example");
    expect(senderKeyOf("x@sub.flood.example")).toBe("flood.example");
    expect(senderKeyOf("Jane.Doe+promo@Gmail.com")).toBe("janedoe@gmail.com");
    expect(senderKeyOf("jane@outlook.com")).not.toBe(senderKeyOf("john@outlook.com"));
    expect(senderKeyOf("agent-1@mail.example.com", ["mail.example.com"])).toBe("agent-1@mail.example.com");
    expect(senderKeyOf("")).toBe("<>");
  });
  it("identity follows what authentication vouches for", () => {
    const auth = (o: Partial<{ verdict: string; trusted: boolean; spf: string | null; dkim_domains: string[] }>) => ({
      verdict: "unknown",
      trusted: true,
      spf: null,
      dkim_domains: [],
      ...o,
    });
    expect(senderIdentity({ fromAddress: "a@github.com", envelopeFrom: "b@bounce.example", auth: auth({ verdict: "pass" }) })).toBe(
      "a@github.com",
    );
    expect(senderIdentity({ fromAddress: "a@victim.example", envelopeFrom: "b@evil.example", auth: auth({ spf: "pass" }) })).toBe(
      "b@evil.example",
    );
    expect(
      senderIdentity({
        fromAddress: "a@victim.example",
        envelopeFrom: "b@spoofed.example",
        auth: auth({ spf: "fail", dkim_domains: ["evil.example"] }),
      }),
    ).toBe("dkim@evil.example");
  });
  it("over the text budget, action links are kept first", () => {
    const links = [
      ...Array.from({ length: 20 }, (_, i) => ({ url: `https://x.example/${i}`, kind: "other" as const, text: "" })),
      { url: "https://x.example/verify?t=1", kind: "verify" as const, text: "Verify" },
    ];
    const t = trimLinks(links);
    expect(t).toHaveLength(10);
    expect(t[0]!.kind).toBe("verify");
  });
});

describe("list, bulk and auto-generated mail never unlocks reply_only", () => {
  const h = (key: string, value: string) => ({ key, value });
  it("detects lists, bulk, auto-replies and bounces", () => {
    expect(isAutomated([h("list-id", "Dev <dev.lists.example>")], "a@b.example")).toBe(true);
    expect(isAutomated([h("list-unsubscribe", "<https://x>")], "a@b.example")).toBe(true);
    expect(isAutomated([h("precedence", "bulk")], "a@b.example")).toBe(true);
    expect(isAutomated([h("auto-submitted", "auto-replied")], "a@b.example")).toBe(true);
    expect(isAutomated([h("x-autoreply", "yes")], "a@b.example")).toBe(true);
    expect(isAutomated([h("content-type", 'multipart/report; report-type="delivery-status"')], "a@b.example")).toBe(true);
    expect(isAutomated([], "")).toBe(true); // bounce: null envelope sender
    expect(isAutomated([], "<>")).toBe(true);
  });
  it("personal mail is not automated", () => {
    expect(isAutomated([h("auto-submitted", "no"), h("subject", "hi")], "jane@partner.example")).toBe(false);
    expect(isAutomated([], "jane@partner.example")).toBe(false);
  });
});

describe("auth: only the first Authentication-Results header, exactly mx.cloudflare.net", () => {
  it("a Cloudflare-looking header below a non-Cloudflare first header is not trusted", () => {
    const a = extractAuth(
      [ar("mx.evil.example; dmarc=fail"), ar("mx.cloudflare.net; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example")],
      "ceo@bank.example",
    );
    expect(a).toMatchObject({ trusted: false, authserv_id: "mx.evil.example", verdict: "unknown" });
  });
  it("other cloudflare-ish authserv-ids are not trusted", () => {
    for (const id of ["evil.cloudflare.net", "mx.cloudflare.com", "cloudflare.net"]) {
      expect(extractAuth([ar(`${id}; dmarc=pass header.from=bank.example`)], "ceo@bank.example").trusted).toBe(false);
    }
  });
  it("two From headers, or two mailboxes in From, never pass", () => {
    const genuine = ar("mx.cloudflare.net; dkim=pass header.d=bank.example; spf=pass smtp.mailfrom=x@bank.example; dmarc=pass");
    const one = extractAuth([genuine, { key: "from", value: "CEO <ceo@bank.example>" }], "ceo@bank.example");
    expect(one.verdict).toBe("pass");
    const two = extractAuth(
      [genuine, { key: "from", value: "CEO <ceo@bank.example>" }, { key: "from", value: "x@evil.example" }],
      "ceo@bank.example",
    );
    expect(two.verdict).toBe("unknown");
    const list = extractAuth([genuine, { key: "from", value: "ceo@bank.example, x@evil.example" }], "ceo@bank.example");
    expect(list.verdict).toBe("unknown");
  });
  it("a trusted header reporting dmarc or spf twice (injected text) does not pass", () => {
    const a = extractAuth(
      [ar("mx.cloudflare.net; dkim=none; spf=none; dmarc=none; dmarc=pass header.from=victim.example")],
      "ops@victim.example",
    );
    expect(a.trusted).toBe(true);
    expect(a.verdict).toBe("unknown");
    expect(a.dmarc).toBe("none"); // the first result is the result
  });
  // Email Routing's own header on ordinary mail from Gmail / Google Workspace (as received, names
  // changed): one SPF result for the HELO name, one for the envelope sender.
  const gmail = [
    "mx.cloudflare.net;",
    "\tdkim=pass header.d=partner.example header.s=google header.b=e8mR0GV6;",
    "\tdmarc=pass header.from=partner.example policy.dmarc=quarantine;",
    "\tspf=none (mx.cloudflare.net: no SPF records found for postmaster@mail-ed1-x52c.google.com) smtp.helo=mail-ed1-x52c.google.com;",
    "\tspf=pass (mx.cloudflare.net: domain of jane@partner.example designates 2a00:1450:4864:20::52c as permitted sender) smtp.mailfrom=jane@partner.example;",
    '\tarc=pass smtp.remote-ip="2a00:1450:4864:20::52c"',
  ].join("\r\n");
  it("one SPF result for the HELO name and one for the envelope sender is Cloudflare's normal header, and passes", () => {
    const a = extractAuth([ar(gmail), { key: "from", value: "Jane <jane@partner.example>" }], "jane@partner.example");
    expect(a).toMatchObject({ trusted: true, verdict: "pass", spf: "pass", dkim: "pass", dmarc: "pass", arc: "pass" });
    expect(a.dkim_domains).toEqual(["partner.example"]);
    // SPF alone (no DMARC record, no DKIM) still counts the envelope sender's result, not the HELO one.
    const spfOnly = extractAuth(
      [ar("mx.cloudflare.net; dkim=none; dmarc=none; spf=none smtp.helo=mx.partner.example; spf=pass smtp.mailfrom=jane@partner.example")],
      "jane@partner.example",
    );
    expect(spfOnly).toMatchObject({ spf: "pass", verdict: "pass" });
    // Only a HELO result: that is the spf result, and it vouches for no From domain.
    const heloOnly = extractAuth(
      [ar("mx.cloudflare.net; dkim=none; dmarc=none; spf=pass smtp.helo=partner.example")],
      "jane@partner.example",
    );
    expect(heloOnly).toMatchObject({ spf: "pass", verdict: "unknown" });
  });
  it("a second SPF result for the same identity is still injected text, and does not pass", () => {
    for (const extra of [
      "spf=pass smtp.mailfrom=ceo@victim.example",
      "spf=pass smtp.helo=victim.example",
      "dmarc=pass header.from=victim.example",
    ]) {
      const a = extractAuth(
        [
          ar(
            `mx.cloudflare.net; dkim=none; dmarc=none; spf=none smtp.helo=x.evil.example; spf=none smtp.mailfrom=x@evil.example; ${extra}`,
          ),
        ],
        "ceo@victim.example",
      );
      expect(a.verdict, extra).toBe("unknown");
    }
    const unnamed = extractAuth([ar("mx.cloudflare.net; dkim=none; dmarc=none; spf=none; spf=pass")], "ceo@victim.example");
    expect(unnamed).toMatchObject({ spf: "none", verdict: "unknown" });
  });
});

describe("latest-code sender filter", () => {
  it("accepts a domain or an address, refuses bare words", () => {
    expect(parseSenderFilter("GitHub.com")).toEqual({ domain: "github.com" });
    expect(parseSenderFilter("@github.com")).toEqual({ domain: "github.com" });
    expect(parseSenderFilter("NoReply@GitHub.com")).toEqual({ address: "noreply@github.com" });
    expect(() => parseSenderFilter("github")).toThrow(/neither a domain nor an address/);
    expect(() => parseSenderFilter("GitHub Support")).toThrow();
  });
  it("domain condition matches the domain and its subdomains only", () => {
    const c = senderCondition({ domain: "github.com" });
    expect(c.binds).toEqual([".github.com".length, ".github.com"]);
    // The same test SQLite runs: ".<from domain>" ends with ".github.com".
    const matches = (from: string) => `.${from.split("@")[1]}`.endsWith(".github.com");
    expect(matches("noreply@github.com")).toBe(true);
    expect(matches("noreply@mail.github.com")).toBe(true);
    expect(matches("noreply@github.com.evil.example")).toBe(false);
    expect(matches("noreply@evilgithub.com")).toBe(false);
  });
});
