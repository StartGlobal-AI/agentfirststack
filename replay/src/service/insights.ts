import { badRequest, parse } from "@afs/shared";
import type { FunnelStep } from "../do/queries";
import { validGlob } from "../lib/glob";
import { toCsv } from "../lib/csv";
import { UNTRUSTED_NOTICE } from "../lib/untrusted";
import { analyticsFunnelSteps } from "./analytics";
import { eventMatchFor } from "./event-definitions";
import { type Ctx, loadSite, siteStub } from "./context";
import type { SessionFilters } from "../do/queries";
import { errorsInput, funnelInput, heatmapInput, SESSION_ONLY_FILTERS } from "./schemas";
import { range, resolveFilters, sessionListItem } from "./sessions";
import type { SiteRow } from "./context";

/** The session-level filters of a heatmap or error query, or null when none was given. */
export async function sessionScopeOf(ctx: Ctx, site: SiteRow, q: Record<string, unknown>): Promise<SessionFilters | null> {
  const picked: Record<string, unknown> = {};
  for (const k of SESSION_ONLY_FILTERS) if (q[k] !== undefined) picked[k] = q[k];
  if (!Object.keys(picked).length) return null;
  const f = await resolveFilters(ctx, site, picked);
  return { ...f, start: 0, end: Number.MAX_SAFE_INTEGER };
}

type HeatResult = Awaited<ReturnType<ReturnType<typeof siteStub>["heatmap"]>>;
type HeatElement = HeatResult["elements"][number];

const pctOf = (x: number | null | undefined) => (x === null || x === undefined ? "?" : `${Math.round(x * 100)}%`);
const name = (e: HeatElement) => `${e.label ? `${JSON.stringify(e.label)} ` : ""}{${e.selector}}`;

/** Plain sentences from a heatmap (deterministic; labels and selectors are recorded content: untrusted). */
export function heatmapFindings(h: HeatResult, other?: HeatResult | null, convertedEvent?: string): string[] {
  const out: string[] = [];
  const els = h.clicks ? h.elements : [];
  const top = [...els].sort((a, b) => b.clicks - a.clicks)[0];
  if (top)
    out.push(`The most clicked element is ${name(top)}: ${pctOf(top.click_share)} of ${h.clicks} clicks, from ${top.sessions} sessions.`);
  for (const e of els.filter((x) => x.interactive && x.reached_by_share !== null && x.reached_by_share < 0.75).slice(0, 2))
    out.push(`${name(e)} sits at ${e.position_pct}% of the page: ${pctOf(e.reached_by_share)} of pageviews scroll far enough to see it.`);
  const dead = [...els].filter((x) => x.dead_clicks >= 2).sort((a, b) => b.dead_clicks - a.dead_clicks)[0];
  if (dead)
    out.push(
      `Most dead-clicked: ${name(dead)} (${dead.dead_clicks} clicks with no effect, ${pctOf(dead.dead_share)} of its clicks${dead.interactive ? "" : "; it isn't interactive"}).`,
    );
  const rage = [...els].filter((x) => x.rage_clicks >= 3).sort((a, b) => b.rage_clicks - a.rage_clicks)[0];
  if (rage) out.push(`Most rage-clicked: ${name(rage)} (${rage.rage_clicks} clicks in rage bursts).`);
  const err = [...els].filter((x) => x.error_clicks >= 1).sort((a, b) => b.error_clicks - a.error_clicks)[0];
  if (err) out.push(`${name(err)} was followed by a JS error ${err.error_clicks} time(s) (error clicks).`);
  if (h.scroll.median_reach_pct !== null)
    out.push(
      `Half of the pageviews reach ${h.scroll.median_reach_pct}% of the page${h.scroll.avg_fold_pct !== null ? `; the first screen shows ${h.scroll.avg_fold_pct}% of it` : ""}.`,
    );
  if (convertedEvent) {
    const conv = els
      .filter((x) => "conversion_share" in x && (x as { converted_sessions?: number }).converted_sessions)
      .sort(
        (a, b) => ((b as { conversion_share: number }).conversion_share ?? 0) - ((a as { conversion_share: number }).conversion_share ?? 0),
      )[0];
    if (conv)
      out.push(
        `Of the sessions that clicked ${name(conv)}, ${pctOf((conv as { conversion_share: number }).conversion_share)} later had ${JSON.stringify(convertedEvent)}.`,
      );
  }
  if (other) {
    const prev = new Map(other.elements.map((e) => [e.selector, e]));
    const moved = els
      .map((e) => ({ e, d: e.click_share - (prev.get(e.selector)?.click_share ?? 0) }))
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
    if (moved && Math.abs(moved.d) >= 0.05)
      out.push(
        `${name(moved.e)} went from ${pctOf(prev.get(moved.e.selector)?.click_share ?? 0)} to ${pctOf(moved.e.click_share)} of clicks compared with the other heatmap.`,
      );
    if (
      h.scroll.median_reach_pct !== null &&
      other.scroll.median_reach_pct !== null &&
      h.scroll.median_reach_pct !== other.scroll.median_reach_pct
    )
      out.push(`Median scroll reach: ${h.scroll.median_reach_pct}% here vs ${other.scroll.median_reach_pct}% in the comparison.`);
  }
  return out;
}

