import type { Bindings } from "./env";
import { callService } from "./services";

/**
 * Reputation checks for the operator's daily summary: is the deployment's own name in trouble?
 *
 *   safe_browsing  Google Safe Browsing (Lookup API v4) for the site and its service hosts, with the
 *                  SAFE_BROWSING_API_KEY secret (skipped without it).
 *   spamhaus_dbl   the Spamhaus Domain Block List, through DNS over HTTPS (Workers can't send raw
 *                  DNS). Spamhaus refuses public resolvers (127.255.255.254), so without a
 *                  SPAMHAUS_DQS_KEY (Spamhaus Data Query Service) the answer is usually "unknown".
 *   mail           the mail service's bounce and complaint rates over the last day, worst accounts
 *                  first (mail's GET /v1/admin/delivery-health, over the binding with internal auth).
 *
 * Checked: the deployment's domain (PUBLIC_BASE_URL) and its analytics., tags., mail. and replay.
 * hosts, plus REPUTATION_DOMAINS (comma-separated: other domains the deployment uses, such as a
 * user-content or shared-inbox domain). Every lookup has a 5 second timeout and never throws.
 */

export type ReputationStatus = "ok" | "listed" | "warning" | "unknown";
export interface ReputationCheck {
  check: "safe_browsing" | "spamhaus_dbl" | "mail";
  target: string;
  status: ReputationStatus;
  detail: string;
}

type FetchFn = typeof fetch;
const TIMEOUT_MS = 5_000;
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const SERVICES = ["analytics", "tags", "mail", "replay"];
/** Bounce and complaint rates past these are a warning (mailbox providers start filtering around them). */
export const BOUNCE_WARN = 0.05;
export const COMPLAINT_WARN = 0.003;

/** The domains and hosts to check: [domains for DBL, hosts for Safe Browsing]. */
export function reputationTargets(env: Bindings): { domains: string[]; hosts: string[] } {
  let apex: string | null = null;
  try {
    const h = new URL(env.PUBLIC_BASE_URL || "").hostname.toLowerCase();
    if (HOST.test(h) && !h.endsWith(".localhost") && !h.endsWith(".test")) apex = h;
  } catch {
    /* no base: a local or test deployment */
  }
  const extra = (env.REPUTATION_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => HOST.test(s));
  const domains = [...new Set([...(apex ? [apex] : []), ...extra])].slice(0, 10);
  const hosts = [...new Set([...(apex ? [apex, ...SERVICES.map((s) => `${s}.${apex}`)] : []), ...extra])].slice(0, 20);
  return { domains, hosts };
}

