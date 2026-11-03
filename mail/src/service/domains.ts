import { ApiError, badRequest, conflict, hmacSha256Hex, newId, notFound, timingSafeEqual } from "@afs/shared";
import type { AppEnv } from "../env";
import { normalizeDomain } from "../lib/address";
import { type AutoConfigReport, type Fetcher, autoConfigure } from "../lib/cloudflare-api";
import { type DnsRecord, type DomainCheck, buildDomainRecords, checkDomainDns, ownershipRecord } from "../lib/dns";
import { deleteInbox, getInboxRow, sharedDomain } from "./inboxes";

/**
 * Custom domains.
 *
 * Claims are per account: any number of accounts may add the same domain, and a claim gives no
 * rights by itself. The account proves control with a TXT record `_afs-verify.<domain>` =
 * `afs-verify=<token>` (token = first 32 hex chars of HMAC-SHA256(secret, "<account_id>|<domain>"),
 * secret = ENCRYPTION_KEY, else ADMIN_TOKEN). The first account whose challenge passes in verify
 * owns the domain (owner_verified_at); other claims are removed and new ones get 409. Only an owned
 * domain receives mail (addresses and catch-all), sends, or gets inboxes.
 *
 * auto_configure (and force) change the operator's Cloudflare account, so they need the operator:
 * the request header `x-admin-token` must equal the ADMIN_TOKEN secret.
 */

interface DomainRow {
  id: string;
  account_id: string;
  domain: string;
  status: string;
  receiving_verified: number;
  sending_verified: number;
  catch_all_inbox_id: string | null;
  records_json: string;
  last_check_json: string | null;
  checked_at: number | null;
  verified_at: number | null;
  cf_zone_id: string | null;
  auto_config_json: string | null;
  owner_verified_at: number | null;
  created_at: number;
}

/** Operator authorisation for auto_configure / force: `x-admin-token` equal to ADMIN_TOKEN (constant time). */
export function isOperator(env: AppEnv, adminToken: string | null | undefined): boolean {
  return !!env.ADMIN_TOKEN && !!adminToken && timingSafeEqual(adminToken, env.ADMIN_TOKEN);
}

function challengeSecret(env: AppEnv): string | null {
  return env.ENCRYPTION_KEY || env.ADMIN_TOKEN || null;
}

function customDomainsUnavailable(env: AppEnv) {
  return new ApiError(
    400,
    "custom_domains_unavailable",
    "Custom domains are disabled on this deployment: it has no secret to key domain ownership challenges.",
    `The operator must set the ENCRYPTION_KEY secret (openssl rand -base64 32) or ADMIN_TOKEN. Until then use the shared domain: POST /v1/inboxes {"username":"..."} creates name@${sharedDomain(env)}.`,
  );
}

/** Ownership token for (account, domain). Deterministic, so adding the domain again returns the same record. */
export async function ownershipToken(env: AppEnv, accountId: string, domain: string): Promise<string> {
  const secret = challengeSecret(env);
  if (!secret) throw customDomainsUnavailable(env);
  return (await hmacSha256Hex(secret, `${accountId}|${domain}`)).slice(0, 32);
}

export async function challengeRecord(env: AppEnv, accountId: string, domain: string): Promise<DnsRecord> {
  return ownershipRecord(domain, await ownershipToken(env, accountId, domain));
}

/** For read paths: the challenge record, or null when the deployment has no secret. */
async function challengeOrNull(env: AppEnv, accountId: string, domain: string): Promise<DnsRecord | null> {
  return challengeSecret(env) ? challengeRecord(env, accountId, domain) : null;
}

