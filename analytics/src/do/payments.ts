/**
 * Payments in the site's Durable Object. Every payment is stored twice, on purpose:
 *   - as an event (origin 'payment', name payment | renewal | refund, signed revenue) carrying the
 *     attribution, geo and device of the session it is linked to, so revenue shows up in every
 *     breakdown, filter, timeseries and funnel without special cases;
 *   - in the `payments` ledger, keyed by provider:external_id, for idempotency, refunds, renewals
 *     and deletes.
 *
 * Linking, first match wins: afs_session_id -> the visitor's latest session at or before the
 * payment -> the user_id's latest session (a session whose user id a server event sent, unless the
 * site trusts browser user ids: anyone can call afsa('identify', ...) with someone else's id to
 * pre-seed a session) -> the provider customer's earlier link (so renewals
 * keep the original source) -> for refunds, the refunded payment. Nothing matched: the payment is
 * kept as channel "Unattributed" and linked later if the customer turns up (a subscription checkout
 * that arrives after its first invoice).
 */

import { newId, randomString } from "@afs/shared";
import type { PaymentInput, PaymentOutcome, SiteSettings } from "../lib/types";
import { type Db, type Row, DAY, num, round } from "./common";
import { ATTR_COLS, DEVICE_COLS, GEO_COLS, pick } from "./engine";

const DIM_COLS = ["visitor_id", "session_id", "user_id", "hostname", ...ATTR_COLS, ...GEO_COLS, ...DEVICE_COLS] as const;

type Target = { dims: Row | null; linked_by: string | null };

const sessionDims = (s: Row | undefined): Row | null => (s ? { ...s, session_id: s.id ?? null } : null);

function latestSession(db: Db, col: "visitor_id" | "user_id", value: string, ts: number, trustBrowserUserId = true): Row | null {
  const trusted = col === "user_id" && !trustBrowserUserId ? " AND user_source = 'server'" : "";
  const before = db.all(`SELECT * FROM sessions WHERE ${col} = ?${trusted} AND started_at <= ? ORDER BY started_at DESC LIMIT 1`, [
    value,
    ts,
  ])[0];
  return sessionDims(before ?? db.all(`SELECT * FROM sessions WHERE ${col} = ?${trusted} ORDER BY started_at LIMIT 1`, [value])[0]);
}

export interface PaymentOptions {
  /** user ids sent by the browser (afsa('identify')) may link payments; default: only server-sent ones */
  trustBrowserUserId?: boolean;
}

function paymentEventOf(db: Db, where: string, args: (string | number)[]): Row | null {
  return (
    db.all(
      `SELECT e.* FROM payments p JOIN events e ON e.id = p.event_rowid WHERE ${where} AND p.linked_by IS NOT NULL ORDER BY p.ts DESC LIMIT 1`,
      args,
    )[0] ?? null
  );
}

export function resolve(db: Db, p: PaymentInput, o: PaymentOptions): Target {
  if (p.type === "refund" && p.original_refs.length) {
    for (const ref of p.original_refs) {
      const e = paymentEventOf(db, "p.ref = ?", [`${p.provider}:${ref}`]);
      if (e) return { dims: e, linked_by: "original_payment" };
    }
  }
  if (p.session_id) {
    const s = sessionDims(db.all("SELECT * FROM sessions WHERE id = ?", [p.session_id])[0]);
    if (s) return { dims: s, linked_by: "session" };
  }
  if (p.visitor_id) {
    const s = latestSession(db, "visitor_id", p.visitor_id, p.ts);
    if (s) return { dims: s, linked_by: "visitor" };
  }
  if (p.user_id) {
    const s = latestSession(db, "user_id", p.user_id, p.ts, !!o.trustBrowserUserId);
    if (s) return { dims: s, linked_by: "user" };
  }
  if (p.customer) {
    const link = db.all("SELECT session_id FROM payment_links WHERE customer = ?", [p.customer])[0];
    const s = link?.session_id ? sessionDims(db.all("SELECT * FROM sessions WHERE id = ?", [link.session_id])[0]) : null;
    if (s) return { dims: s, linked_by: "customer" };
    // The linked session may be past retention; the customer's latest linked payment still carries its attribution.
    const e = paymentEventOf(db, "p.customer = ?", [p.customer]);
    if (e) return { dims: e, linked_by: "customer" };
  }
  return { dims: null, linked_by: null };
}

function upsertLink(db: Db, customer: string, dims: Row, now: number): void {
  db.run(
    `INSERT INTO payment_links (customer, session_id, visitor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(customer) DO UPDATE SET updated_at = excluded.updated_at`,
    [customer, dims.session_id ?? null, dims.visitor_id ?? null, now, now],
  );
}

