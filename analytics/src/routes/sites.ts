import { parse } from "@afs/shared";
import { Hono } from "hono";
import { z } from "zod";
import { createAnnotation, deleteAnnotation, listAnnotations, updateAnnotation } from "../service/annotations";
import { createFunnel, deleteFunnel, listFunnels, updateFunnel } from "../service/funnels";
import { createGoal, deleteGoal, listGoals, updateGoal } from "../service/goals";
import { ingestServer } from "../service/ingest";
import { FRAMEWORKS } from "../service/install";
import { createShareLink, listShareLinks, revokeShareLinks } from "../service/share";
import { getMrr, listSubscriptions, recordSubscriptions } from "../service/subscriptions";
import { getItems } from "../service/items";
import { getRealtimeMap, listSessions } from "../service/reads";
import { getCrawlers, recordCrawls } from "../service/crawlers";
import { getAiSearch } from "../service/ai-search";
import { getWebVitals, getWebVitalsLab } from "../service/vitals";
import { exportBody, exportEvents } from "../service/export";
import { MAX_IMPORT_BYTES, compareImport, deleteImport, importData, listImports } from "../service/imports";
import { MAX_COST_CSV_BYTES, deleteCosts, listCosts, recordCosts } from "../service/costs";
import { readTextCapped } from "../lib/body";
import { connectBilling, disconnectBilling, getBillingIntegration } from "../service/billing-webhooks";
import { connectStripe, deletePayment, disconnectStripe, getStripeIntegration, listPayments, recordPayments } from "../service/payments";
import { getJourneys, getSession, getVisitor, listUserProps, listVisitors } from "../service/people";
import { createSite, deleteSite, getExclusions, getInstall, getSite, listSites, updateSite } from "../service/sites";
import {
  getAttribution,
  getBreakdown,
  getFunnel,
  getInsights,
  getMovers,
  getPaths,
  getRealtime,
  openRealtimeStream,
  getStats,
  getTimeseries,
  querySql,
} from "../service/stats";
import { verifyInstall } from "../service/verify";
import { getSchema, listProps } from "../service/schema";
import { deleteVisitor, purgeEvents } from "../service/privacy";
import { getQuarantine, purgeQuarantine, releaseQuarantine } from "../service/quarantine";
import { createDestination, deleteDestination, listDestinations, testDestination } from "../service/destinations";
import { alertHistory, createAlert, deleteAlert, getAlert, listAlerts, testAlert, updateAlert } from "../service/alerts";
import { createReport, deleteReport, getDigest, listReports, sendReport, updateReport } from "../service/reports";
import { createSegment, deleteSegment, listSegments, updateSegment } from "../service/segments";
import { getRetention } from "../service/retention";
import { connectStripeWithKey, restartBackfill } from "../service/stripe-connect";
import { body, ctxOf } from "./util";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { csvRows, toCsv } from "../lib/csv";

/** JSON, or CSV with format=csv / Accept: text/csv (REST only; errors stay JSON). */
function out(c: Context<AppEnv>, kind: "stats" | "breakdown" | "timeseries", res: Record<string, unknown>) {
  const csv = c.req.query("format") === "csv" || (c.req.header("accept") ?? "").includes("text/csv");
  if (!csv) return c.json(res);
  return c.body(toCsv(csvRows(kind, res)), 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${String(res.site_id ?? "site")}-${kind}.csv"`,
  });
}

/** /v1/sites/* — thin: parse, call the service, return JSON. Auth is applied by the parent app. */
export const siteRoutes = new Hono<AppEnv>();
const r = siteRoutes;

r.post("/", async (c) => {
  const res = await createSite(ctxOf(c), await body(c));
  return c.json(res, res.existing ? 200 : 201);
});
r.get("/", async (c) => c.json(await listSites(ctxOf(c))));
r.get("/:id", async (c) => c.json(await getSite(ctxOf(c), c.req.param("id"))));
r.patch("/:id", async (c) => c.json(await updateSite(ctxOf(c), c.req.param("id"), await body(c))));
r.delete("/:id", async (c) => c.json(await deleteSite(ctxOf(c), c.req.param("id"))));

r.get("/:id/install", async (c) => {
  const { framework } = parse(z.object({ framework: z.enum(FRAMEWORKS).optional() }), c.req.query());
  return c.json(await getInstall(ctxOf(c), c.req.param("id"), framework));
});
r.post("/:id/verify", async (c) => c.json(await verifyInstall(ctxOf(c), c.req.param("id"), await body(c))));
r.post("/:id/events", async (c) => {
  const validateOnly = ["true", "1"].includes(c.req.query("validate_only") ?? "");
  const res = await ingestServer(ctxOf(c), c.req.param("id"), await body(c), { validateOnly });
  return c.json(res, "validate_only" in res ? 200 : 202);
});

