import { type DnsRecord, mergeCloudflareRecords } from "./dns";

/**
 * Cloudflare API calls behind `auto_configure`. Request builders are pure (tested in
 * test/unit/cloudflare-api.test.ts); `autoConfigure` runs them through an injected fetcher, so
 * tests never touch the real API. Endpoints from the Cloudflare OpenAPI spec (checked 2026-11):
 *
 *   GET  /zones?name=&account.id=                                   find the zone (Zone Read)
 *   POST /zones/:zone/email/routing/dns            {name}           enable Email Routing for the apex or add a subdomain; adds + locks MX/SPF/DKIM (Zone Settings Write)
 *   GET  /zones/:zone/email/routing/dns                             records Email Routing wants (Zone Settings Read)
 *   GET  /zones/:zone/email/routing/rules/catch_all                 current catch-all (Email Routing Rules Read)
 *   PUT  /zones/:zone/email/routing/rules/catch_all {actions:[{type:"worker",value:[name]}],matchers:[{type:"all"}],enabled:true}
 *        (catch-all rules exist only on the zone apex; it also receives mail for routing subdomains
 *        that have no literal rule)
 *   GET  /zones/:zone/email/sending/subdomains                      sending domains already onboarded
 *   POST /zones/:zone/email/sending/subdomains     {name}           onboard a sending domain
 *   GET  /zones/:zone/email/sending/subdomains/:tag/dns             expected sending records (DKIM key etc.)
 *   POST /zones/:zone/email/sending/subdomains/:tag/dns             create missing sending records (idempotent)
 *
 * Token permissions: Zone > Zone Read, Zone > Zone Settings Edit, Zone > Email Routing Rules
 * Edit, and Email Sending edit for the zone (account must be on Workers Paid for sending).
 */

export const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export interface CfRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export const cfRequests = {
  findZone: (name: string, accountId?: string): CfRequest => ({
    method: "GET",
    path: "/zones",
    query: { name, ...(accountId ? { "account.id": accountId } : {}), per_page: "5" },
  }),
  enableRouting: (zoneId: string, domain: string): CfRequest => ({
    method: "POST",
    path: `/zones/${zoneId}/email/routing/dns`,
    body: { name: domain },
  }),
  routingSettings: (zoneId: string): CfRequest => ({ method: "GET", path: `/zones/${zoneId}/email/routing` }),
  routingDns: (zoneId: string): CfRequest => ({ method: "GET", path: `/zones/${zoneId}/email/routing/dns` }),
  getCatchAll: (zoneId: string): CfRequest => ({ method: "GET", path: `/zones/${zoneId}/email/routing/rules/catch_all` }),
  setCatchAllToWorker: (zoneId: string, workerName: string): CfRequest => ({
    method: "PUT",
    path: `/zones/${zoneId}/email/routing/rules/catch_all`,
    body: {
      name: `Catch-all to ${workerName} (mail)`,
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [workerName] }],
    },
  }),
  listSendingSubdomains: (zoneId: string): CfRequest => ({ method: "GET", path: `/zones/${zoneId}/email/sending/subdomains` }),
  createSendingSubdomain: (zoneId: string, name: string): CfRequest => ({
    method: "POST",
    path: `/zones/${zoneId}/email/sending/subdomains`,
    body: { name },
  }),
  sendingDns: (zoneId: string, tag: string): CfRequest => ({ method: "GET", path: `/zones/${zoneId}/email/sending/subdomains/${tag}/dns` }),
  fixSendingDns: (zoneId: string, tag: string): CfRequest => ({
    method: "POST",
    path: `/zones/${zoneId}/email/sending/subdomains/${tag}/dns`,
  }),
};

/** The Fetch call for a request: URL, method, headers, body. Pure. */
export function toFetchArgs(req: CfRequest, token: string): { url: string; init: RequestInit } {
  const url = new URL(CF_API_BASE + req.path);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
  const init: RequestInit = { method: req.method, headers };
  if (req.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(req.body);
  }
  return { url: url.toString(), init };
}

