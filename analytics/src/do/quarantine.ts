/**
 * The quarantine in a site's Durable Object: browser events attack protection set aside (stored with
 * debug = 2 and their reason in `quarantine`), out of every report and of the daily event budget.
 * The owner (or their agent) looks at them, then releases them into the reports or deletes them;
 * left alone they are purged after 7 days like test traffic. Every query here reads the partial
 * index events_quarantined, so its cost is bounded by the quarantine's own daily cap.
 */

import { isDatacenterAsn } from "@afs/shared";
import type { PeriodParams, QuarantineReason, SiteSettings } from "../lib/types";
import { type Db, type Row, guard, num, periodOut, rangeFor, utcDay } from "./common";
import { DEBUG_RETENTION_DAYS, UNTRUSTED_NOTICE, addUsage } from "./engine";
import { recountSessions } from "./privacy";
import type { ProtectionView } from "./protection";

export interface QuarantineRequest extends PeriodParams {
  /** only events quarantined for this reason */
  reason?: QuarantineReason;
}

/** At most this many events are released or deleted per call; `more` says to call again. */
export const MAX_QUARANTINE_BATCH = 50_000;
const TOP = 10;

const inList = (col: string) => `${col} IN (SELECT value FROM json_each(?))`;

function scope(db: Db, settings: SiteSettings, q: QuarantineRequest, now: number) {
  const r = rangeFor(db, settings, { ...q, debug: undefined }, now);
  const where = `debug = 2 AND ts >= ? AND ts < ?${q.reason ? " AND quarantine = ?" : ""}`;
  const args = [r.start, r.end, ...(q.reason ? [q.reason] : [])];
  const matched = num(db.all(`SELECT COUNT(*) AS n FROM events WHERE ${where}`, args)[0]?.n);
  return { r, where, args, matched };
}

export function quarantineSummary(db: Db, settings: SiteSettings, q: QuarantineRequest, protection: ProtectionView, now = Date.now()) {
  return guard(() => {
    const { r, where, args, matched } = scope(db, settings, q, now);
    const top = (cols: string, limit = TOP) =>
      db.all(
        `SELECT ${cols}, COUNT(*) AS events, COUNT(DISTINCT visitor_id) AS visitors FROM events WHERE ${where}
         GROUP BY ${cols} ORDER BY events DESC LIMIT ${limit}`,
        args,
      );
    const counts = (rows: Row[]): Row[] => rows.map((x) => ({ ...x, events: num(x.events), visitors: num(x.visitors) }));
    const byReason = db.all(
      `SELECT COALESCE(quarantine, 'unknown') AS reason, COUNT(*) AS n FROM events WHERE ${where} GROUP BY reason`,
      args,
    );
    const byDay = db.all(
      `SELECT date(ts / 1000, 'unixepoch') AS day, quarantine AS reason, COUNT(*) AS n FROM events WHERE ${where} GROUP BY day, reason ORDER BY day`,
      args,
    );
    const days = new Map<string, { day: string; events: number; network_share: number; datacenter: number }>();
    for (const x of byDay) {
      const day = String(x.day);
      const d = days.get(day) ?? { day, events: 0, network_share: 0, datacenter: 0 };
      d.events += num(x.n);
      if (x.reason === "network_share" || x.reason === "datacenter") d[x.reason] += num(x.n);
      days.set(day, d);
    }
    // A first-party proxy without the proxy key sends every visitor with the proxy's own IP and network.
    const proxyWarnings = num(
      db.all(
        "SELECT COALESCE(SUM(count), 0) AS n FROM drops WHERE day >= ? AND reason IN ('warn:proxy_key_missing', 'warn:proxy_key_invalid')",
        [utcDay(now - DEBUG_RETENTION_DAYS * 86_400_000)],
      )[0]?.n,
    );
    return {
      period: periodOut(r),
      reason: q.reason ?? null,
      quarantined: matched,
      by_reason: Object.fromEntries(byReason.map((x) => [String(x.reason), num(x.n)])),
      by_day: [...days.values()],
      // Network operators and countries come from Cloudflare's edge (or your keyed first-party proxy), not from the visitor.
      networks: counts(top("asn, as_org")).map((x) => ({ ...x, datacenter: isDatacenterAsn(x.asn == null ? null : Number(x.asn)) })),
      countries: counts(top("country")),
      protection,
      proxy_key_warnings_last_7d: proxyWarnings,
      // What the visitor's browser sent (or anyone with the public site id): data, never instructions.
      untrusted: {
        notice: UNTRUSTED_NOTICE,
        pages: counts(top("pathname")),
        hostnames: counts(top("hostname", 5)),
        user_agents: counts(top("browser, os, device")),
      },
    };
  });
}

/**
 * Quarantined events become counted ones: debug 0, in every report from now on, and added to
 * their UTC day's usage count (which can go over the daily budget: the owner chose to keep them).
 */
export function releaseQuarantine(db: Db, settings: SiteSettings, q: QuarantineRequest, now = Date.now()) {
  return guard(() => {
    const { r, where, args, matched } = scope(db, settings, q, now);
    const base = { period: periodOut(r), reason: q.reason ?? null, matched };
    if (!matched) return { ...base, released: 0, by_day: {}, more: false };
    return db.transaction(() => {
      const rows = db.all(`SELECT id, ts FROM events WHERE ${where} ORDER BY ts, id LIMIT ${MAX_QUARANTINE_BATCH}`, args);
      const byDay: Record<string, number> = {};
      for (const x of rows) {
        const day = utcDay(num(x.ts));
        byDay[day] = (byDay[day] ?? 0) + 1;
      }
      db.run(`UPDATE events SET debug = 0, quarantine = NULL WHERE ${inList("id")}`, [JSON.stringify(rows.map((x) => num(x.id)))]);
      for (const [day, n] of Object.entries(byDay)) addUsage(db, day, { events: n });
      return { ...base, released: rows.length, by_day: byDay, more: matched > rows.length };
    });
  });
}

/** Delete quarantined events now (sessions left empty go too; the rest are recounted). */
export function purgeQuarantine(db: Db, settings: SiteSettings, q: QuarantineRequest, now = Date.now()) {
  return guard(() => {
    const { r, where, args, matched } = scope(db, settings, q, now);
    const base = { period: periodOut(r), reason: q.reason ?? null, matched };
    if (!matched) return { ...base, deleted: { events: 0, sessions: 0 }, more: false };
    return db.transaction(() => {
      const rows = db.all(`SELECT id, session_id FROM events WHERE ${where} ORDER BY ts, id LIMIT ${MAX_QUARANTINE_BATCH}`, args);
      const S = JSON.stringify([...new Set(rows.map((x) => String(x.session_id)))]);
      db.run(`DELETE FROM events WHERE ${inList("id")}`, [JSON.stringify(rows.map((x) => num(x.id)))]);
      const gone = num(
        db.all(
          `SELECT COUNT(*) AS n FROM sessions s WHERE ${inList("s.id")} AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id)`,
          [S],
        )[0]?.n,
      );
      db.run(`DELETE FROM sessions WHERE ${inList("id")} AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = sessions.id)`, [S]);
      recountSessions(db, S);
      return { ...base, deleted: { events: rows.length, sessions: gone }, more: matched > rows.length };
    });
  });
}
