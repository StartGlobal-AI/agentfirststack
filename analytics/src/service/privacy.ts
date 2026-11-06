import { badRequest, parse } from "@afs/shared";
import { z } from "zod";
import { enforce } from "../lib/limits";
import { type Ctx, callSite, loadSite } from "./context";
import { hashCustomer } from "./payments";
import { filterShape, periodShape, periodOf, resolveFilters } from "./stats";

export const deleteVisitorInput = z.object({
  payments: z
    .enum(["unlink", "delete"])
    .optional()
    .describe(
      "unlink (default): keep the payment amounts and their channel/source in revenue, drop every link to the person; delete: remove their payments too.",
    ),
});

/**
 * Erase one person: a visitor id, user:<user_id> (with that user's anonymous pre-identify
 * sessions), or customer:<provider>:<customer_id> (the visitor behind that payment customer).
 */
export async function deleteVisitor(ctx: Ctx, siteId: string, key: string, raw: unknown) {
  const q = parse(deleteVisitorInput, raw);
  const site = await loadSite(ctx, siteId);
  let customerHash: string | null = null;
  if (key.startsWith("customer:")) {
    const m = /^customer:([a-z0-9_-]{1,40}):(.{1,200})$/i.exec(key);
    if (!m)
      throw badRequest(
        "Customer keys look like customer:<provider>:<customer_id>.",
        "Example: customer:stripe:cus_123 (the provider you recorded payments with: stripe, or the provider field of POST /payments).",
      );
    customerHash = await hashCustomer(site.id, m[1]!.toLowerCase(), m[2]!);
  } else if (!key || key.length > 205) throw badRequest("Pass a visitor id, user:<user_id> or customer:<provider>:<customer_id>.");
  const res = await callSite(ctx.env, site, (s) => s.deleteVisitor(key, { payments: q.payments ?? "unlink", customerHash }));
  return {
    site_id: site.id,
    visitor: key,
    deleted: res,
    note: "Gone from every report, list and SQL query now. Daily usage counts are not lowered (deleting data never gives back event budget). Events your site sends for this person later are stored again: stop identifying them at the source.",
  };
}

export const purgeInput = z.object({
  ...periodShape,
  ...filterShape,
  dry_run: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .describe("Default true: only count what matches. Pass false to delete (at most 50,000 events per call; `more` says to call again)."),
});

/** Delete events matching filters in a period (test traffic, a broken deploy). Dry run by default. */
export async function purgeEvents(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(purgeInput, raw);
  if (!q.filters?.trim() && !q.filters_json && !q.segment && q.debug !== "only" && q.debug !== "quarantined")
    throw badRequest(
      "A purge needs filters.",
      'Example: {"period":"7d","filters":"hostname==staging.example.com","dry_run":true} (filters_json, segment, or debug: only work too). To delete everything, DELETE /v1/sites/:id.',
    );
  if (!q.period && !q.from)
    throw badRequest("A purge needs a period or from/to.", 'Example: {"from":"2026-11-01","to":"2026-11-03","filters":"page~/test"}.');
  await enforce([[ctx.env.API_INGEST_LIMITER, `acct:${ctx.accountId}`]], "write requests", "Wait a minute and retry.");
  const site = await loadSite(ctx, siteId);
  const dryRun = q.dry_run === undefined ? true : q.dry_run === true || q.dry_run === "true";
  const { segment: _seg, ...f } = await resolveFilters(ctx, site.id, q);
  const res = await callSite(ctx.env, site, (s) => s.purge({ ...periodOf(q), ...f, dry_run: dryRun }));
  return {
    site_id: site.id,
    ...res,
    next_steps: dryRun
      ? ["Nothing was deleted. Check `matched`, then send the same request with dry_run: false."]
      : (res as { more?: boolean }).more
        ? ["More events match: send the same request again."]
        : ["Done. Daily usage counts are not lowered."],
  };
}
