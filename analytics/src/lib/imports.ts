/**
 * Imports of other tools' daily aggregates. Pure: input -> rows.
 * - plausible: the CSV export (imported_visitors, imported_pages, imported_sources,
 *   imported_locations, imported_devices), or a Stats API v2 response (results[].dimensions / metrics).
 * - ga4: report CSVs (Date plus one of page path, source, country, device category), or a Data API
 *   runReport response (what Google's GA4 MCP server returns), mapped onto the CSV's columns so a
 *   CSV and a JSON report of the same data give the same rows.
 * - other (with a tool slug): a generic CSV or JSON rows: date, visitors, visits, pageviews,
 *   bounce_rate (%), visit_duration (average seconds), plus at most one of page, source, country, device.
 */

import { parseCsv } from "./csv";

export const IMPORT_SOURCES = ["plausible", "ga4", "other"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];
export const IMPORT_KINDS = ["visitors", "pages", "sources", "countries", "devices"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
type BreakdownKind = Exclude<ImportKind, "visitors">;
/** The dimension each kind adds to (breakdown name). */
export const KIND_DIMENSION: Record<BreakdownKind, string> = {
  pages: "page",
  sources: "source",
  countries: "country",
  devices: "device",
};
/** source other: the tool's name, as stored and listed. */
export const TOOL_RE = /^[a-z0-9_-]{1,40}$/;

export interface ImportRow {
  day: string;
  value: string;
  visitors: number;
  visits: number;
  pageviews: number;
  bounces: number;
  visit_duration: number;
}

export interface ParsedImport {
  kind: ImportKind;
  rows: ImportRow[];
  skipped: number;
}

export class ImportError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

type Rec = Record<string, string>;

const n = (v: string | undefined) => {
  if (v == null || v === "") return 0;
  const x = Number(v.replace(/[,%]/g, ""));
  return Number.isFinite(x) && x >= 0 ? x : 0;
};

/** Seconds from 95, "95s", "1:35" or "0:01:35". */
const seconds = (v: string | undefined) => {
  const t = (v ?? "").trim();
  const m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (m) return m[3] != null ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
  return n(t.replace(/\s*s$/i, ""));
};

const day = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  const d = /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
  if (!d) return null;
  const dt = new Date(`${d}T00:00:00Z`);
  return Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== d ? null : d;
};

const pick = (r: Rec, names: string[]) => {
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
      ["united states of america", "US"],
      ["usa", "US"],
      ["united kingdom", "GB"],
      ["uk", "GB"],
      ["south korea", "KR"],
      ["russia", "RU"],
      ["czechia", "CZ"],
      ["türkiye", "TR"],
      ["turkey", "TR"],
    ] as const)
      COUNTRY_CODES.set(n, c);
  }
  const named = COUNTRY_CODES.get(t.toLowerCase());
  if (named) return named;
  return /^[a-z]{2}$/i.test(t) ? t.toUpperCase() : t;
}

const DEVICE: Record<string, string> = {
  desktop: "desktop",
  mobile: "mobile",
  phone: "mobile",
  smartphone: "mobile",
  tablet: "tablet",
  "smart tv": "tv",
  tv: "tv",
};
const deviceOf = (v: string) => DEVICE[v.trim().toLowerCase()] ?? v.trim().toLowerCase();

/** "(none)" is how reports name direct traffic; tools say (direct), Direct, Direct / None. */
const DIRECT = new Set(["(direct)", "direct", "direct / none", "(none)", "none"]);
function sourceOf(v: string): string {
  const t = v.trim();
  if (DIRECT.has(t.toLowerCase())) return "(none)";
  const s = t.split(" / ")[0]!.trim(); // "google / organic": the medium is dropped
  return DIRECT.has(s.toLowerCase()) ? "(none)" : s;
}

