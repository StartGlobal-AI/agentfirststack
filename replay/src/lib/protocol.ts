/**
 * The wire protocol between the browser recorder and POST /i. Shared (types only, plus constants)
 * by src/recorder and the Worker. Field names are short because they ride in every chunk.
 *
 * A chunk is `POST /i?s=<site_id>&sid=<session_id>&q=<seq>&z=1` with a gzip body (z=0: plain
 * JSON, used for the last chunk on pagehide, when there is no time to compress), `text/plain` so
 * there is no CORS preflight. The body is an Envelope: rrweb events, among them custom events
 * (rrweb type 5) whose `data.tag` is one of TAGS and whose payload is described below. The
 * recorder computes element selectors and labels in the browser (with masking applied) so the
 * server never needs the DOM to say what was clicked.
 */

export const TAGS = {
  page: "afs.page",
  click: "afs.click",
  input: "afs.input",
  scroll: "afs.scroll",
  error: "afs.error",
  event: "afs.event",
  hide: "afs.hide",
  idle: "afs.idle",
} as const;

export type NavType = "load" | "reload" | "back_forward" | "push" | "replace" | "pop";

/** A pageview (page load or SPA navigation). */
export interface PagePayload {
  /** pageview number within the session (1, 2, ...); every other payload names the pv it belongs to */
  pv: number;
  /** path, no query string or fragment */
  p: string;
  /** hostname */
  h: string;
  /** document.title, masked by the site's rules */
  t?: string;
  /** previous path (SPA / same-origin referrer) or the external referrer's hostname */
  r?: string;
  nav: NavType;
  /** viewport width, height; document height */
  w: number;
  vh: number;
  dh: number;
}

export interface ClickPayload {
  pv: number;
  /** stable selector of the element the click means (see lib/describe) */
  s: string;
  /** label, masked by the site's rules */
  l: string;
  /** 1 when the label was masked (fully or partly) */
  lm?: 0 | 1;
  /** tag descriptor: "button", "a", "input[type=email]" */
  tg: string;
  /** 1 when the element (or an ancestor) is interactive: link, button, input, role=button, ... or cursor:pointer */
  i: 0 | 1;
  /** page coordinates of the click, document width and height (px) */
  x: number;
  y: number;
  w: number;
  dh: number;
  /** element's top edge, % of document height */
  top: number;
  /** link target: same-origin path, or external origin + path; never a query string */
  h?: string;
  /** 1 when the click landed in a blocked element */
  b?: 0 | 1;
}

export interface InputPayload {
  pv: number;
  s: string;
  tg: string;
  /** the field's name or id attribute (a developer identifier, not user content) */
  n?: string;
  /** the field's visible label (label[for], aria-label, placeholder), masked by the site's rules */
  l?: string;
  /** 1 = the value was masked in the recording (always, unless unmask_selectors allows it) */
  m: 0 | 1;
}

export interface ScrollPayload {
  pv: number;
  y: number;
  dh: number;
  vh: number;
}

export interface ErrorPayload {
  pv: number;
  /** error = window.onerror, rejection = unhandledrejection, console = console.error */
  k: "error" | "rejection" | "console";
  /** message, scrubbed of emails, long numbers and query strings */
  m: string;
  /** script path (no query), line, column */
  src?: string;
  ln?: number;
  col?: number;
  /** stack, scrubbed */
  st?: string;
  /** when it happened, if before the recorder started (the loader queues early errors) */
  at?: number;
}

export interface EventPayload {
  pv: number;
  /** name from afsr('event', name, props) */
  n: string;
  p?: Record<string, string | number | boolean | null>;
}

export interface HidePayload {
  pv: number;
  /** hidden = tab hidden, pagehide = leaving the page, max_duration / stop / excluded = recording ended */
  k: "hidden" | "pagehide" | "max_duration" | "stop" | "excluded";
}

export interface IdlePayload {
  pv: number;
}

export interface Envelope {
  v: 1;
  sid: string;
  seq: number;
  /** client clock when sent (unix ms); the server corrects clock skew with it */
  t: number;
  ev: unknown[];
  /** 1 on the last chunk (pagehide, stop, max duration) */
  end?: 1;
  /** afsr('identify', id) */
  uid?: string;
  /** the analytics visitor id (afsa.visitorId()) when the analytics tracker is on the page */
  avid?: string;
  /** 1 when recording was forced (?afsr=1), bypassing sampling and bot filtering */
  f?: 1;
  /** navigator.webdriver */
  wd?: 1;
}

/** The per-site config the loader script (/r/<site>.js) is served with. */
export interface LoaderConfig {
  site: string;
  /** recorder script URL (content-hashed) and ingest URL, relative to the loader's own base */
  rec: string;
  /** effective sample rate 0..1 */
  sr: number;
  mask: "strict" | "balanced" | "relaxed";
  /** CSS selector lists (already joined with the built-in data-afsr-* selectors) */
  unmask: string;
  maskSel: string;
  block: string;
  /** path globs never recorded */
  ex: string[];
  /** max session duration and idle stop (ms) */
  maxMs: number;
  idleMs: number;
  /** wait for afsr('consent', true) */
  consent: boolean;
  /** record console.error, uncaught errors and unhandled rejections */
  errors: boolean;
  /** false = recording turned off for the site */
  on: boolean;
}

/** Ids the browser generates: rs_ + 16 base32 characters, like newId("rs"). */
export const SESSION_ID_RE = /^rs_[0-9a-z]{16}$/;
export const SITE_ID_RE = /^rsite_[0-9a-z]{16}$/;
