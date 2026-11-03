/**
 * Path globs in filters (`page=/pricing*`): `*` matches anything, the rest is literal. Translated
 * to SQLite GLOB patterns, where `?` and `[` are special and need bracketing.
 */
export function sqlGlob(glob: string): string {
  return glob.replace(/[[?]/g, (c) => `[${c}]`);
}

export function validGlob(glob: string): boolean {
  return glob.length > 0 && glob.length <= 500 && (glob[0] === "/" || glob[0] === "*");
}