function attentionFindings(h: HeatResult): string[] {
  if (!h.pageviews || !h.attention.some((b) => b.avg_visible_ms)) return [];
  const top = [...h.attention].sort((a, b) => b.time_share - a.time_share)[0]!;
  const out = [
    `The band ${top.from_pct}-${top.to_pct}% of the page holds ${Math.round(top.time_share * 100)}% of the viewing time (${Math.round(top.avg_visible_ms / 100) / 10} s per pageview).`,
  ];
  const lower = h.attention.slice(5).reduce((n, b) => n + b.time_share, 0);
  out.push(`The lower half of the page gets ${Math.round(lower * 100)}% of the viewing time.`);
  const clicked = [...h.attention].sort((a, b) => b.clicks - a.clicks)[0]!;
  if (clicked.clicks) out.push(`Most clicks (${Math.round(clicked.click_share * 100)}%) land in ${clicked.from_pct}-${clicked.to_pct}%.`);
  return out;
}

function compareRange(compare: string, r: { start: number; end: number }): { start: number; end: number } {
  if (compare === "previous") {
    const len = r.end - r.start;
    return { start: Math.max(0, r.start - len - 1), end: r.start - 1 };
  }
  const m = /^(.+)\.\.(.+)$/.exec(compare);
  if (!m) throw badRequest('compare is "previous" or "<from>..<to>".', "Example: compare=previous, or compare=2026-10-01..2026-10-31");
  const c = range({ from: m[1], to: m[2] }, "30d");
  return { start: c.start, end: c.end };
}

