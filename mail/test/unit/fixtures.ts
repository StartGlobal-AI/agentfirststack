import PostalMime from "postal-mime";
import { type Extracted, extractAll } from "../../src/extract";
import amazonOtp from "../fixtures/amazon-otp.eml?raw";
import githubLaunchCode from "../fixtures/github-launch-code.eml?raw";
import googleVerify from "../fixtures/google-verify.eml?raw";
import magicLinkLogin from "../fixtures/magic-link-login.eml?raw";
import metaFacebook from "../fixtures/meta-facebook.eml?raw";
import microsoftSecurityCode from "../fixtures/microsoft-security-code.eml?raw";
import newsletterNumbers from "../fixtures/newsletter-numbers.eml?raw";
import orderConfirmation from "../fixtures/order-confirmation.eml?raw";
import otpSpanish from "../fixtures/otp-spanish.eml?raw";
import passwordReset from "../fixtures/password-reset.eml?raw";
import quotedReply from "../fixtures/quoted-reply.eml?raw";
import securityAlert from "../fixtures/security-alert.eml?raw";
import shopifyLoginCode from "../fixtures/shopify-login-code.eml?raw";
import slackConfirm from "../fixtures/slack-confirm.eml?raw";
import stripeVerifyEmail from "../fixtures/stripe-verify-email.eml?raw";
import tiktokVerification from "../fixtures/tiktok-verification.eml?raw";

export const FIXTURES: Record<string, string> = {
  "amazon-otp": amazonOtp,
  "github-launch-code": githubLaunchCode,
  "google-verify": googleVerify,
  "magic-link-login": magicLinkLogin,
  "meta-facebook": metaFacebook,
  "microsoft-security-code": microsoftSecurityCode,
  "newsletter-numbers": newsletterNumbers,
  "order-confirmation": orderConfirmation,
  "otp-spanish": otpSpanish,
  "password-reset": passwordReset,
  "quoted-reply": quotedReply,
  "security-alert": securityAlert,
  "shopify-login-code": shopifyLoginCode,
  "slack-confirm": slackConfirm,
  "stripe-verify-email": stripeVerifyEmail,
  "tiktok-verification": tiktokVerification,
};

/** Parse a fixture exactly the way the email() handler does, then run extraction. */
export async function extractFixture(name: string): Promise<Extracted & { subject: string }> {
  const raw = FIXTURES[name];
  if (!raw) throw new Error(`no fixture ${name}`);
  const parsed = await PostalMime.parse(raw);
  const from = parsed.from && "address" in parsed.from ? parsed.from.address : null;
  const ex = extractAll({
    subject: parsed.subject,
    text: parsed.text,
    html: parsed.html,
    headers: parsed.headers,
    fromAddress: from,
    otpHeader: parsed.otp?.code ?? null,
  });
  return { ...ex, subject: parsed.subject ?? "" };
}
