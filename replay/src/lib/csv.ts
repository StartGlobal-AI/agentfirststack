/**
 * CSV for exports. Cells are quoted when needed, and text starting with = + - @ (or a tab / CR) gets
 * a leading ' so a spreadsheet never runs recorded or visitor-typed text as a formula.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (typeof v === "string" || Array.isArray(v)) if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells: readonly unknown[]) => cells.map(csvCell).join(",");

export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [csvLine(header), ...rows.map(csvLine)].join("\r\n") + "\r\n";
}
