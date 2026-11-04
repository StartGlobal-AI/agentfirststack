import { beforeEach, describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import { SCHEMA_SAMPLE_EVENTS, listProps, propKeys, siteSchema } from "../../src/do/schema";
import { METRICS } from "../../src/lib/filters";
import { METRIC_DOCS, metricCatalog } from "../../src/lib/catalog";
import { MIN, NOW, ev, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

describe("schema: event names and prop keys", () => {
  let db: ReturnType<typeof memoryDb>;
  beforeEach(() => {
    db = memoryDb();
    engine.configure(db, settings());
  });

  it("lists event names with counts and visitors, and prop keys with the events that carry them and top values", () => {
    engine.ingest(
      db,
      [
        ev({ ts: NOW - 30 * MIN }),
        ev({ ts: NOW - 29 * MIN, name: "signup", props: '{"plan":"pro","source":"hero"}' }),
        ev({ ts: NOW - 28 * MIN, name: "signup", visitor_hash: "v2", props: '{"plan":"pro"}' }),
        ev({ ts: NOW - 27 * MIN, name: "signup", visitor_hash: "v3", props: '{"plan":"free"}' }),
        ev({ ts: NOW - 26 * MIN, name: "outbound_click", props: '{"url":"https://x.test/"}' }),
      ],
      NOW,
    );
    const s = siteSchema(db, settings(), { period: "24h" }, NOW) as any;
    expect(s.events).toEqual([
      { name: "signup", events: 3, visitors: 3, last_seen_at: NOW - 27 * MIN, automatic: false },
      { name: "outbound_click", events: 1, visitors: 1, last_seen_at: NOW - 26 * MIN, automatic: true },
      { name: "pageview", events: 1, visitors: 1, last_seen_at: NOW - 30 * MIN, automatic: true },
    ]);
    expect(s.props).toEqual([
      {
        key: "plan",
        events: 3,
        distinct_values: 2,
        event_names: ["signup"],
        sample_values: [
          { value: "pro", count: 2 },
          { value: "free", count: 1 },
        ],
      },
      { key: "source", events: 1, distinct_values: 1, event_names: ["signup"], sample_values: [{ value: "hero", count: 1 }] },
      {
        key: "url",
        events: 1,
        distinct_values: 1,
        event_names: ["outbound_click"],
        sample_values: [{ value: "https://x.test/", count: 1 }],
      },
    ]);
    expect(s.sampled).toBe(false);
    const one = listProps(db, settings(), { period: "24h", event_name: "outbound_click" }, NOW) as any;
    expect(one.props.map((p: any) => p.key)).toEqual(["url"]);
  });

  it("samples the most recent events with props and says so", () => {
    expect(SCHEMA_SAMPLE_EVENTS).toBe(20_000);
    const r = propKeys(db, 0, NOW);
    expect(r).toEqual({ props: [], sample_events: 0, sampled: false });
  });

  it("every metric is documented", () => {
    for (const m of METRICS) expect(METRIC_DOCS[m].length).toBeGreaterThan(5);
    expect(metricCatalog().find((m) => m.name === "revenue")).toMatchObject({ default: true, sortable: true });
  });
});
