import { type AttackItem, PROTECTION_MODES, type ProtectionMode, parse } from "@afs/shared";
import { z } from "zod";
import type { ProtectionView } from "../do/protection";
import { enforce } from "../lib/limits";
import { PERIODS } from "../lib/time";
import { QUARANTINE_REASONS } from "../lib/types";
import { type Ctx, callSite, loadSite } from "./context";
import { periodOf } from "./stats";

/**
 * Attack protection, the owner's side: the site's protection mode, its state (get_site, get_usage
 * attacks), and the quarantine (browser events set aside, out of reports and budgets) to review,
 * release or delete. Ingest-side logic lives in the site's Durable Object (do/protection.ts).
 */

export const protectionField = z
  .enum(PROTECTION_MODES as unknown as [ProtectionMode, ...ProtectionMode[]], { error: 'protection must be "auto", "strict" or "off".' })
  .optional()
  .describe(
    "Attack protection. auto (default): one network's browser events past MAX_EVENTS_PER_NETWORK_PER_SITE_PER_DAY in a UTC day are quarantined (kept for review, out of reports and of the daily event budget), and while a sudden traffic spike lasts browser events from data-centre networks are quarantined too. strict: data-centre browser traffic is always quarantined. off: nothing is quarantined (spikes are still detected and reported). Server events (API key) are never quarantined.",
  );

export const quarantineInput = z.object({
  period: z.enum(PERIODS).optional().describe("today, yesterday, 24h, 7d (default), ... Quarantined events are kept 7 days."),
  from: z.string().optional().describe("YYYY-MM-DD (inclusive, site timezone) or an ISO timestamp."),
  to: z.string().optional().describe("YYYY-MM-DD (inclusive) or an ISO timestamp (exclusive)."),
  reason: z
    .enum(QUARANTINE_REASONS)
    .optional()
    .describe("Only events quarantined for this reason: network_share (one network past its daily share) or datacenter."),
});

const periodFor = (q: z.infer<typeof quarantineInput>) => ({
  ...periodOf({ period: q.period ?? (q.from ? undefined : "7d"), from: q.from, to: q.to }),
  ...(q.reason ? { reason: q.reason } : {}),
});

/** What an agent or the owner can do about a site's protection state. */
export function protectionNextSteps(baseUrl: string, siteId: string, p: Pick<ProtectionView, "mode" | "state" | "quarantined_today">) {
  const site = `${baseUrl}/v1/sites/${siteId}`;
  const active = p.state === "under_attack" || p.state === "contained" || p.state === "ended";
  if (!active && !p.quarantined_today)
    return p.mode === "off" ? [`Attack protection is off. PATCH ${site} {"protection":"auto"} turns it back on.`] : [];
  return [
    `Review what was set aside: GET ${site}/quarantine (MCP get_quarantine).`,
    `If it's real traffic: POST ${site}/quarantine/release (MCP release_quarantine), and PATCH ${site} {"protection":"off"} so it isn't quarantined again.`,
    `If it isn't: POST ${site}/quarantine/purge (MCP purge_quarantine) deletes it now; otherwise it is purged after 7 days.`,
    ...(p.mode === "auto"
      ? [`Stricter: PATCH ${site} {"protection":"strict"} quarantines browser traffic from data-centre networks at all times.`]
      : []),
    ...(p.mode === "off" ? [`Protection is off, so nothing is quarantined: PATCH ${site} {"protection":"auto"} turns it on.`] : []),
  ];
}

/** get_site's protection: the mode, the state, today's quarantine and next steps. */
export function protectionJson(baseUrl: string, siteId: string, view: ProtectionView | undefined, mode: ProtectionMode) {
  const v: ProtectionView = view ?? {
    mode,
    state: "none",
    since: null,
    last_seen_at: null,
    ended_at: null,
    reasons: [],
    quarantined: 0,
    quarantined_today: 0,
    busiest_network_today: 0,
    networks_over_share_today: 0,
  };
  return {
    mode: v.mode,
    state: v.state,
    since: v.since,
    last_seen_at: v.last_seen_at,
    ended_at: v.ended_at,
    reasons: v.reasons,
    quarantined: v.quarantined,
    quarantined_today: v.quarantined_today,
    busiest_network_today: v.busiest_network_today,
    networks_over_share_today: v.networks_over_share_today,
    next_steps: protectionNextSteps(baseUrl, siteId, v),
  };
}

