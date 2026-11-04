/**
 * What a heatmap image is drawn from: the latest full DOM snapshot of the page (a hard navigation:
 * the recorder starts on load and snapshots the page then) and the click positions of stored
 * sessions, as a grid of percentages of the document. Read only.
 */

import type { ClickDot } from "../lib/heatmap-overlay";
import { sqlGlob } from "../lib/glob";
import { type Db, num } from "./db";

export interface SnapshotRef {
  session_id: string;
  seq: number;
  /** when the page was loaded */
  ts: number;
  path: string;
  doc_h: number | null;
}

/** The latest page load of `page` (glob) on `device` in [start, end] whose snapshot chunk is stored. */
export function latestSnapshot(db: Db, q: { page: string; device: string; start: number; end: number }): SnapshotRef | null {
  const pages = db.all(
    `SELECT session_id, ts, path, doc_h FROM pages WHERE path GLOB ? AND ts >= ? AND ts <= ? AND device = ?
       AND COALESCE(nav, 'load') IN ('load', 'reload', 'back_forward') ORDER BY ts DESC LIMIT 25`,
    [sqlGlob(q.page), q.start, q.end, q.device],
  );
  for (const p of pages) {
    const sid = String(p.session_id);
    const ts = num(p.ts);
    const c = db.all(
      "SELECT seq FROM chunks WHERE session_id = ? AND snap = 1 AND rr_events > 0 AND first_ts >= ? AND first_ts <= ? ORDER BY first_ts LIMIT 1",
      [sid, ts - 10_000, ts + 60_000],
    )[0];
    if (c) return { session_id: sid, seq: num(c.seq), ts, path: String(p.path), doc_h: p.doc_h == null ? null : num(p.doc_h) };
  }
  return null;
}

/**
 * Clicks of stored sessions on `page` and `device`, binned to 0.5% of the document's width and
 * 0.25% of its height (at most `limit` cells, the busiest first).
 */
export function clickDots(db: Db, q: { page: string; device: string; start: number; end: number; limit?: number }): ClickDot[] {
  return db
    .all(
      `SELECT CAST(MIN(x, doc_w) * 200 / doc_w AS INTEGER) AS gx, CAST(MIN(y, doc_h) * 400 / doc_h AS INTEGER) AS gy, COUNT(*) AS n,
         SUM(rage) AS rage, SUM(dead) AS dead, SUM(error_click) AS err
       FROM events WHERE kind = 'click' AND path GLOB ? AND ts >= ? AND ts <= ? AND device = ?
         AND x IS NOT NULL AND y IS NOT NULL AND doc_w > 0 AND doc_h > 0
       GROUP BY gx, gy ORDER BY n DESC LIMIT ?`,
      [sqlGlob(q.page), q.start, q.end, q.device, q.limit ?? 1500],
    )
    .map((r) => ({
      x_pct: (Math.min(199, num(r.gx)) + 0.5) / 2,
      y_pct: (Math.min(399, num(r.gy)) + 0.5) / 4,
      n: num(r.n),
      rage: num(r.rage),
      dead: num(r.dead),
      error: num(r.err),
    }));
}
