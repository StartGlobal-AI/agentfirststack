/**
 * Reads over sessions: a filterable, paged session list (linked to replay recordings when an
 * event of the session carries props.replay_session_id), and the realtime map (visitors of the
 * last minutes by city, with the city's coordinates).
 */

import type { Filter, FilterExpr } from "../lib/filters";
import type { DebugMode } from "../lib/query";
import { whereFrag } from "../lib/query";
import type { PeriodParams, SiteSettings } from "../lib/types";
import { type Db, all, checkGoalFilters, ctxFor, guard, num, periodOut, rangeFor, round } from "./common";

export const SESSION_SORTS = ["started_at", "duration", "pageviews", "events", "revenue"] as const;
const RS_RE = /^rs_[A-Za-z0-9_-]{6,64}$/;

export interface SessionsRequest extends PeriodParams {
  filters: Filter[];
  where?: FilterExpr | null;
  sort?: (typeof SESSION_SORTS)[number];
  dir?: "asc" | "desc";
  limit: number;
  offset: number;
}

const ORDER: Record<(typeof SESSION_SORTS)[number], string> = {
  started_at: "s.started_at",
  duration: "MAX(s.last_seen_at - s.started_at, s.engagement_ms)",
  pageviews: "s.pageviews",
  events: "events",
  revenue: "revenue",
};

export function listSessions(
  db: Db,
  settings: SiteSettings,
  q: SessionsRequest,
  replay: { site_id: string; base: string } | null,
  now = Date.now(),
) {
  return guard(() => {
    const ge = checkGoalFilters(db, q.filters, q.where);
    if (ge) return ge;
    const r = rangeFor(db, settings, q, now);
    const w = whereFrag(ctxFor(db, r, q));
    const dir = q.dir === "asc" ? "ASC" : "DESC";
    const rows = all(db, {
      sql: `WITH m AS (SELECT DISTINCT e.session_id AS id FROM events e WHERE ${w.sql} AND e.origin != 'payment')
            SELECT s.*, COUNT(*) OVER () AS total,
              (SELECT COUNT(*) FROM events x WHERE x.session_id = s.id AND x.origin != 'payment') AS events,
              (SELECT COALESCE(SUM(x.revenue), 0) FROM events x WHERE x.session_id = s.id) AS revenue
            FROM sessions s JOIN m ON m.id = s.id
            ORDER BY ${ORDER[q.sort ?? "started_at"]} ${dir}, s.started_at DESC, s.id LIMIT ? OFFSET ?`,
      args: [...w.args, q.limit, q.offset],
    });
    const ids = rows.map((x) => String(x.id));
    const links = new Map<string, string>();
    if (ids.length)
      for (const x of db.all(
        `SELECT session_id, json_extract(props, '$.replay_session_id') AS rs FROM events
         WHERE session_id IN (SELECT value FROM json_each(?)) AND props LIKE '%replay_session_id%' ORDER BY ts`,
        [JSON.stringify(ids)],
      )) {
        const rs = String(x.rs ?? "");
        if (RS_RE.test(rs) && !links.has(String(x.session_id))) links.set(String(x.session_id), rs);
      }
    const total = num(rows[0]?.total);
    return {
      period: periodOut(r),
      filters: q.filters,
      sort: `${q.sort ?? "started_at"}:${dir.toLowerCase()}`,
      sessions: rows.map((s) => {
        const rs = links.get(String(s.id));
        return {
          id: s.id,
          visitor_id: s.visitor_id,
          user_id: s.user_id ?? null,
          started_at: s.started_at,
          last_seen_at: s.last_seen_at,
          duration_s: Math.round(Math.max(num(s.last_seen_at) - num(s.started_at), num(s.engagement_ms)) / 1000),
          pageviews: num(s.pageviews),
          events: num(s.events),
          bounced: num(s.pageviews) <= 1 && num(s.custom_events) === 0,
          revenue: round(num(s.revenue), 2),
          hostname: s.hostname ?? null,
          entry_page: s.entry_page ?? null,
          exit_page: s.exit_page ?? null,
          channel: s.channel,
          source: s.source ?? null,
          referrer: s.referrer ?? null,
          utm_source: s.utm_source ?? null,
          utm_medium: s.utm_medium ?? null,
          utm_campaign: s.utm_campaign ?? null,
          country: s.country ?? null,
          region: s.region ?? null,
          city: s.city ?? null,
          device: s.device ?? null,
          browser: s.browser ?? null,
          os: s.os ?? null,
          ...(rs
            ? {
                replay: {
                  session_id: rs,
                  ...(replay ? { replay_site_id: replay.site_id, url: `${replay.base}/v1/sites/${replay.site_id}/sessions/${rs}` } : {}),
                },
              }
            : {}),
        };
      }),
      total,
      offset: q.offset,
      next_offset: q.offset + rows.length < total ? q.offset + rows.length : null,
      timezone: r.timezone,
    };
  });
}

export interface MapRequest {
  minutes?: number;
  filters: Filter[];
  where?: FilterExpr | null;
  debug?: DebugMode;
}

/** Visitors in the last `minutes` (default 30) by city, with the city's coordinates (Cloudflare's, per request). */
export function realtimeMap(db: Db, q: MapRequest, now = Date.now()) {
  return guard(() => {
    const ge = checkGoalFilters(db, q.filters, q.where);
    if (ge) return ge;
    const minutes = Math.min(60, Math.max(1, Math.round(q.minutes ?? 30)));
    const w = whereFrag(ctxFor(db, { start: now - minutes * 60_000, end: now + 60_000 }, q));
    const points = all(db, {
      sql: `SELECT e.country, e.region, e.city, ROUND(AVG(e.latitude), 2) AS latitude, ROUND(AVG(e.longitude), 2) AS longitude,
              COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS events
            FROM events e WHERE ${w.sql} AND e.origin != 'payment' AND e.latitude IS NOT NULL AND e.longitude IS NOT NULL
            GROUP BY e.country, e.region, e.city ORDER BY visitors DESC, events DESC LIMIT 500`,
      args: w.args,
    });
    const head = all(db, {
      sql: `SELECT COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(DISTINCT CASE WHEN e.latitude IS NULL THEN e.visitor_id END) AS unlocated
            FROM events e WHERE ${w.sql} AND e.origin != 'payment'`,
      args: w.args,
    })[0];
    return {
      minutes,
      visitors: num(head?.visitors),
      unlocated_visitors: num(head?.unlocated),
      points: points.map((p) => ({
        country: p.country ?? null,
        region: p.region ?? null,
        city: p.city ?? null,
        latitude: p.latitude,
        longitude: p.longitude,
        visitors: num(p.visitors),
        events: num(p.events),
      })),
      note: "Coordinates are Cloudflare's for the visitor's city (never more precise), averaged per city; visitors without a location are counted in unlocated_visitors.",
    };
  });
}
