/**
 * Erasure and purges in the site's Durable Object.
 *
 *   deleteIdentity: everything stored about one person (a visitor id, user:<user_id> with that
 *     user's anonymous pre-identify sessions, or a payment customer). Their events and sessions go;
 *     their payments stay in the revenue ledger by default but lose every link to them (visitor,
 *     session, user, customer hash, geo, device, click id), or are deleted with payments=delete.
 *   purgeEvents: events matching filters in a time range (test traffic, a bad deploy), with a dry
 *     run that counts first. Sessions left empty are deleted and the others recounted. Payment
 *     events are never purged here (delete_payment keeps the ledger consistent).
 *
 * Neither lowers the daily usage counters: deleting data never gives back event budget.
 */

import type { Filter } from "../lib/filters";
import { whereFrag } from "../lib/query";
import type { PeriodParams, SiteSettings } from "../lib/types";
import { type Db, all, checkGoalFilters, ctxFor, err, guard, num, periodOut, rangeFor } from "./common";
import { DEVICE_COLS, GEO_COLS } from "./engine";

const inList = (col: string) => `${col} IN (SELECT value FROM json_each(?))`;

/** Session ids of an identity key: a visitor id, user:<user_id>, or the sessions a customer's payments link to. */
function identitySessions(db: Db, key: string, customerHash: string | null): string[] {
  if (customerHash) {
    const viaPayments = db.all(
      "SELECT DISTINCT e.session_id AS id FROM payments p JOIN events e ON e.id = p.event_rowid WHERE p.customer = ?",
      [customerHash],
    );
    const links = db.all("SELECT session_id AS id FROM payment_links WHERE customer = ? AND session_id IS NOT NULL", [customerHash]);
    const ids = [...new Set([...viaPayments, ...links].map((r) => String(r.id)).filter((x) => x && x !== "erased"))];
    if (!ids.length) return [];
    // The whole visitor (and user) behind those sessions.
    const people = db.all(`SELECT DISTINCT visitor_id, user_id FROM sessions WHERE ${inList("id")}`, [JSON.stringify(ids)]);
    const vids = JSON.stringify(people.map((p) => String(p.visitor_id)));
    const uids = JSON.stringify(people.map((p) => p.user_id).filter((u) => u != null));
    return db.all(`SELECT id FROM sessions WHERE ${inList("visitor_id")} OR ${inList("user_id")}`, [vids, uids]).map((r) => String(r.id));
  }
  if (key.startsWith("user:")) {
    const uid = key.slice(5);
    return db
      .all(
        `SELECT id FROM sessions WHERE user_id = ?
           OR (user_id IS NULL AND visitor_id IN (SELECT visitor_id FROM sessions WHERE user_id = ?))`,
        [uid, uid],
      )
      .map((r) => String(r.id));
  }
  return db.all("SELECT id FROM sessions WHERE visitor_id = ?", [key]).map((r) => String(r.id));
}

export interface DeleteIdentityOptions {
  /** unlink (default): keep the payment amounts, drop every link to the person; delete: remove them */
  payments?: "unlink" | "delete";
  /** customer:<provider>:<id> keys: the salted hash the Worker computed */
  customerHash?: string | null;
}