/** A page path: full URLs lose their origin, and every page its query string and fragment. */
function pageOf(v: string): string {
  let t = v.trim();
  if (/^https?:\/\//i.test(t)) {
    try {
      t = new URL(t).pathname;
    } catch {
      /* kept as sent */
    }
  }
  return t.split(/[?#]/)[0] || "/";
}

function valueOf(kind: BreakdownKind, raw: string): string {
  const v = kind === "devices" ? deviceOf(raw) : kind === "sources" ? sourceOf(raw) : kind === "countries" ? countryCode(raw) : pageOf(raw);
  return v.slice(0, 500);
}

type Metrics = Omit<ImportRow, "day" | "value">;

/** How one kind of record reads: its breakdown value and its metrics. */
interface Flavor {
  value(r: Rec, kind: BreakdownKind): string | undefined;
  metrics(r: Rec): Metrics;
}

/** Records -> one row per (day, value), summing duplicates (Plausible locations per region, page query strings). */
function aggregate(records: Rec[], kind: ImportKind, f: Flavor, emptyHint: string): ParsedImport {
  const out = new Map<string, ImportRow>();
  let skipped = 0;
  for (const r of records) {
    const d = day(r.date);
    if (!d) {
      skipped++; // totals rows, blank lines
      continue;
    }
    let value = "";
    if (kind !== "visitors") {
      const raw = f.value(r, kind);
      if (!raw?.trim()) {
        skipped++;
        continue;
      }
      value = valueOf(kind, raw);
    }
    const m = f.metrics(r);
    const key = `${d}\u0000${value}`;
    const cur = out.get(key);
    if (cur) {
      cur.visitors += m.visitors;
      cur.visits += m.visits;
      cur.pageviews += m.pageviews;
      cur.bounces += m.bounces;
      cur.visit_duration += m.visit_duration;
    } else out.set(key, { day: d, value, ...m });
  }
  if (!out.size) throw new ImportError("No row had a date and a value.", emptyHint);
  return { kind, rows: [...out.values()], skipped };
}

// ------------------------------------------------------------------ GA4 and Plausible CSV

const VISITORS = ["visitors", "active users", "total users", "users"];
const VISITS = ["visits", "sessions"];
const PAGEVIEWS = ["pageviews", "views", "screen page views"];
const G4: Record<string, string[]> = {
  page: ["page path and screen class", "page path", "landing page", "page path + query string", "landing page + query string"],
  source: ["session source", "first user source", "source", "session source / medium", "session default channel group"],
  country: ["country id", "country"],
  device: ["device category"],
};

const GA4_CSV: Flavor = {
  value: (r, kind) => pick(r, G4[KIND_DIMENSION[kind]]!),
  metrics: (r) => {
    const visits = n(pick(r, VISITS));
    const br = n(r["bounce rate"]);
    return {
      visitors: n(pick(r, VISITORS)),
      visits,
      pageviews: n(pick(r, PAGEVIEWS)),
      // GA4 exports the rate as a fraction (the Data API always does); a "40%" cell is a percentage
      bounces: Math.round(br <= 1 ? br * visits : (br / 100) * visits),
      visit_duration: n(pick(r, ["average session duration", "average engagement time per session"])) * visits,
    };
  },
};

const PLAUSIBLE_CSV: Flavor = {
  value: (r, kind) => ({ pages: r.page, sources: r.source, countries: r.country, devices: r.device })[kind],
  metrics: (r) => ({
    visitors: n(pick(r, VISITORS)),
    visits: n(pick(r, VISITS)),
    pageviews: n(pick(r, PAGEVIEWS)),
    bounces: n(r.bounces),
    visit_duration: n(r.visit_duration),
  }),
};

/** The kind a GA4 or Plausible CSV's columns say. */
function toolCsvKind(source: "plausible" | "ga4", cols: Set<string>): ImportKind {
  const has = (c: string[]) => c.some((x) => cols.has(x));
  const [page, src, country, device] =
    source === "plausible" ? [["page"], ["source"], ["country"], ["device"]] : [G4.page!, G4.source!, G4.country!, G4.device!];
  return has(page!) ? "pages" : has(src!) ? "sources" : has(country!) ? "countries" : has(device!) ? "devices" : "visitors";
}

function fromToolCsv(source: "plausible" | "ga4", rows: Rec[], kindIn: ImportKind | undefined): ParsedImport {
  const cols = new Set(Object.keys(rows[0] ?? {}));
  const kind = kindIn ?? toolCsvKind(source, cols);
  if (!cols.has("date"))
    throw new ImportError(
      "The file has no date column.",
      source === "ga4"
        ? "Add the Date dimension to the GA4 report before exporting (one row per day)."
        : "Use the CSV files of Plausible's export (they have a date column).",
    );
  return aggregate(
    rows,
    kind,
    source === "ga4" ? GA4_CSV : PLAUSIBLE_CSV,
    "Check the export: one row per day (and per page, source, country or device).",
  );
}

// ------------------------------------------------------------------ generic (source other, Plausible API)

const GENERIC_DIMS = ["page", "source", "country", "device"] as const;
const DIM_KIND: Record<(typeof GENERIC_DIMS)[number], BreakdownKind> = {
  page: "pages",
  source: "sources",
  country: "countries",
  device: "devices",
};
export const GENERIC_HINT =
  "One row per day: date (YYYY-MM-DD) and visitors, optionally visits, pageviews, bounce_rate (%) and visit_duration (average seconds), plus at most one of page, source, country or device.";

const GENERIC: Flavor = {
  value: (r, kind) => r[KIND_DIMENSION[kind]],
  metrics: (r) => {
    const visits = n(r.visits);
    return {
      visitors: n(r.visitors),
      visits,
      pageviews: n(r.pageviews),
      bounces: Math.round((Math.min(100, n(r.bounce_rate)) / 100) * visits),
      visit_duration: seconds(r.visit_duration) * visits,
    };
  },
};

/** Generic records (keys already the generic column names): kind from the one dimension present. */
function fromGeneric(records: Rec[], kindIn: ImportKind | undefined, what: string): ParsedImport {
  const cols = new Set<string>();
  for (const r of records) for (const [k, v] of Object.entries(r)) if (v !== "") cols.add(k);
  if (!cols.has("date")) throw new ImportError(`${what} has no date.`, GENERIC_HINT);
  if (!cols.has("visitors")) throw new ImportError(`${what} has no visitors.`, GENERIC_HINT);
  const dims = GENERIC_DIMS.filter((d) => cols.has(d));
  if (dims.length > 1)
    throw new ImportError(
      `${what} has more than one breakdown (${dims.join(", ")}).`,
      "Send each breakdown as its own import: date and the metrics plus one of page, source, country or device (none for daily totals).",
    );
  const kind: ImportKind = dims[0] ? DIM_KIND[dims[0]] : "visitors";
  if (kindIn && kindIn !== kind)
    throw new ImportError(
      `kind ${kindIn} doesn't match the data, which is ${kind}${dims[0] ? ` (it has ${dims[0]})` : " (no page, source, country or device)"}.`,
      "Leave kind out: it is read from the dimension present.",
    );
  return aggregate(records, kind, GENERIC, `Dates must be YYYY-MM-DD. ${GENERIC_HINT}`);
}

/** Generic CSV headers: case, spaces and hyphens don't matter ("Bounce Rate" = bounce_rate). */
const genericKey = (k: string) =>
  k
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

// ------------------------------------------------------------------ entry points

/** Rows of one CSV file. `kind` is detected from the columns when not given. */
export function parseImport(source: ImportSource, text: string, kindIn: ImportKind | undefined, maxRows: number): ParsedImport {
  // GA4 exports open with "# ..." comment lines (report name, dates); Plausible's have none.
  const body = text
    .split(/\r?\n/)
    .filter((l) => !l.startsWith("#"))
    .join("\n");
  const { rows, more } = parseCsv(body, maxRows);
  if (more) throw new ImportError(`More than ${maxRows} rows in one file.`, "Split the export by date range and send each part.");
  if (!rows.length) throw new ImportError("The file has no data rows.", "Send the CSV with its header row.");
  if (source !== "other") return fromToolCsv(source, rows, kindIn);
  return fromGeneric(
    rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [genericKey(k), v]))),
    kindIn,
    "The file",
  );
}

