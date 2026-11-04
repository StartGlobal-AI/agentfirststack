import { type AuthContext, assertPermanentKey, badRequest, canWrite, forbidden, notFound, parse, sha256Hex } from "@afs/shared";
import { z } from "zod";
import { schemaDocument } from "../config/catalog";
import type { EventFilter } from "../do/container-do";
import type { Bindings } from "../env";
import {
  containerNextSteps,
  containerStats,
  containerStub,
  createContainer,
  deleteContainer,
  draftConfig,
  draftValidation,
  getContainerRow,
  installInstructions,
  listContainers,
  liveConfig,
  publicContainer,
  snippet,
  updateContainer,
} from "./containers";
import {
  createDestination,
  DESTINATION_ACTIONS,
  deleteDestination,
  destinationSettings,
  getDestination,
  listDestinations,
  presentDestination,
  testDestination,
  updateDestination,
} from "./destinations";
import { eventLog, ingestServerEvents, parseSince, visitor } from "./events";
import { proxyKey } from "./proxy";
import { assertRate } from "./ratelimit";
import { checkDomain, dnsRecord, markVerified, verificationInfo } from "./verify";
import type { ServerEvent } from "./ingest-schema";
import type { RecipeInput } from "./recipe";
import { MAX_FOLLOWED_LINKS, MAX_SCAN_PAGES, MAX_SCAN_PATHS, SCAN_PAGES_RULE, scanSite } from "./scan";
import { applyRecipe } from "./setup";
import {
  createPreview,
  createVersion,
  getDraft,
  getVersion,
  listVersions,
  patchDraft,
  publish,
  putDraft,
  rollback,
  validateDraft,
} from "./versions";
import {
  createEnvironment,
  deleteEnvironment,
  environmentInput,
  environmentPatch,
  getEnvironment,
  listEnvironments,
  presentEnvironment,
  reauthorizeEnvironment,
  updateEnvironment,
} from "./environments";
import { shownCap, utcDay } from "./limits";
import { deleteLookup, getLookup, listLookups, lookupInput, putLookup } from "./lookups";
import {
  changesVsLive,
  type DraftEditResult,
  diffVersions,
  getDraftItem,
  parseKind,
  parseRef,
  removeDraftItem,
  revertDraftItem,
  upsertDraftItem,
} from "./draft-items";
import { KEY_FIELD, type ItemKind } from "../config/diff";
import { type ImportInput, importDraft } from "./import";

/**
 * Every operation, shaped for agents (the thing needed next + next_steps). REST routes and MCP
 * tools both call these, so the two surfaces always return the same JSON.
 */
export interface OpCtx {
  env: Bindings;
  auth: AuthContext;
  /** Public base URL of this deployment. */
  base: string;
  /** Origins whose edge cache should be purged on publish. */
  origins: string[];
}

export const containerInput = z.strictObject({
  domain: z.string().min(1).max(253).describe("The site's domain, e.g. example.com (scheme/path/www are stripped)."),
  name: z.string().max(200).optional(),
  allowed_hostnames: z
    .array(z.string().max(253))
    .max(50)
    .optional()
    .describe("Extra hostnames allowed to send hits (staging, localhost). The domain and its subdomains are always allowed."),
});
export const containerPatch = z.strictObject({
  name: z.string().max(200).nullable().optional(),
  allowed_hostnames: z.array(z.string().max(253)).max(50).optional(),
});
export const destinationInput = z.strictObject({
  type: z.string().describe("ga4 | meta | google_ads | tiktok | linkedin | pinterest | reddit | snap | x | analytics | webhook"),
  name: z.string().max(200).optional(),
  credentials: z.record(z.string(), z.unknown()).describe("Per type; GET /v1/schema -> destinations.<type>.credentials_schema."),
  settings: destinationSettings.optional(),
  enabled: z.boolean().optional(),
});
export const destinationPatch = z.strictObject({
  name: z.string().max(200).nullable().optional(),
  credentials: z.record(z.string(), z.unknown()).optional().describe("Only the fields to change; null removes an optional field."),
  settings: destinationSettings.optional(),
  enabled: z.boolean().optional(),
});
export const testInput = z.strictObject({
  event_name: z.string().max(40).optional(),
  test_event_code: z.string().max(60).optional().describe("Meta/TikTok test_event_code, or Reddit test_id (Events Manager)."),
  send_to: z
    .strictObject({
      linkedin: z.strictObject({ conversion_id: z.string().regex(/^\d{3,15}$/) }).optional(),
      x: z.strictObject({ event_id: z.string().regex(/^tw-[a-z0-9]+-[a-z0-9]+$/) }).optional(),
    })
    .optional()
    .describe(
      "Accepted for older clients, no longer needed: LinkedIn and X have no test mode, so their tests answer 400 no_test_mode and send nothing.",
    ),
});
export const scanInput = z.strictObject({
  url: z.string().max(2048).optional().describe("https page to scan (on the container's domain, default port). Default https://<domain>/."),
  paths: z
    .array(z.string().max(500))
    .max(MAX_SCAN_PATHS, `At most ${MAX_SCAN_PATHS} paths. ${SCAN_PAGES_RULE}`)
    .optional()
    .describe(
      `Extra paths to scan, at most ${MAX_SCAN_PATHS}, e.g. ['/contact', '/checkout']: the homepage (or url) is always scanned too, ${MAX_SCAN_PAGES} pages in all.`,
    ),
  follow_links: z
    .boolean()
    .optional()
    .describe(
      `Also scan up to ${MAX_FOLLOWED_LINKS} linked contact/signup/pricing pages (default true), only into the ${MAX_SCAN_PAGES}-page room the homepage and paths leave.`,
    ),
});

