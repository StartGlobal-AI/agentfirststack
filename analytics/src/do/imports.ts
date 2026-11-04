/**
 * Imported daily aggregates in the site's Durable Object (imports + imported_rows), and their
 * merge into reports with imported=true: only for days before the site's first live event (so a
 * day is never counted twice), only without filters (imports have no other dimensions), and only
 * for visitors, visits and pageviews (plus bounce_rate and visit_duration on totals).
 */

import type { ImportKind, ImportRow, ImportSource } from "../lib/imports";
import { KIND_DIMENSION } from "../lib/imports";
import { type Range, localDay, ymdString, zonedToUtc } from "../lib/time";
import type { Db } from "./common";
import { num, round } from "./common";

export const IMPORTS_SQL = [
  `CREATE TABLE IF NOT EXISTS imports (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, file_name TEXT, from_day TEXT NOT NULL, to_day TEXT NOT NULL,
    rows INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (source, kind, from_day, to_day)
  )`,
  `CREATE TABLE IF NOT EXISTS imported_rows (
    import_id TEXT NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL, value TEXT NOT NULL,
    visitors INTEGER NOT NULL, visits INTEGER NOT NULL, pageviews INTEGER NOT NULL, bounces INTEGER NOT NULL, visit_duration REAL NOT NULL,
    PRIMARY KEY (import_id, day, value)
  )`,
  "CREATE INDEX IF NOT EXISTS imported_rows_kind_day ON imported_rows(kind, day)",
];

export function saveImport(
  db: Db,
  id: string,
  meta: { source: ImportSource; kind: ImportKind; file_name: string | null },
  rows: ImportRow[],
  caps: { maxRows: number; maxImports: number },
  now = Date.now(),
) {
  const days = rows.map((r) => r.day).sort();
  const from = days[0]!;
  const to = days.at(-1)!;
  return db.transaction(() => {
    const cur = db.all("SELECT * FROM imports WHERE source = ? AND kind = ? AND from_day = ? AND to_day = ?", [
      meta.source,
      meta.kind,
      from,
      to,
    ])[0];
    const existingRows = cur ? num(cur.rows) : 0;
    const stored = num(db.all("SELECT COUNT(*) AS n FROM imported_rows")[0]?.n);
    if (stored - existingRows + rows.length > caps.maxRows)
      return {
        error: {
          code: "quota_exceeded",
          message: `This site keeps at most ${caps.maxRows} imported rows (MAX_IMPORTED_ROWS_PER_SITE); it has ${stored}.`,
          hint: "DELETE /v1/sites/:id/imports/:import_id frees room, or import a shorter range.",
        },
      };
    if (!cur && num(db.all("SELECT COUNT(*) AS n FROM imports")[0]?.n) >= caps.maxImports)
      return {
        error: {
          code: "quota_exceeded",
          message: `This site keeps at most ${caps.maxImports} imports (MAX_IMPORTS_PER_SITE).`,
          hint: "Delete one first: DELETE /v1/sites/:id/imports/:import_id.",
        },
      };
    const importId = cur ? String(cur.id) : id;
    // The same file (source, kind, date range) again replaces its rows: retries are safe.
    if (cur) db.run("DELETE FROM imported_rows WHERE import_id = ?", [importId]);
    for (const r of rows)
      db.run(
        "INSERT INTO imported_rows (import_id, kind, day, value, visitors, visits, pageviews, bounces, visit_duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [importId, meta.kind, r.day, r.value, r.visitors, r.visits, r.pageviews, r.bounces, r.visit_duration],
      );
    if (cur)
      db.run("UPDATE imports SET rows = ?, file_name = COALESCE(?, file_name), updated_at = ? WHERE id = ?", [
        rows.length,
        meta.file_name,
        now,
        importId,
      ]);
    else
      db.run(
        "INSERT INTO imports (id, source, kind, file_name, from_day, to_day, rows, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [importId, meta.source, meta.kind, meta.file_name, from, to, rows.length, now, now],
      );
    const live = firstLiveDay(db);
    return {
      import: { id: importId, source: meta.source, kind: meta.kind, file_name: meta.file_name, from, to, rows: rows.length },
      existing: !!cur,
      ...(cur ? { replaced_rows: existingRows } : {}),
      live_data_from: live,
      ...(live && to >= live
        ? { note: `Days from ${live} on already have live data: reports use live data for them and the import only before.` }
        : {}),
    };
  });
}