export function deleteIdentity(db: Db, key: string, o: DeleteIdentityOptions = {}) {
  return db.transaction(() => {
    const sids = identitySessions(db, key, o.customerHash ?? null);
    const visitorIds = sids.length
      ? db.all(`SELECT DISTINCT visitor_id FROM sessions WHERE ${inList("id")}`, [JSON.stringify(sids)]).map((r) => String(r.visitor_id))
      : [];
    const userIdents = sids.length
      ? db
          .all(`SELECT DISTINCT user_id FROM sessions WHERE ${inList("id")} AND user_id IS NOT NULL`, [JSON.stringify(sids)])
          .map((r) => `user:${r.user_id}`)
      : key.startsWith("user:")
        ? [key]
        : [];
    const S = JSON.stringify(sids);
    const V = JSON.stringify(visitorIds);
    // By session only: a visitor id can be shared (one device, two users), a session can't.
    const payEvents = db.all(`SELECT id FROM events WHERE origin = 'payment' AND ${inList("session_id")}`, [S]).map((r) => Number(r.id));
    const P = JSON.stringify(payEvents);
    const events = num(db.all(`SELECT COUNT(*) AS n FROM events WHERE origin != 'payment' AND ${inList("session_id")}`, [S])[0]?.n);
    // No-visit events (visit: false, no live session) have no session: they go by user id or visitor id.
    const nvUsers = [...new Set([...userIdents.map((u) => u.slice(5)), ...(key.startsWith("user:") ? [key.slice(5)] : [])])];
    const byVisitorKey = !key.startsWith("user:") && !key.startsWith("customer:") && !o.customerHash;
    const nvVisitors = [...new Set([...visitorIds, ...(byVisitorKey ? [key] : [])])];
    const nvWhere = `no_visit = 1 AND (${inList("user_id")} OR ${inList("visitor_id")})`;
    const nvArgs = [JSON.stringify(nvUsers), JSON.stringify(nvVisitors)];
    const noVisit = num(db.all(`SELECT COUNT(*) AS n FROM events WHERE ${nvWhere}`, nvArgs)[0]?.n);
    // Subscriptions of the person: by session, visitor, user or customer.
    const U = JSON.stringify(userIdents.map((u) => u.slice(5)));
    const subWhere = `${inList("session_id")} OR ${inList("visitor_id")} OR ${inList("user_id")}${o.customerHash ? " OR customer = ?" : ""}`;
    const subArgs = o.customerHash ? [S, V, U, o.customerHash] : [S, V, U];
    const subRefs = db.all(`SELECT ref FROM subscriptions WHERE ${subWhere}`, subArgs).map((r) => String(r.ref));
    if (!sids.length && !events && !noVisit && !payEvents.length && !subRefs.length) return null;
    db.run(`DELETE FROM events WHERE origin != 'payment' AND ${inList("session_id")}`, [S]);
    if (noVisit) db.run(`DELETE FROM events WHERE ${nvWhere}`, nvArgs);
    db.run(`DELETE FROM sessions WHERE ${inList("id")}`, [S]);
    // First-touch rows of the person: their visitor ids, and the user ids those sessions carried.
    db.run(`DELETE FROM identities WHERE ${inList("ident")} OR ${inList("canonical")}`, [V, JSON.stringify(userIdents)]);
    db.run(`DELETE FROM identities WHERE ${inList("ident")}`, [JSON.stringify(userIdents)]);
    db.run(`DELETE FROM user_props WHERE ${inList("user_id")}`, [JSON.stringify(userIdents.map((u) => u.slice(5)))]);
    db.run(`DELETE FROM payment_links WHERE ${inList("session_id")} OR ${inList("visitor_id")}`, [S, V]);
    if (o.customerHash) db.run("DELETE FROM payment_links WHERE customer = ?", [o.customerHash]);
    // Their subscriptions are kept (MRR stays true) with every link to them removed, or deleted
    // with their history when payments: delete.
    if (subRefs.length) {
      const R = JSON.stringify(subRefs);
      if (o.payments === "delete") {
        db.run(`DELETE FROM subscription_changes WHERE ${inList("sub_ref")}`, [R]);
        db.run(`DELETE FROM subscriptions WHERE ${inList("ref")}`, [R]);
      } else
        db.run(
          `UPDATE subscriptions SET session_id = NULL, visitor_id = NULL, user_id = NULL, customer = NULL, referrer = NULL, country = NULL, updated_at = ? WHERE ${inList("ref")}`,
          [Date.now(), R],
        );
    }
    if (o.payments === "delete") {
      db.run(`DELETE FROM payments WHERE ${inList("event_rowid")}`, [P]);
      db.run(`DELETE FROM events WHERE ${inList("id")}`, [P]);
    } else if (payEvents.length) {
      // The amount and the marketing attribution (channel, source, UTM tags) stay; nothing that
      // points at the person does.
      const nulls = ["user_id", "hostname", "pathname", "url", "referrer", "click_id", "props", ...GEO_COLS, ...DEVICE_COLS]
        .map((c) => `${c} = NULL`)
        .join(", ");
      db.run(`UPDATE events SET visitor_id = 'erased', session_id = 'erased', ${nulls} WHERE ${inList("id")}`, [P]);
      db.run(`UPDATE payments SET customer = NULL, updated_at = ? WHERE ${inList("event_rowid")}`, [Date.now(), P]);
    }
    return {
      events_deleted: events + noVisit,
      sessions_deleted: sids.length,
      payments: o.payments === "delete" ? { deleted: payEvents.length } : { unlinked: payEvents.length },
      ...(subRefs.length ? { subscriptions: o.payments === "delete" ? { deleted: subRefs.length } : { unlinked: subRefs.length } } : {}),
      visitor_ids: visitorIds.length,
    };
  });
}