/**
 * The scan body. Too many paths is answered with the rule itself in the hint (REST); MCP clients
 * see maxItems in the tool schema and the same rule in the validation message.
 */
export function readScanInput(raw: unknown): z.infer<typeof scanInput> {
  const paths = raw && typeof raw === "object" ? (raw as { paths?: unknown }).paths : undefined;
  if (Array.isArray(paths) && paths.length > MAX_SCAN_PATHS)
    throw badRequest(`paths has ${paths.length} entries; at most ${MAX_SCAN_PATHS} are allowed.`, SCAN_PAGES_RULE, [
      { path: "paths", message: `At most ${MAX_SCAN_PATHS} paths (the homepage or url is the ${MAX_SCAN_PAGES}th page).` },
    ]);
  return parse(scanInput, raw);
}
export const verifyInput = z.strictObject({
  method: z
    .enum(["auto", "dns", "snippet"])
    .optional()
    .describe(
      "dns: the _afs-verify TXT record; snippet: this container's <script> on https://<domain>/; auto (default): dns, then snippet.",
    ),
});
export const eventsQuery = z.object({
  name: z.string().max(64).optional(),
  status: z.enum(["logged", "pending", "delivered", "partial", "failed", "skipped"]).optional(),
  source: z.enum(["browser", "server"]).optional(),
  since: z.string().max(40).optional().describe('unix ms, ISO 8601 or relative ("15m", "2h", "7d")'),
  before: z.coerce.number().optional().describe("Cursor: next_before from the previous page."),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  include_visits: z.union([z.boolean(), z.enum(["true", "false", "1", "0"])]).optional(),
  verbose: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .optional()
    .describe("Include the exact request sent to each destination."),
});

const truthy = (v: unknown) => v === true || v === "true" || v === "1";

