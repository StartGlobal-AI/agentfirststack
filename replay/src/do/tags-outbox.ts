/**
 * Replay signals for a linked tags container: taken from a session's derived events once they
 * can't change any more (like the analytics forwarding, but with its own bit in events.forwarded and
 * its own daily budget, daily.tags_forwarded), queued in tags_outbox, and sent in batches of up to
 * 100 by the DO's alarm (one request per site every 15 s at most, retried with backoff). Rows go
 * when tags accepted them, after a day, or with their session or survey response (privacy deletion).
 */

import { type TagsItem, type TagsServerEvent, type TagsSignal, tagsEvent } from "../lib/tags";
import { DAY, type Db, num, type Row, strOrNull, utcDay } from "./db";

/** events.forwarded bits: 1 = sent to analytics, 2 = queued for tags. */
export const FWD_ANALYTICS = 1;
export const FWD_TAGS = 2;

export interface TagsRequest {
  /** the site's domain, for page_url */
  host: string;
  signals: TagsSignal[];
  /** the tags runtime's visitor id on the recorded page (afst.visitorId()), if any */
  visitor_id: string | null;
  /** events queued per UTC day (MAX_TAGS_EVENTS_PER_SITE_PER_DAY); null = no cap */
  daily: number | null;
}

/** Room left today under the site's tags budget. */
export function tagsRoom(db: Db, now: number, daily: number | null): number {
  if (daily === null) return Number.POSITIVE_INFINITY;
  const used = num(db.all("SELECT tags_forwarded FROM daily WHERE day = ?", [utcDay(now)])[0]?.tags_forwarded);
  return Math.max(0, daily - used);
}

/**
 * Settled signals of one session not queued for tags yet, at most `room`: rage bursts once, dead
 * clicks on interactive elements outside rage bursts, each JS error and each failed request
 * fingerprint once per session. Marks what it takes.
 */
export function takeTagsItems(db: Db, sid: string, settledBefore: number, end: boolean, room: number, signals: TagsSignal[]): TagsItem[] {
  const want = new Set(signals);
  const out: TagsItem[] = [];
  const limit = end ? Number.MAX_SAFE_INTEGER : settledBefore;
  if (room <= 0) return out;
  if (want.has("rage_click") || want.has("dead_click")) {
    const clicks = db.all(
      `SELECT id, ts, path, selector, rage, rage_start, dead, interactive FROM events
       WHERE session_id = ? AND kind = 'click' AND (forwarded & ${FWD_TAGS}) = 0 AND ts <= ? AND (open = 0 OR ? = 1)
         AND (rage_start = 1 OR (dead = 1 AND interactive = 1 AND rage = 0))
       ORDER BY ts LIMIT 100`,
      [sid, limit, end ? 1 : 0],
    );
    for (const r of clicks) {
      const name: TagsSignal | null = num(r.rage_start)
        ? "rage_click"
        : num(r.dead) && num(r.interactive) && !num(r.rage)
          ? "dead_click"
          : null;
      if (name && want.has(name)) {
        if (out.length >= room) return out;
        out.push({
          name,
          key: `rp.${sid}.${num(r.id)}`,
          ts: num(r.ts),
          path: strOrNull(r.path),
          params: { replay_session_id: sid, selector: strOrNull(r.selector) },
        });
      }
      db.run(`UPDATE events SET forwarded = forwarded | ${FWD_TAGS} WHERE id = ?`, [num(r.id)]);
    }
  }
  const once = (kind: "error" | "net", signal: TagsSignal, item: (r: Row) => TagsItem) => {
    if (!want.has(signal)) return true;
    const rows = db.all(
      `SELECT id, ts, path, message, fingerprint, tag, href, detail FROM events
       WHERE session_id = ? AND kind = ? AND (forwarded & ${FWD_TAGS}) = 0 AND ts <= ? ORDER BY ts LIMIT 50`,
      [sid, kind, limit],
    );
    const sent = new Set(
      db
        .all(`SELECT DISTINCT fingerprint FROM events WHERE session_id = ? AND kind = ? AND (forwarded & ${FWD_TAGS}) != 0`, [sid, kind])
        .map((r) => String(r.fingerprint)),
    );
    for (const r of rows) {
      const fp = String(r.fingerprint);
      if (!sent.has(fp)) {
        if (out.length >= room) return false;
        sent.add(fp);
        out.push(item(r));
      }
      db.run(`UPDATE events SET forwarded = forwarded | ${FWD_TAGS} WHERE id = ?`, [num(r.id)]);
    }
    return true;
  };
  const ok = once("error", "js_error", (r) => ({
    name: "js_error",
    key: `rp.${sid}.${num(r.id)}`,
    ts: num(r.ts),
    path: strOrNull(r.path),
    params: { replay_session_id: sid, error_fingerprint: String(r.fingerprint), error_message: String(r.message ?? "") },
  }));
  if (!ok) return out;
  once("net", "api_error", (r) => {
    let status: number | null = null;
    try {
      const d = JSON.parse(String(r.detail ?? "{}")) as { status?: unknown };
      status = typeof d.status === "number" ? d.status : null;
    } catch {
      /* no status */
    }
    return {
      name: "api_error",
      key: `rp.${sid}.${num(r.id)}`,
      ts: num(r.ts),
      path: strOrNull(r.path),
      params: {
        replay_session_id: sid,
        error_fingerprint: String(r.fingerprint),
        request_method: strOrNull(r.tag),
        request_url: strOrNull(r.href),
        status_code: status,
      },
    };
  });
  return out;
}

