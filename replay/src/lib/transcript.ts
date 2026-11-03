/**
 * The session transcript: what happened, in order, as compact text or JSON an agent can read in
 * one go (pages, clicks with labels and selectors, masked inputs, scroll reach, errors, custom
 * events, signals, timestamps). Pure: built from the DO's rows, unit-tested with fixtures.
 *
 * Page-derived strings (paths, titles, labels, selectors, messages, event names) are untrusted:
 * in text they sit inside an UNTRUSTED fence, in JSON under `untrusted`.
 */

import type { EventRow, PageRow, SessionRow } from "./rows";
import { fence, UNTRUSTED_NOTICE } from "./untrusted";

export interface TimelineEntry {
  /** ms since the session started */
  t: number;
  ts: number;
  kind: "page" | "click" | "input" | "scroll" | "error" | "event" | "hide" | "idle";
  pv: number | null;
  path?: string | null;
  title?: string | null;
  referrer?: string | null;
  nav?: string | null;
  stayed_ms?: number | null;
  max_scroll_pct?: number;
  label?: string | null;
  label_masked?: boolean;
  selector?: string | null;
  tag?: string | null;
  interactive?: boolean;
  href?: string | null;
  /** rage bursts are folded into one entry */
  count?: number;
  span_ms?: number;
  field?: string | null;
  value_masked?: boolean;
  pct?: number;
  message?: string | null;
  error_kind?: string;
  source?: string | null;
  fingerprint?: string | null;
  triggered_by?: { selector: string | null; label: string | null } | null;
  name?: string;
  props?: Record<string, unknown> | null;
  detail?: string;
  signals: string[];
}

