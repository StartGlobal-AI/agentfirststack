/**
 * Helpers shared by the per-site engine modules (engine, payments, annotations, people, insights).
 * Storage-agnostic like the engine: everything takes the tiny `Db` interface.
 */

import { FilterError, type Filter } from "../lib/filters";
import { type Frag, type QueryCtx, type SqlValue } from "../lib/query";
import { type Range, PeriodError, resolvePeriod } from "../lib/time";
import type { DoError, PeriodParams, SiteSettings } from "../lib/types";

export type Row = Record<string, SqlValue>;

/** A statement being stepped lazily: each next() produces one row. Counters cover the work so far. */
export interface SqlCursor {
  next(): IteratorResult<Row, unknown>;
  /** Rows SQLite has read so far (grows as the cursor is stepped; 0 where the driver can't tell). */
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

export interface Db {
  all(sql: string, args?: SqlValue[]): Row[];
  run(sql: string, args?: SqlValue[]): void;
  /** Start a statement without reading its rows (for the user SQL endpoint, so it can stop early). */
  cursor(sql: string): SqlCursor;
  /** Run fn in a transaction; throw inside to roll back. */
  transaction<T>(fn: () => T): T;
}

export const DAY = 86_400_000;

export const all = (db: Db, f: Frag) => db.all(f.sql, f.args);
export const num = (v: SqlValue | undefined) => (v == null ? 0 : Number(v));
export const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
export const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export function err(code: string, message: string, hint?: string): DoError {
  return { error: { code, message, ...(hint ? { hint } : {}) } };
}

/** Bad periods and filters come back as 400s with their message, not as thrown errors. */
export function guard<T>(fn: () => T): T | DoError {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PeriodError || e instanceof FilterError) return err("bad_request", e.message);
    throw e;
  }
}

export const periodOut = (r: Range) => ({ name: r.period, from: r.from, to: r.to, timezone: r.timezone, start: r.start, end: r.end });

export function firstEventTs(db: Db): number | null {
  const r = db.all("SELECT MIN(ts) AS t FROM events")[0];
  return r?.t == null ? null : Number(r.t);
}

export function rangeFor(db: Db, settings: SiteSettings, p: PeriodParams, now: number): Range {
  return resolvePeriod(p, settings.timezone, now, p.period === "all" ? firstEventTs(db) : null);
}

export function ctxFor(db: Db, range: { start: number; end: number }, filters: Filter[]): QueryCtx {
  const g = db.all("SELECT COUNT(*) AS n, COUNT(value) AS v FROM goals")[0];
  return { start: range.start, end: range.end, filters, hasGoals: num(g?.n) > 0, hasGoalValues: num(g?.v) > 0 };
}

export function goalNames(db: Db): Set<string> {
  return new Set(db.all("SELECT name FROM goals").map((r) => String(r.name)));
}

export function unknownGoals(db: Db, names: string[], what = "goal(s)"): DoError | null {
  if (!names.length) return null;
  const known = goalNames(db);
  const missing = names.filter((n) => !known.has(n));
  if (!missing.length) return null;
  return err(
    "unknown_goal",
    `Unknown ${what}: ${missing.join(", ")}.`,
    known.size ? `Goals on this site: ${[...known].join(", ")}.` : "This site has no goals yet; create one with POST /v1/sites/:id/goals.",
  );
}

export function checkGoalFilters(db: Db, filters: Filter[]): DoError | null {
  return unknownGoals(
    db,
    filters.filter((f) => f.key === "goal" && (f.op === "==" || f.op === "!=")).flatMap((f) => f.values),
  );
}

/** JSON props text -> object (null when absent or unparseable). */
export function parseProps(v: SqlValue | undefined): Record<string, unknown> | null {
  if (v == null) return null;
  try {
    return JSON.parse(String(v)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The identity a session belongs to: its user_id, else the user_id seen on any session of the same
 * visitor id (so pre-signup visits join the user), else the visitor id. As SQL over sessions `s`.
 */
export const IDENT_SQL = "COALESCE(s.user_id, (SELECT MAX(s2.user_id) FROM sessions s2 WHERE s2.visitor_id = s.visitor_id), s.visitor_id)";

/** The note every visitor-level answer carries in cookieless mode. */
export function identityNote(settings: SiteSettings): string | null {
  return settings.visitor_id_mode === "persistent"
    ? null
    : "Cookieless mode: anonymous visitor ids rotate daily (UTC), so history before today is linked only for identified users (afsa('identify', id) or user_id on server events). For multi-day journeys of anonymous visitors, set visitor_id_mode to persistent (PATCH /v1/sites/:id).";
}
