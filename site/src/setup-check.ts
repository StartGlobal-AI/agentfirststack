import { type AuthContext, badRequest, requireAuth, tooManyRequests } from "@afs/shared";
import { Hono } from "hono";
import type { Bindings, SiteEnv } from "./env";
import { type DomainRow, storedDomains } from "./first-party-domains";
import { siteBase } from "./google";
import { readSetupState, recordSetupCheck } from "./notices";
import { AGENTS_MD_BLOCK } from "./setup-catalog";
import {
  type ContainerItem,
  callService,
  type InboxForward,
  type InboxItem,
  projectResources,
  type ReplaySiteItem,
  type Resources,
  type SiteItem,
} from "./services";

/**
 * The setup check: the full setup (llms.txt section 3) as a list of checks an agent runs with one
 * call, each ok / missing / failing / warning / waiting_on_owner / unavailable, with the exact call
 * that fixes it. It reads each service as the project (internal auth over the bindings, like the
 * dashboard) and fetches nothing from the website itself: install status comes from what the
 * services already received and from the last verify. It returns nothing an agent couldn't read
 * with the project's own key, and no content visitors sent.
 */

export const SETUP_SERVICES = ["analytics", "tags", "mail", "replay"] as const;
export type SetupService = (typeof SETUP_SERVICES)[number];

/** "analytics,tags" or ["analytics", "tags"] -> the services; null when one isn't a service. */
export function parseServices(raw: unknown): SetupService[] | null {
  const names = (Array.isArray(raw) ? raw : String(raw).split(",")).map((n) => String(n).trim().toLowerCase()).filter(Boolean);
  if (!names.length || names.some((n) => !(SETUP_SERVICES as readonly string[]).includes(n))) return null;
  return [...new Set(names)] as SetupService[];
}

export type CheckStatus = "ok" | "missing" | "failing" | "warning" | "waiting_on_owner" | "unavailable";
export type CheckService = "project" | "mail" | "analytics" | "tags" | "replay";

export interface SetupCheck {
  /** Stable id, e.g. "analytics.goals_counted". */
  id: string;
  /** The full-setup step (llms.txt section 3) this belongs to. */
  step: number;
  service: CheckService;
  domain?: string;
  status: CheckStatus;
  /** What is checked, as a statement that's true when it passes. */
  title: string;
  /** What was found. */
  detail: string;
  /** The call that fixes it (only when it doesn't pass). */
  fix?: string;
  /** This check didn't exist the last time the project's agent ran the setup check. */
  new?: true;
}

export interface SetupReport {
  project: { id: string; name: string | null; claimed: boolean };
  /** The services checked: all this deployment runs, unless the caller passed `services`. */
  services: SetupService[];
  ready: boolean;
  summary: string;
  counts: Record<CheckStatus, number>;
  checks: SetupCheck[];
  next_steps: string[];
  not_checked: string[];
  domains_not_checked?: string[];
  /** What's set up, one row per part, for the owner (the dashboard renders the same rows). */
  rows: ReportRow[];
  /** The rows as a markdown table with check marks: put it in your final message to the owner. */
  report_markdown: string;
  checked_at: number;
  /** The AgentFirstStack block for the repo's AGENTS.md (the full setup's step 9). */
  agents_md: string;
  /** When the project's agent last ran the setup check before this run (null: this is the first). */
  last_checked_at?: number | null;
  /** Checks that are new since that run: features that arrived after the project was set up. */
  new_since_last_check?: { id: string; title: string; status: CheckStatus; domain?: string }[];
}

export type RowStatus = CheckStatus | "none";
export interface ReportRow {
  part: string;
  domain?: string;
  status: RowStatus;
  details: string;
}

/** Crawler categories as the owner reads them. */
const CRAWL_NAMES: Record<string, string> = {
  ai_assistant: "AI answers",
  ai_search: "AI search",
  ai_training: "AI training",
  search: "search engines",
  seo: "SEO tools",
  preview: "link previews",
  other: "other bots",
};

/** The owner's view: each part of the setup, and which checks' details say what it is. */
const ROWS: { part: string; ids: string[]; show: string[]; perDomain?: true }[] = [
  { part: "Project", ids: ["project.named"], show: ["project.named"] },
  { part: "Inbox", ids: ["mail.inbox", "mail.forwarding"], show: ["mail.forwarding"] },
  {
    part: "Analytics",
    ids: [
      "analytics.site",
      "analytics.receiving",
      "analytics.domain_verified",
      "analytics.first_party",
      "analytics.proxy_key",
      "analytics.server_events",
    ],
    show: ["analytics.site", "analytics.receiving"],
    perDomain: true,
  },
  { part: "Goals", ids: ["analytics.goals", "analytics.goals_counted"], show: ["analytics.goals"], perDomain: true },
  { part: "AI crawlers", ids: ["analytics.crawlers"], show: ["analytics.crawlers"], perDomain: true },
  { part: "Other tools", ids: ["migrate.tools", "migrate.compare"], show: ["migrate.tools", "migrate.compare"], perDomain: true },
  {
    part: "Reports and alerts",
    ids: ["analytics.owner_email", "analytics.weekly_report", "analytics.alerts"],
    show: ["analytics.weekly_report", "analytics.alerts"],
    perDomain: true,
  },
  {
    part: "Tag manager",
    ids: ["tags.container", "tags.installed", "tags.published", "tags.firing"],
    show: ["tags.published"],
    perDomain: true,
  },
  { part: "Events", ids: ["tags.events", "tags.to_analytics", "tags.goals_for_events"], show: ["tags.events"], perDomain: true },
  { part: "Ad platforms", ids: ["tags.destinations"], show: ["tags.destinations"], perDomain: true },
  { part: "Consent banner", ids: ["tags.consent_banner"], show: ["tags.consent_banner"], perDomain: true },
  {
    part: "Session replay",
    ids: ["replay.site", "replay.linked", "replay.verified", "replay.recording", "replay.consent"],
    show: ["replay.site", "replay.recording"],
    perDomain: true,
  },
  { part: "Dashboard access", ids: ["project.claimed"], show: ["project.claimed"] },
];
const SEVERITY: CheckStatus[] = ["failing", "missing", "unavailable", "warning", "waiting_on_owner", "ok"];
export const STATUS_MARK: Record<RowStatus, string> = {
  ok: "✅",
  missing: "❌",
  failing: "❌",
  warning: "⚠️",
  waiting_on_owner: "⏳",
  unavailable: "❔",
  none: "—",
};
export const STATUS_WORD: Record<RowStatus, string> = {
  ok: "Done",
  missing: "Missing",
  failing: "Not working",
  warning: "Worth a look",
  waiting_on_owner: "Waiting on you",
  unavailable: "Couldn't check",
  none: "None",
};