const parse = (s: string | null): Record<string, unknown> => {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Merge pages and derived events into one ordered timeline, folding rage bursts. */
export function buildTimeline(session: SessionRow, pages: PageRow[], events: EventRow[]): TimelineEntry[] {
  const t0 = session.started_at;
  const out: TimelineEntry[] = [];
  for (const p of pages) {
    const signals: string[] = [];
    if (p.quick_back) signals.push("quick_back");
    if (p.excessive_scroll) signals.push("excessive_scroll");
    out.push({
      t: p.ts - t0,
      ts: p.ts,
      kind: "page",
      pv: p.pv,
      path: p.path,
      title: p.title,
      referrer: p.referrer,
      nav: p.nav,
      stayed_ms: p.left_at !== null && p.left_at >= p.ts ? p.left_at - p.ts : null,
      max_scroll_pct: p.max_scroll,
      signals,
    });
  }
  let burst: TimelineEntry | null = null;
  for (const e of events) {
    const base = { t: e.ts - t0, ts: e.ts, pv: e.pv };
    const d = parse(e.detail);
    if (e.kind === "click") {
      if (e.rage && !e.rage_start && burst && burst.selector === e.selector && burst.pv === e.pv) {
        burst.count = (burst.count ?? 1) + 1;
        burst.span_ms = e.ts - burst.ts;
        if (e.error_click && !burst.signals.includes("error_click")) burst.signals.push("error_click");
        continue;
      }
      const signals: string[] = [];
      if (e.rage) signals.push("rage_click");
      if (e.dead) signals.push("dead_click");
      if (e.error_click) signals.push("error_click");
      const entry: TimelineEntry = {
        ...base,
        kind: "click",
        path: e.path,
        label: e.label,
        label_masked: !!e.label_masked,
        selector: e.selector,
        tag: e.tag,
        interactive: !!e.interactive,
        href: e.href,
        signals,
      };
      if (d.blocked) entry.detail = "blocked element";
      out.push(entry);
      burst = e.rage ? entry : null;
      continue;
    }
    // Errors and scroll milestones inside a burst don't end it (a broken button throws on every click).
    if (e.kind !== "error" && e.kind !== "scroll") burst = null;
    if (e.kind === "input") {
      out.push({
        ...base,
        kind: "input",
        path: e.path,
        selector: e.selector,
        tag: e.tag,
        label: e.label,
        field: typeof d.name === "string" ? d.name : null,
        value_masked: d.masked !== false,
        signals: [],
      });
    } else if (e.kind === "scroll") {
      out.push({ ...base, kind: "scroll", path: e.path, pct: typeof d.pct === "number" ? d.pct : 0, signals: [] });
    } else if (e.kind === "error") {
      out.push({
        ...base,
        kind: "error",
        path: e.path,
        message: e.message,
        error_kind: typeof d.kind === "string" ? d.kind : "error",
        source:
          typeof d.source === "string"
            ? `${d.source}${typeof d.line === "number" ? `:${d.line}${typeof d.col === "number" ? `:${d.col}` : ""}` : ""}`
            : null,
        fingerprint: e.fingerprint,
        triggered_by: e.error_click ? { selector: e.selector, label: e.label } : null,
        signals: e.error_click ? ["error_click"] : ["js_error"],
      });
    } else if (e.kind === "event") {
      out.push({
        ...base,
        kind: "event",
        path: e.path,
        name: e.label ?? "",
        props: (d.props as Record<string, unknown>) ?? null,
        signals: [],
      });
    } else if (e.kind === "hide" || e.kind === "idle") {
      out.push({ ...base, kind: e.kind, path: e.path, detail: typeof d.k === "string" ? d.k : e.kind, signals: [] });
    }
  }
  // Pages first when they share a timestamp with the events they contain.
  const order: Record<string, number> = { page: 0 };
  return out.sort((a, b) => a.ts - b.ts || (order[a.kind] ?? 1) - (order[b.kind] ?? 1));
}

export function clock(ms: number): string {
  const tenths = Math.round(Math.abs(ms) / 100);
  const m = Math.floor(tenths / 600);
  const s = ((tenths % 600) / 10).toFixed(1).padStart(4, "0");
  return `${ms < 0 ? "-" : ""}${String(m).padStart(2, "0")}:${s}`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

const q = (s: string | null | undefined) => (s ? JSON.stringify(s) : '""');
const FLAG: Record<string, string> = {
  rage_click: "RAGE",
  dead_click: "DEAD",
  error_click: "ERROR-CLICK",
  quick_back: "QUICK-BACK",
  excessive_scroll: "EXCESSIVE-SCROLL",
};

/** One line per entry. */
export function entryLine(e: TimelineEntry): string {
  const flags = e.signals
    .filter((s) => FLAG[s])
    .map((s) => FLAG[s])
    .join(" ");
  const tail = flags ? `  [${flags}]` : "";
  const at = `[${clock(e.t)}]`;
  switch (e.kind) {
    case "page": {
      const bits = [`page ${e.path}`, e.nav ?? "load"];
      if (e.referrer) bits.push(`from ${e.referrer}`);
      if (e.title) bits.push(`title ${q(e.title)}`);
      if (e.stayed_ms !== null && e.stayed_ms !== undefined) bits.push(`stayed ${duration(e.stayed_ms)}`);
      bits.push(`saw ${e.max_scroll_pct ?? 0}% of the page`);
      return `${at} ${bits.join(" · ")}${tail}`;
    }
    case "click": {
      const what = `${e.tag || "element"}${e.label ? ` ${q(e.label)}` : ""}${e.label_masked ? " (text masked)" : ""}`;
      const n = e.count && e.count > 1 ? ` x${e.count} in ${((e.span_ms ?? 0) / 1000 || 0).toFixed(1)}s` : "";
      const extra = [e.interactive ? null : "not interactive", e.href ? `-> ${e.href}` : null, e.detail ?? null].filter(Boolean).join(", ");
      return `${at} click${n} ${what} {${e.selector}}${extra ? ` (${extra})` : ""}${tail}`;
    }
    case "input":
      return `${at} typed into ${e.tag || "field"}${e.label ? ` ${q(e.label)}` : ""}${e.field ? ` name=${e.field}` : ""} {${e.selector}} (value ${e.value_masked ? "masked" : "recorded"})`;
    case "scroll":
      return `${at} scrolled to ${e.pct}% of ${e.path}`;
    case "error": {
      const trig = e.triggered_by ? ` after click on {${e.triggered_by.selector}}` : "";
      return `${at} ${e.error_kind === "console" ? "console.error" : e.error_kind === "rejection" ? "unhandled rejection" : "JS error"} ${q(e.message)}${e.source ? ` at ${e.source}` : ""}${trig}${tail}`;
    }
    case "event":
      return `${at} event ${q(e.name)}${e.props ? ` ${JSON.stringify(e.props)}` : ""}`;
    case "hide": {
      const what: Record<string, string> = {
        hidden: "tab hidden",
        pagehide: "left the page",
        max_duration: "recording ended (max session length)",
        stop: "recording stopped",
        excluded: "navigated to an excluded path (not recorded)",
      };
      return `${at} ${what[e.detail ?? ""] ?? e.detail}`;
    }
    case "idle":
      return `${at} idle: recording paused until the visitor is active again`;
  }
}

export function signalSummary(s: SessionRow): string {
  const parts = [
    s.rage_clicks && `${s.rage_clicks} rage click${s.rage_clicks === 1 ? "" : "s"}`,
    s.dead_clicks && `${s.dead_clicks} dead click${s.dead_clicks === 1 ? "" : "s"} (${s.dead_interactive} on interactive elements)`,
    s.error_clicks && `${s.error_clicks} error click${s.error_clicks === 1 ? "" : "s"}`,
    s.errors && `${s.errors} JS error${s.errors === 1 ? "" : "s"}`,
    s.quick_backs && `${s.quick_backs} quick back${s.quick_backs === 1 ? "" : "s"}`,
    s.excessive_scrolls && `${s.excessive_scrolls} excessive scroll${s.excessive_scrolls === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "none";
}

export interface TranscriptOptions {
  maxEvents: number;
  kinds?: readonly string[] | null;
  siteDomain: string;
}

export function sessionHeader(s: SessionRow, domain: string): string[] {
  const device = [s.device, [s.browser, s.browser_version].filter(Boolean).join(" "), s.os, s.country].filter(Boolean).join(" · ");
  return [
    `Session ${s.id} on ${domain}`,
    `Started ${new Date(s.started_at).toISOString()} · ${duration(s.duration_ms)} · ${device || "unknown device"}${s.viewport_w ? ` · viewport ${s.viewport_w}x${s.viewport_h}` : ""}`,
    `${s.pageviews} pageview${s.pageviews === 1 ? "" : "s"} · ${s.clicks} click${s.clicks === 1 ? "" : "s"} · ${s.inputs} field${s.inputs === 1 ? "" : "s"} typed into · ${s.errors} error${s.errors === 1 ? "" : "s"}`,
    `Signals: ${signalSummary(s)} · frustration ${s.frustration}/100`,
  ];
}

/** The text transcript: header in the clear, the timeline fenced as untrusted. */
export function transcriptText(s: SessionRow, timeline: TimelineEntry[], opts: TranscriptOptions & { truncated: boolean }): string {
  const lines = timeline.map(entryLine);
  if (opts.truncated) lines.push(`[... more events not shown: pass a larger max_events (up to 5000) or kinds=click,error to narrow]`);
  return [
    ...sessionHeader(s, opts.siteDomain),
    s.user_id ? "Identified: user_id is set (see JSON format)." : null,
    s.limited ? `Recording was cut short: ${s.limited}.` : null,
    "Times are [mm:ss.s] since the session started. Text in quotes was masked in the visitor's browser where it shows as *.",
    UNTRUSTED_NOTICE,
    fence("REPLAY_TRANSCRIPT", lines.join("\n")),
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
}

/** Session fields that come from the server (geo, parsed user agent, counts), not from page content. */
export function sessionJson(s: SessionRow) {
  return {
    id: s.id,
    started_at: s.started_at,
    started_at_iso: new Date(s.started_at).toISOString(),
    last_at: s.last_at,
    duration_ms: s.duration_ms,
    pageviews: s.pageviews,
    clicks: s.clicks,
    inputs: s.inputs,
    errors: s.errors,
    signals: {
      rage_clicks: s.rage_clicks,
      dead_clicks: s.dead_clicks,
      dead_clicks_interactive: s.dead_interactive,
      error_clicks: s.error_clicks,
      quick_backs: s.quick_backs,
      excessive_scrolls: s.excessive_scrolls,
      js_errors: s.errors,
    },
    frustration: s.frustration,
    device: s.device,
    browser: s.browser,
    browser_version: s.browser_version,
    os: s.os,
    country: s.country,
    region: s.region,
    city: s.city,
    viewport: s.viewport_w ? { width: s.viewport_w, height: s.viewport_h } : null,
    analytics_visitor_id: s.analytics_visitor_id,
    chunks: s.chunks,
    bytes: s.bytes,
    ended: !!s.ended,
    forced: !!s.forced,
    limited: s.limited,
  };
}
