import { describe, expect, it } from "vitest";
import { extractAuth, parseAuthenticationResults } from "../../src/extract/auth";
import { classifyLink, extractLinks, hasToken } from "../../src/extract/links";
import { decodeEntities, htmlToText, makePreview } from "../../src/extract/text";

describe("links", () => {
  it("detects tokens in query and path", () => {
    expect(hasToken("https://x.com/verify?token=abcdef")).toBe(true);
    expect(hasToken("https://x.com/c/8f3d2a9c7b1e4f60a5d2")).toBe(true);
    expect(hasToken("https://x.com/login")).toBe(false);
    expect(hasToken("https://x.com/blog/2026/11/03/hello-world")).toBe(false);
  });

  it("a footer 'Log in' link without a token is not a magic link", () => {
    expect(classifyLink("https://news.example/login", "Log in", "", "Weekly news. Log in to manage")).toBe("other");
  });

  it("verify needs wording plus a token or verify path", () => {
    expect(classifyLink("https://x.com/confirm?t=Pq7Xk2Lm9Vb3Nz8Rt5Yw1", "Confirm email", "", "")).toBe("verify");
    expect(classifyLink("https://x.com/about", "Verify our claims", "", "")).toBe("other");
    expect(classifyLink("https://x.com/email/verify/abc", "Click here", "Please verify your address:", "")).toBe("verify");
  });

  it("generic anchors take the action from the sentence before", () => {
    expect(
      classifyLink(
        "https://t.sendgrid.net/ls/click?upn=AbC123dEf456GhI789jKl",
        "click here",
        "To reset your password,",
        "Reset your password",
      ),
    ).toBe("password_reset");
    expect(classifyLink("https://x.com/u?id=Ab12Cd34Ef56Gh78", "click here", "If you no longer wish to receive these emails,", "")).toBe(
      "unsubscribe",
    );
  });

  it("magic links need a login-ish email", () => {
    const url = "https://app.example/auth/callback?token=Ab12Cd34Ef56Gh78Ij90";
    expect(classifyLink(url, "Sign in", "", "Your sign-in link for Example")).toBe("magic_login");
  });

  it("takes text URLs, strips trailing punctuation, orders actions first", () => {
    const links = extractLinks({
      subject: "Confirm your email",
      text: "Visit https://example.com/home.\nConfirm your email: https://example.com/confirm?token=Zx9Yw8Vu7Ts6Rq5Po4.",
    });
    expect(links.map((l) => [l.kind, l.url])).toEqual([
      ["verify", "https://example.com/confirm?token=Zx9Yw8Vu7Ts6Rq5Po4"],
      ["other", "https://example.com/home"],
    ]);
  });

  it("adds List-Unsubscribe http links and ignores mailto/tel/anchors", () => {
    const links = extractLinks({
      html: '<a href="mailto:a@b.com">mail</a><a href="tel:+1555">call</a><a href="#top">top</a><a href="https://x.com/">home</a>',
      listUnsubscribe: "<mailto:u@x.com>, <https://x.com/unsub?u=1>",
    });
    expect(links).toEqual([
      { url: "https://x.com/", kind: "other", text: "home" },
      { url: "https://x.com/unsub?u=1", kind: "unsubscribe", text: "List-Unsubscribe" },
    ]);
  });
});

describe("auth results", () => {
  it("parses methods, props and comments", () => {
    const p = parseAuthenticationResults(
      "mx.cloudflare.net; dkim=pass (2048-bit key) header.d=example.com header.s=s1; spf=softfail (domain of x does not designate) smtp.mailfrom=x@y.com; dmarc=fail header.from=example.com",
    );
    expect(p.authservId).toBe("mx.cloudflare.net");
    expect(p.methods.map((m) => [m.method, m.result])).toEqual([
      ["dkim", "pass"],
      ["spf", "softfail"],
      ["dmarc", "fail"],
    ]);
    expect(p.methods[0]!.props["header.d"]).toBe("example.com");
  });

  it("trusts only the Cloudflare header, not forged ones further down", () => {
    const a = extractAuth(
      [
        {
          key: "authentication-results",
          value: "mx.cloudflare.net; dkim=none; spf=fail smtp.mailfrom=evil.example; dmarc=fail header.from=bank.example",
        },
        { key: "authentication-results", value: "mx.bank.example; dkim=pass header.d=bank.example; spf=pass; dmarc=pass" },
      ],
      "security@bank.example",
    );
    expect(a).toMatchObject({ trusted: true, dmarc: "fail", spf: "fail", verdict: "fail" });
  });

  it("untrusted headers give verdict unknown", () => {
    const a = extractAuth([{ key: "authentication-results", value: "mx.evil.example; dmarc=pass" }], "a@b.com");
    expect(a).toMatchObject({ trusted: false, dmarc: "pass", verdict: "unknown" });
  });

  it("aligned DKIM pass without DMARC counts as pass; Received-SPF fallback", () => {
    const a = extractAuth(
      [
        { key: "authentication-results", value: "mx.cloudflare.net; dkim=pass header.d=mail.example.com" },
        { key: "received-spf", value: "pass (mx.cloudflare.net: domain of x@example.com designates 1.2.3.4)" },
      ],
      "x@example.com",
    );
    expect(a).toMatchObject({ verdict: "pass", spf: "pass", dkim_domains: ["mail.example.com"] });
  });

  it("no headers -> nulls", () => {
    expect(extractAuth([], null)).toMatchObject({ spf: null, dkim: null, dmarc: null, trusted: false, verdict: "unknown" });
  });
});

describe("text", () => {
  it("decodes entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#39;d&#x27; &nbsp;&mdash;")).toBe("a & b <c> 'd'  —");
  });
  it("turns tables into lines and drops style/script", () => {
    const t = htmlToText("<style>p{}</style><table><tr><td>Code</td><td>123456</td></tr></table><script>x()</script><p>Bye<br>now</p>");
    expect(t.split("\n")).toEqual(["Code", "123456", "", "Bye", "now"]);
  });
  it("preview skips URL-only lines and truncates", () => {
    expect(makePreview("https://x.com\nHello there\nSecond line", 20)).toBe("Hello there Second…");
  });
});