export type GenericRowInput = Record<string, string | number | null | undefined>;

/** JSON rows in the generic shape (any source). */
export function parseRows(rows: GenericRowInput[], kindIn: ImportKind | undefined): ParsedImport {
  if (!rows.length) throw new ImportError("rows is empty.", GENERIC_HINT);
  const recs = rows.map((r) => {
    const o: Rec = {};
    for (const [k, v] of Object.entries(r)) if (v != null) o[k] = String(v).trim();
    return o;
  });
  return fromGeneric(recs, kindIn, "rows");
}

const GA4_API_DIMENSIONS: Record<string, string> = {
  date: "date",
  pagePath: "page path",
  pagePathPlusQueryString: "page path + query string",
  landingPage: "landing page",
  landingPagePlusQueryString: "landing page + query string",
  sessionSource: "session source",
  sessionSourceMedium: "session source / medium",
  firstUserSource: "first user source",
  country: "country",
  countryId: "country id",
  deviceCategory: "device category",
};
const GA4_API_METRICS: Record<string, string> = {
  totalUsers: "total users",
  activeUsers: "active users",
  sessions: "sessions",
  screenPageViews: "views",
  bounceRate: "bounce rate",
  averageSessionDuration: "average session duration",
};
export const GA4_REPORT_HINT =
  'Run the report (Data API runReport, or the GA4 MCP server\'s run_report) with dimensions [{"name":"date"}] plus at most one of pagePath, landingPage, sessionSource, sessionSourceMedium, firstUserSource, country, countryId or deviceCategory, and metrics activeUsers (or totalUsers), sessions, screenPageViews, bounceRate, averageSessionDuration.';