/** One entry of GET /v1/usage `attacks`, for a site whose protection is active or ended in the last 24 h; null otherwise. */
export function attackItem(baseUrl: string, site: { id: string; domain: string }, v: ProtectionView | undefined): AttackItem | null {
  if (!v || v.state === "none" || v.since === null || v.last_seen_at === null) return null;
  return {
    service: "analytics",
    resource_id: site.id,
    resource_label: site.domain,
    state: v.state,
    mode: v.mode,
    since: v.since,
    last_seen_at: v.last_seen_at,
    ended_at: v.state === "ended" ? v.ended_at : null,
    reasons: v.reasons,
    quarantined: v.quarantined,
    next_steps: protectionNextSteps(baseUrl, site.id, v),
  };
}

export async function getQuarantine(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(quarantineInput, raw);
  const site = await loadSite(ctx, siteId);
  const res = await callSite(ctx.env, site, (s) => s.quarantineSummary(periodFor(q)));
  const view = (res as { protection?: ProtectionView }).protection;
  const n = (res as { quarantined?: number }).quarantined ?? 0;
  const proxied = ((res as { proxy_key_warnings_last_7d?: number }).proxy_key_warnings_last_7d ?? 0) > 0;
  const base = `${ctx.baseUrl}/v1/sites/${site.id}`;
  return {
    site_id: site.id,
    ...res,
    protection: protectionJson(ctx.baseUrl, site.id, view, site.protection ?? "auto"),
    notes: [
      "Quarantined events are stored but left out of every report, the daily event budget and realtime; read them in any report with debug=quarantined. They are purged after 7 days.",
      ...(proxied
        ? [
            "Some events reached this site through a first-party proxy without a valid x-afs-proxy-key: those visitors all share the proxy's IP, network and network operator, so they can pass a network's share together (and look like a data centre). Send the proxy key (get_install_instructions) and release them.",
          ]
        : []),
    ],
    next_steps: n
      ? [
          `If it's real traffic: POST ${base}/quarantine/release {"period":"7d"} (MCP release_quarantine), and PATCH ${base} {"protection":"off"} so it isn't quarantined again.`,
          `If it isn't: POST ${base}/quarantine/purge {"period":"7d"} (MCP purge_quarantine) deletes it now.`,
          `Look closer: GET ${base}/realtime?debug=quarantined or GET ${base}/stats?debug=quarantined&breakdown=source.`,
        ]
      : ["Nothing is quarantined in this period."],
  };
}

async function writeCall(ctx: Ctx) {
  await enforce([[ctx.env.API_INGEST_LIMITER, `acct:${ctx.accountId}`]], "write requests", "Wait a minute and retry.");
}

export async function releaseQuarantine(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(quarantineInput, raw ?? {});
  await writeCall(ctx);
  const site = await loadSite(ctx, siteId);
  const res = await callSite(ctx.env, site, (s) => s.releaseQuarantine(periodFor(q)));
  const more = (res as { more?: boolean }).more;
  return {
    site_id: site.id,
    ...res,
    note: "Released events count in every report from now on, and were added to their day's usage count (it may pass the daily budget: that was your call).",
    next_steps: [
      ...(more ? ["More quarantined events match: send the same request again."] : []),
      ...((site.protection ?? "auto") !== "off"
        ? [
            `The same traffic will be quarantined again while protection is ${site.protection ?? "auto"}: PATCH ${ctx.baseUrl}/v1/sites/${site.id} {"protection":"off"} if it is real.`,
          ]
        : []),
    ],
  };
}

export async function purgeQuarantine(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(quarantineInput, raw ?? {});
  await writeCall(ctx);
  const site = await loadSite(ctx, siteId);
  const res = await callSite(ctx.env, site, (s) => s.purgeQuarantine(periodFor(q)));
  const more = (res as { more?: boolean }).more;
  return {
    site_id: site.id,
    ...res,
    note: "Deleted. The quarantine's daily count is not lowered.",
    next_steps: more ? ["More quarantined events match: send the same request again."] : [],
  };
}