/** Group the checks into the owner's rows: a row is as good as its worst check. */
export function reportRows(checks: SetupCheck[]): ReportRow[] {
  const domains = [...new Set(checks.map((c) => c.domain).filter((d): d is string => !!d))];
  const rows: ReportRow[] = [];
  for (const def of ROWS) {
    for (const domain of def.perDomain ? domains : [undefined]) {
      const cs = checks.filter((c) => def.ids.includes(c.id) && c.domain === domain);
      if (!cs.length) {
        // A container without ad platform destinations: say so, it's not a failure.
        const tagsOk = checks.some((c) => c.id === "tags.container" && c.domain === domain && c.status === "ok");
        if (def.part === "Ad platforms" && tagsOk)
          rows.push({
            part: def.part,
            domain,
            status: "none",
            details: "None connected. Conversions go to analytics only; add platforms when you run ads.",
          });
        continue;
      }
      const status = SEVERITY.find((st) => cs.some((c) => c.status === st)) ?? "ok";
      const details = cs
        .filter((c) => c.status !== "ok" || def.show.includes(c.id))
        .map((c) =>
          c.status === "ok" ? c.detail : `${STATUS_WORD[c.status]}: ${c.title.charAt(0).toLowerCase()}${c.title.slice(1)}. ${c.detail}`,
        )
        .join(" ");
      // A row whose usual detail check isn't there (an older service): say what its first check found.
      rows.push({ part: def.part, ...(domain ? { domain } : {}), status, details: details || cs[0]!.detail });
    }
  }
  return rows;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export function reportMarkdown(r: Pick<SetupReport, "project" | "ready" | "checks" | "counts">, rows: ReportRow[]): string {
  const multi = new Set(rows.map((x) => x.domain).filter(Boolean)).size > 1;
  const todo = r.counts.missing + r.counts.failing + r.counts.unavailable;
  const head = r.ready
    ? `**AgentFirstStack setup for ${r.project.name ?? r.project.id}: ready** (${r.checks.length - todo} of ${r.checks.length} checks pass)`
    : `**AgentFirstStack setup for ${r.project.name ?? r.project.id}: ${todo} ${todo === 1 ? "thing" : "things"} left to fix**`;
  const lines = [head, "", "| | Part | What's set up |", "|---|---|---|"];
  for (const row of rows)
    lines.push(`| ${STATUS_MARK[row.status]} | ${cell(row.part)}${multi && row.domain ? ` (${row.domain})` : ""} | ${cell(row.details)} |`);
  lines.push("", "✅ done · ❌ missing or not working · ⚠️ worth a look · ⏳ waiting on you · — not used");
  return lines.join("\n");
}

/** Each extra domain costs about a dozen service reads; the rest are named with how to check them. */
const MAX_DOMAINS = 5;
const DAY = 86_400_000;
const BLOCKING: CheckStatus[] = ["missing", "failing", "unavailable"];

const NOT_CHECKED = [
  "That every main action from your site map has an event: compare the list in AGENTFIRSTSTACK.md with the tags events and analytics goals above.",
  "That the live pages are the ones you changed: this check fetches nothing. POST /v1/sites/:id/verify on analytics and replay fetch the live homepage.",
  'Backend conversions and payments, if the business has them: send each once with "debug": true and find it in analytics realtime?debug=only.',
  "AGENTFIRSTSTACK.md and the AgentFirstStack section of AGENTS.md (they live in the repo), and the ad platform IDs or tokens still waiting on the owner.",
];

const ALERT_NAMES: Record<string, string> = {
  traffic_drop: "traffic drop",
  no_data: "tracking stopped",
  traffic_spike: "traffic spike",
  goal: "goal threshold",
  payment: "new payment",
};

const STATUS_ORDER: CheckStatus[] = ["ok", "missing", "failing", "warning", "waiting_on_owner", "unavailable"];

/** https://example.com -> https://analytics.example.com (service hosts derive from the apex). */
export const serviceUrl = (base: string, svc: string) => {
  const u = new URL(base);
  return `${u.protocol}//${svc}.${u.host}`;
};

export const normDomain = (d: string) =>
  d
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");

/** "example.com", "https://www.example.com/pricing" -> "example.com"; null when it isn't a host. */
export function parseDomain(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 300) return null;
  try {
    const host = new URL(s.includes("://") ? s : `https://${s}`).hostname;
    return /^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(host) ? normDomain(host) : null;
  } catch {
    return null;
  }
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never");
const list = (names: string[], max = 8) =>
  names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", ");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------- the service reads ----------

interface AnalyticsSite {
  site: { id: string; domain: string; replay_site_id: string | null; verification?: { verified?: boolean } | null };
  data: {
    total_events: number;
    browser_events: number;
    server_events: number;
    last_event_at: number | null;
    /** setup problems on events that were kept, by reason (proxy_key_missing, proxy_key_invalid) */
    warnings_last_7d?: Record<string, { count: number }>;
    /** how the last 7 days' browser events reached the collector (absent on older analytics deployments) */
    collection_last_7d?: {
      direct: number;
      proxy: number;
      edge: number;
      edge_hosts?: string[];
      last_direct_at?: number | null;
      last_first_party_at?: number | null;
    };
  } | null;
}
interface Goal {
  id: string;
  name: string;
  type: string;
  match: string;
}
interface GoalRow {
  value: string;
  conversions?: number;
}
interface AnalyticsDestination {
  id: string;
  type: string;
  name: string | null;
  last_status: string | null;
}
interface Report {
  id: string;
  enabled: boolean;
  cadence?: string;
}
interface Alert {
  type: string;
  enabled: boolean;
}
interface Conversion {
  name: string;
  send_to?: Record<string, unknown> & { analytics?: { event_name?: string } };
}
type ConsentState = Record<string, string>;
/** The parts of a live tags config the consent check reads. */
interface LiveTagsConfig {
  conversions?: Conversion[];
  tags?: { id: string; type: string; enabled?: boolean; consent?: string[] }[];
  consent?: { mode?: string; default?: ConsentState; regions?: Record<string, ConsentState>; tcf?: boolean };
  consent_banner?: { enabled?: boolean; regions?: string };
}
interface TagsContainer {
  container: {
    id: string;
    live_version: number | null;
    domain_verified?: boolean;
    /** What the tags scan last found on the site (other tools, not ours). */
    last_scan?: { at: number; url?: string; tools: { tool: string; id?: string | null }[] } | null;
    /** The last non-dry-run draft import (a GTM container, for example). */
    last_import?: { at: number; format: string; summary?: Record<string, number> } | null;
  };
  stats?: { today?: { browser_events?: number } };
}
interface TagStats {
  reporting: boolean;
  /** test_skipped: ad pixels that would have fired on test traffic (they don't run in test tabs). */
  tags: { tag_id: string; fired: number; test_skipped?: number }[];
  never_fired: string[];
  failing: string[];
}
interface TagsDestination {
  id: string;
  type: string;
  name: string | null;
  enabled: boolean;
  health?: { circuit?: string; consecutive_failures?: number };
}
interface ReplaySite {
  site: {
    id: string;
    enabled: boolean;
    analytics_site_id: string | null;
    require_consent: string | null;
    mask_mode?: string;
    verification?: { verified?: boolean } | null;
  };
  data: { sessions_total: number; last_session_started_at: number | null } | null;
}

type Read = <T>(service: "analytics" | "tags" | "mail" | "replay", path: string) => Promise<T | null>;

