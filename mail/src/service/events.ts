import { badRequest } from "@afs/shared";
import { type AppEnv, standingOf } from "../env";
import { parkOnInbox } from "../lib/park";
import { assertActive, rateLimit } from "./budgets";
import { FEED_EVENT_TYPES, feedObjectName } from "./feed";
import { getInboxRow } from "./inboxes";
import { acquireWaitSlot, clampTimeout, releaseWaitSlot } from "./wait";

/**
 * GET /v1/events and wait_for_event: the account's events (the same ones webhooks get) after a
 * cursor, oldest first. With timeout > 0 and nothing new, the call blocks (a hibernating park on
 * the account's feed object, like wait_for_email) until an event lands or the timeout passes, and
 * then answers 200 with what it has (possibly none) and the cursor to continue from.
 *
 *   after    the next_after of the previous call; "latest" = from now on (returns at once with the
 *            current cursor and no events, so a loop can start without replaying the last 7 days);
 *            omitted = the oldest event kept (7 days).
 *   types    comma-separated event types; inbox_id one inbox.
 * Waits share the account's concurrent-wait slots (MAX_CONCURRENT_WAITS) and rate limit.
 */

export interface EventQuery {
  after?: string | number;
  types?: string;
  inbox_id?: string;
  limit?: number;
  timeout?: number;
}

interface EventRow {
  seq: number;
  id: string;
  inbox_id: string | null;
  type: string;
  data_json: string;
  created_at: number;
}

function parseTypes(types: string | undefined): string[] {
  if (!types) return [];
  const list = [
    ...new Set(
      types
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
  for (const t of list)
    if (!(FEED_EVENT_TYPES as readonly string[]).includes(t))
      throw badRequest(`Unknown event type "${t}".`, `Event types: ${FEED_EVENT_TYPES.join(", ")}.`);
  return list;
}

export function eventJson(r: EventRow) {
  return { id: r.id, seq: r.seq, type: r.type, inbox_id: r.inbox_id, created_at: r.created_at, data: JSON.parse(r.data_json) as unknown };
}

export async function listEvents(env: AppEnv, accountId: string, q: EventQuery = {}) {
  const started = Date.now();
  const standing = await standingOf(env, accountId);
  assertActive(standing);
  const types = parseTypes(q.types);
  if (q.inbox_id) await getInboxRow(env, accountId, q.inbox_id);
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const latest = String(q.after ?? "") === "latest";
  const maxSeq = async () =>
    (await env.DB.prepare("SELECT MAX(seq) AS s FROM events WHERE account_id = ?").bind(accountId).first<{ s: number | null }>())?.s ?? 0;
  if (latest) return { events: [], next_after: String(await maxSeq()), waited_ms: 0 };
  const raw = q.after === undefined || q.after === "" ? "0" : String(q.after);
  if (!/^\d+$/.test(raw))
    throw badRequest(
      "Invalid `after`.",
      'Pass next_after from the previous call, "latest" to start from now, or omit it for everything kept (7 days).',
    );
  const after = Number(raw);

  const where = ["account_id = ?", "seq > ?"];
  const binds: unknown[] = [accountId, after];
  if (q.inbox_id) {
    where.push("inbox_id = ?");
    binds.push(q.inbox_id);
  }
  if (types.length) {
    where.push("type IN (SELECT value FROM json_each(?))");
    binds.push(JSON.stringify(types));
  }
  const find = () =>
    env.DB.prepare(
      `SELECT seq, id, inbox_id, type, data_json, created_at FROM events WHERE ${where.join(" AND ")} ORDER BY seq ASC LIMIT ?`,
    )
      .bind(...binds, limit + 1)
      .all<EventRow>()
      .then((r) => r.results);
  const answer = async (rows: EventRow[]) => {
    const page = rows.slice(0, limit);
    // Nothing matched: continue from the newest event seen, so filtered-out events are not re-scanned.
    const next = page.length ? page[page.length - 1]!.seq : Math.max(after, await maxSeq());
    return { events: page.map(eventJson), next_after: String(next), more: rows.length > limit, waited_ms: Date.now() - started };
  };

  const first = await find();
  const timeout = clampTimeout(q.timeout ?? 0);
  if (first.length || timeout <= 0) return answer(first);
  await rateLimit(
    env.WAIT_LIMITER,
    `wait:${accountId}`,
    "wait",
    "Waits are limited per account per minute. Use a longer timeout (up to 120 s) instead of many short ones. Retry in a minute.",
  );
  const deadline = started + timeout * 1000;
  const target = { id: feedObjectName(accountId), account_id: accountId, address: "the event feed" };
  const slot = await acquireWaitSlot(env, standing, target, deadline);
  const stub = env.INBOX.get(env.INBOX.idFromName(target.id));
  try {
    let version = await stub.version();
    for (;;) {
      const rows = await find();
      if (rows.length) return answer(rows);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const r = await parkOnInbox(stub, version, remaining);
      if (!r.woken) break;
      if (r.version === version) await new Promise((res) => setTimeout(res, Math.min(250, Math.max(0, deadline - Date.now()))));
      version = r.version;
    }
  } finally {
    if (slot) await releaseWaitSlot(env, slot);
  }
  return answer(await find());
}
