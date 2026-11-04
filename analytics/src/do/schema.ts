/**
 * What a site's data looks like: its event names and custom prop keys (with counts and sample
 * values), so an agent can filter and break down by names it has never seen. Every name, key and
 * value here was sent by visitors or the site's backend: the service returns them under
 * `untrusted`.
 *
 * Prop keys come from the most recent SCHEMA_SAMPLE_EVENTS events with props in the range (json_each
 * over every row of a long range would be unbounded); `sampled` says when that cap was hit.
 */

import { type DebugMode, debugFrag } from "../lib/query";
import type { PeriodParams, SiteSettings } from "../lib/types";
import { type Db, guard, num, periodOut, rangeFor } from "./common";

export const SCHEMA_SAMPLE_EVENTS = 20_000;
export const MAX_EVENT_NAMES = 200;
export const MAX_PROP_KEYS = 100;
const VALUE_CHARS = 100;

/** Names the tracker, the payments ledger or the server send by themselves. */
export const AUTOMATIC_EVENTS = new Set([
  "pageview",
  "outbound_click",
  "file_download",
  "404",
  "form_submit",
  "form_start",
  "element_view",
  "site_search",
  "payment",
  "renewal",
  "refund",
]);

const dbg = (mode: DebugMode | undefined, alias = "events") => {
  const f = debugFrag(mode, alias);
  return f ? ` AND ${f.sql}` : "";
};

export function eventNames(db: Db, start: number, end: number, limit = MAX_EVENT_NAMES, debug?: DebugMode) {
  return db
    .all(
      `SELECT name, COUNT(*) AS events, COUNT(DISTINCT CASE WHEN no_visit = 0 THEN visitor_id END) AS visitors, MAX(ts) AS last_seen_at
       FROM events WHERE ts >= ? AND ts < ?${dbg(debug)} GROUP BY name ORDER BY events DESC, name LIMIT ?`,
      [start, end, limit],
    )
    .map((r) => ({
      name: String(r.name),
      events: num(r.events),
      visitors: num(r.visitors),
      last_seen_at: num(r.last_seen_at),
      automatic: AUTOMATIC_EVENTS.has(String(r.name)),
    }));
}

export interface PropKeysOptions {
  eventName?: string;
  debug?: DebugMode;
  keys?: number;
  values?: number;
}

/** Prop keys with how often each appears, the event names that carry it and its most common values. */
export function propKeys(db: Db, start: number, end: number, o: PropKeysOptions = {}) {
  const sampleArgs = [start, end, ...(o.eventName ? [o.eventName] : []), SCHEMA_SAMPLE_EVENTS];
  const sample = `s AS (SELECT e.name, e.props FROM events e WHERE e.ts >= ? AND e.ts < ? AND e.props IS NOT NULL${dbg(o.debug, "e")}${
    o.eventName ? " AND e.name = ?" : ""
  } ORDER BY e.ts DESC LIMIT ?),
    kv AS (SELECT s.name AS name, j.key AS key, j.value AS value FROM s, json_each(s.props) j)`;
  const sampled = num(db.all(`WITH ${sample} SELECT (SELECT COUNT(*) FROM s) AS n`, sampleArgs)[0]?.n);
  const keys = db.all(
    `WITH ${sample} SELECT key, COUNT(*) AS n, COUNT(DISTINCT value) AS distinct_values FROM kv GROUP BY key ORDER BY n DESC, key LIMIT ?`,
    [...sampleArgs, o.keys ?? MAX_PROP_KEYS],
  );
  const list = JSON.stringify(keys.map((k) => String(k.key)));
  const top = (col: "value" | "name", per: number) => {
    const out = new Map<string, { value: string; count: number }[]>();
    if (!keys.length) return out;
    for (const r of db.all(
      `WITH ${sample},
       vc AS (SELECT key, ${col} AS v, COUNT(*) AS n FROM kv WHERE key IN (SELECT value FROM json_each(?)) GROUP BY key, ${col}),
       rk AS (SELECT key, v, n, ROW_NUMBER() OVER (PARTITION BY key ORDER BY n DESC, v) AS rn FROM vc)
       SELECT key, v, n FROM rk WHERE rn <= ? ORDER BY key, rn`,
      [...sampleArgs, list, per],
    )) {
      const k = String(r.key);
      out.set(k, [...(out.get(k) ?? []), { value: String(r.v ?? "").slice(0, VALUE_CHARS), count: num(r.n) }]);
    }
    return out;
  };
  const values = top("value", o.values ?? 5);
  const names = top("name", 3);
  return {
    props: keys.map((k) => {
      const key = String(k.key);
      return {
        key,
        events: num(k.n),
        distinct_values: num(k.distinct_values),
        event_names: (names.get(key) ?? []).map((x) => x.value),
        sample_values: values.get(key) ?? [],
      };
    }),
    sample_events: sampled,
    sampled: sampled >= SCHEMA_SAMPLE_EVENTS,
  };
}

export interface SchemaRequest extends PeriodParams {
  event_name?: string;
}

/** Event names and prop keys of the period (default 30 days). */
export function siteSchema(db: Db, settings: SiteSettings, q: SchemaRequest, now = Date.now()) {
  return guard(() => {
    const r = rangeFor(db, settings, q, now);
    return {
      period: periodOut(r),
      events: eventNames(db, r.start, r.end, MAX_EVENT_NAMES, q.debug),
      ...propKeys(db, r.start, r.end, { debug: q.debug }),
    };
  });
}

/** Prop keys only, optionally of one event name, with more sample values. */
export function listProps(db: Db, settings: SiteSettings, q: SchemaRequest & { limit?: number }, now = Date.now()) {
  return guard(() => {
    const r = rangeFor(db, settings, q, now);
    return {
      period: periodOut(r),
      event_name: q.event_name ?? null,
      ...propKeys(db, r.start, r.end, { eventName: q.event_name, keys: q.limit ?? MAX_PROP_KEYS, values: 10, debug: q.debug }),
    };
  });
}
