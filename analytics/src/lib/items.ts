/**
 * Ecommerce items, GA4 style: an `items` array on view_item_list, select_item, view_item,
 * add_to_cart, remove_from_cart, begin_checkout, purchase and refund events (browser props.items,
 * or items on server events). Each item: item_id and / or item_name, item_category, item_brand,
 * item_variant, item_list_name, price (per unit, the event's currency) and quantity. Pure.
 */

export const ECOMMERCE_EVENTS = [
  "view_item_list",
  "select_item",
  "view_item",
  "add_to_cart",
  "remove_from_cart",
  "begin_checkout",
  "purchase",
  "refund",
] as const;
export const ECOMMERCE_SET = new Set<string>(ECOMMERCE_EVENTS);
/** Items the Worker reads off one event at most (GA4's own limit); the site's cap applies in the DO. */
export const MAX_ITEMS_READ = 200;
export const DEFAULT_MAX_ITEMS_PER_EVENT = 25;

export interface Item {
  item_id: string | null;
  item_name: string | null;
  item_category: string | null;
  item_brand: string | null;
  item_variant: string | null;
  item_list_name: string | null;
  price: number | null;
  quantity: number;
}

const text = (v: unknown, max: number): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v).slice(0, max);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};
const numOf = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

/** Valid items of an untrusted array (at most MAX_ITEMS_READ): each needs an id or a name. */
export function cleanItems(input: unknown): Item[] | null {
  if (!Array.isArray(input)) return null;
  const out: Item[] = [];
  for (const raw of input.slice(0, MAX_ITEMS_READ)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const o = raw as Record<string, unknown>;
    const id = text(o.item_id ?? o.id, 100);
    const name = text(o.item_name ?? o.name, 200);
    if (!id && !name) continue;
    const price = numOf(o.price);
    const q = numOf(o.quantity);
    out.push({
      item_id: id,
      item_name: name,
      item_category: text(o.item_category ?? o.category, 100),
      item_brand: text(o.item_brand ?? o.brand, 100),
      item_variant: text(o.item_variant ?? o.variant, 100),
      item_list_name: text(o.item_list_name, 100),
      price: price != null && price >= 0 && price <= 1e9 ? Math.round(price * 1000) / 1000 : null,
      quantity: q != null && q >= 1 && q <= 1e6 ? Math.floor(q) : 1,
    });
  }
  return out.length ? out : null;
}
