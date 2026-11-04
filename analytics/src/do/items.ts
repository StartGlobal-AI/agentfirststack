/**
 * Ecommerce items in the site's Durable Object: one row per item of an ecommerce event
 * (event_items, removed with its event by a trigger), and the item report: list views, views,
 * adds, removes, checkouts, purchases and item revenue per item id / name / category / brand /
 * variant / list, with the visitor-based cart-to-purchase and view-to-purchase rates.
 */

import type { Filter, FilterExpr } from "../lib/filters";
import { whereFrag } from "../lib/query";
import type { PeriodParams, SiteSettings } from "../lib/types";
import type { Item } from "../lib/items";
import { type Db, type Row, all, checkGoalFilters, ctxFor, guard, num, periodOut, rangeFor, round } from "./common";

export const ITEMS_SQL = [
  `CREATE TABLE IF NOT EXISTS event_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_rowid INTEGER NOT NULL, ts INTEGER NOT NULL, event_name TEXT NOT NULL,
    item_id TEXT, item_name TEXT, item_category TEXT, item_brand TEXT, item_variant TEXT, item_list_name TEXT,
    price REAL, quantity INTEGER NOT NULL DEFAULT 1
  )`,
  "CREATE INDEX IF NOT EXISTS event_items_ts ON event_items(ts)",
  "CREATE INDEX IF NOT EXISTS event_items_event ON event_items(event_rowid)",
  // Every way an event goes (retention, erasure, purge, a deleted payment) takes its items along.
  "CREATE TRIGGER IF NOT EXISTS event_items_gc AFTER DELETE ON events BEGIN DELETE FROM event_items WHERE event_rowid = OLD.id; END",
];

