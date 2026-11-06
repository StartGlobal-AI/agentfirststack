/**
 * First touch per identity, kept at ingest so first-touch dimensions and retention cohorts are a
 * primary-key lookup instead of a scan of every session.
 *
 * An identity is a visitor id, or user:<user_id> once a server or the tracker identified it. Each
 * row holds the identity's first session and that session's attribution (channel, source,
 * referrer, UTM source / medium / campaign, entry page), first and last seen. When a visitor id
 * gets a user id, the user row takes the earlier of the two first touches and the visitor row
 * points at it (`canonical`) and copies it, so events from before and after the sign-up report
 * the same first touch.
 *
 * Cookieless visitor ids rotate daily (UTC): for anonymous visitors in that mode the "first
 * touch" is that day's first session. Identified users and persistent mode see across days.
 */

import type { SqlValue } from "../lib/query";
import type { Db } from "./common";

export const TOUCH_COLS = ["channel", "source", "referrer", "utm_source", "utm_medium", "utm_campaign", "entry_page"] as const;

export const IDENTITIES_SQL = `CREATE TABLE IF NOT EXISTS identities (
  ident TEXT PRIMARY KEY, canonical TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, first_session_id TEXT,
  channel TEXT, source TEXT, referrer TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, entry_page TEXT
)`;

const cols = TOUCH_COLS.join(", ");
const ph = TOUCH_COLS.map(() => "?").join(", ");
/** On a conflict, an earlier session replaces the first touch (server events can be backdated). */
const keepEarliest = TOUCH_COLS.map((c) => `${c} = CASE WHEN excluded.first_seen < first_seen THEN excluded.${c} ELSE ${c} END`).join(", ");

export interface Touch {
  session_id: string;
  ts: number;
  attr: Record<string, SqlValue>;
}

/** A new session of `ident` (a visitor id or user:<id>). */
export function touchIdentity(db: Db, ident: string, t: Touch): void {
  db.run(
    `INSERT INTO identities (ident, first_seen, last_seen, first_session_id, ${cols}) VALUES (?, ?, ?, ?, ${ph})
     ON CONFLICT(ident) DO UPDATE SET ${keepEarliest},
       first_session_id = CASE WHEN excluded.first_seen < first_seen THEN excluded.first_session_id ELSE first_session_id END,
       first_seen = MIN(first_seen, excluded.first_seen), last_seen = MAX(last_seen, excluded.last_seen)`,
    [ident, t.ts, t.ts, t.session_id, ...TOUCH_COLS.map((c) => t.attr[c] ?? null)],
  );
}

/** A Direct session adopted a real source: the identities whose first session it is follow. */
export function retouchSession(db: Db, idents: string[], sessionId: string, attr: Record<string, SqlValue>): void {
  const set = TOUCH_COLS.filter((c) => c !== "entry_page")
    .map((c) => `${c} = ?`)
    .join(", ");
  for (const ident of idents)
    db.run(`UPDATE identities SET ${set} WHERE ident = ? AND first_session_id = ?`, [
      ...TOUCH_COLS.filter((c) => c !== "entry_page").map((c) => attr[c] ?? null),
      ident,
      sessionId,
    ]);
}

/** Visitor `visitorId` is user `userId`: merge first touches and point the visitor at the user. */
export function linkIdentity(db: Db, visitorId: string, userId: string): void {
  const user = `user:${userId}`;
  const v = db.all("SELECT canonical FROM identities WHERE ident = ?", [visitorId])[0];
  if (!v || v.canonical === user) return;
  // The user row: created from the visitor row, or given the visitor's first touch when that is earlier.
  db.run(
    `INSERT INTO identities (ident, first_seen, last_seen, first_session_id, ${cols})
       SELECT ?, first_seen, last_seen, first_session_id, ${cols} FROM identities WHERE ident = ?
     ON CONFLICT(ident) DO UPDATE SET ${keepEarliest},
       first_session_id = CASE WHEN excluded.first_seen < first_seen THEN excluded.first_session_id ELSE first_session_id END,
       first_seen = MIN(first_seen, excluded.first_seen), last_seen = MAX(last_seen, excluded.last_seen)`,
    [user, visitorId],
  );
  db.run(
    `UPDATE identities SET canonical = ?, (first_seen, first_session_id, ${cols}) =
       (SELECT first_seen, first_session_id, ${cols} FROM identities u WHERE u.ident = ?)
     WHERE ident = ?`,
    [user, user, visitorId],
  );
}