export async function getHeatmap(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(heatmapInput, raw);
  if (!validGlob(q.page)) throw badRequest('page must be a path glob starting with "/" or "*".', "Example: page=/pricing or page=/blog/*");
  const site = await loadSite(ctx, siteId);
  const r = range(q, "30d");
  const sessions = await sessionScopeOf(ctx, site, q);
  const stub = siteStub(ctx.env, site.id);
  const base = {
    page: q.page,
    limit: q.limit ?? 50,
    click: q.click,
    sort: q.sort,
    converted_event: q.converted_event ?? null,
  };
  const h = await stub.heatmap({ ...base, start: r.start, end: r.end, device: q.device, sessions });
  let other: HeatResult | null = null;
  let against: Record<string, unknown> | null = null;
  if (q.compare || q.compare_device || q.compare_segment_id) {
    const cr = q.compare ? compareRange(q.compare, r) : r;
    const otherSessions = q.compare_segment_id ? await sessionScopeOf(ctx, site, { ...q, segment_id: q.compare_segment_id }) : sessions;
    other = await stub.heatmap({
      ...base,
      limit: 500,
      start: cr.start,
      end: cr.end,
      device: q.compare_device ?? q.device,
      sessions: otherSessions,
    });
    against = {
      period: { start: cr.start, end: cr.end },
      device: q.compare_device ?? q.device ?? "all",
      ...(q.compare_segment_id ? { segment_id: q.compare_segment_id } : {}),
      pageviews: other.pageviews,
      clicks: other.clicks,
    };
  }
  const prev = other ? new Map(other.elements.map((e) => [e.selector, e])) : null;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const elements = h.elements.map((e) => {
    if (!prev) return e;
    const o = prev.get(e.selector);
    return {
      ...e,
      compare: {
        clicks: o?.clicks ?? 0,
        click_share: o?.click_share ?? 0,
        click_share_delta: r3(e.click_share - (o?.click_share ?? 0)),
        rage_share_delta: r3(e.rage_share - (o?.rage_share ?? 0)),
        dead_share_delta: r3(e.dead_share - (o?.dead_share ?? 0)),
      },
    };
  });
  const scroll =
    other === null
      ? h.scroll
      : {
          ...h.scroll,
          reach: h.scroll.reach.map((x, i) => ({
            ...x,
            compare_share: other!.scroll.reach[i]?.share ?? 0,
            delta: r3(x.share - (other!.scroll.reach[i]?.share ?? 0)),
          })),
          compare_median_reach_pct: other.scroll.median_reach_pct,
        };
  if (q.format === "csv") {
    const cols = [
      "selector",
      "label",
      "tag",
      "interactive",
      "clicks",
      "click_share",
      "sessions",
      "rage_clicks",
      "dead_clicks",
      "error_clicks",
      "rage_share",
      "dead_share",
      "error_share",
      "position_pct",
      "reached_by_share",
      ...(q.converted_event ? ["converted_sessions", "conversion_share"] : []),
      ...(prev ? ["compare_click_share", "click_share_delta"] : []),
    ];
    const rows = elements.map((e) => {
      const x = e as Record<string, unknown> & { compare?: { click_share: number; click_share_delta: number } };
      return [
        ...cols.slice(0, q.converted_event ? 17 : 15).map((c) => x[c]),
        ...(prev ? [x.compare?.click_share, x.compare?.click_share_delta] : []),
      ];
    });
    return {
      raw: true as const,
      format: "csv" as const,
      content_type: "text/csv; charset=utf-8",
      filename: "heatmap.csv",
      body: toCsv(cols, rows),
      rows: rows.length,
    };
  }
  const type = q.type ?? "both";
  if (type === "attention")
    return {
      site_id: site.id,
      page: q.page,
      device: q.device ?? "all",
      period: { name: r.period, start: r.start, end: r.end },
      pageviews: h.pageviews,
      clicks: h.clicks,
      attention: h.attention,
      findings: attentionFindings(h),
      rolled_up_through: h.rolled_up_through,
      how_to_read: [
        "attention: per 10% band of the page height, avg_visible_ms = time a pageview had that band in view (positions held until the next scroll, at most 30 s each), time_share = its share of all viewing time, clicks in the band.",
      ],
    };
  return {
    site_id: site.id,
    page: q.page,
    device: q.device ?? "all",
    period: { name: r.period, start: r.start, end: r.end },
    click: h.click,
    pageviews: h.pageviews,
    ...(q.group_by === "zone" && type !== "scroll"
      ? {
          clicks: h.clicks,
          untrusted: { notice: UNTRUSTED_NOTICE, zones: h.zones, findings: heatmapFindings(h, other, q.converted_event) },
        }
      : {}),
    ...(q.group_by !== "zone" && type !== "scroll"
      ? {
          clicks: h.clicks,
          untrusted: { notice: UNTRUSTED_NOTICE, elements, findings: heatmapFindings(h, other, q.converted_event) },
        }
      : {
          // scroll only: no recorded labels or selectors in it
          findings: heatmapFindings({ ...h, clicks: 0, elements: [] }, other ? { ...other, elements: [] } : null),
        }),
    ...(type !== "click" ? { scroll } : {}),
    ...(against ? { compared_with: against } : {}),
    rolled_up_through: h.rolled_up_through,
    ...(h.live_only
      ? {
          note: "Session filters, click=first|last and converted_event use live data only (sessions within retention_days), not the daily aggregates.",
        }
      : {}),
    how_to_read: [
      "elements: clicks per element (stable selector + label), with rage/dead/error shares. position_pct is where the element's top sits (% of page height); reached_by_share is the share of pageviews that scrolled at least that far, i.e. could see it.",
      "scroll.reach: share of pageviews whose viewport reached pct% of the page. avg_fold_pct: how much of the page the first screen shows. A CTA at position 60% with reach[60%] = 0.3 is seen by about 30% of visitors.",
      "Days up to rolled_up_through come from daily aggregates (kept heatmap_retention_days), later days from live data.",
    ],
  };
}

