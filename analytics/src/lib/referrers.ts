/**
 * Referrers that must not become a session's source. Pure.
 *
 * Ignored referrers ("unwanted referrals" in GA4): a visitor who leaves for a hosted checkout or a
 * sign-in page and comes back arrives with that host as referrer. Without this, a Direct session
 * adopts "checkout.stripe.com" as its source, and the purchase linked to it is credited to Referral.
 * An ignored referrer is treated as no referrer at all; when it opens a new session (the return
 * came after the 30-minute timeout), that session continues the visitor's previous attribution.
 * Built-in defaults always apply; a site adds its own (`ignored_referrers`, up to 50 hosts).
 */

/** Hosted checkouts, payment pages, 3-D Secure and sign-in hosts. A pattern covers its subdomains. */
export const DEFAULT_IGNORED_REFERRERS = [
  // Stripe: Checkout, Payment Links, customer portal, hosted invoices, 3-D Secure redirects, Connect OAuth
  "checkout.stripe.com",
  "buy.stripe.com",
  "billing.stripe.com",
  "invoice.stripe.com",
  "pay.stripe.com",
  "hooks.stripe.com",
  "connect.stripe.com",
  // PayPal (www, sandbox and checkout hosts)
  "paypal.com",
  // Paddle (classic and Billing checkouts)
  "checkout.paddle.com",
  "sandbox-checkout.paddle.com",
  "buy.paddle.com",
  "pay.paddle.io",
  "sandbox-pay.paddle.io",
  // Lemon Squeezy (store checkouts live on <store>.lemonsqueezy.com)
  "lemonsqueezy.com",
  // Polar (buy.polar.sh, sandbox.polar.sh, polar.sh/checkout)
  "polar.sh",
  // Shopify checkout, Shop Pay
  "checkout.shopify.com",
  "pay.shopify.com",
  "shop.app",
  // Other processors and hosted payment pages
  "checkout.dodopayments.com",
  "test.checkout.dodopayments.com",
  "checkout.razorpay.com",
  "api.razorpay.com",
  "klarna.com",
  "mollie.com",
  "adyen.com",
  "checkout.square.site",
  "square.link",
  "chargebee.com",
  "secure.2checkout.com",
  "accept.authorize.net",
  "cardinalcommerce.com",
  "pay.google.com",
  "payments.google.com",
  // Sign-in round trips (OAuth / OpenID providers)
  "accounts.google.com",
  "appleid.apple.com",
  "login.microsoftonline.com",
  "login.live.com",
] as const;

export const MAX_IGNORED_REFERRERS = 50;

/**
 * A referrer host pattern as stored: lowercase host, no scheme, path or port; "*.example.com" is
 * the same as "example.com" (both cover subdomains). Null when it isn't a hostname.
 */
export function normalizeHostPattern(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  s = s.replace(/^\*\./, "").replace(/^www\./, "");
  if (!/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/.test(s)) return null;
  return s;
}

/** Does `host` equal the pattern or sit under it (www.paypal.com under paypal.com)? */
export function hostUnder(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === pattern || h.endsWith(`.${pattern}`);
}

/** Which list ignores this referrer host: "default", "site", or null. */
export function referrerIgnoredBy(host: string | null | undefined, site: readonly string[] | null | undefined): "default" | "site" | null {
  if (!host) return null;
  if (DEFAULT_IGNORED_REFERRERS.some((p) => hostUnder(host, p))) return "default";
  if (site?.some((p) => hostUnder(host, p))) return "site";
  return null;
}

/** Validate a site's list: normalised, deduplicated, at most MAX_IGNORED_REFERRERS. */
export function normalizeHostList(input: readonly string[], field: string): { value: string[]; problems: string[] } {
  const value: string[] = [];
  const problems: string[] = [];
  for (const raw of input) {
    const h = normalizeHostPattern(raw);
    if (!h) problems.push(`${field}: "${raw}" is not a hostname (e.g. pay.example.com or *.example.com).`);
    else if (!value.includes(h)) value.push(h);
  }
  return { value, problems };
}

/**
 * Referrer spam: hosts that fake visits to get their name into analytics reports. A built-in list
 * of well-known ones (a subset of the public-domain matomo-org/referrer-spam-list, refreshed with
 * releases); a site adds its own with exclusions.referrers. Events carrying them are dropped
 * (reason referrer_spam, or excluded_referrer for the site's own list).
 */
export const DEFAULT_SPAM_REFERRERS = [
  "100dollars-seo.com",
  "4webmasters.org",
  "7makemoneyonline.com",
  "best-seo-offer.com",
  "best-seo-solution.com",
  "bestwebsitesawards.com",
  "blackhatworth.com",
  "buttons-for-website.com",
  "buttons-for-your-website.com",
  "cenoval.ru",
  "darodar.com",
  "econom.co",
  "event-tracking.com",
  "fix-website-errors.com",
  "floating-share-buttons.com",
  "forum69.info",
  "free-social-buttons.com",
  "free-video-tool.com",
  "get-free-social-traffic.com",
  "get-free-traffic-now.com",
  "hulfingtonpost.com",
  "humanorightswatch.org",
  "iloveitaly.com",
  "iloveitaly.ru",
  "ilovevitaly.co",
  "ilovevitaly.com",
  "ilovevitaly.info",
  "ilovevitaly.ru",
  "kambasoft.com",
  "keywords-monitoring-your-success.com",
  "o-o-6-o-o.com",
  "o-o-8-o-o.com",
  "priceg.com",
  "ranksonic.info",
  "ranksonic.org",
  "sanjosestartups.com",
  "savetubevideo.com",
  "screentoolkit.com",
  "semalt.com",
  "seo-2-0.com",
  "simple-share-buttons.com",
  "sitevaluation.org",
  "smailik.org",
  "social-buttons.com",
  "success-seo.com",
  "traffic2money.com",
  "trafficmonetize.org",
  "trafficmonetizer.org",
  "videos-for-your-business.com",
  "webmonetizer.net",
  "website-analyzer.info",
] as const;

const SPAM = new Set<string>(DEFAULT_SPAM_REFERRERS);

/** The built-in spam entry this referrer host falls under (itself or a parent domain), or null. */
export function spamReferrer(host: string | null | undefined): string | null {
  if (!host) return null;
  const parts = host.toLowerCase().replace(/\.$/, "").split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const h = parts.slice(i).join(".");
    if (SPAM.has(h)) return h;
  }
  return null;
}
