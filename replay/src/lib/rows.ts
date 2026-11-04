/** Rows of the per-site Durable Object's SQLite tables, as the engine returns them. */

export interface SessionRow {
  id: string;
  started_at: number;
  last_at: number;
  received_at: number;
  day: string;
  duration_ms: number;
  entry_path: string | null;
  exit_path: string | null;
  pageviews: number;
  clicks: number;
  inputs: number;
  errors: number;
  rage_clicks: number;
  dead_clicks: number;
  dead_interactive: number;
  error_clicks: number;
  quick_backs: number;
  excessive_scrolls: number;
  frustration: number;
  device: string | null;
  browser: string | null;
  browser_version: string | null;
  os: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  viewport_w: number | null;
  viewport_h: number | null;
  user_id: string | null;
  analytics_visitor_id: string | null;
  ua_hash: string | null;
  chunks: number;
  bytes: number;
  rr_events: number;
  derived: number;
  ended: number;
  forced: number;
  skew_ms: number;
  limited: string | null;
  /** v3: the entry page's referrer */
  referrer?: string | null;
  /** v3: time the visitor was active (see lib/derive ACTIVE_GAP_MS) */
  active_ms?: number;
  /** v3: failed requests */
  api_errors?: number;
  /** v3: starred (outlives retention_days up to MAX_STARRED_RETENTION_DAYS) */
  starred?: number;
  /** v3: afsr('upgrade') reason */
  upgraded?: string | null;
}

export interface PageRow {
  session_id: string;
  pv: number;
  ts: number;
  path: string;
  host: string | null;
  title: string | null;
  referrer: string | null;
  nav: string | null;
  left_at: number | null;
  max_scroll: number;
  doc_h: number | null;
  view_h: number | null;
  scroll_dist: number;
  reversals: number;
  last_y: number | null;
  last_dir: number;
  quick_back: number;
  excessive_scroll: number;
  device: string | null;
  /** v3 */
  active_ms?: number;
}

export interface EventRow {
  id: number;
  session_id: string;
  ts: number;
  seq: number;
  pv: number | null;
  kind: "click" | "input" | "error" | "event" | "hide" | "idle" | "scroll" | "net" | "warn" | "survey";
  path: string | null;
  selector: string | null;
  label: string | null;
  label_masked: number;
  tag: string | null;
  interactive: number;
  x: number | null;
  y: number | null;
  doc_w: number | null;
  doc_h: number | null;
  top_pct: number | null;
  href: string | null;
  detail: string | null;
  message: string | null;
  fingerprint: string | null;
  rage: number;
  rage_start: number;
  dead: number;
  open: number;
  error_click: number;
  device: string | null;
}

export interface TagRow {
  key: string;
  value: string;
  ts: number;
}