function setDims(db: Db, where: string, args: (string | number)[], dims: Row): void {
  db.run(`UPDATE events SET ${DIM_COLS.map((c) => `${c} = ?`).join(", ")} WHERE ${where}`, [
    ...DIM_COLS.map((c) => dims[c] ?? null),
    ...args,
  ]);
}

/** A customer just got linked: attribute their earlier unlinked payments too. */
function relinkCustomer(db: Db, customer: string, dims: Row, now: number): void {
  setDims(db, "id IN (SELECT event_rowid FROM payments WHERE customer = ? AND linked_by IS NULL)", [customer], dims);
  db.run("UPDATE payments SET linked_by = 'customer', updated_at = ? WHERE customer = ? AND linked_by IS NULL", [now, customer]);
}

const EVENT_NAME = { new: "payment", renewal: "renewal", refund: "refund" } as const;

function insertEvent(db: Db, p: PaymentInput & { type: keyof typeof EVENT_NAME }, signed: number, t: Target): number {
  const d = t.dims;
  const dims: Record<string, unknown> = d
    ? pick(d, DIM_COLS)
    : {
        ...Object.fromEntries(DIM_COLS.map((c) => [c, null])),
        // Unlinked: one stable pseudo-visitor per customer, never counted as a visitor (origin 'payment').
        visitor_id: p.customer ? `c${p.customer.slice(0, 15)}` : `x${randomString(15)}`,
        session_id: `p${randomString(15)}`,
        user_id: p.user_id,
        channel: "Unattributed",
      };
  const cols = ["ts", "name", "origin", "props", "revenue", "currency", "revenue_type", ...DIM_COLS];
  const row = db.all(`INSERT INTO events (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) RETURNING id`, [
    p.ts,
    EVENT_NAME[p.type],
    "payment",
    JSON.stringify({ provider: p.provider }),
    signed,
    p.currency,
    p.type,
    ...DIM_COLS.map((c) => (dims[c] ?? null) as string | number | null),
  ])[0];
  return num(row?.id);
}

