import { badRequest, parse, publicBaseUrl, readJson, readQuery } from "@afs/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import {
  consentQuery,
  consentRecordsQuery,
  containerInput,
  containerPatch,
  destinationInput,
  destinationPatch,
  eventsQuery,
  type OpCtx,
  ops,
  parseVersion,
  readScanInput,
  testInput,
  verifyInput,
} from "../service/api";
import { environmentInput, environmentPatch } from "../service/environments";
import { assertImportSize, importInput } from "../service/import";
import { lookupInput } from "../service/lookups";
import { serverEventsBody } from "../service/ingest-schema";
import { recipeInput } from "../service/recipe";

/** Authenticated REST API. Thin: parse -> ops (src/service/api.ts) -> JSON. */
export const v1 = new Hono<AppEnv>();

export function opCtx(c: Context<AppEnv>): OpCtx {
  const base = publicBaseUrl(c);
  return { env: c.env, auth: c.var.auth, base, origins: [base, new URL(c.req.url).origin] };
}

const revisionQuery = z.object({ revision: z.coerce.number().int().positive().optional() });
const installQuery = z.object({ proxy: z.enum(["1", "0", "true", "false"]).optional() });
const truthyFlag = (v: string | undefined) => v === "1" || v === "true";
const rawJson = async (c: Context<AppEnv>) => readJson(c, z.unknown());

v1.get("/usage", async (c) => c.json(await ops.usage(opCtx(c))));

v1.post("/containers", async (c) => {
  const r = await ops.createContainer(opCtx(c), await readJson(c, containerInput));
  return c.json(r.body, r.status as 200 | 201);
});
v1.get("/containers", async (c) => c.json(await ops.listContainers(opCtx(c))));
v1.get("/containers/:id", async (c) => c.json(await ops.getContainer(opCtx(c), c.req.param("id"))));
v1.patch("/containers/:id", async (c) => c.json(await ops.updateContainer(opCtx(c), c.req.param("id"), await readJson(c, containerPatch))));
v1.delete("/containers/:id", async (c) => c.json(await ops.deleteContainer(opCtx(c), c.req.param("id"))));
v1.get("/containers/:id/install", async (c) =>
  c.json(await ops.install(opCtx(c), c.req.param("id"), { proxy: truthyFlag(readQuery(c, installQuery).proxy) })),
);
v1.post("/containers/:id/scan", async (c) => c.json(await ops.scan(opCtx(c), c.req.param("id"), readScanInput(await rawJson(c)))));
v1.post("/containers/:id/verify", async (c) => c.json(await ops.verify(opCtx(c), c.req.param("id"), await readJson(c, verifyInput))));

