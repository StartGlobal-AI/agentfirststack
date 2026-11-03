import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Just enough of D1Database over node:sqlite for unit tests: prepare/bind/first/all/run and
 * batch. Migrations from a directory are applied in order, so tests run the real schema.
 */
export function memoryD1(migrationsDir?: URL): D1Database {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  if (migrationsDir) {
    for (const f of readdirSync(migrationsDir)
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      raw.exec(readFileSync(new URL(f, migrationsDir), "utf8"));
    }
  }
  const norm = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v);
  const statement = (sql: string, args: unknown[] = []) => {
    const stmt = {
      bind: (...a: unknown[]) => statement(sql, a.map(norm)),
      first: async <T>(col?: string) => {
        const row = raw.prepare(sql).get(...args) as Record<string, unknown> | undefined;
        if (!row) return null;
        return (col ? row[col] : { ...row }) as T;
      },
      all: async <T>() => ({
        results: raw
          .prepare(sql)
          .all(...args)
          .map((r) => ({ ...r })) as T[],
        success: true,
        meta: {},
      }),
      run: async () => {
        const r = raw.prepare(sql).run(...args);
        return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
      raw: async () =>
        raw
          .prepare(sql)
          .all(...args)
          .map((r) => Object.values(r)),
    };
    return stmt;
  };
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: { run: () => Promise<unknown> }[]) => {
      raw.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
    exec: async (sql: string) => {
      raw.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return db as unknown as D1Database;
}
