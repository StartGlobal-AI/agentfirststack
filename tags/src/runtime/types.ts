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
  /** Preview token when this build serves the draft. */
  preview?: string;
  /** Default analytics app base URL. */
  ab?: string;
  /** Visitor location from Cloudflare's edge, added per request. */
  geo?: { country?: string; region?: string };
  /** Fallback base URL if document.currentScript is unavailable. */
  base?: string;
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
  ts: number;
}