async function safeBrowsing(key: string, hosts: string[], f: FetchFn): Promise<ReputationCheck[]> {
  if (!hosts.length) return [];
  const urls = hosts.map((h) => `https://${h}/`);
  try {
    const res = await f(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client: { clientId: "agentfirststack", clientVersion: "1" },
        threatInfo: {
          threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
          platformTypes: ["ANY_PLATFORM"],
          threatEntryTypes: ["URL"],
          threatEntries: urls.map((url) => ({ url })),
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [{ check: "safe_browsing", target: hosts.join(", "), status: "unknown", detail: `HTTP ${res.status}` }];
    const j = (await res.json()) as { matches?: { threatType?: string; threat?: { url?: string } }[] };
    return hosts.map((host, i) => {
      const hits = (j.matches ?? []).filter((m) => m.threat?.url === urls[i]).map((m) => m.threatType ?? "THREAT");
      return hits.length
        ? { check: "safe_browsing", target: host, status: "listed", detail: `flagged: ${[...new Set(hits)].join(", ")}` }
        : { check: "safe_browsing", target: host, status: "ok", detail: "not flagged" };
    });
  } catch (e) {
    return [{ check: "safe_browsing", target: hosts.join(", "), status: "unknown", detail: e instanceof Error ? e.message : String(e) }];
  }
}

/** Spamhaus DBL answers: 127.0.1.x listed (what for), 127.255.255.x the query was refused. */
const DBL_CODES: Record<string, string> = {
  "127.0.1.2": "spam domain",
  "127.0.1.4": "phishing domain",
  "127.0.1.5": "malware domain",
  "127.0.1.6": "botnet C&C domain",
  "127.0.1.102": "abused legit spam",
  "127.0.1.103": "abused spammed redirector",
  "127.0.1.104": "abused legit phish",
  "127.0.1.105": "abused legit malware",
  "127.0.1.106": "abused legit botnet C&C",
};

async function spamhaus(domain: string, dqsKey: string | undefined, f: FetchFn): Promise<ReputationCheck> {
  const name = dqsKey ? `${domain}.${dqsKey}.dbl.dq.spamhaus.net` : `${domain}.dbl.spamhaus.org`;
  const out = (status: ReputationStatus, detail: string): ReputationCheck => ({ check: "spamhaus_dbl", target: domain, status, detail });
  try {
    const res = await f(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=A`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return out("unknown", `DNS over HTTPS answered HTTP ${res.status}`);
    const j = (await res.json()) as { Status?: number; Answer?: { type?: number; data?: string }[] };
    if (j.Status === 3) return out("ok", "not listed");
    const ips = (j.Answer ?? []).filter((a) => a.type === 1 && a.data).map((a) => a.data as string);
    if (j.Status !== 0) return out("unknown", `DNS status ${j.Status}`);
    if (!ips.length) return out("ok", "not listed");
    if (ips.some((ip) => ip.startsWith("127.255.255.")))
      return out("unknown", dqsKey ? `query refused (${ips.join(", ")})` : "Spamhaus refuses public resolvers: set SPAMHAUS_DQS_KEY");
    const what = ips.map((ip) => DBL_CODES[ip] ?? ip);
    return ips.some((ip) => ip.startsWith("127.0.1."))
      ? out("listed", `listed: ${what.join(", ")}`)
      : out("unknown", `answer ${ips.join(", ")}`);
  } catch (e) {
    return out("unknown", e instanceof Error ? e.message : String(e));
  }
}

interface DeliveryHealth {
  hours?: number;
  /** false: the mail service sees no bounces or complaints (DELIVERY_EVENTS_QUEUE unset) */
  tracking?: boolean;
  sent?: number;
  bounced?: number;
  complained?: number;
  /** accounts with bounces or complaints, worst first */
  accounts?: { account_id: string; sent: number; bounced: number; complained: number }[];
}

/**
 * The account the site reads deployment-wide answers as (internal auth needs one that exists): the
 * deployment's own project when OWN_ANALYTICS_ACCOUNT_ID is set, else the oldest live account.
 */
async function readerAccount(env: Bindings): Promise<string | null> {
  if (env.OWN_ANALYTICS_ACCOUNT_ID) return env.OWN_ANALYTICS_ACCOUNT_ID;
  return env.DB.prepare(
    "SELECT id FROM accounts WHERE deleted_at IS NULL AND suspended_at IS NULL ORDER BY created_at LIMIT 1",
  ).first<string>("id");
}

async function mailRates(env: Bindings): Promise<ReputationCheck> {
  const out = (status: ReputationStatus, detail: string): ReputationCheck => ({ check: "mail", target: "outbound mail", status, detail });
  const account = await readerAccount(env).catch(() => null);
  if (!account) return out("unknown", "no account to read mail's delivery health as");
  // Mail's operator route (internal auth or x-admin-token): deployment-wide bounce and complaint rates.
  const r = await callService<DeliveryHealth>(env, "mail", account, "/v1/admin/delivery-health?hours=24");
  if (!r.ok || !r.json || typeof r.json.sent !== "number")
    return out("unknown", r.status === 503 ? "mail not bound" : `mail didn't report delivery health (HTTP ${r.status})`);
  if (r.json.tracking === false)
    return out("unknown", "mail's delivery tracking is off (DELIVERY_EVENTS_QUEUE unset): bounces and complaints aren't seen");
  const sent = r.json.sent;
  const bounced = Number(r.json.bounced ?? 0);
  const complained = Number(r.json.complained ?? 0);
  const pct = (n: number, of = sent) => (of ? `${((n / of) * 100).toFixed(1)}%` : "0%");
  const worst = (r.json.accounts ?? [])
    .slice(0, 3)
    .map((a) => `${a.account_id} ${a.bounced} bounced, ${a.complained} complaints of ${a.sent}`);
  const detail = `${sent} sent in ${r.json.hours ?? 24} h, ${bounced} bounced (${pct(bounced)}), ${complained} complaints (${pct(complained)})${
    worst.length ? `; worst: ${worst.join("; ")}` : ""
  }`;
  const warn = sent >= 20 && (bounced / sent > BOUNCE_WARN || complained / sent > COMPLAINT_WARN);
  return out(warn ? "warning" : "ok", detail);
}

export async function reputationChecks(env: Bindings, f: FetchFn = fetch): Promise<ReputationCheck[]> {
  const { domains, hosts } = reputationTargets(env);
  const [sb, dbl, mail] = await Promise.all([
    env.SAFE_BROWSING_API_KEY ? safeBrowsing(env.SAFE_BROWSING_API_KEY, hosts, f) : Promise.resolve([]),
    Promise.all(domains.map((d) => spamhaus(d, env.SPAMHAUS_DQS_KEY, f))),
    mailRates(env),
  ]);
  return [...sb, ...dbl, mail];
}
