import { type AttackItem, accountStanding, capabilityPaused } from "@afs/shared";
import type { ContainerConfig } from "../config/schema";
import type { ContainerUsage } from "../do/container-do";
import type { Bindings } from "../env";
import { containerStub } from "./containers";
import { outboundScope } from "./budget";
import { containerCaps, deliveryBudgets, eventBudgets, limits, outboundBudgets, standingFlag, utcDay } from "./limits";
import { customCodeIn } from "./verify";
import { attackItem, protectionCaps } from "./protection";

/**
 * GET /v1/usage (MCP get_usage): every cap tags enforces for this account, with what it has used,
 * the limit this deployment sets for an account of its standing (UNCLAIMED_<name> until a person
 * claims it), and when daily budgets reset. limit null = no cap. Mail, analytics and replay share
 * the item shape (label, drops_data, per), so the platform site can warn owners before a limit.
 *
 * The site calls it hourly for every claimed project, so it stays cheap: one D1 batch (per-container
 * counts through the container_id indexes, today's budget rows) and one point-read call per
 * container's Durable Object. Deployment-wide budgets (MAX_EVENTS_PER_DAY, MAX_DELIVERIES_PER_DAY)
 * are the deployment's volume, not the account's, and are left out.
 *
 * `attacks` (attack protection, src/service/protection.ts) lists every container under attack,
 * contained, or ended in the last 24 h; it rides on the same Durable Object answers (no extra call),
 * so the site's hourly check can email people and show a banner from it.
 */

/** One container under a per-container cap. */
export interface UsagePer {
  id: string;
  /** What a person reads: the container's domain. */
  label: string;
  used: number;
  remaining: number | null;
}

export interface UsageItem {
  /** A short sentence-case name a person reads in an email ("Browser events a day in one container"). */
  label: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  /** Daily budgets: next 00:00 UTC (unix ms). null for caps that do not reset. */
  resets_at: number | null;
  /** What one unit is, and what the cap counts. */
  unit: string;
  /** The operator var that sets it (UNCLAIMED_<var> for unclaimed accounts). */
  var: string;
  note?: string;
  /**
   * Reaching it silently loses incoming data (browser hits dropped, backend events refused at
   * ingest, deliveries to ad platforms skipped, visitor identities evicted, the event store full)
   * rather than failing the agent's own call with a clear error. Absent otherwise.
   */
  drops_data?: true;
  /** Per-container caps: every container, highest use first, at most PER_MAX. used = the top one. */
  per?: UsagePer[];
}

/** At most this many entries in an item's per list. */
export const PER_MAX = 25;
/** Container Durable Objects asked per call (an account without MAX_CONTAINERS_PER_ACCOUNT may have many). */
export const MAX_USAGE_CONTAINERS = 100;

const DAY = 86_400_000;
const nextUtcMidnight = (now: number) => (Math.floor(now / DAY) + 1) * DAY;
const num = (n: number) => (Number.isFinite(n) ? n : null);
const left = (limit: number | null, used: number) => (limit === null ? null : Math.max(0, limit - used));

interface ItemOpts {
  note?: string;
  drops_data?: true;
  per?: UsagePer[];
}

function item(
  label: string,
  used: number | null,
  limit: number,
  unit: string,
  varName: string,
  resetsAt: number | null,
  opts: ItemOpts = {},
): UsageItem {
  const l = num(limit);
  return {
    label,
    used,
    limit: l,
    remaining: l === null || used === null ? null : left(l, used),
    resets_at: resetsAt,
    unit,
    var: varName,
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.drops_data ? { drops_data: true as const } : {}),
    ...(opts.per ? { per: opts.per } : {}),
  };
}

interface ContainerUsageRow {
  id: string;
  domain: string;
  created_at: number;
  draft_bytes: number;
  /** Only selected when MAX_CUSTOM_CODE_BYTES is set (custom code is counted in the draft). */
  draft?: string;
  destinations: number;
  versions: number;
  version_bytes: number;
  environments: number;
  lookups: number;
  lookup_rows: number;
  lookup_max_bytes: number;
  lookup_bytes: number;
}

