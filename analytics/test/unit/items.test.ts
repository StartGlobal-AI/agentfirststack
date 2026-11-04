import { describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import { itemsReport } from "../../src/do/items";
import { cleanItems } from "../../src/lib/items";
import { HOUR, NOW, ev, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

const shoe = { item_id: "SKU1", item_name: "Runner", item_category: "Shoes", item_brand: "Acme", price: 50 };
const sock = { item_id: "SKU2", item_name: "Sock", item_category: "Socks", item_brand: "Acme", price: 5, quantity: 3 };

describe("ecommerce items", () => {
  it("cleans untrusted items", () => {
    expect(
      cleanItems([
        { id: 7, name: " Runner ", price: "12.5", quantity: "2" },
        { price: 3 },
        "x",
        { item_name: "n", quantity: -1, price: -5 },
      ]),
    ).toEqual([
      {
        item_id: "7",
        item_name: "Runner",
        item_category: null,
        item_brand: null,
        item_variant: null,
        item_list_name: null,
        price: 12.5,
        quantity: 2,
      },
      {
        item_id: null,
        item_name: "n",
        item_category: null,
        item_brand: null,
        item_variant: null,
        item_list_name: null,
        price: null,
        quantity: 1,
      },
    ]);
    expect(cleanItems({})).toBeNull();
    expect(cleanItems(Array.from({ length: 300 }, (_, i) => ({ item_id: `i${i}` })))!.length).toBe(200);
  });

  it("stores items of ecommerce events (capped), reports the funnel per item, and drops them with their events", () => {
    const db = memoryDb();
    const s = settings({ visitor_id_mode: "persistent" });
    engine.configure(db, s);
    const t = NOW - 2 * HOUR;
    const server = (v: string, name: string, items: unknown[], dt = 0) =>
      ev({ ts: t + dt, origin: "server", visitor_hash: v, name, items: cleanItems(items) });
    engine.ingest(
      db,
      [
        server("a", "view_item_list", [shoe, sock]),
        server("a", "view_item", [shoe], 1000),
        server("b", "view_item", [shoe], 1000),
        server("a", "add_to_cart", [shoe], 2000),
        server("b", "add_to_cart", [shoe, sock], 2000),
        server("a", "purchase", [shoe], 3000),
        server("b", "purchase", [sock], 3000),
        server("a", "pageview", [shoe], 4000), // not an ecommerce event: no items
      ],
      NOW,
    );
    const r = itemsReport(db, s, { period: "today", by: "item_id", filters: [], limit: 10, offset: 0 } as any, NOW) as any;
    const sku1 = r.results.find((x: any) => x.value === "SKU1");
    expect(sku1).toMatchObject({
      item_name: "Runner",
      items_listed: 1,
      items_viewed: 2,
      items_added: 2,
      items_purchased: 1,
      item_revenue: 50,
      viewers: 2,
      adders: 2,
      purchasers: 1,
      cart_to_purchase_rate: 50,
      view_to_purchase_rate: 50,
    });
    expect(r.results.find((x: any) => x.value === "SKU2")).toMatchObject({ items_added: 3, items_purchased: 3, item_revenue: 15 });
    expect(r.results[0].value).toBe("SKU1"); // by item_revenue
    expect(r.totals).toMatchObject({ item_revenue: 65, purchasers: 2 });
    const byCat = itemsReport(
      db,
      s,
      { period: "today", by: "item_category", filters: [], item_filters: { item_brand: "Acme" }, limit: 10, offset: 0 } as any,
      NOW,
    ) as any;
    expect(byCat.results.map((x: any) => x.value).sort()).toEqual(["Shoes", "Socks"]);
    // The per-event cap, and a warning when items are dropped.
    engine.ingest(db, [server("c", "add_to_cart", [shoe, sock, { item_id: "SKU3" }], 5000)], NOW, { itemsPerEvent: 2 });
    expect(db.all("SELECT COUNT(*) AS n FROM event_items WHERE event_name = 'add_to_cart'")[0]!.n).toBe(5);
    expect(db.all("SELECT reason FROM drops WHERE reason LIKE '%items_truncated'")).toHaveLength(1);
    // Items go with their events (retention, erasure, purge).
    const keep = db.all("SELECT COUNT(*) AS n FROM event_items i JOIN events e ON e.id = i.event_rowid WHERE e.visitor_id != 'a'")[0]!.n;
    expect(keep).toBeLessThan(db.all("SELECT COUNT(*) AS n FROM event_items")[0]!.n as number);
    db.run("DELETE FROM events WHERE visitor_id = 'a'");
    expect(db.all("SELECT COUNT(*) AS n FROM event_items")[0]!.n).toBe(keep);
  });

  it("browser purchase prices count only with browser_revenue", () => {
    const db = memoryDb();
    engine.configure(db, settings());
    engine.ingest(db, [ev({ name: "purchase", items: cleanItems([shoe]) }), ev({ name: "add_to_cart", items: cleanItems([shoe]) })], NOW);
    expect(db.all("SELECT event_name, price FROM event_items ORDER BY id")).toEqual([
      { event_name: "purchase", price: null },
      { event_name: "add_to_cart", price: 50 },
    ]);
  });
});