function domainJson(r: DomainRow, challenge: DnsRecord | null) {
  const records = JSON.parse(r.records_json) as DnsRecord[];
  return {
    id: r.id,
    domain: r.domain,
    status: r.status,
    ownership: r.owner_verified_at ? "verified" : "pending",
    receiving: r.receiving_verified ? "verified" : "pending",
    sending: r.sending_verified ? "verified" : "pending",
    catch_all_inbox_id: r.catch_all_inbox_id,
    records: challenge ? [challenge, ...records] : records,
    last_check: r.last_check_json ? (JSON.parse(r.last_check_json) as DomainCheck) : null,
    checked_at: r.checked_at,
    verified_at: r.verified_at,
    owner_verified_at: r.owner_verified_at,
    cloudflare_zone_id: r.cf_zone_id,
    auto_configure: r.auto_config_json ? (JSON.parse(r.auto_config_json) as AutoConfigReport) : null,
    created_at: r.created_at,
  };
}

function ownershipStep(domain: string, challenge: DnsRecord): string {
  return `Prove you control ${domain} first: add TXT ${challenge.name} "${challenge.value}" (records[0]), then POST /v1/domains/${domain}/verify. Until it passes, ${domain} receives no mail, cannot send and gets no inboxes, and another account may claim it.`;
}

function manualSteps(domain: string, records: DnsRecord[]): string[] {
  return [
    `The zone for ${domain} must use Cloudflare DNS (Email Routing and Email Sending require it).`,
    `Receiving: enable Email Routing for ${domain} (dashboard: Compute > Email Service > Email Routing > Onboard Domain; for a subdomain: the apex's Settings > Subdomains). It adds the "receiving" records listed here.`,
    `Then set the zone's catch-all rule to "Send to a Worker" -> the mail Worker so every address reaches this app. Catch-all rules exist only on the zone apex; the apex catch-all also receives mail for routing subdomains that have no literal rule.`,
    `Sending: onboard ${domain} to Email Sending (Compute > Email Service > Email Sending > Onboard Domain). It adds the cf-bounce MX/SPF/DKIM and the DMARC record.`,
    `Records to expect: ${records
      .map((r) => `${r.type} ${r.name}`)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join("; ")}.`,
    `POST /v1/domains/${domain}/verify checks them live and says what to fix.`,
  ];
}

async function getRow(env: AppEnv, accountId: string, domain: string): Promise<DomainRow> {
  const d = normalizeDomain(domain);
  const row = d
    ? await env.DB.prepare("SELECT * FROM domains WHERE domain = ? AND account_id = ?").bind(d, accountId).first<DomainRow>()
    : null;
  if (!row) throw notFound("Domain", "GET /v1/domains lists your domains; POST /v1/domains adds one.");
  return row;
}

/** The account that passed the ownership challenge for a domain, if any. */
async function ownerOf(env: AppEnv, domain: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT account_id FROM domains WHERE domain = ? AND owner_verified_at IS NOT NULL")
    .bind(domain)
    .first<{ account_id: string }>();
  return r?.account_id ?? null;
}

const ownedElsewhere = (d: string) =>
  conflict(
    `${d} is already verified by another account.`,
    "Use a different domain or subdomain. A domain belongs to the account that first passed its ownership challenge.",
  );

function canAutoConfigure(env: AppEnv): boolean {
  return !!env.CF_API_TOKEN;
}

/** auto_configure / force without operator authorisation: refuse, and hand back the records to add by hand. */
function operatorOnly(domain: string, records: DnsRecord[]) {
  return new ApiError(
    403,
    "admin_required",
    "auto_configure and force change the operator's Cloudflare account, so only the operator may use them.",
    `Add the DNS records listed in error.details.records to ${domain} by hand (POST /v1/domains without auto_configure registers the domain and returns the same list), then POST /v1/domains/${domain}/verify. Operators: send the x-admin-token header.`,
    { domain, records },
  );
}

function assertAutoConfigure(
  env: AppEnv,
  input: { auto_configure?: boolean; force?: boolean },
  adminToken: string | null | undefined,
  domain: string,
  records: () => DnsRecord[],
) {
  if (input.auto_configure && !canAutoConfigure(env)) {
    throw new ApiError(
      400,
      "auto_configure_unavailable",
      "auto_configure is not enabled on this deployment.",
      "The operator must set the CF_API_TOKEN secret (and CF_ACCOUNT_ID). Until then, add the returned DNS records yourself and call verify.",
    );
  }
  if ((input.auto_configure || input.force) && !isOperator(env, adminToken)) throw operatorOnly(domain, records());
}