const ERROR_KINDS = { js: "error", network: "net", console_warn: "warn" } as const;

export async function listErrors(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(errorsInput, raw);
  if (q.page !== undefined && !validGlob(q.page))
    throw badRequest('page must be a path glob starting with "/" or "*".', "Example: page=/checkout*");
  const site = await loadSite(ctx, siteId);
  const r = range(q, "7d");
  const sessions = await sessionScopeOf(ctx, site, q);
  const want = q.kind ?? "js";
  const kinds = want === "all" ? (["js", "network", "console_warn"] as const) : [want];
  const stub = siteStub(ctx.env, site.id);
  const parts = await Promise.all(
    kinds.map((k) =>
      stub.errors({
        start: r.start,
        end: r.end,
        page: q.page,
        device: q.device,
        browser: q.browser,
        fingerprint: q.fingerprint,
        limit: q.limit ?? 20,
        sessions,
        kind: ERROR_KINDS[k],
      }),
    ),
  );
  const errors = parts
    .flatMap((p) => p.errors)
    .sort((a, b) => b.sessions - a.sessions || b.occurrences - a.occurrences)
    .slice(0, q.limit ?? 20);
  const sum = (k: "occurrences" | "sessions_with_errors" | "groups") => parts.reduce((n, p) => n + p[k], 0);
  return {
    site_id: site.id,
    period: { name: r.period, start: r.start, end: r.end },
    kind: want,
    occurrences: sum("occurrences"),
    sessions_with_errors: want === "all" ? Math.max(...parts.map((p) => p.sessions_with_errors)) : sum("sessions_with_errors"),
    sessions_in_range: parts[0]?.sessions_in_range ?? 0,
    groups: sum("groups"),
    untrusted: { notice: UNTRUSTED_NOTICE, errors },
    next_steps: errors.length
      ? [
          `Sessions with one of them: GET /v1/sites/${site.id}/sessions?error_fingerprint=${errors[0]!.fingerprint} (MCP search_sessions), then read a transcript to see what led to it.`,
          ...(want === "js" ? [`Failed requests: GET /v1/sites/${site.id}/errors?kind=network (with capture_network_errors on).`] : []),
        ]
      : [
          want === "network"
            ? site.capture_network_errors
              ? "No failed requests recorded in this period."
              : `Failed requests are recorded once capture_network_errors is on: PATCH /v1/sites/${site.id} {"capture_network_errors": true}.`
            : want === "console_warn" && !site.capture_console_warnings
              ? `console.warn is recorded once capture_console_warnings is on: PATCH /v1/sites/${site.id} {"capture_console_warnings": true}.`
              : "No errors recorded in this period.",
        ],
  };
}

