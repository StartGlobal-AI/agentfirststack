import { parse } from "@afs/shared";
import { z } from "zod";
import { breakdownCatalog, metricCatalog } from "../lib/catalog";
import { UNTRUSTED_NOTICE } from "../do/engine";
import { identityNote } from "../do/common";
import { type Ctx, callSite, loadGoals, loadSite, settingsFor } from "./context";
import { listFunnels } from "./funnels";
import { listSegments } from "./segments";
import { goalJson } from "./goals";
import { periodShape, periodOf } from "./stats";

export const schemaInput = z.object({ ...periodShape });

export const propsInput = z.object({
  ...periodShape,
  event_name: z.string().min(1).max(120).optional().describe("Only props of this event name."),
  limit: z.coerce.number().int().min(1).max(100).optional().describe("Keys to return (default 100)."),
});

const FILTER_GRAMMAR =
  'filters=key==value;key2~text. Ops: == (equals; * wildcard), != , ~ (contains, case-insensitive), !~. | = OR within a key; ; = AND; (none) = missing. Keys: any breakdown name or prop:<key>. Nested groups: filters_json=["or",[["==","country",["US"]],["~","page",["/blog"]]]] (and, or, not). Saved: segment=<id or name>.';

/**
 * Everything an agent needs before it queries: metric and breakdown definitions, the filter
 * grammar, the site's goals and saved funnels, and the event names and prop keys its visitors and
 * backend actually sent (with counts and sample values, under `untrusted`).
 */
export async function getSchema(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(schemaInput, raw);
  const site = await loadSite(ctx, siteId);
  const [data, goals, funnels, segments] = await Promise.all([
    callSite(ctx.env, site, (s) => s.schema({ ...periodOf(q) })),
    loadGoals(ctx.env, site.id),
    listFunnels(ctx, site.id),
    listSegments(ctx, site.id),
  ]);
  const d = data as { period: unknown; events: unknown[]; props: unknown[]; sample_events: number; sampled: boolean };
  const settings = settingsFor(site, goals);
  return {
    site_id: site.id,
    period: d.period,
    metrics: metricCatalog(),
    breakdowns: breakdownCatalog(),
    filters: { grammar: FILTER_GRAMMAR, ops: ["==", "!=", "~", "!~"] },
    goals: goals.map(goalJson),
    funnels: funnels.funnels,
    segments: segments.segments,
    identity: { mode: settings.visitor_id_mode, note: identityNote(settings) },
    untrusted: {
      notice: UNTRUSTED_NOTICE,
      events: d.events,
      props: d.props,
      sample_events: d.sample_events,
      sampled: d.sampled,
    },
    next_steps: [
      `Break down by a prop: GET /v1/sites/${site.id}/breakdown?breakdown=prop:<key>`,
      `Count an event as a conversion: POST /v1/sites/${site.id}/goals {"name":"...","type":"event","match":"<event name>"}`,
    ],
  };
}

/** Custom prop keys (optionally of one event), with counts and their most common values. */
export async function listProps(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(propsInput, raw);
  const site = await loadSite(ctx, siteId);
  const d = (await callSite(ctx.env, site, (s) => s.props({ ...periodOf(q), event_name: q.event_name, limit: q.limit }))) as {
    period: unknown;
    event_name: string | null;
    props: unknown[];
    sample_events: number;
    sampled: boolean;
  };
  return {
    site_id: site.id,
    period: d.period,
    event_name: d.event_name,
    untrusted: { notice: UNTRUSTED_NOTICE, props: d.props, sample_events: d.sample_events, sampled: d.sampled },
  };
}