/** At most this many events are deleted per purge call; `more` says to call again. */
export const MAX_PURGE_EVENTS = 50_000;

export interface PurgeRequest extends PeriodParams {
  filters: Filter[];
  dry_run: boolean;
}

export function purgeEvents(db: Db, settings: SiteSettings, q: PurgeRequest, now = Date.now()) {
  return guard(() => {
    const ge = checkGoalFilters(db, q.filters, q.where);
    if (ge) return ge;
    const r = rangeFor(db, settings, q, now);
    const ctx = ctxFor(db, r, q);
    const where = whereFrag(ctx);
    const head = all(db, {
      sql: `SELECT COALESCE(SUM(e.origin != 'payment'), 0) AS n, COUNT(DISTINCT CASE WHEN e.origin != 'payment' AND e.no_visit = 0 THEN e.session_id END) AS s,
              COALESCE(SUM(e.origin = 'payment'), 0) AS p FROM events e WHERE ${where.sql}`,
      args: where.args,
    })[0];
    const matched = { events: num(head?.n), sessions: num(head?.s), payment_events_skipped: num(head?.p) };
    const base = { period: periodOut(r), filters: q.filters, dry_run: q.dry_run, matched };
    if (q.dry_run || !matched.events) return { ...base, deleted: { events: 0, sessions: 0 }, more: false };
    return db.transaction(() => {
      const ids = all(db, {
        sql: `SELECT e.id, e.session_id FROM events e WHERE ${where.sql} AND e.origin != 'payment' ORDER BY e.ts, e.id LIMIT ${MAX_PURGE_EVENTS}`,
        args: where.args,
      });
      const I = JSON.stringify(ids.map((x) => Number(x.id)));
      const S = JSON.stringify([...new Set(ids.map((x) => String(x.session_id)))]);
      db.run(`DELETE FROM events WHERE ${inList("id")}`, [I]);
      const gone = num(
        db.all(
          `SELECT COUNT(*) AS n FROM sessions s WHERE ${inList("s.id")} AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id)`,
          [S],
        )[0]?.n,
      );
      db.run(`DELETE FROM sessions WHERE ${inList("id")} AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = sessions.id)`, [S]);
      recountSessions(db, S);
      return { ...base, deleted: { events: ids.length, sessions: gone }, more: matched.events > ids.length };
    });
  });
}

/** Recompute the counters of sessions some of whose events were deleted. */
export function recountSessions(db: Db, idsJson: string): void {
  db.run(
    `UPDATE sessions SET
       pageviews = (SELECT COUNT(*) FROM events e WHERE e.session_id = sessions.id AND e.name = 'pageview'),
       custom_events = (SELECT COUNT(*) FROM events e WHERE e.session_id = sessions.id AND e.name != 'pageview' AND e.origin != 'payment' AND e.non_interactive = 0),
       engagement_ms = (SELECT COALESCE(SUM(e.engagement_ms), 0) FROM events e WHERE e.session_id = sessions.id),
       started_at = COALESCE((SELECT MIN(e.ts) FROM events e WHERE e.session_id = sessions.id), started_at),
       last_seen_at = COALESCE((SELECT MAX(e.ts) FROM events e WHERE e.session_id = sessions.id), last_seen_at),
       entry_page = (SELECT e.pathname FROM events e WHERE e.session_id = sessions.id AND e.name = 'pageview' ORDER BY e.ts, e.id LIMIT 1),
       exit_page = (SELECT e.pathname FROM events e WHERE e.session_id = sessions.id AND e.name = 'pageview' ORDER BY e.ts DESC, e.id DESC LIMIT 1),
       last_pageview_at = (SELECT MAX(e.ts) FROM events e WHERE e.session_id = sessions.id AND e.name = 'pageview')
     WHERE ${inList("id")}`,
    [idsJson],
  );
}

export const notFoundIdentity = (key: string) =>
  err(
    "not_found",
    `Nothing stored for ${key} on this site (within retention).`,
    "Keys: a visitor id or user:<user_id> from GET /v1/sites/:id/visitors, or customer:<provider>:<customer_id> for a payment customer.",
  );
