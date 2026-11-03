import { publicBaseUrl, readJson, readQuery } from "@afs/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import {
  containerInput,
  containerPatch,
  destinationInput,
  destinationPatch,
  eventsQuery,
  type OpCtx,
  ops,
  parseVersion,
  scanInput,
} from "../service/api";
import { serverEventsBody } from "../service/ingest-schema";
import { recipeInput } from "../service/recipe";

/** Authenticated REST API. Thin: parse -> ops (src/service/api.ts) -> JSON. */
export const v1 = new Hono<AppEnv>();

export function opCtx(c: Context<AppEnv>): OpCtx {
  const base = publicBaseUrl(c);
  return { env: c.env, auth: c.var.auth, base, origins: [base, new URL(c.req.url).origin] };
}

const revisionQuery = z.object({ revision: z.coerce.number().int().positive().optional() });
const rawJson = async (c: Context<AppEnv>) => readJson(c, z.unknown());

v1.post("/containers", async (c) => {
  const r = await ops.createContainer(opCtx(c), await readJson(c, containerInput));
  return c.json(r.body, r.status as 200 | 201);
});
v1.get("/containers", async (c) => c.json(await ops.listContainers(opCtx(c))));
v1.get("/containers/:id", async (c) => c.json(await ops.getContainer(opCtx(c), c.req.param("id"))));
v1.patch("/containers/:id", async (c) => c.json(await ops.updateContainer(opCtx(c), c.req.param("id"), await readJson(c, containerPatch))));
v1.delete("/containers/:id", async (c) => c.json(await ops.deleteContainer(opCtx(c), c.req.param("id"))));
v1.get("/containers/:id/install", async (c) => c.json(await ops.install(opCtx(c), c.req.param("id"))));
v1.post("/containers/:id/scan", async (c) => c.json(await ops.scan(opCtx(c), c.req.param("id"), await readJson(c, scanInput))));

v1.get("/containers/:id/draft", async (c) => c.json(await ops.getDraft(opCtx(c), c.req.param("id"))));
v1.put("/containers/:id/draft", async (c) =>
  c.json(await ops.putDraft(opCtx(c), c.req.param("id"), await rawJson(c), readQuery(c, revisionQuery).revision)),
);
v1.patch("/containers/:id/draft", async (c) =>
  c.json(await ops.patchDraft(opCtx(c), c.req.param("id"), await rawJson(c), readQuery(c, revisionQuery).revision)),
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
      await readJson(c, z.strictObject({ ttl_minutes: z.number().int().optional(), path: z.string().max(500).optional() })),
    ),
  ),
);
v1.post("/containers/:id/publish", async (c) =>
  c.json(
    await ops.publish(opCtx(c), c.req.param("id"), (await readJson(c, z.strictObject({ note: z.string().max(500).optional() }))).note),
    201,
  ),
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
  c.json(
    await ops.testDestination(
      opCtx(c),
      c.req.param("id"),
      c.req.param("did"),
      await readJson(c, z.strictObject({ event_name: z.string().max(40).optional(), test_event_code: z.string().max(60).optional() })),
    ),
  ),
);

v1.post("/containers/:id/events", async (c) => {
  const body = await readJson(c, serverEventsBody);
  return c.json(await ops.sendEvents(opCtx(c), c.req.param("id"), body.events, !!body.test), 202);
});
v1.get("/containers/:id/events", async (c) => c.json(await ops.events(opCtx(c), c.req.param("id"), readQuery(c, eventsQuery))));
v1.get("/containers/:id/visitors/:vid", async (c) => c.json(await ops.visitor(opCtx(c), c.req.param("id"), c.req.param("vid"))));
v1.post("/containers/:id/setup", async (c) => c.json(await ops.setup(opCtx(c), c.req.param("id"), await readJson(c, recipeInput))));