/** "*.example" goal matches compile the way analytics does: `*` is any run of characters. */
function goalMatches(match: string, eventName: string) {
  if (!match.includes("*")) return match === eventName;
  const re = new RegExp(
    `^${match
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return re.test(eventName);
}

// ---------- the report ----------

export async function setupReport(
  env: Bindings,
  accountId: string,
  opts: {
    base: string;
    domain?: string | null;
    services?: SetupService[] | null;
    resources?: Resources;
    /** The project's agent ran it (REST / MCP): remember what it saw and clear its notice. Not the dashboard. */
    record?: boolean;
  },
): Promise<SetupReport> {
  // Each check reads the services about 15 times: a burst limit per project (the dashboard counts too).
  if (env.SETUP_LIMITER) {
    const { success } = await env.SETUP_LIMITER.limit({ key: `setup|${accountId}` });
    if (!success) throw tooManyRequests("Running the setup check too often (30 a minute per project). Wait a minute, then run it again.");
  }
  const A = serviceUrl(opts.base, "analytics");
  const T = serviceUrl(opts.base, "tags");
  const M = serviceUrl(opts.base, "mail");
  const R = serviceUrl(opts.base, "replay");
  // A service is checked when this deployment runs it and the caller didn't leave it out.
  const want = (s: SetupService) => !opts.services || opts.services.includes(s);
  const has = {
    analytics: !!env.ANALYTICS && want("analytics"),
    tags: !!env.TAGS && want("tags"),
    mail: !!env.MAIL && want("mail"),
    replay: !!env.REPLAY && want("replay"),
  };
  const read: Read = async <T>(service: "analytics" | "tags" | "mail" | "replay", path: string) => {
    const r = await callService<T>(env, service, accountId, path);
    return r.ok ? r.json : null;
  };

  const [resources, account, members, link] = await Promise.all([
    opts.resources ?? projectResources(env, accountId),
    env.DB.prepare("SELECT name FROM accounts WHERE id = ?").bind(accountId).first<{ name: string | null }>(),
    env.DB.prepare("SELECT count(*) AS n FROM memberships WHERE account_id = ?").bind(accountId).first<number>("n"),
    // An open claim link: unused, unexpired, and the key that asked for it still works.
    env.DB.prepare(
      `SELECT l.expires_at FROM claim_links l LEFT JOIN api_keys k ON k.id = l.created_by_key_id
        WHERE l.account_id = ? AND l.used_at IS NULL AND l.expires_at > ?
          AND (l.created_by_key_id IS NULL OR (k.id IS NOT NULL AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)))
        ORDER BY l.expires_at DESC LIMIT 1`,
    )
      .bind(accountId, Date.now(), Date.now())
      .first<{ expires_at: number }>(),
  ]);
  const name = account?.name?.trim() || null;
  const claimed = (members ?? 0) > 0;
  const checks: SetupCheck[] = [];

  // Step 1: a name the owner recognises.
  checks.push(
    name
      ? { id: "project.named", step: 1, service: "project", status: "ok", title: "The project is named", detail: `"${name}"` }
      : {
          id: "project.named",
          step: 1,
          service: "project",
          status: "missing",
          title: "The project is named",
          detail: "The project has no name, so the owner sees an id in the dashboard and on the claim page.",
          fix: `PATCH ${opts.base}/v1/me {"name":"example.com"} (MCP afs_update_project)`,
        },
  );

  // Step 3: an inbox.
  if (has.mail) {
    checks.push(inboxCheck(resources.inboxes, M));
    const fwd = forwardCheck(resources.inboxes, M);
    if (fwd) checks.push(fwd);
  }

  // Steps 4-6, per domain.
  const domainsOf = (items: { domain: string }[] | null) => (items ?? []).map((i) => normDomain(i.domain));
  let domains = [
    ...new Set([...domainsOf(resources.sites), ...domainsOf(resources.containers), ...domainsOf(resources.replaySites)]),
  ].sort();
  let notChecked: string[] = [];
  if (opts.domain) domains = [opts.domain];
  else if (domains.length > MAX_DOMAINS) {
    notChecked = domains.slice(MAX_DOMAINS);
    domains = domains.slice(0, MAX_DOMAINS);
  }
  if (!domains.length) {
    // Nothing created yet: everything per website is missing, analytics first (replay links to it).
    const none = (
      id: string,
      step: number,
      service: CheckService,
      listed: unknown[] | null,
      title: string,
      what: string,
      fix: string,
    ): SetupCheck => ({
      id,
      step,
      service,
      status: listed ? "missing" : "unavailable",
      title,
      detail: listed ? `No ${what} yet.` : `The ${service} service didn't answer.`,
      fix,
    });
    if (has.analytics)
      checks.push(
        none(
          "analytics.site",
          4,
          "analytics",
          resources.sites,
          "Analytics has a site for the website",
          "analytics site",
          `POST ${A}/v1/sites {"domain":"example.com"} (MCP analytics_create_site)`,
        ),
      );
    if (has.tags)
      checks.push(
        none(
          "tags.container",
          5,
          "tags",
          resources.containers,
          "There is a tag container for the website",
          "tag container",
          `POST ${T}/v1/containers {"domain":"example.com"} (MCP tags_create_container)`,
        ),
      );
    if (has.replay)
      checks.push(
        none(
          "replay.site",
          6,
          "replay",
          resources.replaySites,
          "Replay records the website",
          "replay site",
          `After the analytics site: POST ${R}/v1/sites {"domain":"example.com","analytics_site_id":"site_...","require_consent":"eea"} (MCP replay_create_replay_site)`,
        ),
      );
  }
  const firstParty = has.analytics ? await storedDomains(env, accountId) : null;
  const perDomain = await Promise.all(
    domains.map((domain) => domainChecks(domain, { resources, read, has, A, T, R, S: opts.base, firstParty })),
  );
  for (const list of perDomain) checks.push(...list);

  // Step 10: the owner has the project.
  checks.push(
    claimed
      ? {
          id: "project.claimed",
          step: 10,
          service: "project",
          status: "ok",
          title: "The owner has claimed the project",
          detail: `${plural(members ?? 0, "person", "people")} can see it in the dashboard.`,
        }
      : link
        ? {
            id: "project.claimed",
            step: 10,
            service: "project",
            status: "waiting_on_owner",
            title: "The owner has claimed the project",
            detail: `A claim link is waiting to be opened (it expires ${iso(link.expires_at)}). Give the owner its URL if you haven't.`,
          }
        : {
            id: "project.claimed",
            step: 10,
            service: "project",
            status: "missing",
            title: "The owner has claimed the project",
            detail: "No one has claimed it and there is no open claim link.",
            fix: `POST ${opts.base}/v1/claim-link (MCP afs_create_claim_link), then give the owner the url`,
          },
  );

  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<CheckStatus, number>;
  for (const c of checks) counts[c.status]++;
  const blocking = checks.filter((c) => BLOCKING.includes(c.status));
  const ready = blocking.length === 0;
  const passed = counts.ok + counts.warning + counts.waiting_on_owner;
  const parts = (["missing", "failing", "unavailable", "warning"] as const).filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
  const summary = ready
    ? `Ready: ${passed} of ${checks.length} checks pass${counts.warning ? ` (${plural(counts.warning, "warning")})` : ""}${
        counts.waiting_on_owner ? "; waiting on the owner to open the claim link" : ""
      }. Run the checks in not_checked yourself.`
    : `Not ready: ${parts.join(", ")} of ${checks.length} checks. Fix them in the order of next_steps, then run this check again.`;

  const next_steps = [...new Set(blocking.map((c) => `${c.title}${c.domain ? ` (${c.domain})` : ""}: ${c.fix ?? c.detail}`))];
  if (ready && counts.warning)
    next_steps.push(
      ...checks
        .filter((c) => c.status === "warning")
        .map((c) => `Optional: ${c.title}${c.domain ? ` (${c.domain})` : ""}: ${c.fix ?? c.detail}`),
    );
  if (notChecked.length) next_steps.push(`Check the other domains one at a time: GET ${opts.base}/v1/setup?domain=${notChecked[0]}`);

  // What's new since the project's agent last ran this check: new features, as new check ids.
  let history: Pick<SetupReport, "last_checked_at" | "new_since_last_check"> = {};
  if (opts.record) {
    const prev = await readSetupState(env.DB, accountId);
    if (prev) {
      const seen = new Set(prev.seen);
      const fresh = checks.filter((c) => !seen.has(c.id));
      for (const c of fresh) c.new = true;
      history = {
        last_checked_at: prev.checked_at,
        new_since_last_check: fresh.map((c) => ({ id: c.id, title: c.title, status: c.status, ...(c.domain ? { domain: c.domain } : {}) })),
      };
      const todo = fresh.filter((c) => c.status !== "ok");
      if (todo.length) next_steps.unshift(`New since the last setup check: ${list(todo.map((c) => c.title))}. Their fixes are below.`);
    } else history = { last_checked_at: null };
    await recordSetupCheck(
      env.DB,
      accountId,
      checks.map((c) => c.id),
      Date.now(),
      { ready, todo: blocking.length },
    );
  }

  const rows = reportRows(checks);
  return {
    project: { id: accountId, name, claimed },
    services: SETUP_SERVICES.filter((x) => has[x]),
    ready,
    summary,
    counts,
    checks,
    next_steps,
    not_checked: NOT_CHECKED,
    ...(notChecked.length ? { domains_not_checked: notChecked } : {}),
    rows,
    report_markdown: reportMarkdown({ project: { id: accountId, name, claimed }, ready, checks, counts }, rows),
    checked_at: Date.now(),
    agents_md: AGENTS_MD_BLOCK(opts.base),
    ...history,
  };
}

/** "each email as it arrives" / "a daily digest at 08:00 (Europe/Berlin)" */
export function forwardText(f: InboxForward): string {
  if (f.mode === "off") return "not forwarded";
  return f.mode === "each"
    ? "forwarded to the owner as each email arrives"
    : `forwarded to the owner as a daily digest at ${String(f.digest_hour).padStart(2, "0")}:00 (${f.timezone})`;
}

/** Step 3: the inbox's mail reaches a person after the agent stops reading it. */
function forwardCheck(inboxes: InboxItem[] | null, M: string): SetupCheck | null {
  const withSetting = (inboxes ?? []).filter((i) => i.forward);
  if (!withSetting.length) return null;
  const base = { id: "mail.forwarding", step: 3, service: "mail" as const, title: "The inbox's email reaches the owner" };
  const off = withSetting.filter((i) => i.forward!.mode === "off");
  if (off.length)
    return {
      ...base,
      status: "warning",
      detail: `Not forwarded: ${list(off.map((i) => i.address))}. Once your agent stops, nobody reads ${off.length === 1 ? "it" : "them"} (verification codes, password resets, service notices). Fine if the owner chose that.`,
      fix: `Ask the owner: each email as it arrives, or a daily digest? Then PATCH ${M}/v1/inboxes/${off[0]!.id} {"forward":{"mode":"each"}} or {"forward":{"mode":"digest","digest_hour":8,"timezone":"Europe/Berlin"}}`,
    };
  const on = withSetting.map(
    (i) => `${i.address}: ${forwardText(i.forward!)}${i.forward!.waiting_for_owner ? " (starts when the owner claims the project)" : ""}`,
  );
  return { ...base, status: "ok", detail: `${on.join("; ")}.` };
}

function inboxCheck(inboxes: InboxItem[] | null, M: string): SetupCheck {
  const base = { id: "mail.inbox", step: 3, service: "mail" as const, title: "The project has an inbox" };
  if (!inboxes) return { ...base, status: "unavailable", detail: "The mail service didn't answer.", fix: `GET ${M}/v1/inboxes` };
  if (!inboxes.length)
    return {
      ...base,
      status: "missing",
      detail: "No inbox yet. The setup uses it for any third-party signup that needs an email address.",
      fix: `POST ${M}/v1/inboxes {"username":"example-signups"} (MCP mail_create_inbox)`,
    };
  return {
    ...base,
    status: "ok",
    detail: list(
      inboxes.map((i) => i.address),
      3,
    ),
  };
}