async function runAutoConfigure(env: AppEnv, row: DomainRow, force: boolean, fetcher?: Fetcher): Promise<AutoConfigReport> {
  const report = await autoConfigure(
    row.domain,
    JSON.parse(row.records_json) as DnsRecord[],
    { token: env.CF_API_TOKEN!, accountId: env.CF_ACCOUNT_ID, workerName: env.WORKER_NAME || "afs-mail", force },
    fetcher,
  );
  await env.DB.prepare("UPDATE domains SET records_json = ?, cf_zone_id = ?, auto_config_json = ? WHERE id = ?")
    .bind(JSON.stringify(report.records), report.zone_id, JSON.stringify(report), row.id)
    .run();
  return report;
}

export interface AddDomainInput {
  domain: string;
  auto_configure?: boolean;
  force?: boolean;
  catch_all_inbox_id?: string | null;
}

export interface DomainCallOptions {
  fetcher?: Fetcher;
  now?: number;
  /** Value of the request's x-admin-token header. */
  adminToken?: string | null;
}

export async function addDomain(env: AppEnv, accountId: string, input: AddDomainInput, opts: DomainCallOptions = {}) {
  const now = opts.now ?? Date.now();
  const d = normalizeDomain(input.domain);
  if (!d)
    throw badRequest(
      `"${input.domain}" is not a valid domain.`,
      "Pass a bare hostname such as example.com or mail.example.com (no scheme, no path).",
    );
  const shared = sharedDomain(env);
  if (d === shared || d.endsWith(`.${shared}`)) {
    throw badRequest(
      `${d} is the shared domain (or under it).`,
      `Every account can already use ${shared}: POST /v1/inboxes {"username":"..."}.`,
    );
  }
  const challenge = await challengeRecord(env, accountId, d);
  assertAutoConfigure(env, input, opts.adminToken, d, () => [challenge, ...buildDomainRecords(d)]);
  if (input.catch_all_inbox_id) {
    const inbox = await getInboxRow(env, accountId, input.catch_all_inbox_id);
    if (inbox.domain !== d)
      throw badRequest(
        "catch_all_inbox_id must be an inbox on this domain.",
        `Create it once ownership is verified: POST /v1/inboxes {"username":"hello","domain":"${d}"}, then PATCH /v1/domains/${d}.`,
      );
  }

  const owner = await ownerOf(env, d);
  if (owner && owner !== accountId) throw ownedElsewhere(d);

  const mine = () => env.DB.prepare("SELECT * FROM domains WHERE domain = ? AND account_id = ?").bind(d, accountId).first<DomainRow>();
  let row = await mine();
  let existing = !!row;
  if (!row) {
    const fresh: DomainRow = {
      id: newId("dom"),
      account_id: accountId,
      domain: d,
      status: "pending",
      receiving_verified: 0,
      sending_verified: 0,
      catch_all_inbox_id: input.catch_all_inbox_id ?? null,
      records_json: JSON.stringify(buildDomainRecords(d)),
      last_check_json: null,
      checked_at: null,
      verified_at: null,
      cf_zone_id: null,
      auto_config_json: null,
      owner_verified_at: null,
      created_at: now,
    };
    try {
      await env.DB.prepare(
        "INSERT INTO domains (id, account_id, domain, status, receiving_verified, sending_verified, catch_all_inbox_id, records_json, created_at) VALUES (?, ?, ?, 'pending', 0, 0, ?, ?, ?)",
      )
        .bind(fresh.id, accountId, d, fresh.catch_all_inbox_id, fresh.records_json, now)
        .run();
      row = fresh;
    } catch (e) {
      if (!/UNIQUE/i.test(String(e))) throw e;
      row = await mine(); // lost a race with a concurrent add by the same account
      if (!row) throw e;
      existing = true;
    }
  }

  let report: AutoConfigReport | null = null;
  if (input.auto_configure) {
    report = await runAutoConfigure(env, row, !!input.force, opts.fetcher);
    row = { ...row, records_json: JSON.stringify(report.records), cf_zone_id: report.zone_id, auto_config_json: JSON.stringify(report) };
  }
  const records = JSON.parse(row.records_json) as DnsRecord[];
  const operator = isOperator(env, opts.adminToken);
  return {
    domain: domainJson(row, challenge),
    existing,
    ...(report ? { auto_configure: report } : {}),
    next_steps: [
      ...(row.owner_verified_at ? [] : [ownershipStep(d, challenge)]),
      ...(report
        ? report.next_steps
        : [
            ...manualSteps(d, records),
            ...(canAutoConfigure(env) && operator
              ? [
                  `Or let this app do it: POST /v1/domains {"domain":"${d}","auto_configure":true} with the x-admin-token header (zone must be in the operator's Cloudflare account).`,
                ]
              : []),
          ]),
    ],
  };
}

