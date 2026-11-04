import { ApiError, badRequest } from "@afs/shared";
import type { Bindings } from "../env";
import { TAGS_CONTAINER_RE, type TagsServerEvent } from "../lib/tags";

/**
 * The optional link to an AgentFirstStack tags container, over the TAGS service binding with
 * internal auth (x-afs-internal: INTERNAL_TOKEN, x-afs-account: the site's account), so tags checks
 * the account exactly as it checks an API key: a container of another account is a 404 there.
 *   - GET  /v1/containers/:id          validates tags_container_id when a site is linked;
 *   - POST /v1/containers/:id/events   {events: [...<=100]} the routes backends send server events to
 *                                      (202 {accepted, duplicates, results}); event_id dedupes retries.
 */

export const tagsAvailable = (env: Bindings) => !!env.TAGS && !!env.INTERNAL_TOKEN;

async function call(env: Bindings, accountId: string, method: string, path: string, body?: unknown) {
  if (!env.TAGS || !env.INTERNAL_TOKEN) return { status: 503, json: null as any };
  const res = await env.TAGS.fetch(
    new Request(`https://tags.internal${path}`, {
      method,
      headers: {
        "x-afs-internal": env.INTERNAL_TOKEN,
        "x-afs-account": accountId,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, json };
}

/** Throws unless `containerId` is a tags container of this account. */
export async function checkTagsContainer(env: Bindings, accountId: string, containerId: string): Promise<{ domain: string | null }> {
  if (!TAGS_CONTAINER_RE.test(containerId))
    throw badRequest(
      "tags_container_id must be a tags container id (ctr_...).",
      "GET /v1/containers on the tags service lists them; null unlinks.",
    );
  if (!tagsAvailable(env))
    throw new ApiError(
      400,
      "tags_not_available",
      "This deployment has no link to a tags service (TAGS service binding and INTERNAL_TOKEN).",
      "Leave tags_container_id unset here, or ask the operator to bind the tags Worker as TAGS and set INTERNAL_TOKEN on both.",
    );
  const r = await call(env, accountId, "GET", `/v1/containers/${containerId}`).catch((e: unknown) => ({ status: 0, json: String(e) }));
  if (r.status === 404)
    throw badRequest(
      `Tags container ${containerId} was not found on this account.`,
      "Use the id of a container created with the same API key (tags GET /v1/containers).",
    );
  if (r.status !== 200) throw new ApiError(502, "tags_error", `The tags service answered HTTP ${r.status}.`, "Retry in a minute.");
  return { domain: typeof r.json?.container?.domain === "string" ? r.json.container.domain : null };
}

/** Send one batch (at most 100 events). Never throws: status 0 = the binding failed. */
export async function postTagsEvents(
  env: Bindings,
  accountId: string,
  containerId: string,
  events: TagsServerEvent[],
): Promise<{ status: number; accepted: number; error: string | null }> {
  try {
    const r = await call(env, accountId, "POST", `/v1/containers/${containerId}/events`, { events });
    const accepted = typeof r.json?.accepted === "number" ? r.json.accepted + (Number(r.json.duplicates) || 0) : 0;
    const error =
      r.status === 202 || r.status === 200 ? null : String(r.json?.error?.code ?? r.json?.error ?? `HTTP ${r.status}`).slice(0, 100);
    return { status: r.status, accepted, error };
  } catch (e) {
    return { status: 0, accepted: 0, error: String(e).slice(0, 100) };
  }
}