export const PLAUSIBLE_REPORT_HINT =
  'Query the Stats API (POST /api/v2/query) with "dimensions": ["time:day"] plus at most one of event:page, visit:source, visit:country (or visit:country_name) or visit:device, and "metrics": ["visitors", "visits", "pageviews", "bounce_rate", "visit_duration"].';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
/** The API's camelCase field, or the snake_case one protobuf dicts use (preserving_proto_field_name). */
const field = (o: Obj, camel: string): unknown => o[camel] ?? o[camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
const names = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.map((h) => (isObj(h) ? String(h.name ?? "") : typeof h === "string" ? h : "")) : null;
const cell = (v: unknown): string => (v == null ? "" : isObj(v) ? cell(v.value) : String(v).trim());

function tooMany(count: number, sent: number, maxRows: number, hint: string) {
  if (sent > maxRows)
    throw new ImportError(
      `The report has ${sent} rows; one import takes at most ${maxRows}.`,
      `Split the date range and import each part. ${hint}`,
    );
  if (count > sent)
    throw new ImportError(
      `The report holds ${count} rows but ${sent} were sent (only its first page).`,
      `Run it again with a limit of at least ${count} (up to ${maxRows}), or split the date range and import each part.`,
    );
}

/** A GA4 Data API runReport response -> the GA4 CSV's columns -> the same rows as its CSV export. */
function fromGa4Report(report: Obj, kindIn: ImportKind | undefined, maxRows: number): ParsedImport {
  const dims = names(field(report, "dimensionHeaders"));
  const mets = names(field(report, "metricHeaders"));
  if (!dims || !mets) {
    if (Array.isArray(report.results))
      throw new ImportError("This looks like a Plausible Stats API response, not a GA4 report.", "Send it with source plausible.");
    throw new ImportError("report is not a GA4 runReport response (no dimensionHeaders / metricHeaders).", GA4_REPORT_HINT);
  }
  const unknown = dims.filter((d) => !(d in GA4_API_DIMENSIONS));
  if (unknown.length) throw new ImportError(`These GA4 dimensions can't be imported: ${unknown.join(", ")}.`, GA4_REPORT_HINT);
  if (!dims.includes("date")) throw new ImportError("The report has no date dimension (one row per day is needed).", GA4_REPORT_HINT);
  const breakdowns = dims.filter((d) => d !== "date");
  if (breakdowns.length > 1)
    throw new ImportError(
      `The report has more than one breakdown dimension (${breakdowns.join(", ")}).`,
      `Run one report per breakdown. ${GA4_REPORT_HINT}`,
    );
  if (!mets.includes("totalUsers") && !mets.includes("activeUsers"))
    throw new ImportError("The report has no users metric (activeUsers or totalUsers).", GA4_REPORT_HINT);
  const rows = field(report, "rows");
  const list = Array.isArray(rows) ? rows : [];
  tooMany(Number(field(report, "rowCount")) || 0, list.length, maxRows, GA4_REPORT_HINT);
  if (!list.length) throw new ImportError("The report has no rows.", "Check its date range (startDate, endDate) and the property id.");
  const recs = list.map((row) => {
    const r: Rec = {};
    const dv = isObj(row) ? field(row, "dimensionValues") : null;
    const mv = isObj(row) ? field(row, "metricValues") : null;
    dims.forEach((d, i) => {
      r[GA4_API_DIMENSIONS[d]!] = cell(Array.isArray(dv) ? dv[i] : undefined);
    });
    mets.forEach((m, i) => {
      const col = GA4_API_METRICS[m];
      if (col) r[col] = cell(Array.isArray(mv) ? mv[i] : undefined);
    });
    return r;
  });
  const kind = toolCsvKind("ga4", new Set(Object.keys(recs[0]!)));
  if (kindIn && kindIn !== kind)
    throw new ImportError(
      `kind ${kindIn} doesn't match the report, which is ${kind}.`,
      "Leave kind out: it is read from the report's dimensions.",
    );
  return fromToolCsv("ga4", recs, kind);
}

const PLAUSIBLE_DIMENSIONS: Record<string, string> = {
  "time:day": "date",
  "event:page": "page",
  "visit:source": "source",
  "visit:country": "country",
  "visit:country_name": "country",
  "visit:device": "device",
};
const PLAUSIBLE_METRICS = new Set(["visitors", "visits", "pageviews", "bounce_rate", "visit_duration"]);

/** A Plausible Stats API v2 response -> generic records (its metrics are the generic ones). */
function fromPlausibleReport(
  report: Obj,
  given: { dimensions?: string[]; metrics?: string[] },
  kindIn: ImportKind | undefined,
  maxRows: number,
): ParsedImport {
  const results = report.results;
  if (!Array.isArray(results)) {
    if (field(report, "dimensionHeaders"))
      throw new ImportError("This looks like a GA4 runReport response, not a Plausible one.", "Send it with source ga4.");
    throw new ImportError("report is not a Plausible Stats API v2 response (no results).", PLAUSIBLE_REPORT_HINT);
  }
  const query = isObj(report.query) ? report.query : {};
  const dims = names(query.dimensions) ?? names(report.dimensions) ?? given.dimensions ?? null;
  const mets = names(query.metrics) ?? names(report.metrics) ?? given.metrics ?? null;
  if (!dims || !mets)
    throw new ImportError(
      "The report doesn't say which dimensions and metrics its columns are.",
      "Send Plausible's response as it came (it echoes them in query), or pass dimensions and metrics next to report, in the order you queried them.",
    );
  const unknown = dims.filter((d) => !(d in PLAUSIBLE_DIMENSIONS));
  if (unknown.length) throw new ImportError(`These Plausible dimensions can't be imported: ${unknown.join(", ")}.`, PLAUSIBLE_REPORT_HINT);
  if (!dims.includes("time:day"))
    throw new ImportError("The report has no time:day dimension (one row per day is needed).", PLAUSIBLE_REPORT_HINT);
  const breakdowns = dims.filter((d) => d !== "time:day");
  if (breakdowns.length > 1)
    throw new ImportError(
      `The report has more than one breakdown dimension (${breakdowns.join(", ")}).`,
      `Run one query per breakdown. ${PLAUSIBLE_REPORT_HINT}`,
    );
  if (!mets.includes("visitors")) throw new ImportError("The report has no visitors metric.", PLAUSIBLE_REPORT_HINT);
  const meta = isObj(report.meta) ? report.meta : {};
  tooMany(Number(meta.total_rows) || 0, results.length, maxRows, PLAUSIBLE_REPORT_HINT);
  if (!results.length) throw new ImportError("The report has no results.", "Check its date_range and site_id.");
  const recs = results.map((row) => {
    const r: Rec = {};
    const dv = isObj(row) && Array.isArray(row.dimensions) ? row.dimensions : [];
    const mv = isObj(row) && Array.isArray(row.metrics) ? row.metrics : [];
    dims.forEach((d, i) => {
      r[PLAUSIBLE_DIMENSIONS[d]!] = cell(dv[i]);
    });
    mets.forEach((m, i) => {
      if (PLAUSIBLE_METRICS.has(m)) r[m] = cell(mv[i]);
    });
    return r;
  });
  return fromGeneric(recs, kindIn, "The report");
}

/** A tool's API response: GA4 runReport or Plausible Stats API v2. */
export function parseReport(
  source: "plausible" | "ga4",
  report: unknown,
  given: { dimensions?: string[]; metrics?: string[] },
  kindIn: ImportKind | undefined,
  maxRows: number,
): ParsedImport {
  if (!isObj(report)) throw new ImportError("report must be a JSON object.", source === "ga4" ? GA4_REPORT_HINT : PLAUSIBLE_REPORT_HINT);
  return source === "ga4" ? fromGa4Report(report, kindIn, maxRows) : fromPlausibleReport(report, given, kindIn, maxRows);
}
