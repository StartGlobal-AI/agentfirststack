import { type AuthBindings, identityDb, isSchemaError } from "./auth";
import { ApiError } from "./errors";

/**
 * Capability pauses: the automatic answer to a strong abuse signal. One capability of one account
 * stops (sending mail, custom code, share links, new inboxes) while everything else keeps working;
 * the project's people and the operator are emailed, and only the operator lifts it. Suspending a
 * whole account stays a manual step (`pnpm afs suspend`).
 *
 *   - The table is `capability_pauses` in the identity database (site migration 0012). One row per
 *     account and capability; lifting keeps the row (lifted_at) so an automatic re-pause right after
 *     the operator's review is ignored for PAUSE_LIFT_GRACE_HOURS (default 24).
 *   - Services check `capabilityPaused(env, accountId, capability)` where the capability is used
 *     and answer `capabilityPausedError(pause)` (403 capability_paused). Cached per isolate for a
 *     minute, like account standing, so a hot path costs one D1 read per account per minute.
 *   - A service that sees a strong signal calls `requestCapabilityPause(env, ...)`: over the SITE
 *     service binding it posts to `https://site.internal/v1/internal/pauses` (the site records it
 *     and emails the people and the operator at once); without the binding, or when the site can't
 *     be reached, it writes the row itself and the site's hourly cron sends the emails.
 */