/**
 * A per-container cap: `value` per container (undefined = unknown, e.g. its Durable Object didn't
 * answer), the highest as used (0 without containers, null when none is known) and the per list,
 * highest first (then oldest container first).
 */
function perContainer(rows: ContainerUsageRow[], value: (r: ContainerUsageRow) => number | undefined, limit: number) {
  const known = rows.flatMap((r) => {
    const v = value(r);
    return v === undefined ? [] : [{ r, used: v }];
  });
  known.sort((a, b) => b.used - a.used || a.r.created_at - b.r.created_at || (a.r.id < b.r.id ? -1 : 1));
  const l = num(limit);
  return {
    used: known.length ? known[0]!.used : rows.length ? null : 0,
    per: known.slice(0, PER_MAX).map((k) => ({ id: k.r.id, label: k.r.domain, used: k.used, remaining: left(l, k.used) })),
  };
}

export async function getUsage(env: Bindings, accountId: string, now = Date.now(), base = "") {
  const standing = await accountStanding(env, accountId);
  const day = utcDay(now);
  const resets = nextUtcMidnight(now);
  const caps = limits(env, standing);
  const cc = containerCaps(env, standing);
  const events = eventBudgets(env, standing);
  const deliveries = deliveryBudgets(env, standing);
  const protect = protectionCaps(env, standing);
  const outbound = outboundBudgets(env, standing);
  const countCustomCode = Number.isFinite(caps.maxCustomCodeBytes);

  // Containers per account are capped (MAX_CONTAINERS_PER_ACCOUNT), and each subquery reads one
  // container's rows through its container_id index; the sums are what accountTagsBytes() adds up.
  const [containers, daily, delivered, outboundToday] = await env.DB.batch([
    env.DB.prepare(
      `SELECT c.id AS id, c.domain AS domain, c.created_at AS created_at,
              LENGTH(CAST(c.draft AS BLOB)) AS draft_bytes${countCustomCode ? ", c.draft AS draft" : ""},
              (SELECT COUNT(*) FROM destinations d WHERE d.container_id = c.id) AS destinations,
              (SELECT COUNT(*) FROM container_versions v WHERE v.container_id = c.id) AS versions,
              (SELECT COALESCE(SUM(LENGTH(CAST(v.config AS BLOB))), 0) FROM container_versions v WHERE v.container_id = c.id) AS version_bytes,
              (SELECT COUNT(*) FROM environments e WHERE e.container_id = c.id) AS environments,
              (SELECT COUNT(*) FROM lookups l WHERE l.container_id = c.id) AS lookups,
              (SELECT COALESCE(MAX(l.row_count), 0) FROM lookups l WHERE l.container_id = c.id) AS lookup_rows,
              (SELECT COALESCE(MAX(l.bytes), 0) FROM lookups l WHERE l.container_id = c.id) AS lookup_max_bytes,
              (SELECT COALESCE(SUM(l.bytes), 0) FROM lookups l WHERE l.container_id = c.id) AS lookup_bytes
       FROM containers c WHERE c.account_id = ? ORDER BY c.created_at, c.id`,
    ).bind(accountId),
    // Today's counts each container last reported (rows of deleted containers stay: they still count).
    env.DB.prepare("SELECT container_id, browser_events, server_events FROM usage_daily WHERE account_id = ? AND day = ?").bind(
      accountId,
      day,
    ),
    env.DB.prepare("SELECT n FROM delivery_usage WHERE scope = ? AND day = ?").bind(`account:${accountId}`, day),
    env.DB.prepare("SELECT scope, n FROM delivery_usage WHERE scope IN (?, ?) AND day = ?").bind(
      outboundScope("scans", accountId),
      outboundScope("tests", accountId),
      day,
    ),
  ]);
  const outboundUsed = (kind: "scans" | "tests") =>
    Number(
      ((outboundToday?.results ?? []) as { scope: string; n: number }[]).find((r) => r.scope === outboundScope(kind, accountId))?.n ?? 0,
    );
  const pause = await capabilityPaused(env, accountId, "tags.custom_code");
  const rows = (containers?.results ?? []) as unknown as ContainerUsageRow[];
  const reported = (daily?.results ?? []) as unknown as { container_id: string; browser_events: number; server_events: number }[];
  const accountDeliveries = Number((delivered?.results[0] as { n?: number } | undefined)?.n ?? 0);

  // Today's counters, visitors and event store size from each container's Durable Object.
  const asked = rows.slice(0, MAX_USAGE_CONTAINERS);
  const answers = await Promise.all(
    asked.map(async (r) => {
      try {
        return [r.id, await containerStub(env, r.id).usageToday(day, standing, now)] as const;
      } catch (e) {
        console.error(`usage: container ${r.id} did not answer`, e);
        return [r.id, null] as const;
      }
    }),
  );
  const live = new Map<string, ContainerUsage>();
  for (const [id, u] of answers) if (u) live.set(id, u);
  const fromDO = (k: Exclude<keyof ContainerUsage, "protection">) => (r: ContainerUsageRow) => live.get(r.id)?.[k];

  // The account's daily totals, as the budgets count them: each container's own count (fresher
  // than its last report to D1), plus what containers deleted today reported.
  const ids = new Set(rows.map((r) => r.id));
  const byContainer = new Map(reported.map((d) => [d.container_id, d]));
  const account = { browser: 0, server: 0, deliveries: 0 };
  for (const r of rows) {
    const u = live.get(r.id);
    const d = byContainer.get(r.id);
    account.browser += Math.max(u?.browser_events ?? 0, d?.browser_events ?? 0);
    account.server += Math.max(u?.server_events ?? 0, d?.server_events ?? 0);
    account.deliveries += u?.deliveries ?? 0;
  }
  for (const d of reported)
    if (!ids.has(d.container_id)) {
      account.browser += d.browser_events;
      account.server += d.server_events;
    }
  // D1 counts the account's deliveries only while MAX_DELIVERIES_PER_ACCOUNT_PER_DAY is set (and keeps deleted containers').
  account.deliveries = Math.max(account.deliveries, accountDeliveries);

  const customCode = (r: ContainerUsageRow) => {
    try {
      return customCodeIn(JSON.parse(r.draft ?? "{}") as ContainerConfig, env).bytes;
    } catch {
      return 0;
    }
  };
  const per = (value: (r: ContainerUsageRow) => number | undefined, limit: number) => perContainer(rows, value, limit);
  const destinations = per((r) => r.destinations, caps.maxDestinations);
  const versions = per((r) => r.versions, caps.maxVersions);
  const environments = per((r) => r.environments, caps.maxEnvironments);
  const lookups = per((r) => r.lookups, caps.maxLookups);
  const lookupRows = per((r) => r.lookup_rows, caps.maxLookupRows);
  const lookupBytes = per((r) => r.lookup_max_bytes, caps.maxLookupBytes);
  const draftBytes = per((r) => r.draft_bytes, caps.maxDraftBytes);
  const codeBytes = countCustomCode ? per(customCode, caps.maxCustomCodeBytes) : null;
  const browser = per(fromDO("browser_events"), cc.eventsPerDay);
  const server = per(fromDO("server_events"), cc.eventsPerDay);
  const queued = per(fromDO("deliveries"), cc.deliveriesPerDay);
  const visitors = per(fromDO("visitors"), cc.visitors);
  const dbBytes = per(fromDO("db_bytes"), cc.dbBytes);
  const perNetwork = per(fromDO("network_max"), protect.perNetwork);
  const quarantined = per(fromDO("quarantined"), protect.quarantinedPerDay);
  const consentRecords = per(fromDO("consent_records"), cc.consentRecordsPerDay);
  const storage = rows.reduce((n, r) => n + r.draft_bytes + r.version_bytes + r.lookup_bytes, 0);

  const limitsOut = {
    containers: item("Containers", rows.length, caps.maxContainers, "containers", "MAX_CONTAINERS_PER_ACCOUNT", null, {
      note: "Creating another answers 403 quota_exceeded; delete containers you no longer need (DELETE /v1/containers/:id).",
    }),
    storage_bytes: item(
      "Tag storage",
      storage,
      caps.maxAccountBytes,
      "bytes of drafts, kept versions and lookup tables (serialised JSON), across containers",
      "MAX_TAGS_BYTES_PER_ACCOUNT",
      null,
      {
        note: "Saving a draft, publishing or saving a lookup table that would pass it answers 413 storage_quota_exceeded; shrink drafts (load large code from your own URL) or lookups, or delete containers.",
      },
    ),
    browser_events_per_day: item(
      "Browser events a day",
      account.browser,
      events.perAccount,
      "browser hits (visits, conversions, tag-fire reports) across the account's containers; deleting containers frees nothing",
      "MAX_EVENTS_PER_ACCOUNT_PER_DAY",
      resets,
      {
        note: "Past it /collect drops browser hits on every container until 00:00 UTC: they are not stored or sent to destinations.",
        drops_data: true,
      },
    ),
    server_events_per_day: item(
      "Backend events a day",
      account.server,
      events.perAccount,
      "backend events (POST /v1/containers/:id/events) across the account's containers; deleting containers frees nothing",
      "MAX_EVENTS_PER_ACCOUNT_PER_DAY",
      resets,
      {
        note: "A batch that would pass it is refused (429 quota_exceeded) until 00:00 UTC; conversions a backend doesn't send again are lost.",
        drops_data: true,
      },
    ),
    deliveries_per_day: item(
      "Server-side deliveries a day",
      account.deliveries,
      deliveries.perAccount,
      "deliveries queued (one per event and destination) across the account's containers; deleting containers frees nothing",
      "MAX_DELIVERIES_PER_ACCOUNT_PER_DAY",
      resets,
      {
        note: "Past it events are still logged, but not sent to ad platforms or other destinations (skipped with the reason) until 00:00 UTC.",
        drops_data: true,
      },
    ),
    scans_per_day: item(
      "Scans and verifications a day",
      outboundUsed("scans"),
      outbound.scans.perAccount,
      "site scans and domain verifications (each fetches pages of your site), refused ones included",
      "MAX_SCANS_PER_ACCOUNT_PER_DAY",
      resets,
      {
        note: "Past it scan and verify answer 429 quota_exceeded until 00:00 UTC; scan several pages in one call (paths) and verify with the DNS record.",
      },
    ),
    destination_tests_per_day: item(
      "Destination tests a day",
      outboundUsed("tests"),
      outbound.tests.perAccount,
      "destination tests sent to ad platforms and webhooks, refused ones included",
      "MAX_DESTINATION_TESTS_PER_ACCOUNT_PER_DAY",
      resets,
      { note: "Past it POST /destinations/:did/test answers 429 quota_exceeded until 00:00 UTC; real deliveries are not affected." },
    ),
    browser_events_per_container_per_day: item(
      "Browser events a day in one container",
      browser.used,
      cc.eventsPerDay,
      "browser hits (visits, conversions, tag-fire reports) one container receives (used = the busiest container)",
      "MAX_EVENTS_PER_CONTAINER_PER_DAY",
      resets,
      {
        note: "Past it /collect drops the container's browser hits until 00:00 UTC: they are not stored or sent to destinations.",
        drops_data: true,
        per: browser.per,
      },
    ),
    server_events_per_container_per_day: item(
      "Backend events a day in one container",
      server.used,
      cc.eventsPerDay,
      "backend events (POST /v1/containers/:id/events) one container accepts (used = the busiest container)",
      "MAX_EVENTS_PER_CONTAINER_PER_DAY",
      resets,
      {
        note: "A batch that would pass it is refused (429 quota_exceeded) until 00:00 UTC; conversions a backend doesn't send again are lost.",
        drops_data: true,
        per: server.per,
      },
    ),
    deliveries_per_container_per_day: item(
      "Server-side deliveries a day in one container",
      queued.used,
      cc.deliveriesPerDay,
      "deliveries queued (one per event and destination) in one container (used = the busiest container)",
      "MAX_DELIVERIES_PER_CONTAINER_PER_DAY",
      resets,
      {
        note: "Past it events are still logged, but not sent to ad platforms or other destinations (skipped with the reason) until 00:00 UTC.",
        drops_data: true,
        per: queued.per,
      },
    ),
    visitors_per_container: item(
      "Visitors stored in one container",
      visitors.used,
      cc.visitors,
      "visitor identities (click ids, consent, hashed contact details) one container keeps (used = the container with the most)",
      "MAX_VISITORS_PER_CONTAINER",
      null,
      {
        note: "Past it the least recently seen visitors are deleted to make room (1% at a time): later backend events can't join them, so their click ids are lost. Visitors unseen for 180 days are purged daily.",
        drops_data: true,
        per: visitors.per,
      },
    ),
    container_db_bytes: item(
      "Event store size in one container",
      dbBytes.used,
      cc.dbBytes,
      "bytes of one container's event store (7-day event log, visitors, stats; used = the largest)",
      "MAX_CONTAINER_DB_BYTES",
      null,
      {
        note: "Above it /collect stores nothing (507 storage_full) and backend events stop 25% past it. Events older than 7 days and visitors unseen for 180 days are purged daily.",
        drops_data: true,
        per: dbBytes.per,
      },
    ),
    events_per_network_per_container_per_day: item(
      "Browser events a day from one network in one container",
      perNetwork.used,
      protect.perNetwork,
      "browser hits one client network (an IPv4 address or IPv6 /48, the visitor's behind your first-party proxy with its key) sends one container (used = the busiest network of the busiest container)",
      "MAX_EVENTS_PER_NETWORK_PER_CONTAINER_PER_DAY",
      resets,
      {
        note: "Attack protection, not a loss: past it that network's browser hits are quarantined until 00:00 UTC (logged for review with GET /v1/containers/:id/quarantine, never sent to destinations, not counted against the daily budgets), so one source can't use up the budget real visitors need. Off with protection: off. Backend events are never affected.",
        per: perNetwork.per,
      },
    ),
    quarantined_events_per_container_per_day: item(
      "Quarantined browser hits a day in one container",
      quarantined.used,
      protect.quarantinedPerDay,
      "browser hits attack protection set aside in one container today (a network past its share, or data-centre traffic during an attack; used = the container with the most)",
      "MAX_QUARANTINED_EVENTS_PER_CONTAINER_PER_DAY",
      resets,
      {
        note: "Past it further quarantined hits are counted but not logged. They were never going to be delivered, so nothing from real visitors is lost; GET /v1/containers/:id/quarantine shows what was set aside.",
        per: quarantined.per,
      },
    ),
    consent_records_per_container_per_day: item(
      "Consent records a day in one container",
      consentRecords.used,
      cc.consentRecordsPerDay,
      "consent banner choices recorded as proof of consent in one container today (used = the container with the most)",
      "MAX_CONSENT_RECORDS_PER_CONTAINER_PER_DAY",
      resets,
      {
        note: "Past it visitors' choices still apply in their browsers, but aren't recorded (no proof of consent for them) until 00:00 UTC. GET /v1/containers/:id/consent shows today's count.",
        drops_data: true,
        per: consentRecords.per,
      },
    ),
    destinations_per_container: item(
      "Destinations in one container",
      destinations.used,
      caps.maxDestinations,
      "server-side destinations in one container (used = the container with the most)",
      "MAX_DESTINATIONS_PER_CONTAINER",
      null,
      {
        note: "Adding another answers 403 quota_exceeded; remove one you don't need, or use one webhook that fans out on your side.",
        per: destinations.per,
      },
    ),
    versions_per_container: item(
      "Saved versions in one container",
      versions.used,
      caps.maxVersions,
      "published or saved versions one container keeps (used = the container with the most)",
      "MAX_VERSIONS_PER_CONTAINER",
      null,
      {
        note: "Nothing is refused: publishing past it deletes the oldest versions (never the live one or one an environment is pinned to).",
        per: versions.per,
      },
    ),
    draft_bytes: item(
      "Draft size in one container",
      draftBytes.used,
      caps.maxDraftBytes,
      "bytes of one container's draft config, serialised JSON (used = the largest draft)",
      "MAX_DRAFT_BYTES",
      null,
      {
        note: "A larger draft is refused (413 draft_too_large); load large custom code from your own URL and drop unused tags.",
        per: draftBytes.per,
      },
    ),
    custom_code_bytes: item(
      "Custom code in one container",
      codeBytes ? codeBytes.used : null,
      caps.maxCustomCodeBytes,
      "bytes of custom_html and custom_js code (tags and variables) in one container's draft (used = the most)",
      "MAX_CUSTOM_CODE_BYTES",
      null,
      codeBytes
        ? {
            note: "A draft with more is refused (413 custom_code_too_large); load large code from your own site (<script src=...>).",
            per: codeBytes.per,
          }
        : { note: "Not capped on this deployment beyond the 50 KB per tag the schema allows." },
    ),
    environments_per_container: item(
      "Environments in one container",
      environments.used,
      caps.maxEnvironments,
      "environment snippets in one container (used = the container with the most)",
      "MAX_ENVIRONMENTS_PER_CONTAINER",
      null,
      {
        note: "Creating another answers 403 quota_exceeded; delete one you no longer use, or re-point one with PATCH { version }.",
        per: environments.per,
      },
    ),
    lookups_per_container: item(
      "Lookup tables in one container",
      lookups.used,
      caps.maxLookups,
      "lookup tables in one container (used = the container with the most)",
      "MAX_LOOKUPS_PER_CONTAINER",
      null,
      { note: "Creating another answers 403 quota_exceeded; delete or merge tables.", per: lookups.per },
    ),
    rows_per_lookup: item(
      "Rows in one lookup table",
      lookupRows.used,
      caps.maxLookupRows,
      "rows in one lookup table (used = the largest table; per: each container's largest)",
      "MAX_LOOKUP_ROWS",
      null,
      { note: "A larger table is refused (413 lookup_too_large); split it, or keep only the keys your events carry.", per: lookupRows.per },
    ),
    lookup_bytes: item(
      "Lookup table size",
      lookupBytes.used,
      caps.maxLookupBytes,
      "bytes of one lookup table, serialised JSON (used = the largest table; per: each container's largest); at most 1.5 MB",
      "MAX_LOOKUP_BYTES",
      null,
      { note: "A larger table is refused (413 lookup_too_large); shorten keys and values, or split the table.", per: lookupBytes.per },
    ),
  } satisfies Record<string, UsageItem>;

  // Attack protection: every container under attack, contained, or ended in the last 24 h (the
  // platform site emails people and shows a banner from these; they ride on the answers above).
  const attacks: AttackItem[] = [];
  for (const r of asked) {
    const v = live.get(r.id)?.protection;
    const a = v ? attackItem(base, r.id, r.domain, v) : null;
    if (a) attacks.push(a);
  }

  const missing = rows.length - live.size;
  const claim = env.AUTH_ISSUER ? `POST ${env.AUTH_ISSUER.replace(/\/$/, "")}/v1/claim-link` : "POST /v1/claim-link (on the platform site)";
  return {
    day,
    resets_at: resets,
    resets_at_iso: new Date(resets).toISOString(),
    claimed: standing.claimed,
    limits: limitsOut,
    attacks,
    policy: {
      custom_code_allowed: standingFlag(env, standing, "ALLOW_CUSTOM_CODE", true, false) && !pause,
      // A strong abuse signal (or the operator) paused custom code: { reason, paused_at, until } until lifted.
      custom_code_paused: pause ? { reason: pause.reason, paused_at: pause.paused_at, until: pause.until } : null,
    },
    rate_limits:
      "Bursts are also limited at the edge: /collect per client network and per container (conversions tighter), and scan + verify, destination tests and backend event requests per account (429 rate_limited). Those counters are approximate and not listed here.",
    ...(missing > 0
      ? {
          warnings: [
            `${missing} of ${rows.length} containers' event stores weren't read (${rows.length > MAX_USAGE_CONTAINERS ? `at most ${MAX_USAGE_CONTAINERS} are` : "they didn't answer"}): the per-container event, delivery, visitor and storage figures leave them out.`,
          ],
        }
      : {}),
    next_steps: [
      ...(standing.claimed
        ? []
        : [`Nobody has claimed this account, so the lower unclaimed limits apply. ${claim} gives your person a link to claim it.`]),
      "GET /v1/containers/:id shows one container's last 24 hours, today's counts and storage.",
    ],
  };
}
