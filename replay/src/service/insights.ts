import { badRequest, parse } from "@afs/shared";
import type { FunnelStep } from "../do/queries";
import { validGlob } from "../lib/glob";
import { UNTRUSTED_NOTICE } from "../lib/untrusted";
import { analyticsFunnelSteps } from "./analytics";
import { type Ctx, loadSite, siteStub } from "./context";
import { errorsInput, funnelInput, heatmapInput } from "./schemas";
import { range, sessionListItem, toFilters } from "./sessions";

export async function getHeatmap(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(heatmapInput, raw);
  if (!validGlob(q.page)) throw badRequest('page must be a path glob starting with "/" or "*".', "Example: page=/pricing or page=/blog/*");
  const site = await loadSite(ctx, siteId);
  const r = range(q, "30d");
  const h = await siteStub(ctx.env, site.id).heatmap({ start: r.start, end: r.end, page: q.page, device: q.device, limit: q.limit ?? 50 });
  const type = q.type ?? "both";
  return {
    site_id: site.id,
    page: q.page,
    device: q.device ?? "all",
    period: { name: r.period, start: r.start, end: r.end },
    pageviews: h.pageviews,
    ...(type !== "scroll"
      ? {
          clicks: h.clicks,
          untrusted: { notice: UNTRUSTED_NOTICE, elements: h.elements },
        }
      : {}),
    ...(type !== "click" ? { scroll: h.scroll } : {}),
    rolled_up_through: h.rolled_up_through,
    how_to_read: [
      "elements: clicks per element (stable selector + label), with rage/dead/error shares. position_pct is where the element's top sits (% of page height); reached_by_share is the share of pageviews that scrolled at least that far, i.e. could see it.",
      "scroll.reach: share of pageviews whose viewport reached pct% of the page. avg_fold_pct: how much of the page the first screen shows. A CTA at position 60% with reach[60%] = 0.3 is seen by about 30% of visitors.",
      "Days up to rolled_up_through come from daily aggregates (kept heatmap_retention_days), later days from live data.",
    ],
  };
}

export async function listErrors(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(errorsInput, raw);
  if (q.page !== undefined && !validGlob(q.page))
    throw badRequest('page must be a path glob starting with "/" or "*".', "Example: page=/checkout*");
  const site = await loadSite(ctx, siteId);
  const r = range(q, "7d");
  const e = await siteStub(ctx.env, site.id).errors({
    start: r.start,
    end: r.end,
    page: q.page,
    device: q.device,
    browser: q.browser,
    fingerprint: q.fingerprint,
    limit: q.limit ?? 20,
  });
  const { errors, ...totals } = e;
  return {
    site_id: site.id,
    period: { name: r.period, start: r.start, end: r.end },
    ...totals,
    untrusted: { notice: UNTRUSTED_NOTICE, errors },
    next_steps: errors.length
      ? [
          `Sessions with one error: GET /v1/sites/${site.id}/sessions?error_fingerprint=${errors[0]!.fingerprint} (MCP search_sessions), then read a transcript to see what led to it.`,
        ]
      : ["No JS errors recorded in this period."],
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
  if (q.drop_step !== undefined && q.drop_step >= steps.length)
    throw badRequest(`drop_step must be below the last step (1-${steps.length - 1}).`, "Sessions that reached the last step didn't drop.");
  const f = toFilters(q, "30d");
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