export function listImports(db: Db) {
  return {
    imports: db.all("SELECT * FROM imports ORDER BY source, kind, from_day").map((r) => ({
      id: r.id,
      source: r.source,
      kind: r.kind,
      file_name: r.file_name ?? null,
      from: r.from_day,
      to: r.to_day,
      rows: num(r.rows),
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
    rows_stored: num(db.all("SELECT COUNT(*) AS n FROM imported_rows")[0]?.n),
    live_data_from: firstLiveDay(db),
  };
}

export function deleteImport(db: Db, id: string) {
  const cur = db.all("SELECT id FROM imports WHERE id = ?", [id])[0];
  if (!cur) return null;
  return db.transaction(() => {
    const n = num(db.all("SELECT COUNT(*) AS n FROM imported_rows WHERE import_id = ?", [id])[0]?.n);
    db.run("DELETE FROM imported_rows WHERE import_id = ?", [id]);
    db.run("DELETE FROM imports WHERE id = ?", [id]);
    return { deleted: true, rows_deleted: n };
  });
}

/** The site-timezone day of the first live (non-payment) event, or null. */
function firstLiveDay(db: Db): string | null {
  const t = db.all("SELECT MIN(ts) AS t FROM events WHERE origin != 'payment'")[0]?.t;
  if (t == null) return null;
  const st = db.all("SELECT value FROM meta WHERE key = 'settings'")[0]?.value;
  const tz = st ? ((JSON.parse(String(st)) as { timezone?: string }).timezone ?? "UTC") : "UTC";
  return ymdString(localDay(Number(t), tz));
}

/** Days of a range that imports may fill: before the first live event. */
function importDays(db: Db, r: Pick<Range, "start" | "end" | "timezone">): { from: string; to: string } | null {
  const from = ymdString(localDay(r.start, r.timezone));
  let to = ymdString(localDay(r.end - 1, r.timezone));
  const live = firstLiveDay(db);
  if (live && live <= to) {
    const d = new Date(`${live}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    to = d.toISOString().slice(0, 10);
  }
  return from <= to ? { from, to } : null;
}

type MetricValues = Record<string, number | null>;
const ADDED = ["visitors", "visits", "pageviews"] as const;

export interface ImportedTotals {
  visitors: number;
  visits: number;
  pageviews: number;
  bounces: number;
  visit_duration: number;
  days: number;
}

export function importedTotals(db: Db, r: Pick<Range, "start" | "end" | "timezone">): ImportedTotals | null {
  const d = importDays(db, r);
  if (!d) return null;
  const x = db.all(
    `SELECT COALESCE(SUM(visitors), 0) AS visitors, COALESCE(SUM(visits), 0) AS visits, COALESCE(SUM(pageviews), 0) AS pageviews,
            COALESCE(SUM(bounces), 0) AS bounces, COALESCE(SUM(visit_duration), 0) AS visit_duration, COUNT(DISTINCT day) AS days
     FROM imported_rows WHERE kind = 'visitors' AND day >= ? AND day <= ?`,
    [d.from, d.to],
  )[0];
  return x && num(x.days)
    ? {
        visitors: num(x.visitors),
        visits: num(x.visits),
        pageviews: num(x.pageviews),
        bounces: num(x.bounces),
        visit_duration: num(x.visit_duration),
        days: num(x.days),
      }
    : null;
}

/** Live totals plus imported ones (bounce_rate and visit_duration weighted by visits). */
export function mergeTotals(m: MetricValues, imp: ImportedTotals | null): MetricValues {
  if (!imp) return m;
  const out = { ...m };
  const liveVisits = num(m.visits);
  for (const k of ADDED) if (k in out) out[k] = num(out[k]) + imp[k];
  const visits = liveVisits + imp.visits;
  if ("bounce_rate" in out && visits) out.bounce_rate = round((num(m.bounce_rate) * liveVisits + imp.bounces * 100) / visits, 1);
  if ("visit_duration" in out && visits)
    out.visit_duration = Math.round((num(m.visit_duration) * liveVisits + imp.visit_duration) / visits);
  if ("views_per_visit" in out && visits) out.views_per_visit = round((num(out.pageviews) || 0) / visits, 2);
  return out;
}

/** Imported rows of a breakdown dimension (page, source, country, device) by value. */
export function importedByValue(db: Db, dim: string, r: Pick<Range, "start" | "end" | "timezone">): Map<string, ImportedTotals> | null {
  const kind = Object.entries(KIND_DIMENSION).find(([, d]) => d === dim)?.[0];
  const d = kind ? importDays(db, r) : null;
  if (!kind || !d) return null;
  const rows = db.all(
    `SELECT value, SUM(visitors) AS visitors, SUM(visits) AS visits, SUM(pageviews) AS pageviews, SUM(bounces) AS bounces, SUM(visit_duration) AS visit_duration, COUNT(DISTINCT day) AS days
     FROM imported_rows WHERE kind = ? AND day >= ? AND day <= ? GROUP BY value`,
    [kind, d.from, d.to],
  );
  return new Map(
    rows.map((x) => [
      String(x.value),
      {
        visitors: num(x.visitors),
        visits: num(x.visits),
        pageviews: num(x.pageviews),
        bounces: num(x.bounces),
        visit_duration: num(x.visit_duration),
        days: num(x.days),
      },
    ]),
  );
}

/** Imported visitors / visits / pageviews per timeseries bucket (by each day's local noon). */
export function importedByBucket(
  db: Db,
  r: Pick<Range, "start" | "end" | "timezone">,
  bs: { label: string; start: number; end: number }[],
): Map<string, ImportedTotals> | null {
  const d = importDays(db, r);
  if (!d) return null;
  const out = new Map<string, ImportedTotals>();
  for (const x of db.all(
    "SELECT day, SUM(visitors) AS visitors, SUM(visits) AS visits, SUM(pageviews) AS pageviews, SUM(bounces) AS bounces, SUM(visit_duration) AS visit_duration FROM imported_rows WHERE kind = 'visitors' AND day >= ? AND day <= ? GROUP BY day",
    [d.from, d.to],
  )) {
    const [y, m, dd] = String(x.day).split("-").map(Number) as [number, number, number];
    const t = zonedToUtc(y, m, dd, 12, r.timezone);
    const b = bs.find((b) => t >= b.start && t < b.end);
    if (!b) continue;
    const cur = out.get(b.label) ?? { visitors: 0, visits: 0, pageviews: 0, bounces: 0, visit_duration: 0, days: 0 };
    cur.visitors += num(x.visitors);
    cur.visits += num(x.visits);
    cur.pageviews += num(x.pageviews);
    cur.bounces += num(x.bounces);
    cur.visit_duration += num(x.visit_duration);
    cur.days += 1;
    out.set(b.label, cur);
  }
  return out;
}

export const IMPORT_NOTE_FILTERED =
  "Imported data has no filters or other dimensions: it is left out of filtered reports and of breakdowns other than page, source, country and device.";