interface Ctx {
  resources: Resources;
  read: Read;
  has: Record<"analytics" | "tags" | "mail" | "replay", boolean>;
  A: string;
  T: string;
  R: string;
  /** the site (platform) base, where first-party domains are */
  S: string;
  /** the project's first-party domains as stored (null: unreadable) */
  firstParty: DomainRow[] | null;
}

async function domainChecks(domain: string, x: Ctx): Promise<SetupCheck[]> {
  const find = <I extends { domain: string }>(items: I[] | null) => items?.find((i) => normDomain(i.domain) === domain) ?? null;
  const site = find<SiteItem>(x.resources.sites);
  const container = find<ContainerItem>(x.resources.containers);
  const rsite = find<ReplaySiteItem>(x.resources.replaySites);
  const [analytics, tags, replay] = await Promise.all([
    x.has.analytics ? analyticsChecks(domain, site, x) : { checks: [], goals: null, siteId: null },
    x.has.tags && container ? tagsDetail(container, x) : null,
    x.has.replay ? replayChecks(domain, rsite, site?.id ?? null, x) : [],
  ]);
  const tagsChecks = x.has.tags ? tagsChecksFor(domain, container, tags, analytics, x) : [];
  const moving = x.has.tags && x.has.analytics ? await movingChecks(domain, analytics.siteId, tags, x) : [];
  return [...analytics.checks, ...tagsChecks, ...replay, ...moving];
}

// ---------- other tools: what the site used before (steps 2, 4 and 5) ----------

/** Tools whose history analytics can import, and the import source that covers each. */
const HISTORY_TOOLS: Record<string, string> = {
  ga4: "Google Analytics 4",
  plausible: "Plausible",
  datafast: "DataFast",
  fathom: "Fathom",
  umami: "Umami",
  matomo: "Matomo",
  simple_analytics: "Simple Analytics",
  mixpanel: "Mixpanel",
  posthog: "PostHog",
  amplitude: "Amplitude",
  heap: "Heap",
};
/** Everything else the scan names (ad pixels, chat, forms), as the owner reads them. */
const OTHER_TOOLS: Record<string, string> = {
  google_ads: "Google Ads",
  universal_analytics: "Universal Analytics (retired by Google)",
  meta: "Meta Pixel",
  tiktok: "TikTok Pixel",
  linkedin: "LinkedIn Insight Tag",
  bing_uet: "Microsoft Ads (UET)",
  reddit: "Reddit Pixel",
  x: "X Pixel",
  pinterest: "Pinterest Tag",
  snap: "Snap Pixel",
  segment: "Segment",
  hubspot: "HubSpot",
  intercom: "Intercom",
  stripe: "Stripe.js",
  calendly: "Calendly",
  typeform: "Typeform",
};
/** Replay tools: their recordings can't move, so finding one needs nothing done. */
const REPLAY_TOOLS: Record<string, string> = {
  hotjar: "Hotjar",
  clarity: "Microsoft Clarity",
  fullstory: "FullStory",
  logrocket: "LogRocket",
};

interface ImportItem {
  source: string;
  tool?: string | null;
  kind: string;
  from: string;
  to: string;
  rows: number;
}
interface ImportCompare {
  source?: string | null;
  tool?: string | null;
  overlap_days: number;
  ratio: number | null;
  verdict: "close" | "lower" | "higher" | "not_enough_overlap";
  note?: string;
}

async function movingChecks(domain: string, siteId: string | null, tags: TagsDetail | null, x: Ctx): Promise<SetupCheck[]> {
  const { A, T } = x;
  const c = tags?.container?.container;
  if (!c) return []; // no container yet: the tags checks say so
  const scan = c.last_scan ?? null;
  const imports = siteId ? ((await x.read<{ imports?: ImportItem[] }>("analytics", `/v1/sites/${siteId}/imports`))?.imports ?? []) : [];
  const checks: SetupCheck[] = [];
  const title = "What the site used before (other analytics and tag tools) is brought over";
  const at = (s: Omit<SetupCheck, "step" | "service" | "domain">, step: number, service: CheckService): SetupCheck => ({
    ...s,
    step,
    service,
    domain,
  });
  if (!scan)
    checks.push(
      at(
        {
          id: "migrate.tools",
          status: "warning",
          title,
          detail: "The tags scan hasn't been run since it started remembering what it finds.",
          fix: `POST ${T}/v1/containers/${c.id}/scan (MCP tags scan_site): it lists the other tools on the site and keeps the list for this check`,
        },
        2,
        "tags",
      ),
    );
  else {
    const found = scan.tools ?? [];
    const named = (t: { tool: string; id?: string | null }) =>
      `${HISTORY_TOOLS[t.tool] ?? REPLAY_TOOLS[t.tool] ?? OTHER_TOOLS[t.tool] ?? (t.tool === "gtm" ? "Google Tag Manager" : t.tool)}${t.id ? ` (${t.id})` : ""}`;
    const imported = (tool: string) => imports.filter((i) => (i.source === "other" ? i.tool === tool : i.source === tool) && i.rows > 0);
    const left: string[] = [];
    const done: string[] = [];
    const fixes: string[] = [];
    for (const t of found) {
      if (t.tool === "gtm") {
        if (c.last_import?.format === "gtm")
          done.push(`${named(t)}: container imported ${new Date(c.last_import.at).toISOString().slice(0, 10)}`);
        else {
          left.push(named(t));
          fixes.push(
            `GTM: POST ${T}/v1/containers/${c.id}/draft/import {"format":"gtm","data":<the export, or the GTM API lists>,"dry_run":true}, then without dry_run`,
          );
        }
      } else if (HISTORY_TOOLS[t.tool]) {
        const got = imported(t.tool);
        if (got.length) {
          const from = got.map((i) => i.from).sort()[0];
          const to = got
            .map((i) => i.to)
            .sort()
            .at(-1);
          done.push(`${named(t)}: history ${from} to ${to}`);
        } else if (siteId) {
          left.push(named(t));
          fixes.push(
            `${HISTORY_TOOLS[t.tool]}: POST ${A}/v1/sites/${siteId}/imports (${
              t.tool === "ga4" || t.tool === "plausible"
                ? `{"source":"${t.tool}","report":...} or its CSV export`
                : `{"source":"other","tool":"${t.tool}","rows":[...]}`
            })`,
          );
        }
      } else if (REPLAY_TOOLS[t.tool]) done.push(`${named(t)} (its recordings can't move, so it stays until they expire)`);
    }
    const others = found.filter((t) => t.tool !== "gtm" && !HISTORY_TOOLS[t.tool] && !REPLAY_TOOLS[t.tool]).map(named);
    const when = new Date(scan.at).toISOString().slice(0, 10);
    checks.push(
      at(
        left.length
          ? {
              id: "migrate.tools",
              status: "warning",
              title,
              detail: `Not brought over yet: ${list(left)}.${done.length ? ` Done: ${done.join("; ")}.` : ""} (scan of ${when})`,
              fix: `${fixes.join("; ")}. How to get the data out of each tool: "Move from another tool" in https://agentfirststack.com/llms.txt`,
            }
          : {
              id: "migrate.tools",
              status: "ok",
              title,
              detail: found.length
                ? `${(done.length ? done : found.map(named)).join("; ")}${others.length ? `. Also on the site: ${list(others)}` : ""} (scan of ${when}).`
                : `No other analytics or tag tools on the site (scan of ${when}).`,
            },
        2,
        "tags",
      ),
    );
  }

  // Do our numbers match the old tool's, for the days both ran?
  if (siteId && imports.some((i) => i.kind === "visitors" && i.rows > 0)) {
    const cmp = await x.read<ImportCompare>("analytics", `/v1/sites/${siteId}/imports/compare`);
    const ctitle = "Our daily visitors match the old tool's, for the days both ran";
    const old = cmp
      ? cmp.source === "other"
        ? (HISTORY_TOOLS[cmp.tool ?? ""] ?? cmp.tool)
        : (HISTORY_TOOLS[cmp.source ?? ""] ?? cmp.source)
      : null;
    if (cmp && cmp.verdict === "close")
      checks.push(
        at(
          {
            id: "migrate.compare",
            status: "ok",
            title: ctitle,
            detail: `Within ${Math.round(Math.abs(1 - (cmp.ratio ?? 1)) * 100)}% of ${old ?? "the old tool"} over ${plural(cmp.overlap_days, "day")}. The old tool can go once the owner agrees.`,
          },
          4,
          "analytics",
        ),
      );
    else if (cmp)
      checks.push(
        at(
          {
            id: "migrate.compare",
            status: "warning",
            title: ctitle,
            detail:
              cmp.verdict === "not_enough_overlap"
                ? `Only ${plural(cmp.overlap_days, "day")} both ran so far (3 needed). Keep ${old ?? "the old tool"} installed.`
                : `${cmp.verdict === "lower" ? "Lower" : "Higher"} than ${old ?? "the old tool"}: ${cmp.ratio}x over ${plural(cmp.overlap_days, "day")}. ${cmp.note ?? ""}`.trim(),
            fix:
              cmp.verdict === "not_enough_overlap"
                ? `Import ${old ?? "the old tool"}'s daily visitors up to today again in a few days (POST ${A}/v1/sites/${siteId}/imports, the same call with the newer dates), then GET ${A}/v1/sites/${siteId}/imports/compare`
                : `GET ${A}/v1/sites/${siteId}/imports/compare and fix what its note points to (the snippet on every page, consent, bot filtering); keep the old tool until it says close`,
          },
          4,
          "analytics",
        ),
      );
  }
  return checks;
}

