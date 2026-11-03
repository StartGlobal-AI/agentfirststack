import { type AuthContext, badRequest } from "@afs/shared";
import { z } from "zod";
import { schemaDocument } from "../config/catalog";
import type { EventFilter } from "../do/container-do";
import type { Bindings } from "../env";
import {
  containerNextSteps,
  containerStats,
  createContainer,
  deleteContainer,
  draftConfig,
  getContainerRow,
  installInstructions,
  listContainers,
  publicContainer,
  snippet,
  updateContainer,
} from "./containers";
import {
  createDestination,
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
import type { ServerEvent } from "./ingest-schema";
import type { RecipeInput } from "./recipe";
import { scanSite } from "./scan";
import { applyRecipe } from "./setup";
import { createPreview, getDraft, getVersion, listVersions, patchDraft, publish, putDraft, rollback, validateDraft } from "./versions";

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
  type: z.string().describe("ga4 | meta | google_ads | tiktok | analytics | webhook"),
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
export const scanInput = z.strictObject({
  url: z.string().max(2048).optional().describe("Page to scan (must be on the container's domain). Default https://<domain>/."),
  paths: z.array(z.string().max(500)).max(5).optional().describe("Extra paths to scan, e.g. ['/contact', '/checkout']."),
  follow_links: z.boolean().optional().describe("Also scan up to 3 linked contact/signup/pricing pages (default true)."),
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
        install: installInstructions(o.base, row, await proxyKey(o.env, row.id)),
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
    const stats = await containerStats(o.env, id);
    return {
      container: publicContainer(row, o.base),
      destinations: dest.map(presentDestination),
      stats,
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

  async install(o: OpCtx, id: string) {
    const row = await getContainerRow(o.env, o.auth.accountId, id);
    return { container_id: id, ...installInstructions(o.base, row, await proxyKey(o.env, row.id)) };
  },

  async scan(o: OpCtx, id: string, input: z.infer<typeof scanInput>) {
    const row = await getContainerRow(o.env, o.auth.accountId, id);
    const r = await scanSite(row.domain, id, input);
    return {
      ...r,
      next_steps: [
        ...(r.container_installed ? [] : [`Install the snippet: ${snippet(o.base, row.id)}`]),
        `Review suggested_config, fill in what's missing, then PUT /v1/containers/${id}/draft (or use setup_conversion_tracking).`,
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

  async preview(o: OpCtx, id: string, input: { ttl_minutes?: number; path?: string }) {
    const r = await createPreview(o.env, o.auth.accountId, id, input);
    const sep = r.path.includes("?") ? "&" : "?";
    return {
      token: r.token,
      expires_at: r.expires_at,
      preview_url: `https://${r.row.domain}${r.path}${sep}afst_preview=${r.token}`,
      script_url: `${o.base}/c/${id}.js?preview=${r.token}`,
      how_it_works:
        "Open preview_url in a browser: the installed live snippet sees afst_preview, remembers it for the tab (sessionStorage) and loads the DRAFT with console debug logging. Preview conversions go to /collect marked preview and destinations use their test modes. Add ?afst_preview=off to leave.",
      next_steps: [
        "Open preview_url (or drive it with a headless browser) and trigger each conversion.",
        `GET /v1/containers/${id}/events?since=15m shows the preview events (preview: true) with per-destination results.`,
        `POST /v1/containers/${id}/publish when it looks right.`,
      ],
    };
  },

  async publish(o: OpCtx, id: string, note?: string) {
    const r = await publish(o.env, o.auth.accountId, id, { note, keyId: o.auth.keyId, origins: o.origins });
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
    const { row, existing } = await createDestination(o.env, o.auth.accountId, id, input, o.origins);
    return {
      status: existing ? 200 : 201,
      body: {
        destination: presentDestination(row),
        existing,
        next_steps: [
          `POST /v1/containers/${id}/destinations/${row.id}/test sends a test event in ${row.type}'s test mode and returns the raw answer.`,
          row.type === "webhook" || row.type === "analytics"
            ? "It receives every conversion with server: true (and every server event)."
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
    return { destination: presentDestination(await updateDestination(o.env, o.auth.accountId, id, did, input, o.origins)) };
  },

  async removeDestination(o: OpCtx, id: string, did: string) {
    await deleteDestination(o.env, o.auth.accountId, id, did);
    return { deleted: did };
  },

  async testDestination(o: OpCtx, id: string, did: string, input: { event_name?: string; test_event_code?: string }) {
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
    return applyRecipe(o.env, o.auth.accountId, id, input, o.origins);
  },

  async currentDraft(o: OpCtx, id: string) {
    return draftConfig(await getContainerRow(o.env, o.auth.accountId, id));
  },
};

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
