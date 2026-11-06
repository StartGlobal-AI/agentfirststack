import type { ContainerConfig } from "../config/schema";

/** Inlined by the Worker when serving /c/:id.js (see src/service/script.ts). */
export interface BootConfig {
  /** Container id. */
  id: string;
  /** Published version, 0 when nothing is published yet, or "draft" in preview. */
  v: number | "draft";
  /** Container domain (cookie domain + first-party detection). */
  d: string;
  cfg: ContainerConfig;
  /** Preview token when this build serves the draft (or a version, in preview). */
  preview?: string;
  /** Environment snippet: its name (the `environment` built-in) and token (sent with hits). */
  env?: { name: string; token: string };
  /** Default analytics app base URL. */
  ab?: string;
  /** Visitor location from Cloudflare's edge, added per request. */
  geo?: { country?: string; region?: string };
  /** Fallback base URL if document.currentScript is unavailable. */
  base?: string;
  /** consent_banner: the banner UI script's version (<base>/cb/<ui>.js), added per request. */
  ui?: string;
}

export interface EventCtx {
  type: string;
  name: string;
  /** dataLayer model snapshot at the time of the event. */
  model: Record<string, unknown>;
  /** The raw dataLayer entry / afst('event') data. */
  data?: Record<string, unknown>;
  el?: Element | null;
  form?: Element | null;
  triggerId?: string;
  scroll?: number;
  /** The DOM event (click, submit), for wait_for_tags. */
  ev?: Event;
  /** "b": seen at window in the bubble phase (check_validation, wait_for_tags); default capture. */
  phase?: "b";
  /** Event-scoped built-ins (error_*, history_*, scroll_units, percent_visible, video_*...). */
  vars?: Record<string, unknown>;
  ts: number;
}

/** One preview log entry (posted to /collect as type "debug"; GET /v1/containers/:id/preview/:token/log). */
export interface TraceEntry {
  ts: number;
  event: string;
  page?: string;
  triggers: { id: string; matched: boolean; reason?: string }[];
  tags: { id: string; type: string; status: string; reason?: string; trigger?: string }[];
  conversions: { name: string; status: string; reason?: string; platforms?: string[] }[];
}
