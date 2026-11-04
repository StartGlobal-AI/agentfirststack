import { type AuthBindings, identityDb, isSchemaError } from "./auth";

/**
 * An account's standing, for every app's hot paths (public ingest keyed by a site or container id,
 * where there is no API key to check):
 *   - suspended: the operator stopped the account (abuse). Keys stop working (authenticate()), and
 *     data planes refuse its traffic.
 *   - claimed:   a person signed in with Google has claimed it (it has a membership). Unclaimed
 *     accounts are agent-only and get the lower UNCLAIMED_* caps, see capFor().
 *
 * Read from the identity database and cached per isolate for a minute, so a hot path costs one D1
 * read per account per isolate per minute at most. Single-app self-hosting without the people
 * tables (no memberships) reads as claimed, so no UNCLAIMED_* cap applies there by surprise.
 */
export interface Standing {
  suspended: boolean;
  claimed: boolean;
}

const TTL_MS = 60_000;
const MAX_ENTRIES = 5_000;
const cache = new Map<string, { at: number; standing: Standing }>();

export async function accountStanding(env: AuthBindings, accountId: string): Promise<Standing> {
  const now = Date.now();
  const hit = cache.get(accountId);
  if (hit && now - hit.at < TTL_MS) return hit.standing;
  const db = identityDb(env);
  let standing: Standing = { suspended: false, claimed: true };
  try {
    const row = await db
      .prepare(
        "SELECT a.suspended_at AS suspended_at, EXISTS (SELECT 1 FROM memberships m WHERE m.account_id = a.id) AS claimed FROM accounts a WHERE a.id = ?",
      )
      .bind(accountId)
      .first<{ suspended_at: number | null; claimed: number }>();
    if (row) standing = { suspended: row.suspended_at != null, claimed: !!row.claimed };
  } catch (e) {
    if (!isSchemaError(e)) return unreadable(e);
    // No memberships table (a single app self-hosted without the site): suspension only.
    try {
      const row = await db
        .prepare("SELECT suspended_at FROM accounts WHERE id = ?")
        .bind(accountId)
        .first<{ suspended_at: number | null }>();
      if (row) standing = { suspended: row.suspended_at != null, claimed: true };
    } catch (e2) {
      // Older schema without suspended_at: nothing to enforce.
      if (!isSchemaError(e2)) return unreadable(e2);
    }
  }
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(accountId, { at: now, standing });
  return standing;
}

/**
 * The identity DB couldn't be read (not an old schema: an outage). Hot paths keep working, but with
 * the lower unclaimed caps, and nothing is cached, so the real standing applies once D1 answers.
 */
function unreadable(e: unknown): Standing {
  console.error("account standing unreadable", e);
  return { suspended: false, claimed: false };
}

/** Forget a cached standing (after suspending or claiming, in the same isolate). */
export function forgetStanding(accountId: string): void {
  cache.delete(accountId);
}

/**
 * A numeric cap from a var, by standing: `UNCLAIMED_<NAME>` applies to unclaimed accounts when
 * set, otherwise `<NAME>`; `fallback` when neither is set (use Infinity for "no cap").
 * Non-numeric or negative values count as unset.
 */
export function capFor(env: Record<string, unknown>, standing: Standing, name: string, fallback: number): number {
  const read = (k: string) => {
    const v = env[k];
    if (v === undefined || v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  if (!standing.claimed) {
    const u = read(`UNCLAIMED_${name}`);
    if (u !== undefined) return u;
  }
  return read(name) ?? fallback;
}