/** "/pricing", "page:/pricing", "event:signup"; goal: steps exist only in analytics. */
export function parseSteps(steps: string[]): FunnelStep[] {
  if (steps.length < 2 || steps.length > 8)
    throw badRequest("A funnel needs 2-8 steps.", "Example: steps=/pricing,/signup,event:signup_done");
  return steps.map((s) => {
    const t = s.trim();
    if (t.startsWith("event:")) {
      const name = t.slice(6).trim();
      if (!name) throw badRequest(`Step "${s}" has no event name.`, "Write event:<name>, the name the page passes to afsr('event', name).");
      return { type: "event", name };
    }
    if (t.startsWith("goal:"))
      throw badRequest(
        `Step "${s}" is an analytics goal; replay doesn't know goals.`,
        "Use the goal's page (\"/thank-you\") or have the page call afsr('event', 'purchase') and use event:purchase.",
      );
    const pattern = t.startsWith("page:") ? t.slice(5).trim() : t;
    if (!validGlob(pattern))
      throw badRequest(`Step "${s}" is not a path glob or event:<name>.`, 'Example: "/checkout*" or "event:checkout_started".');
    return { type: "page", pattern };
  });
}

export async function getFunnelDropoffs(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(funnelInput, raw);
  const site = await loadSite(ctx, siteId);
  let stepTexts = q.steps;
  if (q.analytics_funnel_id) {
    if (!site.analytics_site_id)
      throw badRequest(
        "This replay site isn't linked to an analytics site.",
        `PATCH /v1/sites/${site.id} {"analytics_site_id":"site_..."} first, or pass steps.`,
      );
    stepTexts = await analyticsFunnelSteps(ctx.env, ctx.accountId, site.analytics_site_id, q.analytics_funnel_id);
  }
  if (!stepTexts?.length) throw badRequest("Pass steps (or analytics_funnel_id).", "Example: steps=/pricing,/signup,/welcome&drop_step=2");
  const steps = parseSteps(stepTexts);
  // event:<name> of a defined or built-in event matches its clicks / page visits
  for (const st of steps)
    if (st.type === "event") {
      const m = await eventMatchFor(ctx.env, site, st.name);
      if (m) st.match = m;
    }
  if (q.drop_step !== undefined && q.drop_step >= steps.length)
    throw badRequest(`drop_step must be below the last step (1-${steps.length - 1}).`, "Sessions that reached the last step didn't drop.");
  const f = await resolveFilters(ctx, site, q, "30d");
  const r = await siteStub(ctx.env, site.id).funnel({ ...f, steps, drop_step: q.drop_step, limit: q.limit ?? 20, max_sessions: 20_000 });
  const dropped = r.dropped
    ? (() => {
        const s = r.dropped.summary;
        const { findings, top_rage_targets, top_dead_clicks, top_errors, quick_back_pages, exit_pages, ...numbers } =
          s && !("empty" in s) ? s : ({} as Record<string, unknown> & { findings?: unknown });
        return {
          step: r.dropped.step,
          total: r.dropped.total,
          sessions: r.dropped.sessions.map(sessionListItem),
          common: s && !("empty" in s) ? { sessions_with: (numbers as { sessions_with?: unknown }).sessions_with } : null,
          untrusted: { notice: UNTRUSTED_NOTICE, findings, top_rage_targets, top_dead_clicks, top_errors, quick_back_pages, exit_pages },
        };
      })()
    : null;
  const worst = r.steps
    .slice(0, -1)
    .reduce<{ step: number; dropped: number } | null>(
      (a, s) => (s.dropped !== null && (!a || s.dropped > a.dropped) ? { step: s.step, dropped: s.dropped } : a),
      null,
    );
  return {
    site_id: site.id,
    period: { name: f.period, start: f.start, end: f.end },
    sessions_considered: r.sessions_considered,
    untrusted: { notice: UNTRUSTED_NOTICE, steps: r.steps },
    dropped,
    next_steps: dropped
      ? ["Read the listed sessions' transcripts (get_session_transcript) to see what happened on the step's page."]
      : worst && worst.dropped > 0
        ? [
            `Most sessions drop after step ${worst.step}: call again with drop_step=${worst.step} for those sessions and what they have in common.`,
          ]
        : ["Pass drop_step to list the sessions that stopped at a step."],
    note: "Steps match recorded sessions only (sampled, masked, kept retention_days); counts are sessions, in order, within one session.",
  };
}