export interface CfResult<T = unknown> {
  ok: boolean;
  status: number;
  result: T | null;
  errors: { code: number; message: string }[];
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export async function cfCall<T = unknown>(req: CfRequest, token: string, fetcher: Fetcher = fetch): Promise<CfResult<T>> {
  const { url, init } = toFetchArgs(req, token);
  const res = await fetcher(url, init);
  let body: { success?: boolean; result?: T; errors?: { code: number; message: string }[] } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* non-JSON error page */
  }
  return { ok: res.ok && body.success !== false, status: res.status, result: body.result ?? null, errors: body.errors ?? [] };
}

/** Zone candidates for a (sub)domain, most specific first: a.b.example.com -> a.b.example.com, b.example.com, example.com. */
export function zoneCandidates(domain: string): string[] {
  const labels = domain.split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

export interface AutoConfigStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface AutoConfigReport {
  ok: boolean;
  zone_id: string | null;
  zone_name: string | null;
  steps: AutoConfigStep[];
  records: DnsRecord[];
  next_steps: string[];
}

interface CatchAll {
  enabled?: boolean;
  actions?: { type: string; value?: string[] }[];
}

interface SendingSubdomain {
  tag: string;
  name: string;
  enabled: boolean;
}

const errText = (r: CfResult) => r.errors.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${r.status}`;

/**
 * Configure a domain that lives in the operator's Cloudflare account: Email Routing on, catch-all
 * -> this Worker, Email Sending onboarded. Never overwrites a catch-all that points somewhere
 * else unless `force` is set (it would silently steal someone's mail).
 */
export async function autoConfigure(
  domain: string,
  records: DnsRecord[],
  opts: { token: string; accountId?: string; workerName: string; force?: boolean; receiving?: boolean },
  fetcher: Fetcher = fetch,
): Promise<AutoConfigReport> {
  const steps: AutoConfigStep[] = [];
  const next: string[] = [];
  const call = <T>(req: CfRequest) => cfCall<T>(req, opts.token, fetcher);
  let merged = records;

  // 1. Zone
  let zone: { id: string; name: string } | null = null;
  for (const name of zoneCandidates(domain)) {
    const r = await call<{ id: string; name: string }[]>(cfRequests.findZone(name, opts.accountId));
    if (!r.ok) {
      steps.push({ step: "find_zone", ok: false, detail: errText(r) });
      return {
        ok: false,
        zone_id: null,
        zone_name: null,
        steps,
        records,
        next_steps: ["Check CF_API_TOKEN has Zone Read on the zone and CF_ACCOUNT_ID is right."],
      };
    }
    const hit = r.result?.find((z) => z.name === name);
    if (hit) {
      zone = hit;
      break;
    }
  }
  if (!zone) {
    steps.push({ step: "find_zone", ok: false, detail: `No zone for ${domain} in this Cloudflare account.` });
    return {
      ok: false,
      zone_id: null,
      zone_name: null,
      steps,
      records,
      next_steps: [
        "auto_configure only works for zones in the operator's Cloudflare account. Add the DNS records listed in `records` yourself, then POST /v1/domains/" +
          domain +
          "/verify.",
      ],
    };
  }
  steps.push({ step: "find_zone", ok: true, detail: `${zone.name} (${zone.id})` });

  // Send-only domains (receiving: false) keep their own MX: Email Routing and the catch-all are
  // left alone.
  if (opts.receiving === false) {
    steps.push({
      step: "enable_email_routing",
      ok: true,
      detail: "skipped: send-only domain (receiving: false); existing MX records stay",
    });
  } else {
    // 2. Email Routing. The apex is enabled once per zone; a subdomain is added to Email Routing
    // with the same endpoint and its own name (Cloudflare then publishes MX/SPF/DKIM on it).
    const isApex = zone.name === domain;
    const settings = isApex ? await call<{ enabled?: boolean; status?: string }>(cfRequests.routingSettings(zone.id)) : null;
    if (settings?.ok && settings.result?.enabled) {
      steps.push({ step: "enable_email_routing", ok: true, detail: `already enabled (status ${settings.result.status ?? "unknown"})` });
    } else {
      const en = await call(cfRequests.enableRouting(zone.id, domain));
      steps.push({
        step: "enable_email_routing",
        ok: en.ok,
        detail: en.ok ? `enabled for ${domain}; Cloudflare added and locked the MX/SPF/DKIM records` : errText(en),
      });
      if (!en.ok)
        next.push(
          `Enable Email Routing for ${domain} in the dashboard (Compute > Email Service > Email Routing${isApex ? "" : " > Settings > Subdomains"}). Error 2008 means other MX records exist: remove them first.`,
        );
    }
    const dns = await call<{ type: string; name: string; content: string; priority?: number }[]>(cfRequests.routingDns(zone.id));
    if (dns.ok && Array.isArray(dns.result)) merged = mergeCloudflareRecords(merged, dns.result);

    // 3. Catch-all -> Worker
    const current = await call<CatchAll>(cfRequests.getCatchAll(zone.id));
    const action = current.result?.actions?.[0];
    const pointsHere = action?.type === "worker" && action.value?.[0] === opts.workerName;
    const pointsElsewhere = !!current.result?.enabled && !!action && action.type !== "drop" && !pointsHere;
    if (pointsHere && current.result?.enabled) {
      steps.push({ step: "catch_all_to_worker", ok: true, detail: `already routes to ${opts.workerName}` });
    } else if (pointsElsewhere && !opts.force) {
      steps.push({
        step: "catch_all_to_worker",
        ok: false,
        detail: `catch-all currently ${action!.type} -> ${(action!.value ?? []).join(", ")}; not changed`,
      });
      next.push(
        `The zone's catch-all already routes elsewhere. Re-run with "force": true to point it at ${opts.workerName}, or add per-address routing rules instead.`,
      );
    } else {
      const set = await call(cfRequests.setCatchAllToWorker(zone.id, opts.workerName));
      steps.push({ step: "catch_all_to_worker", ok: set.ok, detail: set.ok ? `catch-all -> Worker ${opts.workerName}` : errText(set) });
      if (!set.ok) next.push(`Set the catch-all rule to "Send to a Worker: ${opts.workerName}" in Email Routing > Routing rules.`);
    }
    if (!isApex) {
      next.push(
        `Note: Email Routing catch-all rules exist only on the zone apex (${zone.name}). It also receives mail for ${domain} (and any other routing subdomain without a literal rule), so unknown addresses on ${zone.name} now reach this Worker too, which rejects them unless that domain is registered here.`,
      );
    }
  }

  // 4. Email Sending
  const list = await call<SendingSubdomain[]>(cfRequests.listSendingSubdomains(zone.id));
  let sub = list.ok ? ((list.result ?? []).find((s) => s.name === domain) ?? null) : null;
  if (sub?.enabled) {
    steps.push({ step: "onboard_email_sending", ok: true, detail: "already onboarded" });
  } else {
    const created = await call<SendingSubdomain>(cfRequests.createSendingSubdomain(zone.id, domain));
    if (created.ok && created.result) sub = created.result;
    steps.push({ step: "onboard_email_sending", ok: created.ok, detail: created.ok ? "sending domain created" : errText(created) });
    if (!created.ok)
      next.push(
        "Onboard the domain in Compute > Email Service > Email Sending (needs the Workers Paid plan to send to arbitrary recipients).",
      );
  }
  if (sub) {
    const fix = await call(cfRequests.fixSendingDns(zone.id, sub.tag));
    steps.push({ step: "sending_dns_records", ok: fix.ok, detail: fix.ok ? "missing sending records created" : errText(fix) });
    const sdns = await call<{ type: string; name: string; content: string; priority?: number }[]>(cfRequests.sendingDns(zone.id, sub.tag));
    if (sdns.ok && Array.isArray(sdns.result)) merged = mergeCloudflareRecords(merged, sdns.result);
  }

  const ok = steps.every((s) => s.ok);
  next.push(`DNS on Cloudflare usually propagates in 5-15 minutes. Then POST /v1/domains/${domain}/verify.`);
  return { ok, zone_id: zone.id, zone_name: zone.name, steps, records: merged, next_steps: next };
}