// ---------- first-party collection (step 4) ----------

const FP_TITLE = "Browser events arrive first-party (through the site's own domain), so ad blockers don't drop them";

/**
 * analytics.first_party: fails while the latest browser events go straight to the analytics host;
 * a warning when some did this week but the latest came first-party (pages still on the direct
 * snippet); waiting_on_owner while a first-party domain waits for its DNS record. Only once browser
 * events arrived in the last 7 days, and only with an analytics service that counts them.
 */
export function firstPartyCheck(
  domain: string,
  siteId: string,
  data: AnalyticsSite["data"] | undefined,
  x: Pick<Ctx, "S" | "A" | "firstParty">,
): Omit<SetupCheck, "step" | "service" | "domain"> | null {
  const c = data?.collection_last_7d;
  if (!c || !(c.direct + c.proxy + c.edge)) return null;
  const firstParty = c.proxy + c.edge;
  const via = [
    c.edge ? `${c.edge} through ${list(c.edge_hosts?.length ? c.edge_hosts : ["a first-party domain"], 3)}` : "",
    c.proxy ? `${c.proxy} through the site's own proxy` : "",
  ]
    .filter(Boolean)
    .join(", ");
  if (!c.direct)
    return {
      id: "analytics.first_party",
      status: "ok",
      title: FP_TITLE,
      detail: `All ${plural(firstParty, "browser event")} in 7 days came first-party (${via}).`,
    };
  const base = domain.replace(/^www\./, "");
  const mine = (x.firstParty ?? []).filter((d) => d.hostname.endsWith(`.${base}`));
  const active = mine.find((d) => d.status === "active");
  const pending = mine.find((d) => d.status === "pending");
  const swap = (h: string) =>
    `Swap the snippets on every page to https://${h}: <script defer src="https://${h}/_a/s.js" data-site="${siteId}"></script> (tags: https://${h}/_t/c/<ctr>.js), deploy, open a page once, then run this check again`;
  const fix = active
    ? swap(active.hostname)
    : pending
      ? `The owner adds the DNS record CNAME ${pending.hostname} (GET ${x.S}/v1/first-party-domains/${pending.hostname} has it; MCP afs_list_first_party_domains); once it says active: ${swap(pending.hostname).charAt(0).toLowerCase()}${swap(pending.hostname).slice(1)}`
      : `Add a first-party domain, one CNAME: POST ${x.S}/v1/first-party-domains {"hostname":"edge.${base}"} (MCP afs_add_first_party_domain) and follow its next_steps. Can't change DNS: the path proxy, GET ${x.A}/v1/sites/${siteId}/install (first_party_proxy). Then swap the snippet`;
  const recentFirstParty = !!c.last_first_party_at && (c.last_direct_at ?? 0) <= c.last_first_party_at;
  if (recentFirstParty)
    return {
      id: "analytics.first_party",
      status: "warning",
      title: FP_TITLE,
      detail: `The latest browser events came first-party (${via}), but ${plural(c.direct, "event")} this week went straight to the analytics host (the last at ${iso(c.last_direct_at)}). Fine if that was before the switch; otherwise some pages still have the direct snippet.`,
      fix: `Check every page and template for ${x.A}/s.js and swap it for the first-party src${active ? ` (https://${active.hostname}/_a/s.js)` : ""}`,
    };
  if (pending && !active)
    return {
      id: "analytics.first_party",
      status: "waiting_on_owner",
      title: FP_TITLE,
      detail: `${plural(c.direct, "browser event")} in 7 days went straight to the analytics host, which ad blockers block. First-party domain ${pending.hostname} is waiting for its DNS record (CNAME), so the pages keep the current snippet until it is active.`,
      fix,
    };
  return {
    id: "analytics.first_party",
    status: "failing",
    title: FP_TITLE,
    detail: `${plural(c.direct, "browser event")} in 7 days${firstParty ? ` (and the latest ones, at ${iso(c.last_direct_at)})` : ""} went straight to the analytics host: ad blockers block it (their filter lists target analytics.* hosts), so some visitors are never counted.${firstParty ? ` ${via} came first-party.` : ""}`,
    fix,
  };
}

// ---------- analytics (step 4) ----------

async function analyticsChecks(domain: string, site: SiteItem | null, x: Ctx) {
  const { A } = x;
  const at = (c: Omit<SetupCheck, "step" | "service" | "domain">): SetupCheck => ({ ...c, step: 4, service: "analytics", domain });
  if (!x.resources.sites)
    return {
      checks: [
        at({
          id: "analytics.site",
          status: "unavailable",
          title: "Analytics has a site for the website",
          detail: "The analytics service didn't answer.",
        }),
      ],
      goals: null,
      siteId: null,
    };
  if (!site)
    return {
      checks: [
        at({
          id: "analytics.site",
          status: "missing",
          title: "Analytics has a site for the website",
          detail: `No analytics site for ${domain}.`,
          fix: `POST ${A}/v1/sites {"domain":"${domain}"} (MCP analytics_create_site)`,
        }),
      ],
      goals: null,
      siteId: null,
    };
  const p = `/v1/sites/${site.id}`;
  const [detail, goalsRes, goalStats, dests, reports, alerts, crawls] = await Promise.all([
    x.read<AnalyticsSite>("analytics", p),
    x.read<{ goals: Goal[] }>("analytics", `${p}/goals`),
    x.read<{ breakdown?: { results?: GoalRow[] } }>("analytics", `${p}/stats?period=30d&breakdown=goal&debug=include&limit=100`),
    x.read<{ destinations: AnalyticsDestination[]; email_available?: boolean }>("analytics", `${p}/destinations`),
    x.read<{ reports: Report[] }>("analytics", `${p}/reports`),
    x.read<{ alerts: Alert[] }>("analytics", `${p}/alerts`),
    x.read<{ totals?: { hits?: number; by_category?: Record<string, number> } }>("analytics", `${p}/crawlers?period=7d&by=category`),
  ]);
  const checks: SetupCheck[] = [
    at({ id: "analytics.site", status: "ok", title: "Analytics has a site for the website", detail: `${site.id} (${site.domain}).` }),
  ];
  const unavailable = (id: string, title: string) =>
    at({ id, status: "unavailable", title, detail: "The analytics service didn't answer this read.", fix: `GET ${A}${p}` });

  // Events arriving
  const data = detail?.data;
  const receiving = "Analytics is receiving events from the pages";
  if (!detail) checks.push(unavailable("analytics.receiving", receiving));
  else if (!data || !data.total_events)
    checks.push(
      at({
        id: "analytics.receiving",
        status: "missing",
        title: receiving,
        detail: "No events yet.",
        fix: `Put the site's snippet (GET ${A}${p} -> site.snippet) in the <head> of every page, deploy, then open https://${domain}/?afsa_debug=1 and check realtime?debug=only`,
      }),
    );
  else if (!data.browser_events)
    checks.push(
      at({
        id: "analytics.receiving",
        status: "failing",
        title: receiving,
        detail: `${plural(data.server_events, "server event")} but nothing from a browser: the snippet isn't on the live pages.`,
        fix: `Put the site's snippet (GET ${A}${p} -> site.snippet) in the <head> of every page and deploy`,
      }),
    );
  else if (data.last_event_at && Date.now() - data.last_event_at > 7 * DAY)
    checks.push(
      at({
        id: "analytics.receiving",
        status: "warning",
        title: receiving,
        detail: `No events in 7 days (the last at ${iso(data.last_event_at)}). Fine for a site without visitors; otherwise the snippet may have been removed.`,
        fix: `POST ${A}${p}/verify (MCP analytics_verify_install)`,
      }),
    );
  else
    checks.push(
      at({
        id: "analytics.receiving",
        status: "ok",
        title: receiving,
        detail: `${plural(data.total_events, "event")} (${data.browser_events} from browsers, ${data.server_events} server); the last at ${iso(data.last_event_at)}.`,
      }),
    );

  // Domain verified (verify proved the snippet is on the homepage, or the DNS record)
  const verifiedTitle = "The site's domain is verified";
  if (detail?.site?.verification?.verified)
    checks.push(
      at({
        id: "analytics.domain_verified",
        status: "ok",
        title: verifiedTitle,
        detail: "verify found the snippet on the homepage, or the DNS record.",
      }),
    );
  else if (detail)
    checks.push(
      at({
        id: "analytics.domain_verified",
        status: "missing",
        title: verifiedTitle,
        detail: "Not verified yet: verify hasn't found the snippet on the live homepage.",
        fix: `Deploy the snippet, then POST ${A}${p}/verify (MCP analytics_verify_install)`,
      }),
    );

  // A first-party proxy that doesn't send its key: every visitor looks like the proxy (one network,
  // its country), visitors merge, and attack protection's per-network share fills up with real
  // visitors. Shown only when it happens.
  const warn = data?.warnings_last_7d ?? {};
  const keyless = (warn.proxy_key_missing?.count ?? 0) + (warn.proxy_key_invalid?.count ?? 0);
  if (keyless)
    checks.push(
      at({
        id: "analytics.proxy_key",
        status: "failing",
        title: "Events through a first-party proxy carry its proxy key",
        detail: `${plural(keyless, "event")} in the last 7 days came through a first-party proxy ${
          warn.proxy_key_invalid?.count ? "with a wrong" : "without an"
        } x-afs-proxy-key header, so they carry the proxy's address and country instead of the visitor's: visitors merge into one, countries are wrong, and attack protection can set real visitors aside as one network over its daily share.`,
        fix: `Re-apply the proxy snippet from GET ${A}${p}/install (first_party_proxy): it sends x-afs-proxy-key with the site's proxy_key and the visitor's IP and geo. Then release anything set aside: GET ${A}${p}/quarantine.`,
      }),
    );

  // First-party collection (the default): browser events sent straight to the analytics host are
  // the ones ad blockers drop. Judged by the latest events, so a switch shows at once.
  const fp = firstPartyCheck(domain, site.id, data, x);
  if (fp) checks.push(at(fp));

  // Goals, and whether each has counted
  const goals = goalsRes?.goals ?? null;
  if (!goals) checks.push(unavailable("analytics.goals", "There is a goal for each conversion and main action"));
  else if (!goals.length)
    checks.push(
      at({
        id: "analytics.goals",
        status: "missing",
        title: "There is a goal for each conversion and main action",
        detail: "No goals yet.",
        fix: `POST ${A}${p}/goals {"name":"Signed up","type":"event","match":"sign_up"} for each one (MCP analytics_create_goal)`,
      }),
    );
  else {
    checks.push(
      at({
        id: "analytics.goals",
        status: "ok",
        title: "There is a goal for each conversion and main action",
        detail: `${plural(goals.length, "goal")}: ${list(
          goals.map((g) => g.name),
          30,
        )}.`,
      }),
    );
    const counted = new Map((goalStats?.breakdown?.results ?? []).map((r) => [r.value, r.conversions ?? 0]));
    const title = "Every goal has counted at least once (test traffic included, last 30 days)";
    if (!goalStats) checks.push(unavailable("analytics.goals_counted", title));
    else {
      const never = goals.filter((g) => !counted.get(g.name)).map((g) => g.name);
      checks.push(
        never.length
          ? at({
              id: "analytics.goals_counted",
              status: "failing",
              title,
              detail: `Never counted: ${list(never)}.`,
              fix: `Trigger each on the live site with ?afsa_debug=1 (server events: send one with "debug": true). If one still doesn't count, compare its match with the event names in GET ${A}${p}/schema`,
            })
          : at({ id: "analytics.goals_counted", status: "ok", title, detail: `All ${plural(goals.length, "goal")} counted.` }),
      );
    }
  }

  // Server events (only a hint: not every site has backend conversions)
  if (data?.total_events && !data.server_events)
    checks.push(
      at({
        id: "analytics.server_events",
        status: "warning",
        title: "Conversions only the backend knows arrive as server events",
        detail: "No server events yet. Ignore this if the business has no backend conversions (a verified sign-up, a paid order).",
        fix: `POST ${A}${p}/events {"events":[{"name":"sign_up","visitor_id":"<afsa.visitorId() from the page>","debug":true}]}`,
      }),
    );

  // AI crawlers and search bots (a hint: a site on static hosting has no server to report them)
  const crawlTitle = "AI crawler and search bot visits are reported from the site's server";
  if (!crawls) checks.push(unavailable("analytics.crawlers", crawlTitle));
  else if (crawls.totals?.hits) {
    const by = crawls.totals.by_category ?? {};
    const parts = Object.entries(CRAWL_NAMES)
      .filter(([k]) => by[k])
      .map(([k, name]) => `${by[k]} from ${name}`);
    checks.push(
      at({
        id: "analytics.crawlers",
        status: "ok",
        title: crawlTitle,
        detail: `${plural(crawls.totals.hits, "bot request")} in the last 7 days${parts.length ? ` (${parts.join(", ")})` : ""}.`,
      }),
    );
  } else
    checks.push(
      at({
        id: "analytics.crawlers",
        status: "warning",
        title: crawlTitle,
        detail:
          "None reported in the last 7 days. Bots don't run the tracker, so the site's server reports them. Ignore this if the site is on static hosting with no server or edge code (GitHub Pages, a plain bucket).",
        fix: `In the site's server or edge middleware, for requests whose user agent matches the prefilter from GET ${A}/v1/crawlers, POST ${A}${p}/crawls {"user_agent","path","status"} without waiting for it (code in "AI crawlers" in ${A}/llms.txt), then check GET ${A}${p}/crawlers`,
      }),
    );

  // For the owner: email, weekly report, alerts
  const destTitle = "The owner gets email from analytics";
  if (!dests) checks.push(unavailable("analytics.owner_email", destTitle));
  else {
    const email = dests.destinations.filter((d) => d.type === "email");
    const failed = dests.destinations.filter((d) => d.last_status === "failed").map((d) => d.name ?? d.id);
    if (failed.length)
      checks.push(
        at({
          id: "analytics.owner_email",
          status: "failing",
          title: destTitle,
          detail: `Last delivery failed: ${list(failed)}.`,
          fix: `POST ${A}${p}/destinations/<id>/test (MCP analytics_test_destination) and read the error`,
        }),
      );
    else if (email.length)
      checks.push(
        at({
          id: "analytics.owner_email",
          status: "ok",
          title: destTitle,
          detail: "An email destination reaches every member of the project.",
        }),
      );
    else if (dests.email_available === false)
      checks.push(
        at({
          id: "analytics.owner_email",
          status: dests.destinations.length ? "ok" : "warning",
          title: destTitle,
          detail: dests.destinations.length
            ? "This deployment doesn't send email; a webhook or Slack destination is set."
            : "This deployment doesn't send email. Add a Slack or webhook destination if the owner wants reports.",
          ...(dests.destinations.length
            ? {}
            : { fix: `POST ${A}${p}/destinations {"type":"slack","url":"https://hooks.slack.com/services/..."}` }),
        }),
      );
    else
      checks.push(
        at({
          id: "analytics.owner_email",
          status: "missing",
          title: destTitle,
          detail: "No email destination. It reaches the owner once they claim the project (nothing is sent before).",
          fix: `POST ${A}${p}/destinations {"type":"email","name":"Project members"} (MCP analytics_create_destination)`,
        }),
      );
  }
  const reportTitle = "A weekly report goes to the owner";
  if (!reports) checks.push(unavailable("analytics.weekly_report", reportTitle));
  else
    checks.push(
      reports.reports.some((r) => r.enabled)
        ? at({
            id: "analytics.weekly_report",
            status: "ok",
            title: reportTitle,
            detail: `${list([...new Set(reports.reports.filter((r) => r.enabled).map((r) => r.cadence ?? "scheduled"))])} report.`,
          })
        : at({
            id: "analytics.weekly_report",
            status: "missing",
            title: reportTitle,
            detail: "No scheduled report.",
            fix: `POST ${A}${p}/reports {"name":"Weekly report","cadence":"weekly","destination_ids":["<the email destination id>"]} (MCP analytics_create_report)`,
          }),
    );
  const alertTitle = "Alerts fire on a traffic drop and when tracking stops";
  if (!alerts) checks.push(unavailable("analytics.alerts", alertTitle));
  else {
    const on = new Set(alerts.alerts.filter((a) => a.enabled).map((a) => a.type));
    const lacking = (["traffic_drop", "no_data"] as const).filter((t) => !on.has(t));
    checks.push(
      lacking.length
        ? at({
            id: "analytics.alerts",
            status: "missing",
            title: alertTitle,
            detail: `Missing: ${lacking.join(", ")}.`,
            fix: `POST ${A}${p}/alerts {"name":"...","type":"${lacking[0]}","destination_ids":["<the email destination id>"]} for each (MCP analytics_create_alert)`,
          })
        : at({ id: "analytics.alerts", status: "ok", title: alertTitle, detail: `On: ${list([...on].map((t) => ALERT_NAMES[t] ?? t))}.` }),
    );
  }
  return { checks, goals, siteId: site.id };
}

// ---------- tags (step 5) ----------

interface TagsDetail {
  container: TagsContainer | null;
  conversions: Conversion[] | null;
  /** The live version's config (null: nothing published, or it didn't answer). */
  config: LiveTagsConfig | null;
  stats: TagStats | null;
  destinations: TagsDestination[] | null;
}

async function tagsDetail(container: ContainerItem, x: Ctx): Promise<TagsDetail> {
  const p = `/v1/containers/${container.id}`;
  const [detail, stats, dests] = await Promise.all([
    x.read<TagsContainer>("tags", p),
    x.read<TagStats>("tags", `${p}/tag-stats?since=7d`),
    x.read<{ destinations: TagsDestination[] }>("tags", `${p}/destinations`),
  ]);
  const live = detail?.container.live_version ?? container.live_version;
  const version = live ? await x.read<{ config?: LiveTagsConfig }>("tags", `${p}/versions/${live}`) : null;
  return {
    container: detail,
    conversions: live ? (version ? (version.config?.conversions ?? []) : null) : [],
    config: version?.config ?? null,
    stats,
    destinations: dests?.destinations ?? null,
  };
}

function tagsChecksFor(
  domain: string,
  container: ContainerItem | null,
  d: TagsDetail | null,
  analytics: { goals: Goal[] | null; siteId: string | null },
  x: Ctx,
): SetupCheck[] {
  const { T, A } = x;
  const at = (c: Omit<SetupCheck, "step" | "service" | "domain">): SetupCheck => ({ ...c, step: 5, service: "tags", domain });
  if (!x.resources.containers)
    return [
      at({
        id: "tags.container",
        status: "unavailable",
        title: "There is a tag container for the website",
        detail: "The tags service didn't answer.",
      }),
    ];
  if (!container || !d)
    return [
      at({
        id: "tags.container",
        status: "missing",
        title: "There is a tag container for the website",
        detail: `No tag container for ${domain}.`,
        fix: `POST ${T}/v1/containers {"domain":"${domain}"} (MCP tags_create_container)`,
      }),
    ];
  const p = `/v1/containers/${container.id}`;
  const checks: SetupCheck[] = [
    at({ id: "tags.container", status: "ok", title: "There is a tag container for the website", detail: container.id }),
  ];
  const live = d.container?.container.live_version ?? container.live_version;

  // The snippet is on the pages
  const seen =
    d.container?.container.domain_verified ||
    (d.stats?.tags ?? []).some((t) => t.fired > 0 || (t.test_skipped ?? 0) > 0) ||
    (d.container?.stats?.today?.browser_events ?? 0) > 0;
  const installedTitle = "The container snippet is on the pages";
  checks.push(
    seen
      ? at({ id: "tags.installed", status: "ok", title: installedTitle, detail: "Found on the homepage or seen from browsers." })
      : at({
          id: "tags.installed",
          status: "missing",
          title: installedTitle,
          detail: "The snippet hasn't been found on the homepage or seen from a browser.",
          fix: `Put the container's snippet (GET ${T}${p} -> container.snippet) in the <head> of every page, deploy, then POST ${T}${p}/scan (MCP tags_scan_site)`,
        }),
  );

  // Published, with events
  if (!live)
    checks.push(
      at({
        id: "tags.published",
        status: "missing",
        title: "A version is published",
        detail: "Nothing is published: browsers load an empty container.",
        fix: `POST ${T}${p}/setup (MCP tags_setup_conversion_tracking), validate and preview, then POST ${T}${p}/publish (MCP tags_publish)`,
      }),
    );
  else {
    checks.push(at({ id: "tags.published", status: "ok", title: "A version is published", detail: `Version ${live} is live.` }));
    const conv = d.conversions;
    const evTitle = "There is an event for each main action";
    if (!conv)
      checks.push(
        at({
          id: "tags.events",
          status: "unavailable",
          title: evTitle,
          detail: "The tags service didn't return the live version.",
          fix: `GET ${T}${p}/versions/${live}`,
        }),
      );
    else if (!conv.length)
      checks.push(
        at({
          id: "tags.events",
          status: "missing",
          title: evTitle,
          detail: `Version ${live} has no events.`,
          fix: `POST ${T}${p}/setup with platforms ["analytics", ...] and one event per main action (MCP tags_setup_conversion_tracking), then publish`,
        }),
      );
    else {
      checks.push(
        at({
          id: "tags.events",
          status: "ok",
          title: evTitle,
          detail: `${plural(conv.length, "event")} in version ${live}: ${list(
            conv.map((c) => c.name),
            30,
          )}.`,
        }),
      );
      const toAnalytics = conv.filter((c) => c.send_to?.analytics);
      if (!toAnalytics.length)
        checks.push(
          at({
            id: "tags.to_analytics",
            status: "missing",
            title: "The events reach analytics",
            detail: "No event is sent to analytics.",
            fix: `Run setup again with "analytics" in platforms (it adds the analytics tag and send_to.analytics), then publish`,
          }),
        );
      else {
        checks.push(
          at({
            id: "tags.to_analytics",
            status: "ok",
            title: "The events reach analytics",
            detail: `${toAnalytics.length} of ${conv.length} go to analytics.`,
          }),
        );
        // Cross-check: each event sent to analytics has a goal there.
        if (analytics.goals && analytics.siteId) {
          const names = [...new Set(toAnalytics.map((c) => c.send_to?.analytics?.event_name || c.name))];
          const eventGoals = analytics.goals.filter((g) => g.type === "event");
          const noGoal = names.filter((n) => !eventGoals.some((g) => goalMatches(g.match, n)));
          checks.push(
            noGoal.length
              ? at({
                  id: "tags.goals_for_events",
                  status: "missing",
                  title: "Each event sent to analytics has a goal there",
                  detail: `No goal for: ${list(noGoal)}. They're recorded, but don't count as conversions.`,
                  fix: `POST ${A}/v1/sites/${analytics.siteId}/goals {"name":"...","type":"event","match":"${noGoal[0]}"} for each (MCP analytics_create_goal)`,
                })
              : at({
                  id: "tags.goals_for_events",
                  status: "ok",
                  title: "Each event sent to analytics has a goal there",
                  detail: `All ${plural(names.length, "event name")} have a goal.`,
                }),
          );
        }
      }
    }
  }

  // Tags firing (report_tag_fires)
  const fireTitle = "Every tag fires, and none fails";
  if (!d.stats)
    checks.push(
      at({
        id: "tags.firing",
        status: "unavailable",
        title: fireTitle,
        detail: "The tags service didn't answer.",
        fix: `GET ${T}${p}/tag-stats?since=7d`,
      }),
    );
  else if (!d.stats.reporting)
    checks.push(
      at({
        id: "tags.firing",
        status: "missing",
        title: fireTitle,
        detail: "report_tag_fires is off, so there's no way to see whether tags fire.",
        fix: `PATCH ${T}${p}/draft {"settings":{"report_tag_fires":true}} (MCP tags_patch_draft), then publish`,
      }),
    );
  else if (live) {
    const failing = d.stats.failing;
    const never = d.stats.never_fired;
    checks.push(
      failing.length || never.length
        ? at({
            id: "tags.firing",
            status: "failing",
            title: fireTitle,
            detail: [failing.length ? `Failing: ${list(failing)}.` : "", never.length ? `Never fired in 7 days: ${list(never)}.` : ""]
              .filter(Boolean)
              .join(" "),
            fix: `GET ${T}${p}/tag-stats?since=7d (MCP tags_get_tag_stats) says why; open a preview on the page that should fire it`,
          })
        : at({
            id: "tags.firing",
            status: "ok",
            title: fireTitle,
            detail: `${plural(d.stats.tags.length, "tag")} fired in the last 7 days.`,
          }),
    );
  }

  // Ad platform destinations (only when there are any)
  const dests = (d.destinations ?? []).filter((t) => t.enabled);
  if (dests.length) {
    const broken = dests
      .filter((t) => t.health?.circuit === "open" || (t.health?.consecutive_failures ?? 0) > 0)
      .map((t) => t.name ?? t.type);
    checks.push(
      broken.length
        ? at({
            id: "tags.destinations",
            status: "failing",
            title: "Conversions reach every ad platform",
            detail: `Failing deliveries: ${list(broken)}.`,
            fix: `GET ${T}${p}/destinations/<id> shows the last failure; POST ${T}${p}/destinations/<id>/test (MCP tags_test_destination) after fixing`,
          })
        : at({
            id: "tags.destinations",
            status: "ok",
            title: "Conversions reach every ad platform",
            detail: `${list(dests.map((t) => t.name ?? t.type))}, none failing.`,
          }),
    );
  }

  // Ad pixels for visitors who must consent first (only when the live config has ad pixels)
  const consent = d.config ? consentBannerCheck(d.config, domain, `${T}${p}`) : null;
  if (consent) checks.push(at(consent));
  return checks;
}

/** Tag types that are ad pixels (they wait for ad_storage unless a tag says otherwise). */
const AD_PIXELS = new Set([
  "google_ads",
  "meta_pixel",
  "tiktok_pixel",
  "linkedin_insight",
  "microsoft_uet",
  "reddit_pixel",
  "x_pixel",
  "pinterest_tag",
  "snap_pixel",
  "image_pixel",
]);
/** The EEA (tags' "EEA" consent region), then the UK and Switzerland: where visitors must opt in. */
const EEA = "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO".split(" ");
const ASK_FIRST = [...EEA, "GB", "CH"];

/**
 * Countries ("" = unknown) where the live config fires these ad pixels before the visitor chooses:
 * the consent block's start state (mode, default, then the visitor's country or the EEA region, as
 * the tags runtime decides) grants every type a pixel needs.
 */
export function adPixelsBeforeConsent(cfg: LiveTagsConfig): { tags: string[]; countries: string[] } {
  const c = cfg.consent ?? {};
  const base = c.mode === "opt_in" ? "denied" : "granted";
  const pixels = (cfg.tags ?? []).filter((t) => t.enabled !== false && AD_PIXELS.has(t.type));
  const tags = new Set<string>();
  const countries: string[] = [];
  for (const cc of [...ASK_FIRST, ""]) {
    const region = (cc && c.regions?.[cc]) || (EEA.includes(cc) ? c.regions?.EEA : undefined);
    const state = (k: string) => region?.[k] ?? c.default?.[k] ?? base;
    const firing = pixels.filter((t) => (t.consent ?? ["ad_storage"]).every((k) => state(k) === "granted"));
    if (!firing.length) continue;
    countries.push(cc);
    for (const t of firing) tags.add(t.id);
  }
  return { tags: [...tags], countries };
}

function consentBannerCheck(cfg: LiveTagsConfig, domain: string, url: string): Omit<SetupCheck, "step" | "service" | "domain"> | null {
  if (!(cfg.tags ?? []).some((t) => t.enabled !== false && AD_PIXELS.has(t.type))) return null;
  const title = "Visitors from the EU, UK and Switzerland are asked before ad pixels fire";
  if (cfg.consent_banner?.enabled)
    return {
      id: "tags.consent_banner",
      status: "ok",
      title,
      detail: `The consent banner asks ${cfg.consent_banner.regions === "all" ? "every visitor" : "visitors from the EU, UK and Switzerland"} first.`,
    };
  if (cfg.consent?.tcf)
    return { id: "tags.consent_banner", status: "ok", title, detail: "An IAB TCF consent platform on the site decides (consent.tcf)." };
  const firing = adPixelsBeforeConsent(cfg);
  if (!firing.countries.length)
    return {
      id: "tags.consent_banner",
      status: "ok",
      title,
      detail: "Ad pixels wait for consent there; the site's own banner grants it (afst('consent', 'update', ...) or gtag consent).",
    };
  const known = firing.countries.filter(Boolean);
  const where = [
    known.length ? `the EU, UK or Switzerland (${list(known, 5)})` : "",
    firing.countries.includes("") ? "an unknown country" : "",
  ]
    .filter(Boolean)
    .join(" and from ");
  return {
    id: "tags.consent_banner",
    status: "warning",
    title,
    detail: `${list(firing.tags)} fire for visitors from ${where} before they consent, and there's no consent banner. Fine only if the site has its own consent platform that tells the container (gtag('consent', ...) or afst('consent', ...)).`,
    fix: `PATCH ${url}/draft {"consent_banner":{"enabled":true,"privacy_url":"https://${domain}/privacy"}} (MCP tags_patch_draft), then POST ${url}/publish (MCP tags_publish)`,
  };
}

// ---------- replay (step 6) ----------

async function replayChecks(domain: string, rsite: ReplaySiteItem | null, analyticsSiteId: string | null, x: Ctx): Promise<SetupCheck[]> {
  const { R } = x;
  const at = (c: Omit<SetupCheck, "step" | "service" | "domain">): SetupCheck => ({ ...c, step: 6, service: "replay", domain });
  if (!x.resources.replaySites)
    return [
      at({ id: "replay.site", status: "unavailable", title: "Replay records the website", detail: "The replay service didn't answer." }),
    ];
  if (!rsite)
    return [
      at({
        id: "replay.site",
        status: "missing",
        title: "Replay records the website",
        detail: `No replay site for ${domain}.`,
        fix: `POST ${R}/v1/sites {"domain":"${domain}","analytics_site_id":"${analyticsSiteId ?? "site_..."}","require_consent":"eea"} (MCP replay_create_replay_site)`,
      }),
    ];
  const p = `/v1/sites/${rsite.id}`;
  const d = await x.read<ReplaySite>("replay", p);
  if (!d)
    return [
      at({
        id: "replay.site",
        status: "unavailable",
        title: "Replay records the website",
        detail: "The replay service didn't answer.",
        fix: `GET ${R}${p}`,
      }),
    ];
  const checks: SetupCheck[] = [
    d.site.enabled
      ? at({
          id: "replay.site",
          status: "ok",
          title: "Replay records the website",
          detail: `${rsite.id}${d.site.mask_mode ? `, ${d.site.mask_mode} masking` : ""}.`,
        })
      : at({
          id: "replay.site",
          status: "warning",
          title: "Replay records the website",
          detail: `${rsite.id} is turned off (enabled: false). Fine if the owner chose that.`,
          fix: `PATCH ${R}${p} {"enabled":true}`,
        }),
  ];
  checks.push(
    d.site.analytics_site_id
      ? at({
          id: "replay.linked",
          status: "ok",
          title: "Replay is linked to analytics",
          detail: `Loads with analytics site ${d.site.analytics_site_id}.`,
        })
      : at({
          id: "replay.linked",
          status: "missing",
          title: "Replay is linked to analytics",
          detail: "Not linked: the recorder needs its own snippet, and sessions don't join analytics visits.",
          fix: `PATCH ${R}${p} {"analytics_site_id":"${analyticsSiteId ?? "site_..."}"} (MCP replay_update_replay_site)`,
        }),
  );
  checks.push(
    d.site.verification?.verified
      ? at({
          id: "replay.verified",
          status: "ok",
          title: "Replay's domain is verified",
          detail: "verify found the recorder (or the linked tracker) on the homepage.",
        })
      : at({
          id: "replay.verified",
          status: "missing",
          title: "Replay's domain is verified",
          detail: "Not verified: until it is, replay records only a short trial.",
          fix: `POST ${R}${p}/verify (MCP replay_verify_install)`,
        }),
  );
  const sessions = d.data?.sessions_total ?? 0;
  checks.push(
    sessions
      ? at({
          id: "replay.recording",
          status: "ok",
          title: "Sessions are being recorded",
          detail: `${plural(sessions, "session")}; the last started ${iso(d.data?.last_session_started_at)}.`,
        })
      : at({
          id: "replay.recording",
          status: "missing",
          title: "Sessions are being recorded",
          detail: "No sessions yet.",
          fix: `Open https://${domain}/?afsa_debug=1&afsr=1 in a browser (a forced test recording), then GET ${R}${p}/sessions`,
        }),
  );
  if (!d.site.require_consent)
    checks.push(
      at({
        id: "replay.consent",
        status: "warning",
        title: "Visitors from the EU, UK and Switzerland are recorded only after consent",
        detail: "require_consent is off. Fine if the owner decided so, or the site has its own consent banner wired to replay.",
        fix: `PATCH ${R}${p} {"require_consent":"eea"}`,
      }),
    );
  return checks;
}

// ---------- REST ----------

export const setupApi = new Hono<SiteEnv>();
setupApi.get("/v1/setup", requireAuth<SiteEnv>(), async (c) => {
  const auth: AuthContext = c.var.auth;
  const raw = c.req.query("domain");
  const domain = raw ? parseDomain(raw) : null;
  if (raw && !domain) throw badRequest("`domain` isn't a host name.", "Example: GET /v1/setup?domain=example.com");
  const rawServices = c.req.query("services");
  const services = rawServices ? parseServices(rawServices) : null;
  if (rawServices && !services)
    throw badRequest(
      "`services` names a service that doesn't exist.",
      "A comma-separated list of analytics, tags, mail and replay, e.g. GET /v1/setup?services=analytics (default: all of them, the full setup).",
    );
  return c.json(await setupReport(c.env, auth.accountId, { base: siteBase(c), domain, services, record: true }));
});
