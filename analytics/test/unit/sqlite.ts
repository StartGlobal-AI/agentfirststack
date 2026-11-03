import { DatabaseSync } from "node:sqlite";
import type { Db, Row } from "../../src/do/engine";
import { migrate } from "../../src/do/engine";
import type { SqlValue } from "../../src/lib/query";

/** The engine's Db interface over node:sqlite, so unit tests run the real SQL. */
export function memoryDb(opts: { migrate?: boolean } = {}): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  const plain = (r: Record<string, unknown>) => ({ ...r }) as Row;
  const changes = () => Number(raw.prepare("SELECT total_changes() AS n").all()[0]!.n);
  const db = {
    raw,
    all: (sql: string, args: SqlValue[] = []) =>
      raw
        .prepare(sql)
        .all(...args)
        .map(plain),
    run: (sql: string, args: SqlValue[] = []) => {
      raw.prepare(sql).run(...args);
    },
    // Lazy like the DO cursor. node:sqlite has no rows-read counter, so rowsRead stays 0 here.
    cursor: (sql: string) => {
      const before = changes();
      const it = raw.prepare(sql).iterate();
      return {
        next: () => {
          const r = it.next();
          return r.done ? r : { done: false, value: plain(r.value as Record<string, unknown>) };
        },
        rowsRead: 0,
        get rowsWritten() {
          return changes() - before;
        },
      };
    },
    transaction: <T>(fn: () => T): T => {
      raw.exec("BEGIN");
      try {
        const r = fn();
        raw.exec("COMMIT");
        return r;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
  if (opts.migrate !== false) migrate(db);
  return db;
}
