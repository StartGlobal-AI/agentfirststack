/**
 * Path exploration: from a starting page or event, the next pages (or events) sessions went to,
 * step by step; or, from an end point, the steps that led to it. Within sessions, with
 * consecutive repeats of the same node collapsed (a reload is not a step).
 *
 * Per step: the top nodes with sessions and their share of the anchored sessions, plus how many
 * sessions had no further step (exits). And the top full paths. Node values are page paths and
 * event names that visitors sent.
 */

import type { Filter } from "../lib/filters";
import { type Frag, type FunnelStep, GOAL_MATCH, evCte, raw, sql, toGlob } from "../lib/query";
import type { PeriodParams, SiteSettings } from "../lib/types";
import { type Db, all, checkGoalFilters, ctxFor, guard, num, periodOut, rangeFor, round, unknownGoals } from "./common";

export const MAX_PATH_STEPS = 5;

export interface PathsRequest extends PeriodParams {
  filters: Filter[];
  /** the anchor: a page pattern, event:<name> or goal:<name> */
  anchor: FunnelStep;
  direction: "forward" | "backward";
  steps: number;
  /** page: pageviews only (default); any: pageviews and custom events */
  node: "page" | "any";
  limit: number;
}

function anchorCond(a: FunnelStep): Frag {
  switch (a.type) {
    case "page":
      return sql`(e.name = 'pageview' AND e.pathname GLOB ${toGlob(a.pattern)})`;
    case "event":
      return sql`e.name = ${a.name}`;
    case "goal":
      return sql`EXISTS (SELECT 1 FROM goals g WHERE g.name = ${a.name} AND ${raw(GOAL_MATCH)})`;
  }
}

export function paths(db: Db, settings: SiteSettings, q: PathsRequest, now = Date.now()) {
  return guard(() => {
    const ge = checkGoalFilters(db, q.filters, q.where) ?? (q.anchor.type === "goal" ? unknownGoals(db, [q.anchor.name]) : null);
    if (ge) return ge;
    const r = rangeFor(db, settings, q, now);
    const ctx = ctxFor(db, r, q);
    const n = Math.min(MAX_PATH_STEPS, Math.max(1, q.steps));
    const isAnchor = anchorCond(q.anchor);
    const nodeFilter =
      q.node === "any" ? raw("(e.name = 'pageview' OR (e.origin != 'payment' AND e.name != 'engagement'))") : raw("e.name = 'pageview'");
    const fwd = q.direction === "forward";
    const base = sql`WITH ${evCte(ctx)},
    nodes AS (SELECT e.session_id AS sid, e.visitor_id AS vid, e.ts, e.id,
                CASE WHEN e.name = 'pageview' THEN e.pathname ELSE 'event:' || e.name END AS node,
                CASE WHEN ${isAnchor} THEN 1 ELSE 0 END AS anchor
              FROM ev e WHERE e.no_visit = 0 AND (${nodeFilter} OR ${isAnchor})),
    dd AS (SELECT *, LAG(node || '|' || anchor) OVER (PARTITION BY sid ORDER BY ts, id) AS prev FROM nodes),
    seq AS (SELECT sid, vid, node, anchor, ROW_NUMBER() OVER (PARTITION BY sid ORDER BY ts, id) AS pos FROM dd
            WHERE prev IS NULL OR prev != node || '|' || anchor),
    anc AS (SELECT sid, MIN(vid) AS vid, MIN(pos) AS apos FROM seq WHERE anchor = 1 GROUP BY sid),
    st AS (SELECT q.sid, ${raw(fwd ? "q.pos - a.apos" : "a.apos - q.pos")} AS k, q.node FROM seq q JOIN anc a ON a.sid = q.sid
           WHERE ${raw(fwd ? `q.pos > a.apos AND q.pos <= a.apos + ${n}` : `q.pos < a.apos AND q.pos >= a.apos - ${n}`)})`;
    const head = all(db, sql`${base} SELECT COUNT(*) AS sessions, COUNT(DISTINCT vid) AS visitors FROM anc`)[0];
    const anchored = num(head?.sessions);
    const cells = all(
      db,
      sql`${base},
      c AS (SELECT k, node, COUNT(*) AS sessions FROM st GROUP BY k, node),
      rk AS (SELECT k, node, sessions, ROW_NUMBER() OVER (PARTITION BY k ORDER BY sessions DESC, node) AS rn FROM c)
      SELECT k, node, sessions FROM rk WHERE rn <= ${q.limit} ORDER BY k, rn`,
    );
    const reached = new Map(all(db, sql`${base} SELECT k, COUNT(DISTINCT sid) AS n FROM st GROUP BY k`).map((x) => [num(x.k), num(x.n)]));
    const cols = Array.from({ length: n }, (_, i) => i + 1).map((k) => {
      const before = k === 1 ? anchored : (reached.get(k - 1) ?? 0);
      const here = reached.get(k) ?? 0;
      return {
        step: k,
        sessions: here,
        exits: Math.max(0, before - here),
        rows: cells
          .filter((c) => num(c.k) === k)
          .map((c) => ({ value: c.node, sessions: num(c.sessions), share: anchored ? round((num(c.sessions) / anchored) * 100, 1) : 0 })),
      };
    });
    const pick = Array.from({ length: n }, (_, i) => `MAX(CASE WHEN k = ${i + 1} THEN node END) AS n${i + 1}`).join(", ");
    const groupCols = Array.from({ length: n }, (_, i) => `n${i + 1}`).join(", ");
    const top = all(
      db,
      sql`${base},
      ps AS (SELECT sid, ${raw(pick)} FROM st GROUP BY sid)
      SELECT ${raw(groupCols)}, COUNT(*) AS sessions FROM ps GROUP BY ${raw(groupCols)} ORDER BY sessions DESC LIMIT 10`,
    ).map((x) => {
      const nodes = Array.from({ length: n }, (_, i) => x[`n${i + 1}`]).filter((v) => v != null);
      return {
        steps: fwd ? nodes : [...nodes].reverse(),
        sessions: num(x.sessions),
        share: anchored ? round((num(x.sessions) / anchored) * 100, 1) : 0,
      };
    });
    return {
      period: periodOut(r),
      filters: q.filters,
      anchor: q.anchor.type === "page" ? q.anchor.pattern : `${q.anchor.type}:${q.anchor.name}`,
      direction: q.direction,
      node: q.node,
      anchored: { sessions: anchored, visitors: num(head?.visitors) },
      columns: cols,
      top_paths: top,
      note: fwd
        ? "From the first time each session reached the anchor: step k is the k-th page (or event) after it; repeats of the same node in a row count once. exits = sessions with no further step."
        : "Up to the first time each session reached the anchor: step k is the k-th page (or event) before it; top_paths read in visit order, ending just before the anchor. exits = sessions that started there.",
    };
  });
}