/** Queue built events and count them against today's tags budget. */
export function queueTags(
  db: Db,
  q: { session_id: string | null; response_id?: string | null; events: TagsServerEvent[]; now: number },
): number {
  if (!q.events.length) return 0;
  for (const e of q.events)
    db.run("INSERT INTO tags_outbox (session_id, response_id, created_at, event) VALUES (?, ?, ?, ?)", [
      q.session_id,
      q.response_id ?? null,
      q.now,
      JSON.stringify(e),
    ]);
  db.run(
    `INSERT INTO daily (day, tags_forwarded) VALUES (?, ?)
     ON CONFLICT(day) DO UPDATE SET tags_forwarded = tags_forwarded + excluded.tags_forwarded`,
    [utcDay(q.now), q.events.length],
  );
  return q.events.length;
}

/** Take a session's settled signals and queue them (one call per ingested chunk). */
export function queueSessionSignals(db: Db, sid: string, settledBefore: number, end: boolean, req: TagsRequest, now: number): number {
  const items = takeTagsItems(db, sid, settledBefore, end, tagsRoom(db, now, req.daily), req.signals);
  return queueTags(db, { session_id: sid, events: items.map((i) => tagsEvent(i, req.host, req.visitor_id)), now });
}

export interface OutboxRow {
  id: number;
  tries: number;
  event: TagsServerEvent;
}

/** The oldest queued events (a batch for one request). */
export function tagsDue(db: Db, limit = 100): OutboxRow[] {
  return db
    .all("SELECT id, tries, event FROM tags_outbox ORDER BY id LIMIT ?", [limit])
    .map((r) => ({ id: num(r.id), tries: num(r.tries), event: JSON.parse(String(r.event)) as TagsServerEvent }));
}

export const tagsQueued = (db: Db): number => num(db.all("SELECT COUNT(*) AS n FROM tags_outbox")[0]?.n);

export function tagsDone(db: Db, ids: number[]): void {
  if (ids.length) db.run("DELETE FROM tags_outbox WHERE id IN (SELECT value FROM json_each(?))", [JSON.stringify(ids)]);
}

export function tagsRetry(db: Db, ids: number[]): void {
  if (ids.length) db.run("UPDATE tags_outbox SET tries = tries + 1 WHERE id IN (SELECT value FROM json_each(?))", [JSON.stringify(ids)]);
}

/** Drop events older than a day or tried 8 times; returns how many went. */
export function tagsExpire(db: Db, now: number): number {
  const n = num(db.all("SELECT COUNT(*) AS n FROM tags_outbox WHERE created_at < ? OR tries >= 8", [now - DAY])[0]?.n);
  if (n) db.run("DELETE FROM tags_outbox WHERE created_at < ? OR tries >= 8", [now - DAY]);
  return n;
}

export function tagsClear(db: Db): number {
  const n = tagsQueued(db);
  db.run("DELETE FROM tags_outbox");
  return n;
}

/** Privacy deletion of survey responses: their queued events go too. */
export function dropResponseTags(db: Db, responseIds: string[]): void {
  if (responseIds.length)
    db.run("DELETE FROM tags_outbox WHERE response_id IN (SELECT value FROM json_each(?))", [JSON.stringify(responseIds)]);
}