v1.get("/containers/:id/draft", async (c) => c.json(await ops.getDraft(opCtx(c), c.req.param("id"))));
v1.put("/containers/:id/draft", async (c) =>
  c.json(await ops.putDraft(opCtx(c), c.req.param("id"), await rawJson(c), readQuery(c, revisionQuery).revision)),
);
v1.patch("/containers/:id/draft", async (c) =>
  c.json(await ops.patchDraft(opCtx(c), c.req.param("id"), await rawJson(c), readQuery(c, revisionQuery).revision)),
);
v1.post("/containers/:id/draft/import", async (c) => {
  // Imports are big and untrusted: the size is checked before the body is parsed.
  const text = await c.req.text();
  assertImportSize(Math.max(0, new TextEncoder().encode(text).byteLength - 4096));
  let raw: unknown;
  try {
    raw = JSON.parse(text || "{}");
  } catch {
    throw badRequest("The body is not JSON.", 'Send { "format": "gtm", "data": <the GTM export file> } or { "config": {...} }.');
  }
  return c.json(await ops.importDraft(opCtx(c), c.req.param("id"), parse(importInput, raw), readQuery(c, revisionQuery).revision));
});
const itemRoute = "/containers/:id/draft/:kind/:key";
v1.get(itemRoute, async (c) => c.json(await ops.getDraftItem(opCtx(c), c.req.param("id"), c.req.param("kind"), c.req.param("key"))));
v1.put(itemRoute, async (c) =>
  c.json(
    await ops.upsertDraftItem(
      opCtx(c),
      c.req.param("id"),
      c.req.param("kind"),
      c.req.param("key"),
      await rawJson(c),
      readQuery(c, revisionQuery).revision,
    ),
  ),
);
v1.delete(itemRoute, async (c) =>
  c.json(
    await ops.removeDraftItem(opCtx(c), c.req.param("id"), c.req.param("kind"), c.req.param("key"), readQuery(c, revisionQuery).revision),
  ),
);
v1.post(`${itemRoute}/revert`, async (c) =>
  c.json(
    await ops.revertDraftItem(opCtx(c), c.req.param("id"), c.req.param("kind"), c.req.param("key"), readQuery(c, revisionQuery).revision),
  ),
);
v1.get("/containers/:id/diff", async (c) =>
  c.json(
    await ops.diff(
      opCtx(c),
      c.req.param("id"),
      readQuery(c, z.object({ from: z.string().max(20).optional(), to: z.string().max(20).optional() })),
    ),
  ),
);
v1.post("/containers/:id/draft/validate", async (c) => {
  const body = (await rawJson(c)) as Record<string, unknown> | undefined;
  // Optional body { config } validates a candidate without saving it.
  return c.json(
    await ops.validate(opCtx(c), c.req.param("id"), body && typeof body === "object" && "config" in body ? body.config : undefined),
  );
});
v1.post("/containers/:id/preview", async (c) =>
  c.json(
    await ops.preview(
      opCtx(c),
      c.req.param("id"),
      await readJson(
        c,
        z.strictObject({
          ttl_minutes: z.number().int().optional(),
          path: z.string().max(500).optional(),
          version: z.number().int().positive().optional(),
        }),
      ),
    ),
  ),
);
v1.get("/containers/:id/preview/:token/log", async (c) =>
  c.json(
    await ops.previewLog(
      opCtx(c),
      c.req.param("id"),
      c.req.param("token"),
      readQuery(
        c,
        z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }),
      ),
    ),
  ),
);
v1.post("/containers/:id/publish", async (c) => {
  const b = await readJson(c, z.strictObject({ note: z.string().max(500).optional(), version: z.number().int().positive().optional() }));
  return c.json(await ops.publish(opCtx(c), c.req.param("id"), b.note, b.version), 201);
});
v1.post("/containers/:id/versions", async (c) => {
  const r = await ops.createVersion(
    opCtx(c),
    c.req.param("id"),
    (await readJson(c, z.strictObject({ note: z.string().max(500).optional() }))).note,
  );
  return c.json(r.body, r.status as 200 | 201);
});
v1.post("/containers/:id/environments", async (c) => {
  const r = await ops.createEnvironment(opCtx(c), c.req.param("id"), await readJson(c, environmentInput));
  return c.json(r.body, r.status as 200 | 201);
});
v1.get("/containers/:id/environments", async (c) => c.json(await ops.environments(opCtx(c), c.req.param("id"))));
v1.get("/containers/:id/environments/:eid", async (c) => c.json(await ops.getEnvironment(opCtx(c), c.req.param("id"), c.req.param("eid"))));
v1.patch("/containers/:id/environments/:eid", async (c) =>
  c.json(await ops.updateEnvironment(opCtx(c), c.req.param("id"), c.req.param("eid"), await readJson(c, environmentPatch))),
);
v1.post("/containers/:id/environments/:eid/reauthorize", async (c) =>
  c.json(await ops.reauthorizeEnvironment(opCtx(c), c.req.param("id"), c.req.param("eid"))),
);
v1.delete("/containers/:id/environments/:eid", async (c) =>
  c.json(await ops.deleteEnvironment(opCtx(c), c.req.param("id"), c.req.param("eid"))),
);
v1.put("/containers/:id/lookups/:name", async (c) => {
  const r = await ops.putLookup(opCtx(c), c.req.param("id"), c.req.param("name"), await readJson(c, lookupInput));
  return c.json(r.body, r.status as 200 | 201);
});
v1.get("/containers/:id/lookups", async (c) => c.json(await ops.lookups(opCtx(c), c.req.param("id"))));
v1.get("/containers/:id/lookups/:name", async (c) => c.json(await ops.getLookup(opCtx(c), c.req.param("id"), c.req.param("name"))));
v1.delete("/containers/:id/lookups/:name", async (c) => c.json(await ops.deleteLookup(opCtx(c), c.req.param("id"), c.req.param("name"))));
const sinceQuery = z.object({ since: z.string().max(40).optional() });
v1.get("/containers/:id/tag-stats", async (c) => c.json(await ops.tagStats(opCtx(c), c.req.param("id"), readQuery(c, sinceQuery).since)));
v1.get("/containers/:id/coverage", async (c) => c.json(await ops.coverage(opCtx(c), c.req.param("id"), readQuery(c, sinceQuery).since)));
// period is accepted as another name for since (analytics' quarantine read uses period).
const quarantineQuery = z.object({ since: z.string().max(40).optional(), period: z.string().max(40).optional() });
v1.get("/containers/:id/quarantine", async (c) => {
  const q = readQuery(c, quarantineQuery);
  return c.json(await ops.quarantine(opCtx(c), c.req.param("id"), q.since ?? q.period));
});
v1.get("/containers/:id/consent", async (c) => c.json(await ops.consent(opCtx(c), c.req.param("id"), readQuery(c, consentQuery).since)));
v1.get("/containers/:id/consent/records", async (c) =>
  c.json(await ops.consentRecords(opCtx(c), c.req.param("id"), readQuery(c, consentRecordsQuery))),
);
v1.get("/containers/:id/versions", async (c) => c.json(await ops.versions(opCtx(c), c.req.param("id"))));
v1.get("/containers/:id/versions/:n", async (c) => c.json(await ops.version(opCtx(c), c.req.param("id"), parseVersion(c.req.param("n")))));
v1.post("/containers/:id/rollback", async (c) =>
  c.json(
    await ops.rollback(opCtx(c), c.req.param("id"), (await readJson(c, z.strictObject({ version: z.number().int().positive() }))).version),
  ),
);