r.get("/:id/stats", async (c) => out(c, "stats", await getStats(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/breakdown", async (c) => out(c, "breakdown", await getBreakdown(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/timeseries", async (c) => out(c, "timeseries", await getTimeseries(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/realtime", async (c) => c.json(await getRealtime(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/realtime/stream", (c) => openRealtimeStream(ctxOf(c), c.req.param("id"), c.req.raw));
r.get("/:id/realtime/map", async (c) => c.json(await getRealtimeMap(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/sessions", async (c) => c.json(await listSessions(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/funnel", async (c) => c.json(await getFunnel(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/attribution", async (c) => c.json(await getAttribution(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/paths", async (c) => c.json(await getPaths(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/sql", async (c) => c.json(await querySql(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/movers", async (c) => c.json(await getMovers(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/insights", async (c) => c.json(await getInsights(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/schema", async (c) => c.json(await getSchema(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/props", async (c) => c.json(await listProps(ctxOf(c), c.req.param("id"), c.req.query())));

r.get("/:id/visitors", async (c) => c.json(await listVisitors(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/visitors/:visitor", async (c) => c.json(await getVisitor(ctxOf(c), c.req.param("id"), c.req.param("visitor"), c.req.query())));
r.delete("/:id/visitors/:visitor", async (c) =>
  c.json(await deleteVisitor(ctxOf(c), c.req.param("id"), c.req.param("visitor"), c.req.query())),
);
r.post("/:id/purge", async (c) => c.json(await purgeEvents(ctxOf(c), c.req.param("id"), await body(c))));
// Attack protection: what was quarantined, and the owner's decision about it.
r.get("/:id/quarantine", async (c) => c.json(await getQuarantine(ctxOf(c), c.req.param("id"), c.req.query())));
r.post("/:id/quarantine/release", async (c) => c.json(await releaseQuarantine(ctxOf(c), c.req.param("id"), await body(c))));
r.post("/:id/quarantine/purge", async (c) => c.json(await purgeQuarantine(ctxOf(c), c.req.param("id"), await body(c))));
r.get("/:id/sessions/:session_id", async (c) => c.json(await getSession(ctxOf(c), c.req.param("id"), c.req.param("session_id"))));
r.get("/:id/journeys", async (c) => c.json(await getJourneys(ctxOf(c), c.req.param("id"), c.req.query())));

r.get("/:id/integrations/stripe", async (c) => c.json(await getStripeIntegration(ctxOf(c), c.req.param("id"))));
r.post("/:id/integrations/stripe", async (c) => {
  const res = await connectStripe(ctxOf(c), c.req.param("id"), await body(c));
  return c.json(res, res.existing ? 200 : 201);
});
r.delete("/:id/integrations/stripe", async (c) => c.json(await disconnectStripe(ctxOf(c), c.req.param("id"))));
r.post("/:id/integrations/stripe/connect", async (c) => {
  const res = await connectStripeWithKey(ctxOf(c), c.req.param("id"), await body(c));
  return c.json(res, res.existing ? 200 : 201);
});
r.post("/:id/integrations/stripe/backfill", async (c) => c.json(await restartBackfill(ctxOf(c), c.req.param("id"), await body(c))));
// Polar, Paddle, LemonSqueezy (after the Stripe routes, which are more specific).
r.get("/:id/integrations/:provider", async (c) =>
  c.json(await getBillingIntegration(ctxOf(c), c.req.param("id"), c.req.param("provider"))),
);
r.post("/:id/integrations/:provider", async (c) => {
  const res = await connectBilling(ctxOf(c), c.req.param("id"), c.req.param("provider"), await body(c));
  return c.json(res, res.existing ? 200 : 201);
});
r.delete("/:id/integrations/:provider", async (c) => c.json(await disconnectBilling(ctxOf(c), c.req.param("id"), c.req.param("provider"))));
r.get("/:id/export", async (c) => {
  const res = await exportEvents(ctxOf(c), c.req.param("id"), c.req.query());
  const { body, type } = exportBody(res);
  return c.body(body, 200, {
    "content-type": type,
    "x-afs-rows": String(res.rows.length),
    ...(res.next_cursor ? { "x-afs-next-cursor": res.next_cursor } : {}),
    "x-afs-export-used-today": String(res.used_today),
  });
});
r.post("/:id/imports", async (c) => {
  const type = c.req.header("content-type") ?? "";
  const input = type.includes("text/csv")
    ? {
        csv: (await readTextCapped(c.req.raw.body, MAX_IMPORT_BYTES + 1)).text,
        source: c.req.query("source"),
        tool: c.req.query("tool"),
        kind: c.req.query("kind"),
        file_name: c.req.query("file_name"),
      }
    : // JSON rows and API reports run larger than other bodies: up to the import cap.
      await body(c, { maxBytes: MAX_IMPORT_BYTES, hint: "Split the import by date range and send each part." });
  const res = await importData(ctxOf(c), c.req.param("id"), input);
  return c.json(res, "existing" in res && res.existing ? 200 : 201);
});
r.get("/:id/imports", async (c) => c.json(await listImports(ctxOf(c), c.req.param("id"))));
r.get("/:id/imports/compare", async (c) => c.json(await compareImport(ctxOf(c), c.req.param("id"), c.req.query())));
r.delete("/:id/imports/:import_id", async (c) => c.json(await deleteImport(ctxOf(c), c.req.param("id"), c.req.param("import_id"))));
r.post("/:id/crawls", async (c) => c.json(await recordCrawls(ctxOf(c), c.req.param("id"), await body(c)), 202));
r.get("/:id/crawlers", async (c) => c.json(await getCrawlers(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/ai-search", async (c) => c.json(await getAiSearch(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/web-vitals", async (c) => c.json(await getWebVitals(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/web-vitals/lab", async (c) => c.json(await getWebVitalsLab(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/user-props", async (c) => c.json(await listUserProps(ctxOf(c), c.req.param("id"))));
r.get("/:id/items", async (c) => c.json(await getItems(ctxOf(c), c.req.param("id"), c.req.query())));
// Ad spend: JSON {costs:[...]} / {csv}, or a text/csv body.
r.post("/:id/costs", async (c) => {
  const type = c.req.header("content-type") ?? "";
  const input = type.includes("text/csv")
    ? { csv: (await readTextCapped(c.req.raw.body, MAX_COST_CSV_BYTES + 1)).text, currency: c.req.query("currency") }
    : await body(c);
  return c.json(await recordCosts(ctxOf(c), c.req.param("id"), input), 202);
});
r.get("/:id/costs", async (c) => c.json(await listCosts(ctxOf(c), c.req.param("id"), c.req.query())));
r.delete("/:id/costs", async (c) => c.json(await deleteCosts(ctxOf(c), c.req.param("id"), c.req.query())));
r.post("/:id/payments", async (c) => c.json(await recordPayments(ctxOf(c), c.req.param("id"), await body(c)), 202));
r.get("/:id/payments", async (c) => c.json(await listPayments(ctxOf(c), c.req.param("id"), c.req.query())));
r.post("/:id/subscriptions", async (c) => c.json(await recordSubscriptions(ctxOf(c), c.req.param("id"), await body(c)), 202));
r.get("/:id/subscriptions", async (c) => c.json(await listSubscriptions(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/mrr", async (c) => c.json(await getMrr(ctxOf(c), c.req.param("id"), c.req.query())));
r.delete("/:id/payments/:payment_id", async (c) => c.json(await deletePayment(ctxOf(c), c.req.param("id"), c.req.param("payment_id"))));

r.get("/:id/exclusions", async (c) =>
  c.json(await getExclusions(ctxOf(c), c.req.param("id"), c.req.query(), c.req.header("cf-connecting-ip") ?? null)),
);

r.post("/:id/annotations", async (c) => {
  const res = await createAnnotation(ctxOf(c), c.req.param("id"), await body(c));
  return c.json(res, res.existing ? 200 : 201);
});
r.get("/:id/annotations", async (c) => c.json(await listAnnotations(ctxOf(c), c.req.param("id"), c.req.query())));
r.patch("/:id/annotations/:annotation_id", async (c) =>
  c.json(await updateAnnotation(ctxOf(c), c.req.param("id"), c.req.param("annotation_id"), await body(c))),
);
r.delete("/:id/annotations/:annotation_id", async (c) =>
  c.json(await deleteAnnotation(ctxOf(c), c.req.param("id"), c.req.param("annotation_id"))),
);

r.post("/:id/funnels", async (c) => {
  const res = await createFunnel(ctxOf(c), c.req.param("id"), await body(c));
  return c.json(res, res.existing ? 200 : 201);
});
r.get("/:id/funnels", async (c) => c.json(await listFunnels(ctxOf(c), c.req.param("id"))));
r.get("/:id/funnels/:funnel_id", async (c) =>
  c.json(await getFunnel(ctxOf(c), c.req.param("id"), { ...c.req.query(), funnel_id: c.req.param("funnel_id") })),
);
r.patch("/:id/funnels/:funnel_id", async (c) =>
  c.json(await updateFunnel(ctxOf(c), c.req.param("id"), c.req.param("funnel_id"), await body(c))),
);
r.delete("/:id/funnels/:funnel_id", async (c) => c.json(await deleteFunnel(ctxOf(c), c.req.param("id"), c.req.param("funnel_id"))));

r.post("/:id/goals", async (c) => {
  const res = await createGoal(ctxOf(c), c.req.param("id"), await body(c));
  return c.json(res, res.existing ? 200 : 201);
});
r.get("/:id/goals", async (c) => c.json(await listGoals(ctxOf(c), c.req.param("id"))));
r.patch("/:id/goals/:goal_id", async (c) => c.json(await updateGoal(ctxOf(c), c.req.param("id"), c.req.param("goal_id"), await body(c))));
r.delete("/:id/goals/:goal_id", async (c) => c.json(await deleteGoal(ctxOf(c), c.req.param("id"), c.req.param("goal_id"))));

r.post("/:id/share", async (c) => {
  const res = await createShareLink(ctxOf(c), c.req.param("id"), await body(c));
  return c.json(res, res.existing ? 200 : 201);
});
r.delete("/:id/share", async (c) => c.json(await revokeShareLinks(ctxOf(c), c.req.param("id"), c.req.query("token"))));
r.get("/:id/share", async (c) => c.json(await listShareLinks(ctxOf(c), c.req.param("id"))));

r.post("/:id/destinations", async (c) => {
  const res = await createDestination(ctxOf(c), c.req.param("id"), await body(c));
  return c.json(res, res.existing ? 200 : 201);
});
r.get("/:id/destinations", async (c) => c.json(await listDestinations(ctxOf(c), c.req.param("id"))));
r.delete("/:id/destinations/:destination_id", async (c) =>
  c.json(await deleteDestination(ctxOf(c), c.req.param("id"), c.req.param("destination_id"))),
);
r.post("/:id/destinations/:destination_id/test", async (c) =>
  c.json(await testDestination(ctxOf(c), c.req.param("id"), c.req.param("destination_id"))),
);

r.post("/:id/alerts", async (c) => {
  const res = await createAlert(ctxOf(c), c.req.param("id"), await body(c));
  return c.json(res, res.existing ? 200 : 201);
});
r.get("/:id/alerts", async (c) => c.json(await listAlerts(ctxOf(c), c.req.param("id"))));
r.get("/:id/alerts/:alert_id", async (c) => c.json(await getAlert(ctxOf(c), c.req.param("id"), c.req.param("alert_id"), c.req.query())));
r.patch("/:id/alerts/:alert_id", async (c) =>
  c.json(await updateAlert(ctxOf(c), c.req.param("id"), c.req.param("alert_id"), await body(c))),
);
r.delete("/:id/alerts/:alert_id", async (c) => c.json(await deleteAlert(ctxOf(c), c.req.param("id"), c.req.param("alert_id"))));
r.post("/:id/alerts/:alert_id/test", async (c) => c.json(await testAlert(ctxOf(c), c.req.param("id"), c.req.param("alert_id"))));
r.get("/:id/alerts/:alert_id/history", async (c) =>
  c.json(await alertHistory(ctxOf(c), c.req.param("id"), c.req.param("alert_id"), c.req.query())),
);
r.get("/:id/deliveries", async (c) => c.json(await alertHistory(ctxOf(c), c.req.param("id"), null, c.req.query())));

r.get("/:id/retention", async (c) => c.json(await getRetention(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/digest", async (c) => c.json(await getDigest(ctxOf(c), c.req.param("id"), c.req.query())));
r.post("/:id/reports", async (c) => {
  const res = await createReport(ctxOf(c), c.req.param("id"), await body(c));
  return c.json(res, res.existing ? 200 : 201);
});
r.get("/:id/reports", async (c) => c.json(await listReports(ctxOf(c), c.req.param("id"))));
r.patch("/:id/reports/:report_id", async (c) =>
  c.json(await updateReport(ctxOf(c), c.req.param("id"), c.req.param("report_id"), await body(c))),
);
r.delete("/:id/reports/:report_id", async (c) => c.json(await deleteReport(ctxOf(c), c.req.param("id"), c.req.param("report_id"))));
r.post("/:id/reports/:report_id/send", async (c) => c.json(await sendReport(ctxOf(c), c.req.param("id"), c.req.param("report_id"))));

r.post("/:id/segments", async (c) => {
  const res = await createSegment(ctxOf(c), c.req.param("id"), await body(c));
  return c.json(res, res.existing ? 200 : 201);
});
r.get("/:id/segments", async (c) => c.json(await listSegments(ctxOf(c), c.req.param("id"))));
r.patch("/:id/segments/:segment_id", async (c) =>
  c.json(await updateSegment(ctxOf(c), c.req.param("id"), c.req.param("segment_id"), await body(c))),
);
r.delete("/:id/segments/:segment_id", async (c) => c.json(await deleteSegment(ctxOf(c), c.req.param("id"), c.req.param("segment_id"))));
