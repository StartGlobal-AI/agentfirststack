/**
 * CSV for the REST stats, breakdown and timeseries endpoints (format=csv or Accept: text/csv).
 * RFC 4180 quoting, plus formula-injection protection: a text cell that starts with = + - @ or a
 * tab / carriage return gets a leading ' (page paths and referrers are visitor-sent, and the file
 * is likely opened in a spreadsheet). Numbers are written as numbers.
 */

export function csvCell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  let s = typeof v === "string" ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type Row = Record<string, unknown>;

/** A row with its comparison flattened: <metric>_previous, <metric>_change_percent (and previous_date). */
export function flattenRow(row: Row): Row {
  const { comparison, ...rest } = row;
  const out: Row = {};
  for (const [k, v] of Object.entries(rest)) out[k] = v !== null && typeof v === "object" ? JSON.stringify(v) : v;
  if (comparison && typeof comparison === "object") {
    const c = comparison as { date?: unknown; metrics?: Row; change_percent?: Row };
    if (c.date !== undefined) out.previous_date = c.date;
    for (const [m, v] of Object.entries(c.metrics ?? {})) out[`${m}_previous`] = v;
    for (const [m, v] of Object.entries(c.change_percent ?? {})) out[`${m}_change_percent`] = v;
  }
  return out;
}

export function toCsv(rows: Row[]): string {
  const flat = rows.map(flattenRow);
  const columns: string[] = [];
  for (const r of flat) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
  const lines = [columns.map(csvCell).join(","), ...flat.map((r) => columns.map((c) => csvCell(r[c])).join(","))];
  return `${lines.join("\r\n")}\r\n`;
}

/** The rows a stats / breakdown / timeseries answer turns into. */
export function csvRows(kind: "stats" | "breakdown" | "timeseries", res: Row): Row[] {
  if (kind === "timeseries" || kind === "breakdown") return (res.results as Row[] | undefined) ?? [];
  const b = res.breakdown as { results?: Row[] } | undefined;
  if (b?.results) return b.results;
  const p = res.period as { from?: string; to?: string } | undefined;
  return [{ from: p?.from, to: p?.to, ...(res.metrics as Row), ...(res.comparison ? { comparison: res.comparison } : {}) }];
}

/**
 * Parse CSV (RFC 4180: quoted fields, "" escapes, CRLF or LF) into objects keyed by the header row
 * (lowercased, trimmed). At most `maxRows` data rows; `more` says some were left.
 */
export function parseCsv(text: string, maxRows: number): { rows: Record<string, string>[]; more: boolean } {
  const records: string[][] = [];
  let field = "";
  let rec: string[] = [];
  let quoted = false;
  let more = false;
  const end = () => {
    rec.push(field);
    field = "";
    if (rec.length > 1 || rec[0] !== "") records.push(rec);
    rec = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      rec.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      end();
      if (records.length > maxRows) {
        more = true;
        break;
      }
    } else field += c;
  }
  if (!more && (field !== "" || rec.length)) end();
  if (records.length > maxRows + 1) more = true;
  const [head, ...body] = records;
  if (!head) return { rows: [], more: false };
  const keys = head.map((h) => h.trim().toLowerCase().replace(/^﻿/, ""));
  return {
    rows: body.slice(0, maxRows).map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()]))),
    more: more || body.length > maxRows,
  };
}