v1.post("/containers/:id/destinations", async (c) => {
  const r = await ops.addDestination(opCtx(c), c.req.param("id"), await readJson(c, destinationInput));
  return c.json(r.body, r.status as 200 | 201);
});
v1.get("/containers/:id/destinations", async (c) => c.json(await ops.listDestinations(opCtx(c), c.req.param("id"))));
v1.get("/containers/:id/destinations/:did", async (c) => c.json(await ops.getDestination(opCtx(c), c.req.param("id"), c.req.param("did"))));
v1.patch("/containers/:id/destinations/:did", async (c) =>
  c.json(await ops.updateDestination(opCtx(c), c.req.param("id"), c.req.param("did"), await readJson(c, destinationPatch))),
);
v1.delete("/containers/:id/destinations/:did", async (c) =>
  c.json(await ops.removeDestination(opCtx(c), c.req.param("id"), c.req.param("did"))),
);
v1.post("/containers/:id/destinations/:did/test", async (c) =>
  c.json(await ops.testDestination(opCtx(c), c.req.param("id"), c.req.param("did"), await readJson(c, testInput))),
);

v1.post("/containers/:id/events", async (c) => {
  const body = await readJson(c, serverEventsBody);
  return c.json(await ops.sendEvents(opCtx(c), c.req.param("id"), body.events, !!body.test), 202);
});
v1.get("/containers/:id/events", async (c) => c.json(await ops.events(opCtx(c), c.req.param("id"), readQuery(c, eventsQuery))));
v1.get("/containers/:id/visitors/:vid", async (c) => c.json(await ops.visitor(opCtx(c), c.req.param("id"), c.req.param("vid"))));
v1.post("/containers/:id/setup", async (c) => c.json(await ops.setup(opCtx(c), c.req.param("id"), await readJson(c, recipeInput))));
