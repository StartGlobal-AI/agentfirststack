/**
 * The tiny storage interface the per-site engine runs on: the Durable Object's SQLite in
 * production, node:sqlite in unit tests (test/unit/sqlite.ts), so the real SQL is tested.
 */

export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

export interface Db {
  all(sql: string, args?: SqlValue[]): Row[];
  run(sql: string, args?: SqlValue[]): void;
  /** Run fn in a transaction; throw inside to roll back. */
  transaction<T>(fn: () => T): T;
}

export const num = (v: SqlValue | undefined): number => (v === null || v === undefined ? 0 : Number(v));
export const strOrNull = (v: SqlValue | undefined): string | null => (v === null || v === undefined ? null : String(v));

/** "?, ?, ?" for a short, fixed list of values (DO SQLite allows at most 100 bound parameters). */
export const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** `IN ${IN_JSON}` with one argument, JSON.stringify(list): any number of values in one parameter. */
export const IN_JSON = "(SELECT value FROM json_each(?))";

export const DAY = 86_400_000;
export const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);
export const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);

export interface DoError {
  error: { code: string; message: string; hint?: string };
}
export const err = (code: string, message: string, hint?: string): DoError => ({ error: { code, message, ...(hint ? { hint } : {}) } });
export const isDoError = (v: unknown): v is DoError =>
  !!v && typeof v === "object" && "error" in v && typeof (v as DoError).error?.code === "string";
