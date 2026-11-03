import { describe, expect, it } from "vitest";
import type { LinkKind } from "../../src/extract";
import { FIXTURES, extractFixture } from "./fixtures";

/**
 * The corpus: realistic verification and non-verification emails. For each: the exact codes we
 * must extract (in order; [] means "must not report any code"), and the primary action link.
 */
interface Expectation {
  codes: string[];
  action: { kind: Exclude<LinkKind, "other" | "unsubscribe">; contains: string } | null;
  unsubscribe?: boolean;
  dmarc?: "pass";
}

const EXPECT: Record<string, Expectation> = {
  "google-verify": { codes: ["482913"], action: null, dmarc: "pass" },
  "meta-facebook": {
    codes: ["48291"],
    action: { kind: "verify", contains: "facebook.com/n/?confirmemail.php" },
    unsubscribe: true,
    dmarc: "pass",
  },
  "microsoft-security-code": { codes: ["4829"], action: null },
  "stripe-verify-email": { codes: [], action: { kind: "verify", contains: "dashboard.stripe.com/confirm_email" }, unsubscribe: true },
  "github-launch-code": { codes: ["61873352"], action: { kind: "verify", contains: "github.com/account_verifications/confirm/" } },
  "slack-confirm": { codes: ["2RK-9QX"], action: null },
  "shopify-login-code": { codes: ["482913"], action: null },
  "tiktok-verification": { codes: ["739205"], action: null },
  "amazon-otp": { codes: ["614027"], action: null },
  "otp-spanish": { codes: ["305718"], action: null },
  "magic-link-login": { codes: [], action: { kind: "magic_login", contains: "notion.so/loginwithemail" } },
  "password-reset": { codes: [], action: { kind: "password_reset", contains: "app.example-saas.com/reset-password" } },
  // Negatives: plenty of numbers, none of them a code.
  "newsletter-numbers": { codes: [], action: null, unsubscribe: true },
  "order-confirmation": { codes: [], action: null },
  "security-alert": { codes: [], action: null },
  "quoted-reply": { codes: [], action: null },
};

describe("extraction corpus", () => {
  it("covers every fixture", () => {
    expect(Object.keys(EXPECT).sort()).toEqual(Object.keys(FIXTURES).sort());
  });

  for (const [name, exp] of Object.entries(EXPECT)) {
    it(`${name}: codes ${JSON.stringify(exp.codes)}`, async () => {
      const ex = await extractFixture(name);
      expect(ex.codes).toEqual(exp.codes);
      expect(ex.code).toBe(exp.codes[0] ?? null);
    });

    it(`${name}: action link ${exp.action ? exp.action.kind : "none"}`, async () => {
      const ex = await extractFixture(name);
      const actions = ex.links.filter((l) => l.kind === "verify" || l.kind === "magic_login" || l.kind === "password_reset");
      if (!exp.action) {
        expect(actions).toEqual([]);
        expect(ex.verify_link).toBeNull();
      } else {
        expect(actions[0]?.kind).toBe(exp.action.kind);
        expect(actions[0]?.url).toContain(exp.action.contains);
        expect(ex.verify_link).toBe(actions[0]!.url);
        // Only one distinct action target in each of these emails.
        expect(new Set(actions.map((a) => a.url)).size).toBe(1);
      }
      if (exp.unsubscribe) expect(ex.links.some((l) => l.kind === "unsubscribe")).toBe(true);
    });
  }

  it("decodes &amp; in hrefs", async () => {
    const ex = await extractFixture("meta-facebook");
    expect(ex.verify_link).toBe(
      "https://www.facebook.com/n/?confirmemail.php&e=acme-signups%40mail.example.com&c=48291&z=0&gfid=AQDx8a9KzLm3Qp7Wv2",
    );
  });

  it("reads trusted DMARC/DKIM/SPF from the Email Routing header", async () => {
    const ex = await extractFixture("google-verify");
    expect(ex.auth).toMatchObject({
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      trusted: true,
      verdict: "pass",
      authserv_id: "mx.cloudflare.net",
    });
    expect(ex.auth.dkim_domains).toEqual(["accounts.google.com"]);
  });

  it("builds a short preview without URLs", async () => {
    const ex = await extractFixture("github-launch-code");
    expect(ex.preview.length).toBeLessThanOrEqual(160);
    expect(ex.preview).not.toMatch(/https?:/);
    expect(ex.preview).toMatch(/^Here's your GitHub launch code/);
  });

  it("derives text from HTML when there is no text part", async () => {
    const ex = await extractFixture("tiktok-verification");
    expect(ex.text).toContain("To verify your account, enter this code in TikTok:");
    expect(ex.text).not.toContain("<td");
  });
});
