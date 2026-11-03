import { describe, expect, it } from "vitest";
import { extractCodes, scoreCodes, THRESHOLD } from "../../src/extract/codes";

const codes = (text: string, subject = "", html?: string) => extractCodes({ subject, text, html });

describe("codes: positives", () => {
  const cases: [string, string, string, string[]][] = [
    ["inline after keyword", "Your Acme code", "Your code is 482913", ["482913"]],
    ["security code colon", "", "Security code: 4829", ["4829"]],
    ["one-time password", "Sign in", "Your one-time password is 774120. It expires in 10 minutes.", ["774120"]],
    ["'is your code' after", "", "558201 is your Instagram code. Don't share it.", ["558201"]],
    ["dash after", "", "558201 — your verification code", ["558201"]],
    ["standalone under label", "Verify your email", "Enter this verification code:\n\n  904417  \n\nIt expires soon.", ["904417"]],
    ["digit groups with space", "Your login code", "Use this code to sign in: 482 913", ["482913"]],
    ["digit groups with dash", "Your login code", "Your verification code is 482-913", ["482913"]],
    ["alnum with strong keyword", "", "Your confirmation code: K7P-2QX", ["K7P-2QX"]],
    ["alnum no dash", "", "Verification code: 7Q9XLD", ["7Q9XLD"]],
    ["PIN", "", "Your PIN is 4821", ["4821"]],
    ["8-digit", "", "Here is your login code: 12345678", ["12345678"]],
    ["German", "", "Ihr Bestätigungscode lautet: 662910", ["662910"]],
    ["French", "", "Votre code de vérification est 220145", ["220145"]],
    ["Japanese", "", "認証コード: 813377", ["813377"]],
    ["letter-spaced in its own cell", "Verify", "Your verification code\n4 8 2 9 1 3\nDo not share", ["482913"]],
    ["2FA", "", "Your 2FA code is 019283", ["019283"]],
    ["year-looking code right after strong keyword", "", "Your verification code: 2024", ["2024"]],
  ];
  for (const [name, subject, text, want] of cases) {
    it(name, () => expect(codes(text, subject)).toEqual(want));
  }

  it("OTP-Token header wins", () => {
    expect(extractCodes({ subject: "Hi", text: "nothing here", otpHeader: "ABC123" })).toEqual(["ABC123"]);
  });

  it("HTML-only email with the code in a styled cell", () => {
    const html = `<p>Use the code below to confirm your email address.</p><table><tr><td style="font-size:32px">630182</td></tr></table>`;
    expect(extractCodes({ subject: "Confirm your email", html })).toEqual(["630182"]);
  });

  it("ranks the labelled code above other plausible numbers", () => {
    const text = "Your verification code is 482913.\nIf you need help, quote ticket 77120.";
    expect(codes(text)).toEqual(["482913"]);
  });
});

describe("codes: negatives (false positives cost more than misses)", () => {
  const cases: [string, string, string][] = [
    ["promo alnum", "Spring sale", "Use code SAVE20 at checkout for 20% off"],
    ["promo digits", "Spring sale", "Use code 2468 at checkout to get a free gift"],
    ["coupon code", "", "Your coupon code: 550012"],
    ["order number", "Order confirmed", "Your order 123456 has shipped"],
    ["order hash", "", "Order #10234 confirmed"],
    ["order number label", "", "Order number:\n5829301"],
    ["confirmation number", "", "Your confirmation number is 8472910"],
    ["invoice", "", "Invoice 48213 is attached"],
    ["phone US", "", "Questions? Call 1-800-555-0199"],
    ["phone intl", "", "Call us on +44 20 7946 0958"],
    ["price", "", "Total: $1,299.00 (USD)"],
    ["price decimals", "", "Subtotal 59.98"],
    ["year", "", "© 2024 Acme Inc. All rights reserved."],
    ["date", "", "Delivered on 2026-11-03 at 10:30"],
    ["zip", "", "Springfield, IL 62704"],
    ["zip code word", "", "Enter your zip code 94107 to see local stores"],
    ["tracking", "", "Tracking number: 1Z999AA10123456784"],
    ["meeting id", "", "Meeting ID: 845 1234 5678"],
    ["counts", "Dev Weekly", "The code: 12 lessons from 1500 pull requests"],
    ["subscribers", "", "Join 25000 subscribers"],
    ["source code", "", "Download the source code 2.4.1 from GitHub"],
    ["version", "", "Version 10.4.2 is available"],
    ["account number", "", "Account number 99887766"],
    ["reference", "", "Reference: 7F3A9C21"],
    ["sku", "", "SKU 448812 x2"],
    ["plain number no context", "Hello", "We have 4500 locations worldwide and 120000 employees"],
    ["acronym with digit", "", "Our COVID19 policy and WIN10 support"],
    ["quoted reply", "Re: hi", "Sounds good.\n> Your access code is 449120"],
    ["IP address", "New sign-in", "IP address: 198.51.100.23"],
    ["lowercase hex", "", "Commit a1b2c3d4 was pushed"],
    ["url digits", "", "See https://example.com/verify/123456 for details"],
  ];
  for (const [name, subject, text] of cases) {
    it(name, () => expect(codes(text, subject)).toEqual([]));
  }

  it("threshold is meaningful: weak 'code' mention alone is not enough", () => {
    const best = scoreCodes({ subject: "Weekly", text: "code 482913" })[0];
    expect(best?.score ?? 0).toBeLessThan(THRESHOLD);
  });
});
