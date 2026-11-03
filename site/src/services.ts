import type { Bindings } from "./env";

/**
 * The dashboard reads a project's resources from the services themselves, over service bindings,
 * as that project: `x-afs-internal: INTERNAL_TOKEN` plus `x-afs-account`. Each service's
 * requireAuth() accepts that as a full-access caller. Nothing here needs an API key.
 */

export type Service = "analytics" | "tags" | "mail";
const BINDING = { analytics: "ANALYTICS", tags: "TAGS", mail: "MAIL" } as const;

export interface ServiceResult<T = unknown> {
  ok: boolean;
  status: number;
  json: T | null;
}

export async function callService<T = unknown>(
  env: Bindings,
  service: Service,
  accountId: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ServiceResult<T>> {
  const binding = env[BINDING[service]] as Fetcher | undefined;
  if (!binding || !env.INTERNAL_TOKEN) return { ok: false, status: 503, json: null };
  try {
    const res = await binding.fetch(`https://${service}.internal${path}`, {
      method: init.method ?? "GET",
      headers: {
        "x-afs-internal": env.INTERNAL_TOKEN,
        "x-afs-account": accountId,
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let json: T | null = null;
    try {
      json = JSON.parse(text) as T;
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    console.error("service call failed", service, path, e);
    return { ok: false, status: 502, json: null };
  }
}

export interface SiteItem {
  id: string;
  domain: string;
  name: string | null;
  created_at: number;
}
export interface ContainerItem {
  id: string;
  domain: string;
  name: string | null;
  live_version: number | null;
  created_at: number;
}
export interface InboxItem {
  id: string;
  address: string;
  display_name: string | null;
  last_message_at: number | null;
  created_at: number;
}

/** null for a list = that service couldn't be reached (shown as "unavailable", not "none"). */
export interface Resources {
  sites: SiteItem[] | null;
  containers: ContainerItem[] | null;
  inboxes: InboxItem[] | null;
}

export async function projectResources(env: Bindings, accountId: string): Promise<Resources> {
  const [sites, containers, inboxes] = await Promise.all([
    callService<{ sites?: SiteItem[] }>(env, "analytics", accountId, "/v1/sites"),
    callService<{ containers?: ContainerItem[] }>(env, "tags", accountId, "/v1/containers"),
    callService<{ inboxes?: InboxItem[] }>(env, "mail", accountId, "/v1/inboxes"),
  ]);
  return {
    sites: sites.ok ? (sites.json?.sites ?? []) : null,
    containers: containers.ok ? (containers.json?.containers ?? []) : null,
    inboxes: inboxes.ok ? (inboxes.json?.inboxes ?? []) : null,
  };
}

/**
 * Unique visitors over the last 7 days for each site, from analytics' stats API (one call per
 * site). Best effort: a site that doesn't answer is simply missing from the map.
 */
