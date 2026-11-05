import type { Context } from "hono";
import { type AuthBindings, identityDb } from "./auth";

/**
 * Project notices: something new the platform has for one project ("forward the inbox to the
 * owner"), told to the project's agent in-band, since agents only run when someone starts them.
 *
 * The site owns `project_notices` in the identity DB (one row per account: `notice` for the agent,
 * ending with the call to run; `owner_notice` for people; `shown_at`). Its daily cron writes rows and
 * its setup check deletes the project's row. Services only read a row and set `shown_at`:
 *   - REST, in requireAuth(): `AFS-Notice: <notice>` on every answer while the row exists, and at
 *     most once a day a top-level `"notice"` field in a small JSON object answer to a GET.
 *   - MCP, in handleMcp(): at most once a day, one more text item on a successful tools/call result.
 * Internal callers (x-afs-internal) and unauthenticated requests never get one.
 *
 * Cost: an in-isolate cache per account (10 minutes) remembers "no notice" and "shown until", so
 * most requests make no D1 query; a miss is one primary-key SELECT, run alongside the handler.
 * Never fails or slows a request: any error (no AUTH_DB, no table in a standalone app, a D1 hiccup)
 * or a lookup slower than LOOKUP_TIMEOUT_MS reads as "no notice", logged once per isolate.
 */

const DAY_MS = 86_400_000;
/** How long an isolate trusts what it read about an account's notice. */
export const NOTICE_CACHE_MS = 10 * 60_000;
const MAX_ENTRIES = 5_000;
const LOOKUP_TIMEOUT_MS = 250;
export const NOTICE_HEADER = "AFS-Notice";
const MAX_HEADER_CHARS = 500;
/** JSON answers larger than this never get the `notice` field (they aren't read to add it). */
const MAX_BODY_BYTES = 256 * 1024;
/** Prefix of the extra MCP content item. */
export const MCP_NOTICE_PREFIX = "AgentFirstStack notice for this project: ";

interface Entry {
  /** when this isolate read (or wrote) it */
  at: number;
  notice: string | null;
  /** last shown_at known here; null = never shown */
  shownAt: number | null;
}

const cache = new Map<string, Entry>();

function remember(accountId: string, entry: Entry): void {
  cache.delete(accountId);
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(accountId, entry);
}

/** Forget what this isolate knows about an account's notice (after writing or deleting its row). */
export function forgetNotice(accountId?: string): void {
  if (accountId === undefined) cache.clear();
  else cache.delete(accountId);
}

let warned = false;
function warnOnce(e: unknown): void {
  if (warned) return;
  warned = true;
  console.warn("project notices unavailable, answers carry none:", String((e as Error)?.message ?? e));
}

/** `p`, or `fallback` if it takes longer than `ms` (the query keeps running; its result is cached when it lands). */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([p, late]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

async function entryFor(env: AuthBindings, accountId: string, now: number): Promise<Entry> {
  const hit = cache.get(accountId);
  if (hit && now >= hit.at && now - hit.at < NOTICE_CACHE_MS) return hit;
  const empty: Entry = { at: now, notice: null, shownAt: null };
  let query: Promise<Entry>;
  try {
    query = identityDb(env)
      .prepare("SELECT notice, shown_at FROM project_notices WHERE account_id = ?")
      .bind(accountId)
      .first<{ notice: unknown; shown_at: unknown }>()
      .then(
        (row) => {
          const notice = text(row?.notice);
          const entry: Entry = notice ? { at: now, notice, shownAt: typeof row?.shown_at === "number" ? row.shown_at : null } : empty;
          remember(accountId, entry);
          return entry;
        },
        (e: unknown) => {
          // A standalone app without the site's table, or D1 unavailable: no notice for a while.
          warnOnce(e);
          remember(accountId, empty);
          return empty;
        },
      );
  } catch (e) {
    warnOnce(e); // no database bound at all
    remember(accountId, empty);
    return empty;
  }
  return within(query, LOOKUP_TIMEOUT_MS, empty);
}

/** The project's current notice, or null. Cached; never throws. For the `AFS-Notice` header. */
export async function pendingNotice(env: AuthBindings, accountId: string, now = Date.now()): Promise<string | null> {
  try {
    return (await entryFor(env, accountId, now)).notice;
  } catch (e) {
    warnOnce(e);
    return null;
  }
}

/** True when this isolate knows of a notice not shown in the last 24 hours (as takeNotice's UPDATE decides). */
function mayBeDue(accountId: string, now: number): boolean {
  const e = cache.get(accountId);
  return !!e?.notice && (e.shownAt === null || e.shownAt < now - DAY_MS);
}

/**
 * The project's notice when it is due (never shown, or last shown over 24 hours ago), marking it
 * shown in the same statement, so concurrent requests on any isolate show it once. Else null.
 * Cached (most calls make no query); never throws.
 */
export async function takeNotice(env: AuthBindings, accountId: string, now = Date.now()): Promise<string | null> {
  try {
    const e = await entryFor(env, accountId, now);
    if (!e.notice || !mayBeDue(accountId, now)) return null;
    const row = await within(
      identityDb(env)
        .prepare("UPDATE project_notices SET shown_at = ? WHERE account_id = ? AND (shown_at IS NULL OR shown_at < ?) RETURNING notice")
        .bind(now, accountId, now - DAY_MS)
        .first<{ notice: unknown }>(),
      LOOKUP_TIMEOUT_MS,
      null,
    );
    const taken = text(row?.notice);
    // Shown now, here or (no row back) by another isolate; the entry expires and is re-read anyway.
    remember(accountId, { at: now, notice: taken ?? e.notice, shownAt: now });
    return taken;
  } catch (err) {
    warnOnce(err);
    return null;
  }
}

/**
 * The text for the project's people (owner_notice, else notice), or null. Reads the row without
 * marking it shown (shown_at is the agent channel), uncached; never throws. For reports and emails.
 */
export async function ownerNotice(env: AuthBindings, accountId: string): Promise<string | null> {
  try {
    const row = await within(
      identityDb(env)
        .prepare("SELECT notice, owner_notice FROM project_notices WHERE account_id = ?")
        .bind(accountId)
        .first<{ notice: unknown; owner_notice: unknown }>(),
      2_000,
      null,
    );
    return text(row?.owner_notice) ?? text(row?.notice);
  } catch (e) {
    warnOnce(e);
    return null;
  }
}

const ASCII: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u2026": "...",
  "\u00a0": " ",
};