/** Store an event's items (already within the site's cap). */
export function insertItems(db: Db, eventRowid: number, ts: number, name: string, items: Item[]): void {
  for (const it of items)
    db.run(
      `INSERT INTO event_items (event_rowid, ts, event_name, item_id, item_name, item_category, item_brand, item_variant, item_list_name, price, quantity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventRowid,
        ts,
        name,
        it.item_id,
        it.item_name,
        it.item_category,
        it.item_brand,
        it.item_variant,
        it.item_list_name,
        it.price,
        it.quantity,
      ],
    );
}

export const ITEM_DIMS = ["item_id", "item_name", "item_category", "item_brand", "item_variant", "item_list_name"] as const;
export type ItemDim = (typeof ITEM_DIMS)[number];
export const ITEM_SORTS = ["item_revenue", "items_purchased", "items_added", "items_viewed", "purchasers", "value"] as const;

export interface ItemsRequest extends PeriodParams {
  by: ItemDim;
  filters: Filter[];
  where?: FilterExpr | null;
  /** exact item values to keep, e.g. {item_category: "Shoes"} */
  item_filters?: Partial<Record<ItemDim, string>>;
  sort?: (typeof ITEM_SORTS)[number];
  limit: number;
  offset: number;
}

const METRICS_SQL = `
  COALESCE(SUM(CASE WHEN i.event_name = 'view_item_list' THEN i.quantity END), 0) AS items_listed,
  COALESCE(SUM(CASE WHEN i.event_name = 'select_item' THEN i.quantity END), 0) AS items_selected,
  COALESCE(SUM(CASE WHEN i.event_name = 'view_item' THEN 1 END), 0) AS items_viewed,
  COALESCE(SUM(CASE WHEN i.event_name = 'add_to_cart' THEN i.quantity END), 0) AS items_added,
  COALESCE(SUM(CASE WHEN i.event_name = 'remove_from_cart' THEN i.quantity END), 0) AS items_removed,
  COALESCE(SUM(CASE WHEN i.event_name = 'begin_checkout' THEN i.quantity END), 0) AS items_checked_out,
  COALESCE(SUM(CASE WHEN i.event_name = 'purchase' THEN i.quantity END), 0) AS items_purchased,
  COALESCE(SUM(CASE WHEN i.event_name = 'refund' THEN i.quantity END), 0) AS items_refunded,
  COALESCE(SUM(CASE WHEN i.event_name = 'purchase' THEN COALESCE(i.price, 0) * i.quantity END), 0)
    - COALESCE(SUM(CASE WHEN i.event_name = 'refund' THEN COALESCE(i.price, 0) * i.quantity END), 0) AS item_revenue,
  COUNT(DISTINCT CASE WHEN i.event_name = 'view_item' THEN e.visitor_id END) AS viewers,
  COUNT(DISTINCT CASE WHEN i.event_name = 'add_to_cart' THEN e.visitor_id END) AS adders,
  COUNT(DISTINCT CASE WHEN i.event_name = 'purchase' THEN e.visitor_id END) AS purchasers`;

const shape = (r: Row) => {
  const viewers = num(r.viewers);
  const adders = num(r.adders);
  const purchasers = num(r.purchasers);
  return {
    items_listed: num(r.items_listed),
    items_selected: num(r.items_selected),
    items_viewed: num(r.items_viewed),
    items_added: num(r.items_added),
    items_removed: num(r.items_removed),
    items_checked_out: num(r.items_checked_out),
    items_purchased: num(r.items_purchased),
    items_refunded: num(r.items_refunded),
    item_revenue: round(num(r.item_revenue), 2),
    viewers,
    adders,
    purchasers,
    cart_to_view_rate: viewers ? round((adders / viewers) * 100, 1) : null,
    cart_to_purchase_rate: adders ? round((purchasers / adders) * 100, 1) : null,
    view_to_purchase_rate: viewers ? round((purchasers / viewers) * 100, 1) : null,
  };
};

export function itemsReport(db: Db, settings: SiteSettings, q: ItemsRequest, now = Date.now()) {
  return guard(() => {
    const ge = checkGoalFilters(db, q.filters, q.where);
    if (ge) return ge;
    const r = rangeFor(db, settings, q, now);
    const w = whereFrag(ctxFor(db, r, q));
    const itemWhere: string[] = [];
    const itemArgs: string[] = [];
    for (const [k, v] of Object.entries(q.item_filters ?? {}))
      if (v != null && (ITEM_DIMS as readonly string[]).includes(k)) {
        itemWhere.push(`i.${k} = ?`);
        itemArgs.push(v);
      }
    const iw = itemWhere.length ? `AND ${itemWhere.join(" AND ")}` : "";
    const from = `FROM event_items i JOIN events e ON e.id = i.event_rowid LEFT JOIN sessions s ON s.id = e.session_id
                  WHERE i.ts >= ? AND i.ts < ? AND ${w.sql} ${iw}`;
    const args = [r.start, r.end, ...w.args, ...itemArgs];
    const col = `i.${q.by}`;
    const order = q.sort === "value" ? "value" : `${q.sort ?? "item_revenue"} DESC, items_purchased DESC, items_viewed DESC, value`;
    const rows = all(db, {
      sql: `SELECT COALESCE(${col}, '(none)') AS value, ${q.by === "item_id" ? "MAX(i.item_name) AS item_name," : ""} ${METRICS_SQL}, COUNT(*) OVER () AS total_rows
            ${from} GROUP BY value ORDER BY ${order} LIMIT ? OFFSET ?`,
      args: [...args, q.limit, q.offset],
    });
    const totals = all(db, { sql: `SELECT ${METRICS_SQL} ${from}`, args })[0] ?? {};
    const total = num(rows[0]?.total_rows);
    const currencies = all(db, {
      sql: `SELECT DISTINCT e.currency AS c ${from} AND i.event_name IN ('purchase', 'refund') AND e.currency IS NOT NULL LIMIT 3`,
      args,
    }).map((x) => String(x.c));
    return {
      period: periodOut(r),
      filters: q.filters,
      by: q.by,
      totals: shape(totals),
      results: rows.map((x) => ({ value: x.value, ...(q.by === "item_id" ? { item_name: x.item_name ?? null } : {}), ...shape(x) })),
      total_rows: total,
      offset: q.offset,
      next_offset: q.offset + rows.length < total ? q.offset + rows.length : null,
      ...(currencies.length > 1
        ? { note: `Item prices are in their events' currencies (${currencies.join(", ")}): item_revenue adds them as they are.` }
        : {}),
    };
  });
}