export async function listDomains(env: AppEnv, accountId: string) {
  const { results } = await env.DB.prepare("SELECT * FROM domains WHERE account_id = ? ORDER BY created_at DESC")
    .bind(accountId)
    .all<DomainRow>();
  const domains = await Promise.all(results.map(async (r) => domainJson(r, await challengeOrNull(env, accountId, r.domain))));
  return {
    domains,
    shared_domain: {
      domain: sharedDomain(env),
      receiving: "verified",
      sending: "verified",
      note: "Operator-managed; every account can create inboxes on it.",
    },
    auto_configure_available: canAutoConfigure(env),
  };
}

export async function getDomain(env: AppEnv, accountId: string, domain: string) {
  const row = await getRow(env, accountId, domain);
  const challenge = await challengeOrNull(env, accountId, row.domain);
  const inboxes = await env.DB.prepare("SELECT COUNT(*) AS n FROM inboxes WHERE domain = ? AND account_id = ?")
    .bind(row.domain, accountId)
    .first<{ n: number }>();
  const records = JSON.parse(row.records_json) as DnsRecord[];
  return {
    domain: { ...domainJson(row, challenge), inbox_count: inboxes?.n ?? 0 },
    next_steps:
      row.status === "verified"
        ? []
        : [...(!row.owner_verified_at && challenge ? [ownershipStep(row.domain, challenge)] : []), ...manualSteps(row.domain, records)],
  };
}

export async function updateDomain(
  env: AppEnv,
  accountId: string,
  domain: string,
  input: { catch_all_inbox_id?: string | null; auto_configure?: boolean; force?: boolean },
  opts: DomainCallOptions = {},
) {
  let row = await getRow(env, accountId, domain);
  const challenge = await challengeOrNull(env, accountId, row.domain);
  // Refuse before changing anything.
  assertAutoConfigure(env, input, opts.adminToken, row.domain, () => [
    ...(challenge ? [challenge] : []),
    ...(JSON.parse(row.records_json) as DnsRecord[]),
  ]);
  if (input.catch_all_inbox_id !== undefined) {
    if (input.catch_all_inbox_id) {
      const inbox = await getInboxRow(env, accountId, input.catch_all_inbox_id);
      if (inbox.domain !== row.domain)
        throw badRequest("catch_all_inbox_id must be an inbox on this domain.", `That inbox is on ${inbox.domain}.`);
    }
    await env.DB.prepare("UPDATE domains SET catch_all_inbox_id = ? WHERE id = ?").bind(input.catch_all_inbox_id, row.id).run();
    row = { ...row, catch_all_inbox_id: input.catch_all_inbox_id };
  }
  let report: AutoConfigReport | null = null;
  if (input.auto_configure) {
    report = await runAutoConfigure(env, row, !!input.force, opts.fetcher);
    row = { ...row, records_json: JSON.stringify(report.records), cf_zone_id: report.zone_id, auto_config_json: JSON.stringify(report) };
  }
  return { domain: domainJson(row, challenge), ...(report ? { auto_configure: report } : {}) };
}