export const ops = {
  schema: () => schemaDocument(),

  async createContainer(o: OpCtx, input: z.infer<typeof containerInput>) {
    const { row, existing } = await createContainer(o.env, o.auth.accountId, input);
    return {
      status: existing ? 200 : 201,
      body: {
        container: publicContainer(row, o.base),
        existing,
        // The proxy key stays out of this answer: GET /install?proxy=1 returns it when a proxy is set up.
        install: installInstructions(o.base, row),
        next_steps: containerNextSteps(row.id, existing, row.live_version != null),
      },
    };
  },

  async listContainers(o: OpCtx) {
    return { containers: (await listContainers(o.env, o.auth.accountId)).map((r) => publicContainer(r, o.base)) };
  },

  async getContainer(o: OpCtx, id: string) {
    const row = await getContainerRow(o.env, o.auth.accountId, id);
    const dest = await listDestinations(o.env, o.auth.accountId, id);
    const stats = (await containerStats(o.env, id)) as Record<string, unknown> & {
      storage?: { full: boolean };
      quota_reached?: boolean;
      account_quota_reached?: boolean;
      platform_quota_reached?: boolean;
    };
    const warnings: string[] = [];
    if (stats.storage?.full)
      warnings.push("The container's event store is full: /collect hits aren't stored until old rows are purged (daily).");
    if (stats.quota_reached) warnings.push("Today's browser event quota is used up: /collect hits are dropped until 00:00 UTC.");
    if (stats.account_quota_reached)
      warnings.push(
        "The account's daily event budget (across its containers) is used up for browser hits or backend events (stats.today.account): they're refused until 00:00 UTC.",
      );
    if (stats.platform_quota_reached)
      warnings.push("This service's daily event budget is used up for browser hits or backend events: they're refused until 00:00 UTC.");
    for (const d of dest.map(presentDestination))
      if (d.health.circuit === "open")
        warnings.push(`Destination ${d.id} (${d.type}) has an open circuit after repeated failures; fix it and run its test.`);
    const live = await liveConfig(o.env, row);
    return {
      container: publicContainer(row, o.base),
      verification: { ...verificationInfo(row), dns_record: await dnsRecord(o.env, row), verify: `POST /v1/containers/${id}/verify` },
      privacy: {
        // settings.respect_dnt: the live version's (null = nothing published yet) and the draft's.
        respect_dnt: { live: live ? live.settings?.respect_dnt !== false : null, draft: draftConfig(row).settings?.respect_dnt !== false },
        note: "With respect_dnt on (the default), the snippet does nothing in a browser sending Global Privacy Control or Do Not Track: no tags, no /collect hits, no cookies. Change it with PATCH /draft { settings: { respect_dnt: false } } and publish.",
      },
      destinations: dest.map(presentDestination),
      stats,
      ...(warnings.length ? { warnings } : {}),
      next_steps:
        row.live_version == null
          ? containerNextSteps(id, false, false)
          : [
              `GET /v1/containers/${id}/events shows recent conversions and their delivery.`,
              `PATCH /v1/containers/${id}/draft then POST /publish to change tags.`,
            ],
    };
  },

  async updateContainer(o: OpCtx, id: string, input: z.infer<typeof containerPatch>) {
    return { container: publicContainer(await updateContainer(o.env, o.auth.accountId, id, input), o.base) };
  },

  async deleteContainer(o: OpCtx, id: string) {
    await deleteContainer(o.env, o.auth.accountId, id);
    return { deleted: id, note: "The snippet now serves a 404 comment; remove it from the site." };
  },

  async install(o: OpCtx, id: string, opts: { proxy?: boolean } = {}) {
    const row = await getContainerRow(o.env, o.auth.accountId, id);
    if (!opts.proxy) return { container_id: id, ...installInstructions(o.base, row) };
    // The proxy key lets a request set the visitor IP /collect sends on: full-access keys only.
    if (!canWrite(o.auth))
      throw forbidden(
        "The proxy configs carry the container's proxy key, which read-only keys can't see.",
        `Use a key with scope "*" for GET /v1/containers/${id}/install?proxy=1, or leave proxy out for the snippet and the rest.`,
      );
    return { container_id: id, ...installInstructions(o.base, row, { key: await proxyKey(o.env, row.id) }) };
  },

  async scan(o: OpCtx, id: string, input: z.infer<typeof scanInput>) {
    const row = await getContainerRow(o.env, o.auth.accountId, id);
    await assertRate(
      o.env.SCAN_LIMITER,
      o.auth.accountId,
      "scans",
      "Scans and verifications are rate limited per account; retry in a minute.",
    );
    const r = await scanSite(row.domain, id, input);
    // The snippet on https://<domain>/ proves control of the domain (needed to publish custom code).
    let verified_at = row.verified_at ?? null;
    if (r.snippet_on_homepage && !verified_at) verified_at = await markVerified(o.env, id, "snippet");
    return {
      ...r,
      domain_verified: !!verified_at,
      next_steps: [
        ...(r.container_installed ? [] : [`Install the snippet: ${snippet(o.base, row.id)}`]),
        `Review suggested_config, fill in what's missing, then PUT /v1/containers/${id}/draft (or use setup_conversion_tracking).`,
      ],
    };
  },

  async verify(o: OpCtx, id: string, input: z.infer<typeof verifyInput>) {
    const row = await getContainerRow(o.env, o.auth.accountId, id);
    const dns_record = await dnsRecord(o.env, row);
    if (row.verified_at) return { container_id: id, ...verificationInfo(row), dns_record, checks: [], next_steps: ["Already verified."] };
    await assertRate(
      o.env.SCAN_LIMITER,
      o.auth.accountId,
      "verifications",
      "Scans and verifications are rate limited per account; retry in a minute.",
    );
    const r = await checkDomain(o.env, row, input.method ?? "auto");
    if (r.verified) {
      const at = await markVerified(o.env, id, r.verified);
      return {
        container_id: id,
        verified: true,
        method: r.verified,
        verified_at: at,
        dns_record,
        checks: r.checks,
        next_steps: [`Custom code (custom_html, custom_js) can now be published on ${row.domain} (POST /v1/containers/${id}/publish).`],
      };
    }
    return {
      container_id: id,
      verified: false,
      method: null,
      verified_at: null,
      dns_record,
      checks: r.checks,
      next_steps: [
        ...(dns_record
          ? [`Add a DNS TXT record ${dns_record.name} = "${dns_record.value}", wait for it to resolve, then verify again.`]
          : []),
        `Or install the snippet on https://${row.domain}/ (${snippet(o.base, id)}) and verify again (or run scan).`,
      ],
    };
  },

  async getDraft(o: OpCtx, id: string) {
    const r = await getDraft(o.env, o.auth.accountId, id);
    return {
      container_id: id,
      revision: r.row.draft_revision,
      updated_at: r.row.draft_updated_at,
      config: r.config,
      validation: r.validation,
      changes_vs_live: await changesVsLive(o.env, r.row, r.config),
    };
  },

  async getDraftItem(o: OpCtx, id: string, kind: string, key: string) {
    const k = parseKind(kind);
    const r = await getDraftItem(o.env, o.auth.accountId, id, k, key);
    return {
      container_id: id,
      kind: k,
      key,
      revision: r.row.draft_revision,
      item: r.item,
      in_live: r.in_live,
      differs_from_live: r.differs_from_live,
    };
  },

  async upsertDraftItem(o: OpCtx, id: string, kind: string, key: string | undefined, item: unknown, revision?: number) {
    const k = parseKind(kind);
    const field = KEY_FIELD[k];
    const name = key ?? (item && typeof item === "object" ? (item as Record<string, unknown>)[field] : undefined);
    if (typeof name !== "string" || !name)
      throw badRequest(`Which ${k} item? Pass key, or set ${field} in the item.`, `e.g. { "kind": "${k}", "item": { "${field}": "..." } }`);
    const r = await upsertDraftItem(o.env, o.auth.accountId, id, k, name, item, revision);
    return itemResponse(o, id, k, name, r, { created: r.result.created, unchanged: !r.written });
  },

  async removeDraftItem(o: OpCtx, id: string, kind: string, key: string, revision?: number) {
    const k = parseKind(kind);
    const r = await removeDraftItem(o.env, o.auth.accountId, id, k, key, revision);
    return itemResponse(o, id, k, key, r, {
      removed: r.result.removed,
      ...(r.result.removed ? {} : { note: `No ${k} item "${key}" was in the draft; nothing changed.` }),
    });
  },

  async revertDraftItem(o: OpCtx, id: string, kind: string, key: string, revision?: number) {
    const k = parseKind(kind);
    const r = await revertDraftItem(o.env, o.auth.accountId, id, k, key, revision);
    const how = {
      restored: `Copied from live version ${r.result.live_version}.`,
      removed:
        r.result.live_version == null
          ? "Nothing is published, so the item was removed from the draft."
          : `The live version (${r.result.live_version}) has no ${k} item "${key}", so it was removed from the draft.`,
      unchanged: "The draft item already matches the live version.",
    }[r.result.reverted];
    return itemResponse(o, id, k, key, r, { reverted: r.result.reverted, note: how });
  },

  async importDraft(o: OpCtx, id: string, input: ImportInput, revision?: number) {
    const r = await importDraft(o.env, o.auth.accountId, id, input, revision);
    const report = r.report
      ? { ...r.report, totals: { mapped: r.report.mapped.length, adapted: r.report.adapted.length, unmapped: r.report.unmapped.length } }
      : undefined;
    return {
      container_id: id,
      dry_run: r.dry_run,
      written: r.written,
      revision: r.row.draft_revision,
      format: r.format,
      mode: r.mode,
      on_conflict: r.on_conflict,
      summary: r.changes.summary,
      counts: r.counts,
      ...(report ? { report } : {}),
      changes: r.changes.changes,
      validation: r.validation,
      ...(r.dry_run ? { config: r.config } : {}),
      next_steps: [
        ...(r.dry_run ? [`Looks right? Send the same body without dry_run to save it (POST /v1/containers/${id}/draft/import).`] : []),
        ...(report?.unmapped.length ? ["report.unmapped lists what wasn't imported, each with the reason and what to use instead."] : []),
        ...(r.format === "gtm"
          ? [
              "GTM has no conversions: add conversions[] (PUT /draft/conversions/:name) for purchases and leads so pixels and conversion APIs share one event_id.",
            ]
          : []),
        r.validation.valid
          ? `POST /v1/containers/${id}/preview to try it on the site, then POST /v1/containers/${id}/publish.`
          : "Fix validation.errors (each has a hint) before publishing.",
      ],
    };
  },

  async diff(o: OpCtx, id: string, q: { from?: string; to?: string }) {
    const r = await diffVersions(o.env, o.auth.accountId, id, parseRef(q.from, "live"), parseRef(q.to, "draft"));
    return {
      container_id: id,
      from: r.from,
      to: r.to,
      ...(r.nothing_published && (r.from.ref === "live" || r.to.ref === "live")
        ? { note: "Nothing is published yet, so live is an empty config." }
        : {}),
      ...r.diff,
      next_steps: r.diff.identical
        ? ["Nothing to publish: the two configs are the same."]
        : [`POST /v1/containers/${id}/publish publishes the draft; POST /v1/containers/${id}/draft/:kind/:key/revert undoes one item.`],
    };
  },

  async putDraft(o: OpCtx, id: string, body: unknown, revision?: number) {
    const r = await putDraft(o.env, o.auth.accountId, id, body, revision);
    return draftResponse(id, r.row.draft_revision, r.config, r.validation);
  },

  async patchDraft(o: OpCtx, id: string, body: unknown, revision?: number) {
    const r = await patchDraft(o.env, o.auth.accountId, id, body, revision);
    return draftResponse(id, r.row.draft_revision, r.config, r.validation);
  },

  async validate(o: OpCtx, id: string, config?: unknown) {
    const v = await validateDraft(o.env, o.auth.accountId, id, config);
    return {
      container_id: id,
      ...v,
      next_steps: v.valid
        ? [`POST /v1/containers/${id}/preview to test, then POST /v1/containers/${id}/publish.`]
        : ["Fix errors (each has a hint), then validate again."],
    };
  },

  async preview(o: OpCtx, id: string, input: { ttl_minutes?: number; path?: string; version?: number }) {
    const r = await createPreview(o.env, o.auth.accountId, id, input);
    const sep = r.path.includes("?") ? "&" : "?";
    return {
      token: r.token,
      expires_at: r.expires_at,
      shows: r.version ? `version ${r.version}` : "the draft",
      log_url: `${o.base}/v1/containers/${id}/preview/${r.token}/log`,
      preview_url: `https://${r.row.domain}${r.path}${sep}afst_preview=${r.token}`,
      script_url: `${o.base}/c/${id}.js?preview=${r.token}`,
      how_it_works:
        "Open preview_url in a browser: the installed live snippet sees afst_preview, remembers it for the tab (sessionStorage) and loads the DRAFT with console debug logging. Preview conversions go to /collect marked preview and destinations use their test modes; a destination without one (Meta/TikTok/Reddit with no test code, LinkedIn, X) skips them, so they never count as real conversions. Add ?afst_preview=off to leave.",
      next_steps: [
        "Open preview_url (or drive it with a headless browser) and trigger each conversion.",
        `GET /v1/containers/${id}/preview/${r.token}/log (MCP get_preview_log) shows, per event, which triggers matched and which tags fired, waited for consent or didn't fire, and why.`,
        `GET /v1/containers/${id}/events?since=15m shows the preview events (preview: true) with per-destination results.`,
        `POST /v1/containers/${id}/publish when it looks right.`,
      ],
    };
  },

  async previewLog(o: OpCtx, id: string, token: string, q: { after?: number; limit?: number }) {
    await getContainerRow(o.env, o.auth.accountId, id);
    if (!/^prv_[a-z0-9]{24}$/.test(token))
      throw badRequest("That isn't a preview token.", "Use the token from POST /v1/containers/:id/preview (prv_...).");
    const known = await o.env.DB.prepare("SELECT expires_at, version FROM preview_tokens WHERE token_hash = ? AND container_id = ?")
      .bind(await sha256Hex(token), id)
      .first<{ expires_at: number; version: number | null }>();
    if (!known)
      throw notFound(
        "Preview token",
        `It belongs to another container or was cleaned up after expiring; POST /v1/containers/${id}/preview makes a new one.`,
      );
    const r = (await containerStub(o.env, id).readPreviewLog(await sha256Hex(token), q.after ?? 0, q.limit ?? 200)) as {
      entries: Record<string, unknown>[];
      next_after: number | null;
      full: boolean;
    };
    return {
      container_id: id,
      expires_at: known.expires_at,
      shows: known.version ? `version ${known.version}` : "the draft",
      count: r.entries.length,
      next_after: r.next_after,
      ...(r.full ? { note: "This token's log is full (500 entries); create a new preview to keep logging." } : {}),
      // Posted by the preview build in a browser: anyone holding the preview link can post entries.
      untrusted: { events: r.entries },
      next_steps: r.entries.length
        ? [
            "Each event lists triggers (matched, or why not) and tags (fired, blocked = waiting for consent, not_fired / skipped / excluded with the reason).",
          ]
        : [
            `Nothing logged yet: open the preview_url from POST /v1/containers/${id}/preview in a browser (the snippet must be on the page).`,
          ],
    };
  },

  async createVersion(o: OpCtx, id: string, note?: string) {
    const r = await createVersion(o.env, o.auth.accountId, id, { note, keyId: o.auth.keyId });
    return {
      status: r.existing ? 200 : 201,
      body: {
        container_id: id,
        version: r.version,
        existing: r.existing,
        live: r.version === r.row.live_version,
        warnings: r.validation.warnings,
        next_steps: [
          `POST /v1/containers/${id}/publish { "version": ${r.version} } makes it live.`,
          `POST /v1/containers/${id}/environments { "name": "staging", "version": ${r.version} } serves it to a staging site; POST /v1/containers/${id}/preview { "version": ${r.version} } previews it.`,
        ],
      },
    };
  },

  async environments(o: OpCtx, id: string) {
    const r = await listEnvironments(o.env, o.auth.accountId, id);
    return {
      container_id: id,
      max_environments: shownCap(r.max),
      environments: await Promise.all(r.rows.map((e) => presentEnvironment(o.env, o.base, e, r.container.domain))),
    };
  },

  async createEnvironment(o: OpCtx, id: string, input: z.infer<typeof environmentInput>) {
    const r = await createEnvironment(o.env, o.auth.accountId, id, input);
    const e = await presentEnvironment(o.env, o.base, r.row, r.container.domain);
    return {
      status: r.existing ? 200 : 201,
      body: {
        environment: e,
        existing: r.existing,
        ...(r.existing && (r.row.version ?? "draft") !== input.version
          ? {
              note: `It already exists and serves ${r.row.version ? `version ${r.row.version}` : "the draft"}; PATCH it with { "version": ${JSON.stringify(input.version)} } to change that.`,
            }
          : {}),
        next_steps: [
          `Install ${e.snippet} on the ${e.name} site instead of the live snippet.`,
          `PATCH /v1/containers/${id}/environments/${e.id} { "version": <n> } publishes another version to it.`,
        ],
      },
    };
  },

  async getEnvironment(o: OpCtx, id: string, eid: string) {
    const r = await getEnvironment(o.env, o.auth.accountId, id, eid);
    return { environment: await presentEnvironment(o.env, o.base, r.row, r.container.domain) };
  },

  async updateEnvironment(o: OpCtx, id: string, eid: string, input: z.infer<typeof environmentPatch>) {
    const r = await updateEnvironment(o.env, o.auth.accountId, id, eid, input);
    return {
      environment: await presentEnvironment(o.env, o.base, r.row, r.container.domain),
      note: "Browsers pick up the change within a minute (the environment script is cached for 60 s).",
    };
  },

  async reauthorizeEnvironment(o: OpCtx, id: string, eid: string) {
    const r = await reauthorizeEnvironment(o.env, o.auth.accountId, id, eid);
    return {
      environment: await presentEnvironment(o.env, o.base, r.row, r.container.domain),
      note: "The old snippet now loads the live container. Install the new snippet on the environment's site.",
    };
  },

  async deleteEnvironment(o: OpCtx, id: string, eid: string) {
    await deleteEnvironment(o.env, o.auth.accountId, id, eid);
    return { deleted: eid, note: "Its snippet now loads the live container; its pinned version may be pruned by a later publish." };
  },

  async putLookup(o: OpCtx, id: string, name: string, input: z.infer<typeof lookupInput>) {
    const r = await putLookup(o.env, o.auth.accountId, id, name, input);
    return {
      status: r.existing ? 200 : 201,
      body: {
        container_id: id,
        lookup: r,
        next_steps: [
          `Use it from a destination: PATCH /v1/containers/${id}/destinations/:did { "settings": { "params": { "set": { "value": { "lookup": "${name}", "key": "items[].item_id" } } } } } (the sum of each item's value times quantity), or { "lookup": "${name}", "key": "params.sku" } for one value.`,
          "POST /v1/containers/:id/destinations/:did/test shows the transformed request.",
        ],
      },
    };
  },

  async lookups(o: OpCtx, id: string) {
    return { container_id: id, ...(await listLookups(o.env, o.auth.accountId, id)) };
  },

  async getLookup(o: OpCtx, id: string, name: string) {
    return { container_id: id, ...(await getLookup(o.env, o.auth.accountId, id, name)) };
  },

  async deleteLookup(o: OpCtx, id: string, name: string) {
    return { container_id: id, ...(await deleteLookup(o.env, o.auth.accountId, id, name)) };
  },

  async tagStats(o: OpCtx, id: string, since?: string) {
    const row = await getContainerRow(o.env, o.auth.accountId, id);
    const from = parseSince(since ?? "7d") ?? Date.now() - 7 * 86_400_000;
    const rows = (await containerStub(o.env, id).tagStats(utcDay(from))) as {
      tag_id: string;
      status: string;
      n: number;
      last_at: number;
    }[];
    const live = (await liveConfig(o.env, row)) ?? {};
    const tags = (live.tags ?? []).map((t) => {
      const mine = rows.filter((r) => r.tag_id === t.id);
      const n = (s: string) => mine.find((r) => r.status === s)?.n ?? 0;
      return {
        tag_id: t.id,
        type: t.type,
        enabled: t.enabled !== false,
        fired: n("fired"),
        blocked: n("blocked"),
        error: n("error"),
        skipped: n("skipped"),
        excluded: n("excluded"),
        last_at: mine.reduce<number | null>((a, r) => (a === null || r.last_at > a ? r.last_at : a), null),
      };
    });
    const reporting = !!live.settings?.report_tag_fires;
    return {
      container_id: id,
      since: from,
      reporting,
      tags,
      never_fired: tags.filter((t) => t.enabled && !t.fired).map((t) => t.tag_id),
      failing: tags.filter((t) => t.error > 0).map((t) => t.tag_id),
      note: "Counts come from browsers (blocked = waited for consent; skipped = schedule, live_only, once_per_page or a page blocklist). Kept 30 days.",
      next_steps: reporting
        ? ["never_fired and failing list tags to look at; GET /coverage shows which pages sent hits."]
        : [
            `Turn it on: PATCH /v1/containers/${id}/draft { "settings": { "report_tag_fires": true } }, then publish. Each page then sends one telemetry hit (it counts as a browser event).`,
          ],
    };
  },

  async coverage(o: OpCtx, id: string, since?: string) {
    await getContainerRow(o.env, o.auth.accountId, id);
    const from = parseSince(since ?? "7d") ?? Date.now() - 7 * 86_400_000;
    const r = (await containerStub(o.env, id).coverage(from)) as {
      pages: { host: string; path: string; hits: number; first_seen: number; last_seen: number }[];
      capped: boolean;
    };
    const hosts = [...new Set(r.pages.map((p) => p.host))];
    return {
      container_id: id,
      since: from,
      hosts: hosts.length,
      pages: r.pages.length,
      ...(r.capped ? { note: "Past 1000 distinct pages, the rest are counted under path (other)." } : {}),
      // Host and path come from the hit's page URL, which browsers (anyone) send.
      untrusted: { pages: r.pages },
      next_steps: [
        "Pages appear once they send a hit: a visit, a conversion, or (settings.report_tag_fires) one telemetry hit per page.",
        `POST /v1/containers/${id}/scan { "paths": [...] } checks specific pages for the snippet (pages[].snippet).`,
      ],
    };
  },

  async publish(o: OpCtx, id: string, note?: string, version?: number) {
    const r = await publish(o.env, o.auth.accountId, id, { note, keyId: o.auth.keyId, origins: o.origins, version });
    return {
      container_id: id,
      version: r.version,
      published_at: r.published_at,
      script_url: `${o.base}/c/${id}.js`,
      warnings: r.validation.warnings,
      note: "Live now. Edge caches refresh within 60s and browsers within 5 min.",
      next_steps: [
        `GET /v1/containers/${id}/events to watch conversions arrive.`,
        `POST /v1/containers/${id}/rollback { "version": ${Math.max(r.version - 1, 1)} } to undo.`,
      ],
    };
  },

  async versions(o: OpCtx, id: string) {
    return { container_id: id, ...(await listVersions(o.env, o.auth.accountId, id)) };
  },

  async version(o: OpCtx, id: string, n: number) {
    return { container_id: id, ...(await getVersion(o.env, o.auth.accountId, id, n)) };
  },

  async rollback(o: OpCtx, id: string, version: number) {
    return {
      container_id: id,
      ...(await rollback(o.env, o.auth.accountId, id, version, o.origins)),
      note: "The draft is unchanged; copy a version into the draft with PUT /draft if you want to edit it.",
    };
  },

  async addDestination(o: OpCtx, id: string, input: z.infer<typeof destinationInput>) {
    // A destination keeps receiving conversion data (hashed PII included) after an OAuth token expires.
    assertPermanentKey(o.auth, DESTINATION_ACTIONS.add);
    const { row, existing } = await createDestination(o.env, o.auth.accountId, id, input, o.origins);
    return {
      status: existing ? 200 : 201,
      body: {
        destination: presentDestination(row),
        existing,
        next_steps: [
          `POST /v1/containers/${id}/destinations/${row.id}/test sends a test event in ${row.type}'s test mode and returns the raw answer.`,
          row.type === "analytics"
            ? "It receives every conversion with server: true (and every server event)."
            : row.type === "webhook"
              ? "It receives every conversion with server: true, and backend events whose name matches a conversion (settings.all_events: true for every backend event)."
              : `Conversions reach it when they have server: true and send_to.${row.type} in the published config.`,
        ],
      },
    };
  },

  async listDestinations(o: OpCtx, id: string) {
    return { destinations: (await listDestinations(o.env, o.auth.accountId, id)).map(presentDestination) };
  },

  async getDestination(o: OpCtx, id: string, did: string) {
    return { destination: presentDestination(await getDestination(o.env, o.auth.accountId, id, did)) };
  },

  async updateDestination(o: OpCtx, id: string, did: string, input: z.infer<typeof destinationPatch>) {
    if (input.credentials) assertPermanentKey(o.auth, DESTINATION_ACTIONS.change);
    return { destination: presentDestination(await updateDestination(o.env, o.auth.accountId, id, did, input, o.origins)) };
  },

  async removeDestination(o: OpCtx, id: string, did: string) {
    await deleteDestination(o.env, o.auth.accountId, id, did);
    return { deleted: did };
  },

  async testDestination(o: OpCtx, id: string, did: string, input: z.infer<typeof testInput>) {
    return testDestination(o.env, o.auth.accountId, id, did, input);
  },

  async sendEvents(o: OpCtx, id: string, events: ServerEvent[], test: boolean) {
    return ingestServerEvents(o.env, o.auth.accountId, id, events, test);
  },

  async events(o: OpCtx, id: string, q: z.infer<typeof eventsQuery>) {
    const f: EventFilter = {
      name: q.name,
      status: q.status,
      source: q.source,
      since: parseSince(q.since),
      before: q.before,
      limit: q.limit,
      include_visits: truthy(q.include_visits),
      verbose: truthy(q.verbose),
    };
    return { container_id: id, ...(await eventLog(o.env, o.auth.accountId, id, f)) };
  },

  async visitor(o: OpCtx, id: string, vid: string) {
    return { container_id: id, visitor: await visitor(o.env, o.auth.accountId, id, vid) };
  },

  async setup(o: OpCtx, id: string, input: RecipeInput) {
    return applyRecipe(o.env, o.auth, id, input, o.origins);
  },

  async currentDraft(o: OpCtx, id: string) {
    return draftConfig(await getContainerRow(o.env, o.auth.accountId, id));
  },
};

