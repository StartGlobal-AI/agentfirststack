// Minimal Node typings for the unit tests (the package has no @types/node; tsconfig uses workerd types).
declare module "node:sqlite" {
  interface StatementSync {
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): { changes: number | bigint };
    iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}
declare module "node:zlib" {
  export function gzipSync(data: string | Uint8Array): Uint8Array;
}
declare module "node:crypto" {
  export function createHmac(alg: string, key: string): { update(s: string): { digest(enc: "hex"): string } };
}
declare module "node:vm" {
  export function runInNewContext(code: string, context: Record<string, unknown>): unknown;
}

interface ImportMeta {
  url: string;
}
