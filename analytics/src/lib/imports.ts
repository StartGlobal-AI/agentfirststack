/**
 * Imports of other tools' daily aggregates: Plausible's CSV export (imported_visitors,
 * imported_pages, imported_sources, imported_locations, imported_devices) and GA4 report CSVs
 * (Date plus one of page path, source, country, device category). Pure: CSV text -> rows.
 */

import { parseCsv } from "./csv";

export const IMPORT_SOURCES = ["plausible", "ga4"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];
export const IMPORT_KINDS = ["visitors", "pages", "sources", "countries", "devices"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
/** The dimension each kind adds to (breakdown name). */
export const KIND_DIMENSION: Record<Exclude<ImportKind, "visitors">, string> = {
  pages: "page",
  sources: "source",
  countries: "country",
  devices: "device",
};

export interface ImportRow {
  day: string;
  value: string;
  visitors: number;
  visits: number;
  pageviews: number;
  bounces: number;
  visit_duration: number;
}

export class ImportError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

const n = (v: string | undefined) => {
  if (v == null || v === "") return 0;
  const x = Number(v.replace(/[,%]/g, ""));
  return Number.isFinite(x) && x >= 0 ? x : 0;
};

const day = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return null;
};

const pick = (r: Record<string, string>, names: string[]) => {
  for (const k of names) if (r[k] != null && r[k] !== "") return r[k];
  return undefined;
};

/** English country names -> ISO 3166-1 alpha-2 (GA4 exports names; reports store codes). */
let COUNTRY_CODES: Map<string, string> | null = null;
function countryCode(v: string): string {
  const t = v.trim();
  if (/^[A-Z]{2}$/.test(t)) return t;
  if (!COUNTRY_CODES) {
    COUNTRY_CODES = new Map();
    try {
      const names = new Intl.DisplayNames(["en"], { type: "region" });
      for (let a = 65; a <= 90; a++)
        for (let b = 65; b <= 90; b++) {
          const code = String.fromCharCode(a, b);
          const name = names.of(code);
          if (name && name !== code) COUNTRY_CODES.set(name.toLowerCase(), code);
        }
    } catch {
      /* no ICU: names stay as they are */
    }
    for (const [n, c] of [
      ["united states", "US"],
      ["united kingdom", "GB"],
      ["south korea", "KR"],
      ["russia", "RU"],
      ["czechia", "CZ"],
      ["türkiye", "TR"],
      ["turkey", "TR"],
    ] as const)
      COUNTRY_CODES.set(n, c);
  }
  return COUNTRY_CODES.get(t.toLowerCase()) ?? t;
}

const DEVICE: Record<string, string> = { desktop: "desktop", mobile: "mobile", tablet: "tablet", "smart tv": "tv", tv: "tv" };
const deviceOf = (v: string) => DEVICE[v.trim().toLowerCase()] ?? v.trim().toLowerCase();

/** Rows of one export file. `kind` is detected from the columns when not given. */
export function parseImport(
  source: ImportSource,
  text: string,
  kindIn: ImportKind | undefined,
  maxRows: number,
): { kind: ImportKind; rows: ImportRow[]; skipped: number } {
  // GA4 exports open with "# ..." comment lines (report name, dates); Plausible's have none.
  const body = text
    .split(/\r?\n/)
    .filter((l) => !l.startsWith("#"))
    .join("\n");
  const { rows, more } = parseCsv(body, maxRows);
  if (more) throw new ImportError(`More than ${maxRows} rows in one file.`, "Split the export by date range and send each part.");
  if (!rows.length) throw new ImportError("The file has no data rows.", "Send the CSV with its header row.");
  const cols = new Set(Object.keys(rows[0]!));
  const has = (...c: string[]) => c.some((x) => cols.has(x));
  const g4 = {
    page: ["page path and screen class", "page path", "landing page", "page path + query string", "landing page + query string"],
    source: ["session source", "first user source", "source", "session source / medium", "session default channel group"],
    country: ["country id", "country"],
    device: ["device category"],
  };
  const kind: ImportKind =
    kindIn ??
    (source === "plausible"
      ? has("page")
        ? "pages"
        : has("source")
          ? "sources"
          : has("country")
            ? "countries"
            : has("device")
              ? "devices"
              : "visitors"
      : has(...g4.page)
        ? "pages"
        : has(...g4.source)
          ? "sources"
          : has(...g4.country)
            ? "countries"
            : has(...g4.device)
              ? "devices"
              : "visitors");
  if (!has("date"))
    throw new ImportError(
      "The file has no date column.",
      source === "ga4"
        ? "Add the Date dimension to the GA4 report before exporting (one row per day)."
        : "Use the CSV files of Plausible's export (they have a date column).",
    );
  const out = new Map<string, ImportRow>();
  let skipped = 0;
  for (const r of rows) {
    const d = day(r.date);
    if (!d) {
      skipped++; // totals rows, blank lines
      continue;
    }
    let value = "";
    if (kind !== "visitors") {
      const raw =
        source === "plausible"
          ? { pages: r.page, sources: r.source, countries: r.country, devices: r.device }[kind]
          : pick(r, g4[KIND_DIMENSION[kind] as keyof typeof g4]);
      if (!raw) {
        skipped++;
        continue;
      }
      value = (
        kind === "devices"
          ? deviceOf(raw)
          : kind === "sources"
            ? raw.split(" / ")[0]!.trim()
            : kind === "countries"
              ? countryCode(raw)
              : raw.trim()
      ).slice(0, 500);
      if (kind === "sources" && (value === "(direct)" || value === "Direct / None")) value = "(none)";
    }
    const visitors = n(pick(r, ["visitors", "active users", "total users", "users"]));
    const visits = n(pick(r, ["visits", "sessions"]));
    const pageviews = n(pick(r, ["pageviews", "views", "screen page views"]));
    const bounces =
      source === "plausible"
        ? n(r.bounces)
        : Math.round(n(r["bounce rate"]) <= 1 ? n(r["bounce rate"]) * visits : (n(r["bounce rate"]) / 100) * visits);
    const duration =
      source === "plausible"
        ? n(r.visit_duration)
        : n(pick(r, ["average session duration", "average engagement time per session"])) * visits;
    const key = `${d}\u0000${value}`;
    const cur = out.get(key);
    if (cur) {
      // several rows of one day and value (Plausible locations by region / city): summed
      cur.visitors += visitors;
      cur.visits += visits;
      cur.pageviews += pageviews;
      cur.bounces += bounces;
      cur.visit_duration += duration;
    } else out.set(key, { day: d, value, visitors, visits, pageviews, bounces, visit_duration: duration });
  }
  if (!out.size)
    throw new ImportError("No row had a date and a value.", "Check the export: one row per day (and per page, source, country or device).");
  return { kind, rows: [...out.values()], skipped };
}