async function itemResponse(
  o: OpCtx,
  id: string,
  kind: ItemKind,
  key: string,
  r: DraftEditResult<unknown>,
  extra: Record<string, unknown>,
) {
  const validation = await draftValidation(o.env, r.row, r.config);
  const item = ((r.config[kind] as unknown as Record<string, unknown>[] | undefined) ?? []).find((i) => i[KEY_FIELD[kind]] === key) ?? null;
  return {
    container_id: id,
    kind,
    key,
    revision: r.row.draft_revision,
    ...extra,
    item,
    validation,
    changes_vs_live: await changesVsLive(o.env, r.row, r.config),
    next_steps: validation.valid
      ? [`GET /v1/containers/${id}/diff shows everything that will change; POST /v1/containers/${id}/publish when ready.`]
      : ["Saved, but the draft can't be published until validation.errors are fixed (each has a hint)."],
  };
}

function draftResponse(
  id: string,
  revision: number,
  config: unknown,
  validation: { valid: boolean; errors: unknown[]; warnings: unknown[] },
) {
  return {
    container_id: id,
    revision,
    config,
    validation,
    next_steps: validation.valid
      ? [`POST /v1/containers/${id}/preview to test the draft on the live site, then POST /v1/containers/${id}/publish.`]
      : ["Saved, but it can't be published until validation.errors are fixed (each has a hint)."],
  };
}

export function parseVersion(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw badRequest("version must be a positive integer.");
  return n;
}