export async function deleteDomain(env: AppEnv, accountId: string, domain: string, opts: { delete_inboxes?: boolean } = {}) {
  const row = await getRow(env, accountId, domain);
  const { results } = await env.DB.prepare("SELECT id FROM inboxes WHERE domain = ? AND account_id = ?")
    .bind(row.domain, accountId)
    .all<{ id: string }>();
  if (results.length && !opts.delete_inboxes) {
    throw conflict(
      `${row.domain} still has ${results.length} inbox(es).`,
      `Delete them first, or pass ?delete_inboxes=true to delete the domain together with its inboxes and their mail.`,
    );
  }
  for (const r of results) await deleteInbox(env, accountId, r.id);
  await env.DB.prepare("DELETE FROM domains WHERE id = ?").bind(row.id).run();
  return {
    deleted: row.domain,
    inboxes_deleted: results.length,
    note: "Cloudflare Email Routing / Email Sending settings on the zone were not changed; disable them in the dashboard if you no longer need them.",
  };
}

/**
 * The account just became the owner: other accounts' claims on the domain lapse, and inboxes they
 * created before ownership challenges existed are removed (they could not receive anyway, and would
 * otherwise squat the owner's addresses).
 */
async function evictOtherClaims(env: AppEnv, ownerAccountId: string, domain: string) {
  const { results } = await env.DB.prepare("SELECT id, account_id FROM inboxes WHERE domain = ? AND account_id != ?")
    .bind(domain, ownerAccountId)
    .all<{ id: string; account_id: string }>();
  for (const r of results) await deleteInbox(env, r.account_id, r.id);
  await env.DB.prepare("DELETE FROM domains WHERE domain = ? AND account_id != ? AND owner_verified_at IS NULL")
    .bind(domain, ownerAccountId)
    .run();
}

export async function verifyDomain(env: AppEnv, accountId: string, domain: string, opts: DomainCallOptions = {}) {
  const row = await getRow(env, accountId, domain);
  const now = opts.now ?? Date.now();
  const challenge = await challengeRecord(env, accountId, row.domain);
  const owner = await ownerOf(env, row.domain);
  if (owner && owner !== accountId) throw ownedElsewhere(row.domain);

  const emailRecords = JSON.parse(row.records_json) as DnsRecord[];
  // Once ownership is proven it is kept; the challenge is only checked while it is pending.
  const check = await checkDomainDns(row.domain, row.owner_verified_at ? emailRecords : [challenge, ...emailRecords], opts.fetcher, now);
  let ownerVerifiedAt = row.owner_verified_at;
  if (!ownerVerifiedAt && check.ownership === "pass") {
    try {
      await env.DB.prepare("UPDATE domains SET owner_verified_at = ? WHERE id = ? AND owner_verified_at IS NULL").bind(now, row.id).run();
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) throw ownedElsewhere(row.domain); // another account passed a moment earlier
      throw e;
    }
    ownerVerifiedAt = now;
    await evictOtherClaims(env, accountId, row.domain);
  }
  const owned = ownerVerifiedAt ? 1 : 0;
  const receiving = check.receiving === "pass" ? 1 : 0;
  const sending = check.sending === "pass" ? 1 : 0;
  const passed = owned + receiving + sending;
  const status = passed === 3 ? "verified" : passed > 0 ? "partial" : "pending";
  const verifiedAt = status === "verified" ? (row.verified_at ?? now) : row.verified_at;
  await env.DB.prepare(
    "UPDATE domains SET status = ?, receiving_verified = ?, sending_verified = ?, last_check_json = ?, checked_at = ?, verified_at = ? WHERE id = ?",
  )
    .bind(status, receiving, sending, JSON.stringify(check), now, verifiedAt, row.id)
    .run();
  return { ...check, ownership: owned ? ("pass" as const) : ("fail" as const), owner_verified_at: ownerVerifiedAt, status };
}