export const CAPABILITIES = ["mail.send", "mail.inbox_create", "tags.custom_code", "replay.share_links", "analytics.share_links"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const isCapability = (v: unknown): v is Capability => typeof v === "string" && (CAPABILITIES as readonly string[]).includes(v);

/** What each capability is called in errors and emails. */
export const CAPABILITY_LABEL: Record<Capability, string> = {
  "mail.send": "Sending email",
  "mail.inbox_create": "Creating inboxes",
  "tags.custom_code": "Custom code in tag containers",
  "replay.share_links": "Session replay sharing",
  "analytics.share_links": "Analytics dashboard sharing",
};

export interface CapabilityPause {
  capability: Capability;
  /** Why, in words a person can read ("23% of last hour's 40 sends bounced"). */
  reason: string;
  paused_at: number;
  /** Who paused it: the service ("mail", "tags", ...) or "operator". */
  paused_by: string;
  /** When it ends by itself; null = until the operator lifts it. */
  until: number | null;
}

const TTL_MS = 60_000;
const MAX_ENTRIES = 5_000;
const cache = new Map<string, { at: number; pauses: CapabilityPause[] }>();

/**
 * The active pause of one capability of an account, or null when it may be used. Fails open (null)
 * when the identity DB can't be read, and reads as nothing paused on a deployment without the
 * table (a single app self-hosted without the site).
 */
export async function capabilityPaused(env: AuthBindings, accountId: string, capability: Capability): Promise<CapabilityPause | null> {
  const now = Date.now();
  let pauses: CapabilityPause[] | undefined;
  const hit = cache.get(accountId);
  if (hit && now - hit.at < TTL_MS) pauses = hit.pauses;
  else {
    try {
      const { results } = await identityDb(env)
        .prepare("SELECT capability, reason, paused_at, paused_by, until FROM capability_pauses WHERE account_id = ? AND lifted_at IS NULL")
        .bind(accountId)
        .all<CapabilityPause>();
      pauses = results ?? [];
    } catch (e) {
      if (!isSchemaError(e)) {
        console.error("capability pauses unreadable", e);
        return null; // not cached: the real state applies once D1 answers
      }
      pauses = [];
    }
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(accountId, { at: now, pauses });
  }
  return pauses.find((p) => p.capability === capability && (p.until == null || p.until > now)) ?? null;
}

/** Forget an account's cached pauses (after pausing or lifting, in the same isolate). */
export function forgetPauses(accountId?: string): void {
  if (accountId === undefined) cache.clear();
  else cache.delete(accountId);
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The 403 a service answers while a capability is paused. */
export function capabilityPausedError(pause: CapabilityPause, support = "support@agentfirststack.com"): ApiError {
  const label = CAPABILITY_LABEL[pause.capability] ?? pause.capability;
  return new ApiError(
    403,
    "capability_paused",
    `${label} is paused for this project${pause.until ? ` until ${day(pause.until)}` : ""}.`,
    `${pause.paused_by === "operator" ? "Paused by the operator" : "Paused automatically"} because ${pause.reason.trim().replace(/[\s.;,]+$/, "")}. The project's people (once someone claimed it) and the operator were emailed; everything else keeps working. Tell the person you work for. Don't retry or work around it (that breaks the Acceptable Use Policy, https://agentfirststack.com/acceptable-use). To appeal, write to ${support} with the account id and what the project does.`,
    { capability: pause.capability, paused_at: pause.paused_at, paused_by: pause.paused_by, until: pause.until },
  );
}

/** Throw capability_paused when the capability is paused for this account. */
export async function assertCapability(env: AuthBindings, accountId: string, capability: Capability): Promise<void> {
  const pause = await capabilityPaused(env, accountId, capability);
  if (pause) throw capabilityPausedError(pause);
}

// ---------- pausing ----------

export interface PauseInput {
  accountId: string;
  capability: Capability;
  reason: string;
  /** The service that saw the signal ("mail", "tags", ...) or "operator". */
  by: string;
  /** Ends by itself at this time (unix ms); unset = until lifted. */
  until?: number | null;
  /** Numbers behind the decision, for the operator (stored as JSON, never shown to the public). */
  details?: unknown;
}

export interface PauseResult {
  /** The pause is in force now. */
  paused: boolean;
  /** It already was (the row was left as it was). */
  existing?: boolean;
  /** Not paused: the operator lifted this capability recently (automatic re-pauses wait). */
  skipped?: "recently_lifted";
  /** The row needs its emails sent (new, or re-paused). */
  notify?: boolean;
  pause?: CapabilityPause;
}

export const DEFAULT_LIFT_GRACE_HOURS = 24;

const clean = (s: string, max: number) =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, max);

/**
 * Record a pause in the identity DB (the site's internal route and the fallback of
 * requestCapabilityPause both use it). Idempotent: an active pause stays as it is. An automatic
 * pause within `graceMs` of the operator lifting the same capability is skipped; the operator's own
 * pauses always apply.
 */
export async function recordCapabilityPause(
  db: D1Database,
  input: PauseInput,
  opts: { now?: number; graceMs?: number } = {},
): Promise<PauseResult> {
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? DEFAULT_LIFT_GRACE_HOURS * 3_600_000;
  const reason = clean(input.reason, 300) || "a strong abuse signal";
  const by = clean(input.by, 40) || "service";
  const until = input.until != null && Number.isFinite(input.until) && input.until > now ? Math.floor(input.until) : null;
  const details = input.details === undefined ? null : JSON.stringify(input.details).slice(0, 4000);
  type Row = CapabilityPause & { lifted_at: number | null };
  const row = await db
    .prepare(
      "SELECT capability, reason, paused_at, paused_by, until, lifted_at FROM capability_pauses WHERE account_id = ? AND capability = ?",
    )
    .bind(input.accountId, input.capability)
    .first<Row>();
  const active = row && row.lifted_at == null && (row.until == null || row.until > now);
  if (row && active) {
    const { lifted_at: _, ...pause } = row;
    return { paused: true, existing: true, pause };
  }
  if (row?.lifted_at != null && by !== "operator" && now - row.lifted_at < graceMs) return { paused: false, skipped: "recently_lifted" };
  await db
    .prepare(
      `INSERT INTO capability_pauses (account_id, capability, reason, paused_at, paused_by, until, details, notified_at, lifted_at, lifted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
       ON CONFLICT (account_id, capability) DO UPDATE SET reason = excluded.reason, paused_at = excluded.paused_at,
         paused_by = excluded.paused_by, until = excluded.until, details = excluded.details, notified_at = NULL, lifted_at = NULL, lifted_by = NULL`,
    )
    .bind(input.accountId, input.capability, reason, now, by, until, details)
    .run();
  forgetPauses(input.accountId);
  return { paused: true, notify: true, pause: { capability: input.capability, reason, paused_at: now, paused_by: by, until } };
}

/**
 * For the services: pause a capability of an account after a strong signal. Prefers the site's
 * internal route (it emails the project's people and the operator at once); falls back to writing
 * the row directly (the site's hourly cron then sends the emails). Never throws: a pause that can't
 * be recorded is logged, and the caller carries on refusing what it detected.
 */
export async function requestCapabilityPause(
  env: AuthBindings & { SITE?: Fetcher; PAUSE_LIFT_GRACE_HOURS?: string },
  input: PauseInput,
): Promise<PauseResult> {
  if (env.SITE && env.INTERNAL_TOKEN) {
    try {
      const res = await env.SITE.fetch("https://site.internal/v1/internal/pauses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-afs-internal": env.INTERNAL_TOKEN,
          "x-afs-account": input.accountId,
        },
        body: JSON.stringify({
          account_id: input.accountId,
          capability: input.capability,
          reason: input.reason,
          paused_by: input.by,
          until: input.until ?? null,
          details: input.details,
        }),
      });
      if (res.ok) {
        forgetPauses(input.accountId);
        const j = (await res.json()) as PauseResult;
        return {
          paused: !!j.paused,
          ...(j.existing ? { existing: true } : {}),
          ...(j.skipped ? { skipped: j.skipped } : {}),
          ...(j.pause ? { pause: j.pause } : {}),
        };
      }
      console.error(JSON.stringify({ event: "pause.site_refused", status: res.status, capability: input.capability }));
    } catch (e) {
      console.error("pause via site failed", e);
    }
  }
  try {
    const hours = Number(env.PAUSE_LIFT_GRACE_HOURS);
    const graceMs = (Number.isFinite(hours) && hours >= 0 && env.PAUSE_LIFT_GRACE_HOURS ? hours : DEFAULT_LIFT_GRACE_HOURS) * 3_600_000;
    return await recordCapabilityPause(identityDb(env), input, { graceMs });
  } catch (e) {
    console.error("capability pause not recorded", input.capability, e);
    return { paused: false };
  }
}
