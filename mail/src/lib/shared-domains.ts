import { normalizeDomain } from "./address";

/**
 * The operator's shared domains: the ones every account may have inboxes on. Pure (tested in
 * test/unit/shared-domains.test.ts).
 *
 *   MAIL_DOMAIN             the shared domain inboxes have always been created on.
 *   SHARED_INBOX_DOMAIN     optional: a second shared domain that new inboxes go to from now on
 *                           (a domain of its own, so shared inboxes stop sharing the main domain's
 *                           reputation). MAIL_DOMAIN stays shared: its inboxes keep receiving,
 *                           sending, forwarding and waiting exactly as before, and every shared-
 *                           domain rule (reserved names, reply_only, retention, retired addresses)
 *                           covers both. New inboxes are no longer created on it, except by the
 *                           account that holds (or held) that very address.
 *   SHARED_SENDING_DOMAINS  optional, comma-separated: the shared domains onboarded to Cloudflare
 *                           Email Sending. Unset = MAIL_DOMAIN only (what every deployment had to
 *                           onboard). Mail to outside addresses from a shared domain not listed is
 *                           refused (503 domain_not_onboarded) before Email Service sees it;
 *                           mail to the account's own inboxes is delivered internally either way.
 */
export interface SharedDomains {
  /** Where new inboxes go: SHARED_INBOX_DOMAIN when set, else MAIL_DOMAIN. */
  primary: string;
  /** Every shared domain, primary first. */
  all: string[];
  /** Shared domains that are no longer where new inboxes go (MAIL_DOMAIN after a move). */
  legacy: string[];
  /** Shared domains that may send to outside addresses. */
  sending: string[];
}

export interface SharedDomainVars {
  MAIL_DOMAIN?: string;
  SHARED_INBOX_DOMAIN?: string;
  SHARED_SENDING_DOMAINS?: string;
}

const listOf = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((d) => normalizeDomain(d))
    .filter((d): d is string => !!d);

export function sharedDomainsOf(env: SharedDomainVars): SharedDomains {
  const mail = normalizeDomain(env.MAIL_DOMAIN || "") ?? (env.MAIL_DOMAIN || "mail.example.com").trim().toLowerCase();
  // An unparseable SHARED_INBOX_DOMAIN is ignored: inboxes stay on MAIL_DOMAIN, as without it.
  const primary = (env.SHARED_INBOX_DOMAIN?.trim() && normalizeDomain(env.SHARED_INBOX_DOMAIN)) || mail;
  const all = [...new Set([primary, mail])];
  const listed = listOf(env.SHARED_SENDING_DOMAINS);
  const sending = listed.length ? all.filter((d) => listed.includes(d)) : [mail];
  return { primary, all, legacy: all.filter((d) => d !== primary), sending };
}