function one(db: Db, p: PaymentInput, now: number, o: PaymentOptions): PaymentOutcome {
  if (p.event_id) {
    const key = `${p.provider}:${p.event_id}`;
    if (db.all("SELECT 1 FROM provider_events WHERE id = ?", [key]).length) return { ok: true, duplicate_event: true };
    db.run("INSERT INTO provider_events (id, received_at) VALUES (?, ?)", [key, now]);
  }
  const t = resolve(db, p, o);
  if (p.type === "link") {
    if (p.customer && t.dims && t.linked_by !== "customer") {
      upsertLink(db, p.customer, t.dims, now);
      relinkCustomer(db, p.customer, t.dims, now);
    }
    return { ok: true, linked_by: t.linked_by, ...(t.dims ? {} : { reason: "no visitor found for this checkout yet" }) };
  }
  const ref = `${p.provider}:${p.external_id}`;
  const existing = db.all("SELECT * FROM payments WHERE ref = ?", [ref])[0];
  const signed = round(p.type === "refund" ? -p.amount : p.amount, 3);
  if (existing) {
    // Refunds report the cumulative amount: a later partial refund replaces the figure.
    if (p.type === "refund" && Number(existing.amount) !== signed) {
      db.run("UPDATE payments SET amount = ?, original_amount = ?, updated_at = ? WHERE id = ?", [
        signed,
        p.original_amount != null ? -Math.abs(p.original_amount) : signed,
        now,
        String(existing.id),
      ]);
      db.run("UPDATE events SET revenue = ? WHERE id = ?", [signed, num(existing.event_rowid)]);
    }
    // The same payment seen again with better identifiers (a Checkout event after its PaymentIntent).
    if (!existing.linked_by && t.dims) {
      setDims(db, "id = ?", [num(existing.event_rowid)], t.dims);
      db.run("UPDATE payments SET linked_by = ?, updated_at = ? WHERE id = ?", [t.linked_by, now, String(existing.id)]);
      if (p.customer && t.linked_by !== "customer") upsertLink(db, p.customer, t.dims, now);
    }
    return { ok: true, id: String(existing.id), existing: true, linked_by: (existing.linked_by as string | null) ?? t.linked_by };
  }
  const rowid = insertEvent(db, p as PaymentInput & { type: keyof typeof EVENT_NAME }, signed, t);
  const id = newId("pay");
  db.run(
    `INSERT INTO payments (id, ref, provider, external_id, type, amount, currency, ts, customer, event_rowid, linked_by, livemode,
       original_amount, original_currency, fx_rate, fx_day, fx_fallback, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ref,
      p.provider,
      p.external_id,
      p.type,
      signed,
      p.currency,
      p.ts,
      p.customer,
      rowid,
      t.linked_by,
      p.livemode ? 1 : 0,
      round(p.type === "refund" ? -Math.abs(p.original_amount ?? p.amount) : (p.original_amount ?? p.amount), 3),
      p.original_currency ?? p.currency,
      p.fx_rate ?? null,
      p.fx_day ?? null,
      p.fx_fallback ? 1 : 0,
      now,
      now,
    ],
  );
  if (p.customer && t.dims && t.linked_by !== "customer" && t.linked_by !== "original_payment") upsertLink(db, p.customer, t.dims, now);
  return { ok: true, id, existing: false, linked_by: t.linked_by };
}

export function ingestPayments(db: Db, records: PaymentInput[], now = Date.now(), o: PaymentOptions = {}): PaymentOutcome[] {
  const out: PaymentOutcome[] = [];
  db.transaction(() => {
    for (const r of records) out.push(one(db, r, now, o));
  });
  return out;
}

export interface PaymentsQuery {
  start: number;
  end: number;
  type?: string;
  limit: number;
  offset: number;
}

export function listPayments(db: Db, settings: SiteSettings, q: PaymentsQuery) {
  const typeSql = q.type ? "AND p.type = ?" : "";
  const args = q.type ? [q.start, q.end, q.type] : [q.start, q.end];
  const rows = db.all(
    `SELECT p.id, p.provider, p.external_id, p.type, p.amount, p.currency, p.ts, p.linked_by, p.livemode, p.created_at,
            p.original_amount, p.original_currency, p.fx_rate, p.fx_day, p.fx_fallback,
            e.visitor_id, e.session_id, e.user_id, e.channel, e.source, e.country, e.device
     FROM payments p LEFT JOIN events e ON e.id = p.event_rowid
     WHERE p.ts >= ? AND p.ts < ? ${typeSql} ORDER BY p.ts DESC, p.id LIMIT ? OFFSET ?`,
    [...args, q.limit, q.offset],
  );
  const head = db.all(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS revenue, COALESCE(SUM(linked_by IS NULL), 0) AS unlinked
     FROM payments p WHERE p.ts >= ? AND p.ts < ? ${typeSql}`,
    args,
  )[0];
  const total = num(head?.n);
  return {
    payments: rows.map((r) => {
      const linked = r.linked_by != null;
      return {
        id: r.id,
        provider: r.provider,
        external_id: r.external_id,
        type: r.type,
        amount: r.amount,
        currency: r.currency,
        ...(r.fx_rate != null
          ? {
              original: {
                amount: r.original_amount,
                currency: r.original_currency,
                fx_rate: r.fx_rate,
                fx_day: r.fx_day,
                fx_fallback: !!r.fx_fallback,
              },
            }
          : {}),
        timestamp: r.ts,
        time: new Date(Number(r.ts)).toISOString(),
        livemode: !!r.livemode,
        linked,
        linked_by: r.linked_by,
        visitor_id: linked ? r.visitor_id : null,
        session_id: linked ? r.session_id : null,
        user_id: r.user_id ?? null,
        channel: r.channel,
        source: r.source,
        country: r.country,
        device: r.device,
      };
    }),
    total,
    revenue: round(num(head?.revenue), 2),
    unlinked: num(head?.unlinked),
    offset: q.offset,
    next_offset: q.offset + rows.length < total ? q.offset + rows.length : null,
    timezone: settings.timezone,
  };
}

export function deletePayment(db: Db, id: string) {
  const p = db.all("SELECT id, event_rowid FROM payments WHERE id = ?", [id])[0];
  if (!p) return null;
  db.transaction(() => {
    db.run("DELETE FROM events WHERE id = ?", [num(p.event_rowid)]);
    db.run("DELETE FROM payments WHERE id = ?", [id]);
  });
  return { deleted: id };
}

/** For verify and the Stripe status: payments in the last 30 days and how many found no visitor. */
export function paymentsSummary(db: Db, now = Date.now()) {
  const r = db.all(
    `SELECT COUNT(*) AS n, COALESCE(SUM(linked_by IS NULL), 0) AS unlinked, MAX(ts) AS last_ts, COALESCE(SUM(livemode = 0), 0) AS test
     FROM payments WHERE ts >= ?`,
    [now - 30 * DAY],
  )[0];
  return { payments_30d: num(r?.n), unlinked_30d: num(r?.unlinked), test_mode_30d: num(r?.test), last_payment_at: r?.last_ts ?? null };
}
