/**
 * User properties: the last value of each key per identified user (user_props), set by server
 * events (user_props) and afsa('identify', id, props). A browser value never replaces one a
 * server set (anyone can send browser events). Used as user:<key> in filters and breakdowns: an
 * event matches through its user id, so events of anonymous visitors have no user properties.
 */

import type { Db } from "./common";
import { num } from "./common";

export const USER_PROPS_SQL = [
  `CREATE TABLE IF NOT EXISTS user_props (
    user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL, ts INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  )`,
  "CREATE INDEX IF NOT EXISTS user_props_key ON user_props(key, value)",
];

export const MAX_USER_PROPS_PER_USER = 30;
export const DEFAULT_MAX_USER_PROP_KEYS = 50;
export const DEFAULT_MAX_BROWSER_USER_PROP_KEYS = 20;

/**
 * Apply one event's user properties. Keys have two budgets: keys a server set (`maxKeys`), and
 * keys only browsers created (`maxBrowserKeys`), so unauthenticated browser events can never use
 * up the keys a server needs. Returns whether some key was refused by its budget.
 */
export function setUserProps(
  db: Db,
  userId: string,
  props: Record<string, string | null>,
  ts: number,
  source: "browser" | "server",
  maxKeys: number,
  maxBrowserKeys = DEFAULT_MAX_BROWSER_USER_PROP_KEYS,
): { refused: boolean } {
  let refused = false;
  // key -> set by a server (true) or only by browsers (false)
  let keys: Map<string, boolean> | null = null;
  for (const [key, value] of Object.entries(props).slice(0, MAX_USER_PROPS_PER_USER)) {
    const cur = db.all("SELECT source, ts FROM user_props WHERE user_id = ? AND key = ?", [userId, key])[0];
    if (cur && (num(cur.ts) > ts || (cur.source === "server" && source === "browser"))) continue;
    if (value == null) {
      if (cur) db.run("DELETE FROM user_props WHERE user_id = ? AND key = ?", [userId, key]);
      continue;
    }
    if (!cur) {
      keys ??= new Map(
        db.all("SELECT key, MAX(source = 'server') AS srv FROM user_props GROUP BY key").map((r) => [String(r.key), num(r.srv) === 1]),
      );
      const known = keys.get(key);
      const serverKeys = [...keys.values()].filter(Boolean).length;
      const browserKeys = keys.size - serverKeys;
      if (source === "server" && known !== true) {
        if (serverKeys >= maxKeys) {
          refused = true;
          continue;
        }
        keys.set(key, true);
      } else if (source === "browser" && known === undefined) {
        if (browserKeys >= maxBrowserKeys) {
          refused = true;
          continue;
        }
        keys.set(key, false);
      }
      const n = num(db.all("SELECT COUNT(*) AS n FROM user_props WHERE user_id = ?", [userId])[0]?.n);
      if (n >= MAX_USER_PROPS_PER_USER) continue;
    }
    db.run(
      `INSERT INTO user_props (user_id, key, value, source, ts) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, source = excluded.source, ts = excluded.ts`,
      [userId, key, value, source, ts],
    );
  }
  return { refused };
}

/** The keys in use: how many users have each, and its most common values. */
export function listUserProps(db: Db, limit = 50) {
  const keys = db.all(
    "SELECT key, COUNT(*) AS users, COUNT(DISTINCT value) AS distinct_values FROM user_props GROUP BY key ORDER BY users DESC, key LIMIT ?",
    [limit],
  );
  return {
    keys: keys.map((k) => ({
      key: k.key,
      users: num(k.users),
      distinct_values: num(k.distinct_values),
      top_values: db
        .all("SELECT value, COUNT(*) AS users FROM user_props WHERE key = ? GROUP BY value ORDER BY users DESC, value LIMIT 10", [
          String(k.key),
        ])
        .map((v) => ({ value: v.value, users: num(v.users) })),
    })),
  };
}

export function userPropsOf(db: Db, userId: string): Record<string, string> {
  return Object.fromEntries(
    db.all("SELECT key, value FROM user_props WHERE user_id = ? ORDER BY key", [userId]).map((r) => [String(r.key), String(r.value)]),
  );
}
