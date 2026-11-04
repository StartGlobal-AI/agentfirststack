/**
 * What agents and people add to a recorded session: notes at a point in time, labels, a star.
 * All rows go with the session (privacy deletion, retention); a starred session outlives
 * retention_days up to MAX_STARRED_RETENTION_DAYS (see engine.purgeRound).
 */

import { type Db, IN_JSON, num, strOrNull } from "./db";
import { starredBytes } from "./engine";

export interface NoteRow {
  id: string;
  session_id: string;
  t_ms: number;
  text: string;
  created_at: number;
}

export function addNote(
  db: Db,
  q: { id: string; session_id: string; t_ms: number; text: string; now: number; per_session: number; per_site: number | null },
): { ok: true; note: NoteRow } | { ok: false; reason: "not_found" | "session_limit" | "site_limit" } {
  return db.transaction(() => {
    const s = db.all("SELECT duration_ms FROM sessions WHERE id = ?", [q.session_id])[0];
    if (!s) return { ok: false as const, reason: "not_found" as const };
    if (num(db.all("SELECT COUNT(*) AS n FROM notes WHERE session_id = ?", [q.session_id])[0]?.n) >= q.per_session)
      return { ok: false as const, reason: "session_limit" as const };
    if (q.per_site !== null && num(db.all("SELECT COUNT(*) AS n FROM notes")[0]?.n) >= q.per_site)
      return { ok: false as const, reason: "site_limit" as const };
    const note: NoteRow = { id: q.id, session_id: q.session_id, t_ms: Math.max(0, Math.round(q.t_ms)), text: q.text, created_at: q.now };
    db.run("INSERT INTO notes (id, session_id, t_ms, text, created_at) VALUES (?, ?, ?, ?, ?)", [
      note.id,
      note.session_id,
      note.t_ms,
      note.text,
      note.created_at,
    ]);
    return { ok: true as const, note };
  });
}

export const listNotes = (db: Db, sid: string): NoteRow[] =>
  db.all("SELECT * FROM notes WHERE session_id = ? ORDER BY t_ms, created_at LIMIT 500", [sid]) as unknown as NoteRow[];

export function deleteNote(db: Db, sid: string, id: string): boolean {
  if (!db.all("SELECT 1 FROM notes WHERE id = ? AND session_id = ?", [id, sid]).length) return false;
  db.run("DELETE FROM notes WHERE id = ?", [id]);
  return true;
}

export const sessionLabels = (db: Db, sid: string): string[] =>
  db.all("SELECT label FROM session_labels WHERE session_id = ? ORDER BY label", [sid]).map((r) => String(r.label));

export function labelsOf(db: Db, ids: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  for (const r of db.all(`SELECT session_id, label FROM session_labels WHERE session_id IN ${IN_JSON} ORDER BY label`, [
    JSON.stringify(ids),
  ])) {
    const k = String(r.session_id);
    out.set(k, [...(out.get(k) ?? []), String(r.label)]);
  }
  return out;
}

/**
 * Star a session and/or replace its labels. Caps: starred sessions per site, labels per session,
 * distinct labels per site.
 */
export function annotate(
  db: Db,
  q: {
    session_id: string;
    starred?: boolean;
    labels?: string[];
    max_starred: number | null;
    labels_per_session: number;
    max_labels: number | null;
    now: number;
    /** MAX_STARRED_BYTES_PER_SITE: bytes of starred playback copies */
    max_starred_bytes?: number | null;
  },
):
  | { ok: true; starred: boolean; labels: string[]; was_starred: boolean }
  | { ok: false; reason: "not_found" | "starred_limit" | "labels_limit" | "site_labels_limit" | "starred_bytes_limit" } {
  return db.transaction(() => {
    const s = db.all("SELECT starred, bytes FROM sessions WHERE id = ?", [q.session_id])[0];
    if (!s) return { ok: false as const, reason: "not_found" as const };
    if (q.starred === true && !num(s.starred) && q.max_starred !== null) {
      if (num(db.all("SELECT COUNT(*) AS n FROM sessions WHERE starred = 1")[0]?.n) >= q.max_starred)
        return { ok: false as const, reason: "starred_limit" as const };
    }
    // the playback copies of starred sessions count against the site's storage cap
    if (q.starred === true && !num(s.starred) && q.max_starred_bytes !== null && q.max_starred_bytes !== undefined) {
      if (starredBytes(db) + num(s.bytes) > q.max_starred_bytes) return { ok: false as const, reason: "starred_bytes_limit" as const };
    }
    if (q.labels) {
      if (q.labels.length > q.labels_per_session) return { ok: false as const, reason: "labels_limit" as const };
      if (q.max_labels !== null) {
        const known = new Set(db.all("SELECT DISTINCT label FROM session_labels LIMIT 5000").map((r) => String(r.label)));
        const added = q.labels.filter((l) => !known.has(l)).length;
        if (known.size + added > q.max_labels) return { ok: false as const, reason: "site_labels_limit" as const };
      }
      db.run("DELETE FROM session_labels WHERE session_id = ?", [q.session_id]);
      for (const l of q.labels) db.run("INSERT OR IGNORE INTO session_labels (session_id, label) VALUES (?, ?)", [q.session_id, l]);
    }
    if (q.starred !== undefined) db.run("UPDATE sessions SET starred = ? WHERE id = ?", [q.starred ? 1 : 0, q.session_id]);
    const starred = !!num(db.all("SELECT starred FROM sessions WHERE id = ?", [q.session_id])[0]?.starred);
    return { ok: true as const, starred, labels: sessionLabels(db, q.session_id), was_starred: !!num(s.starred) };
  });
}

/** Labels in use on the site with how many sessions have each. */
export const siteLabels = (db: Db) =>
  db
    .all("SELECT label, COUNT(*) AS n FROM session_labels GROUP BY label ORDER BY n DESC, label LIMIT 1000")
    .map((r) => ({ label: String(r.label), sessions: num(r.n) }));

export { strOrNull };
