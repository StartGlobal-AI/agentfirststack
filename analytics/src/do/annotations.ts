/**
 * Annotations: dated notes on a site's timeline (deploys, launches, campaigns), returned with
 * every timeseries, plus automatic "Traffic spike from <source>" notes the daily alarm writes.
 * Each annotation has a unique `key` (note:<ts>:<title>, spike:<YYYY-MM-DD>) so retries and
 * re-evaluations never duplicate one.
 */

import { newId } from "@afs/shared";
import { bucketKey } from "../lib/query";
import { SPIKE_BASELINE_DAYS, detectSpike, spikeDescription, spikeTitle } from "../lib/stats-math";
import { addDays, localDay, offsetSegments, parseYmd, ymdString, zonedToUtc } from "../lib/time";
import type { SiteSettings } from "../lib/types";
import { type Db, type Row, all, err, firstEventTs, num, parseProps } from "./common";

export interface AnnotationInput {
  ts: number;
  end_ts: number | null;
  title: string;
  description: string | null;
}

export type AnnotationPatch = Partial<AnnotationInput>;

const noteKey = (ts: number, title: string) => `note:${ts}:${title}`;

export function shapeAnnotation(r: Row, tz: string) {
  const ts = Number(r.ts);
  const end = r.end_ts == null ? null : Number(r.end_ts);
  return {
    id: r.id,
    kind: r.kind,
    date: ymdString(localDay(ts, tz)),
    end_date: end == null ? null : ymdString(localDay(end, tz)),
    timestamp: ts,
    end_timestamp: end,
    title: r.title,
    description: r.description ?? null,
    source: r.source,
    details: parseProps(r.details),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Annotations overlapping [start, end), oldest first. */
export function annotationsIn(db: Db, settings: SiteSettings, start: number, end: number, kind?: string) {
  const rows = db.all(
    `SELECT * FROM annotations WHERE ts < ? AND COALESCE(end_ts, ts) >= ? ${kind ? "AND kind = ?" : ""} ORDER BY ts, created_at LIMIT 1000`,
    kind ? [end, start, kind] : [end, start],
  );
  return rows.map((r) => shapeAnnotation(r, settings.timezone));
}

export function createAnnotation(db: Db, settings: SiteSettings, a: AnnotationInput, max: number | null, now = Date.now()) {
  const key = noteKey(a.ts, a.title);
  const existing = db.all("SELECT * FROM annotations WHERE key = ?", [key])[0];
  if (existing) return { annotation: shapeAnnotation(existing, settings.timezone), existing: true };
  if (max && num(db.all("SELECT COUNT(*) AS n FROM annotations WHERE kind = 'note'")[0]?.n) >= max) {
    return err(
      "quota_exceeded",
      `This site already has ${max} annotations, the most allowed here.`,
      "Delete old ones (DELETE /v1/sites/:id/annotations/:annotation_id), or self-host for more.",
    );
  }
  const id = newId("ann");
  db.run(
    `INSERT INTO annotations (id, key, kind, ts, end_ts, title, description, source, details, created_at, updated_at)
     VALUES (?, ?, 'note', ?, ?, ?, ?, 'api', NULL, ?, ?)`,
    [id, key, a.ts, a.end_ts, a.title, a.description, now, now],
  );
  return { annotation: shapeAnnotation(db.all("SELECT * FROM annotations WHERE id = ?", [id])[0]!, settings.timezone), existing: false };
}

export function updateAnnotation(db: Db, settings: SiteSettings, id: string, p: AnnotationPatch, now = Date.now()) {
  const cur = db.all("SELECT * FROM annotations WHERE id = ?", [id])[0];
  if (!cur) return err("not_found", "Annotation not found.", "GET /v1/sites/:id/annotations lists this site's annotations.");
  const ts = p.ts ?? Number(cur.ts);
  const title = p.title ?? String(cur.title);
  const key = cur.kind === "note" ? noteKey(ts, title) : String(cur.key);
  if (key !== cur.key && db.all("SELECT 1 FROM annotations WHERE key = ?", [key]).length) {
    return err(
      "conflict",
      "Another annotation already has this title at this time.",
      "Change the title or the date, or delete the other one.",
    );
  }
  db.run("UPDATE annotations SET key = ?, ts = ?, end_ts = ?, title = ?, description = ?, updated_at = ? WHERE id = ?", [
    key,
    ts,
    p.end_ts !== undefined ? p.end_ts : (cur.end_ts ?? null),
    title,
    p.description !== undefined ? p.description : (cur.description ?? null),
    now,
    id,
  ]);
  return { annotation: shapeAnnotation(db.all("SELECT * FROM annotations WHERE id = ?", [id])[0]!, settings.timezone) };
}

export function deleteAnnotation(db: Db, id: string) {
  const cur = db.all("SELECT id FROM annotations WHERE id = ?", [id])[0];
  if (!cur) return err("not_found", "Annotation not found.", "GET /v1/sites/:id/annotations lists this site's annotations.");
  db.run("DELETE FROM annotations WHERE id = ?", [id]);
  return { deleted: id };
}

// ------------------------------------------------------------------ traffic spikes

/** At most this many days are evaluated per alarm (catch-up after a gap). */
export const SPIKE_CATCH_UP_DAYS = 7;

/**
 * Evaluate every complete local day not evaluated yet (at most SPIKE_CATCH_UP_DAYS, ending
 * yesterday in the site timezone) and write a traffic_spike annotation for each spike. The last
 * evaluated day is kept in meta.spikes_through, and each spike's key is spike:<day>, so running
 * this twice changes nothing. Returns the days that got an annotation.
 */
export function evaluateSpikes(db: Db, settings: SiteSettings, now = Date.now()): string[] {
  const tz = settings.timezone;
  const today = localDay(now, tz);
  const yesterday = addDays(today, -1);
  const throughRaw = db.all("SELECT value FROM meta WHERE key = 'spikes_through'")[0]?.value;
  const through = throughRaw ? parseYmd(String(throughRaw)) : null;
  let first = through ? addDays(through, 1) : addDays(yesterday, -(SPIKE_CATCH_UP_DAYS - 1));
  const earliest = addDays(yesterday, -(SPIKE_CATCH_UP_DAYS - 1));
  if (ymdString(first) < ymdString(earliest)) first = earliest;
  const done = () =>
    db.run("INSERT INTO meta (key, value) VALUES ('spikes_through', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
      ymdString(yesterday),
    ]);
  const firstTs = firstEventTs(db);
  if (firstTs == null || ymdString(first) > ymdString(yesterday)) {
    done();
    return [];
  }
  const firstDataDay = ymdString(localDay(firstTs, tz));
  const midnight = (d: { y: number; m: number; d: number }) => zonedToUtc(d.y, d.m, d.d, 0, tz);
  const windowStart = midnight(addDays(first, -SPIKE_BASELINE_DAYS));
  const windowEnd = midnight(today);
  const day = bucketKey("day", offsetSegments(windowStart, windowEnd, tz));
  const totals = new Map(
    all(db, {
      sql: `SELECT ${day.sql} AS day, COUNT(DISTINCT e.visitor_id) AS v FROM events e WHERE e.ts >= ? AND e.ts < ? AND e.origin != 'payment' GROUP BY day`,
      args: [...day.args, windowStart, windowEnd],
    }).map((r) => [String(r.day), num(r.v)]),
  );
  const bySource = new Map<string, Map<string, number>>();
  for (const r of all(db, {
    sql: `SELECT ${day.sql} AS day, COALESCE(e.source, e.channel) AS src, COUNT(DISTINCT e.visitor_id) AS v
          FROM events e WHERE e.ts >= ? AND e.ts < ? AND e.origin != 'payment' GROUP BY day, src`,
    args: [...day.args, windowStart, windowEnd],
  })) {
    const m = bySource.get(String(r.day)) ?? new Map<string, number>();
    m.set(String(r.src), num(r.v));
    bySource.set(String(r.day), m);
  }
  const written: string[] = [];
  for (let d = first; ymdString(d) <= ymdString(yesterday); d = addDays(d, 1)) {
    const label = ymdString(d);
    const baseDays: string[] = [];
    for (let i = SPIKE_BASELINE_DAYS; i >= 1; i--) {
      const b = ymdString(addDays(d, -i));
      if (b >= firstDataDay) baseDays.push(b);
    }
    const sources = [...(bySource.get(label) ?? new Map<string, number>()).entries()].map(([name, visitors]) => ({
      name,
      visitors,
      baseline_mean: baseDays.reduce((a, b) => a + (bySource.get(b)?.get(name) ?? 0), 0) / Math.max(baseDays.length, 1),
    }));
    const spike = detectSpike({ visitors: totals.get(label) ?? 0, baseline: baseDays.map((b) => totals.get(b) ?? 0), sources });
    if (!spike) continue;
    const ts = midnight(d);
    db.run(
      `INSERT OR IGNORE INTO annotations (id, key, kind, ts, end_ts, title, description, source, details, created_at, updated_at)
       VALUES (?, ?, 'traffic_spike', ?, ?, ?, ?, 'auto', ?, ?, ?)`,
      [
        newId("ann"),
        `spike:${label}`,
        ts,
        midnight(addDays(d, 1)) - 1,
        spikeTitle(spike),
        spikeDescription(spike),
        JSON.stringify(spike),
        now,
        now,
      ],
    );
    written.push(label);
  }
  done();
  return written;
}