/**
 * Migration backfill from the sessions already stored: one row per visitor id and per user id
 * (its earliest session, the anonymous ones of its visitor ids included), then visitor ids point
 * at their user and copy its first touch.
 */
export function backfillIdentities(db: Db): void {
  db.run(
    `INSERT OR IGNORE INTO identities (ident, first_seen, last_seen, first_session_id, ${cols})
     SELECT visitor_id, MIN(started_at), 0, id, ${cols} FROM sessions GROUP BY visitor_id`,
  );
  db.run(
    `INSERT OR IGNORE INTO identities (ident, first_seen, last_seen, first_session_id, ${cols})
     SELECT 'user:' || u.uid, MIN(s.started_at), 0, s.id, ${TOUCH_COLS.map((c) => `s.${c}`).join(", ")}
     FROM (SELECT DISTINCT user_id AS uid, visitor_id FROM sessions WHERE user_id IS NOT NULL) u
     JOIN sessions s ON s.visitor_id = u.visitor_id AND (s.user_id = u.uid OR s.user_id IS NULL)
     GROUP BY u.uid`,
  );
  db.run(
    `UPDATE identities SET last_seen = COALESCE((SELECT MAX(last_seen_at) FROM sessions s WHERE s.visitor_id = identities.ident), first_seen)
     WHERE ident NOT LIKE 'user:%'`,
  );
  db.run(
    `UPDATE identities SET last_seen = COALESCE((SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = substr(identities.ident, 6)), first_seen)
     WHERE ident LIKE 'user:%'`,
  );
  db.run(
    `UPDATE identities SET canonical = 'user:' || (SELECT MAX(user_id) FROM sessions s WHERE s.visitor_id = identities.ident)
     WHERE ident NOT LIKE 'user:%' AND EXISTS (SELECT 1 FROM sessions s WHERE s.visitor_id = identities.ident AND s.user_id IS NOT NULL)`,
  );
  db.run(
    `UPDATE identities SET (first_seen, first_session_id, ${cols}) =
       (SELECT u.first_seen, u.first_session_id, ${TOUCH_COLS.map((c) => `u.${c}`).join(", ")} FROM identities u WHERE u.ident = identities.canonical)
     WHERE canonical IS NOT NULL AND EXISTS (SELECT 1 FROM identities u WHERE u.ident = identities.canonical)`,
  );
}

/** The identity whose first touch an event reports: its user, else its visitor id. */
export const EVENT_IDENT = "COALESCE('user:' || e.user_id, e.visitor_id)";

/**
 * The canonical identity of a session (a visitor id that was identified counts as its user). Only
 * a trusted user id counts: one a server sent (user_source = 'server'), or any when the site sets
 * trust_browser_user_id. A browser id (afsa('identify')) never makes a session someone else's.
 */
export const sessionIdent = (trustBrowser: boolean) =>
  `COALESCE(${trustBrowser ? "'user:' || s.user_id" : "CASE WHEN s.user_source = 'server' THEN 'user:' || s.user_id END"}, (SELECT i.canonical FROM identities i WHERE i.ident = s.visitor_id), s.visitor_id)`;

/**
 * The person behind a conversion event `e`, matching sessionIdent: a server event's own user id,
 * else its session's identity, else (no session row: an unlinked payment or a no-visit event) the
 * user id a server or payment carried, the identified visitor's user, or the visitor id.
 */
export const conversionPerson = (trustBrowser: boolean) =>
  trustBrowser
    ? "COALESCE('user:' || e.user_id, (SELECT i.canonical FROM identities i WHERE i.ident = e.visitor_id), e.visitor_id)"
    : `COALESCE(CASE WHEN e.origin = 'server' THEN 'user:' || e.user_id END, (SELECT ${sessionIdent(false)} FROM sessions s WHERE s.id = e.session_id), CASE WHEN e.origin = 'payment' THEN 'user:' || e.user_id END, (SELECT i.canonical FROM identities i WHERE i.ident = e.visitor_id), e.visitor_id)`;
