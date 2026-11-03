import { DatabaseSync } from "node:sqlite";
import type { Db, Row, SqlValue } from "../../src/do/db";
import { migrate } from "../../src/do/engine";

/** The engine's Db interface over node:sqlite, so unit tests run the real SQL. */
export function memoryDb(migrated = true): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  const plain = (r: Record<string, unknown>) => ({ ...r }) as Row;
  let depth = 0;
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
    // Like ctx.storage.transactionSync: nested calls join the outer transaction.
    transaction: <T>(fn: () => T): T => {
      if (depth > 0) return fn();
      depth++;
      raw.exec("BEGIN");
      try {
        const r = fn();
        raw.exec("COMMIT");
        return r;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
  };
  if (migrated) migrate(db);
  return db;
}