/** One line of printable ASCII (header values must be), at most 500 characters. */
export function headerSafeNotice(notice: string): string {
  const flat = notice
    .replace(/[\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u00a0]/g, (ch) => ASCII[ch] ?? "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]+/g, (run) => (/[\r\n\t]/.test(run) ? " " : ""))
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > MAX_HEADER_CHARS ? `${flat.slice(0, MAX_HEADER_CHARS - 3).trimEnd()}...` : flat;
}

// Requests whose answer is already handled (requireAuth mounted twice on one route).
const handled = new WeakSet<Request>();

/**
 * For requireAuth(), API-key callers only: call before the handler (starts the cached lookup while
 * the handler runs), then await the returned function after it. Null when the route never carries
 * a notice: /v1/signup, /mcp (handleMcp has its own) and the site's setup check, /v1/setup[/*]
 * (the call every notice asks for, which deletes the row).
 */
export function noticeAttacher(env: AuthBindings, accountId: string, req: Request): ((c: Context) => Promise<void>) | null {
  let path: string;
  try {
    path = new URL(req.url).pathname;
  } catch {
    return null;
  }
  const skip = ["/v1/signup", "/mcp", "/v1/setup"].some((p) => path === p || path.startsWith(`${p}/`));
  if (skip || handled.has(req)) return null;
  handled.add(req);
  const pending = pendingNotice(env, accountId);
  const method = req.method;
  return async (c) => {
    try {
      const notice = await pending;
      if (!notice) return;
      setHeader(c, NOTICE_HEADER, headerSafeNotice(notice));
      // The body field, once a day: only in answers to GETs, so a backend posting events with the
      // project's key doesn't use up the day's notice before the agent sees it.
      if (method !== "GET" || !mayBeDue(accountId, Date.now())) return;
      const res = c.res;
      if (!jsonObjectAnswer(res)) return;
      const body = await smallJsonObject(res);
      if (!body || "notice" in body) return;
      const taken = await takeNotice(env, accountId);
      if (!taken) return;
      const headers = new Headers(res.headers);
      headers.delete("content-length");
      headers.delete("etag");
      const next = new Response(JSON.stringify({ notice: taken, ...body }), { status: res.status, statusText: res.statusText, headers });
      res.body?.cancel().catch(() => {});
      // Unset first: assigning over a response merges the old one's headers into the new one.
      c.res = undefined;
      c.res = next;
    } catch (e) {
      warnOnce(e);
    }
  };
}

function setHeader(c: Context, name: string, value: string): void {
  try {
    c.res.headers.set(name, value);
  } catch {
    // Immutable headers (a response passed through from fetch): copy it (Hono merges the headers).
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set(name, value);
  }
}

/** A 2xx `application/json` answer with a body, not a download and not encoded. */
function jsonObjectAnswer(res: Response): boolean {
  if (res.status < 200 || res.status >= 300 || !res.body) return false;
  if (!/^application\/json\s*(;|$)/i.test(res.headers.get("content-type") ?? "")) return false;
  if (res.headers.has("content-disposition")) return false;
  const enc = res.headers.get("content-encoding");
  if (enc && enc.toLowerCase() !== "identity") return false;
  const declared = res.headers.get("content-length");
  return declared === null || Number(declared) <= MAX_BODY_BYTES;
}

/** The answer's JSON object, read from a clone (the answer itself is untouched), or null. */
async function smallJsonObject(res: Response): Promise<Record<string, unknown> | null> {
  const reader = res.clone().body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  const raw = new TextDecoder().decode(bytes);
  if (!raw.trimStart().startsWith("{")) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
