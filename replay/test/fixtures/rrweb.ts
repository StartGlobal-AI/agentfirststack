/**
 * Builders for recorder chunks: rrweb events (meta, full snapshot, mutations, scrolls, inputs)
 * plus the afs.* custom events the recorder adds, with controllable timestamps.
 */
import type { Envelope } from "../../src/lib/protocol";

export const T0 = Date.UTC(2026, 10, 3, 10, 0, 0);

export const meta = (ts: number, href = "https://shop.test/checkout", width = 1440, height = 900) => ({
  type: 4,
  timestamp: ts,
  data: { href, width, height },
});
export const snapshot = (ts: number) => ({
  type: 2,
  timestamp: ts,
  data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } },
});
export const mutation = (ts: number) => ({
  type: 3,
  timestamp: ts,
  data: { source: 0, texts: [], attributes: [{ id: 5, attributes: { class: "x" } }], removes: [], adds: [] },
});
export const mousemove = (ts: number) => ({
  type: 3,
  timestamp: ts,
  data: { source: 1, positions: [{ x: 1, y: 1, id: 1, timeOffset: 0 }] },
});
export const rrInput = (ts: number) => ({ type: 3, timestamp: ts, data: { source: 5, id: 9, text: "***", isChecked: false } });
export const custom = (ts: number, tag: string, payload: Record<string, unknown>) => ({ type: 5, timestamp: ts, data: { tag, payload } });

export const page = (ts: number, pv: number, p: string, extra: Record<string, unknown> = {}) =>
  custom(ts, "afs.page", { pv, p, h: "shop.test", nav: "load", w: 1440, vh: 900, dh: 3000, ...extra });
export const click = (ts: number, pv: number, s: string, extra: Record<string, unknown> = {}) =>
  custom(ts, "afs.click", { pv, s, l: "Pay now", tg: "button", i: 1, x: 500, y: 700, w: 1440, dh: 3000, top: 23, ...extra });
export const input = (ts: number, pv: number, s: string, extra: Record<string, unknown> = {}) =>
  custom(ts, "afs.input", { pv, s, tg: "input[type=email]", n: "email", l: "*****", m: 1, ...extra });
export const scroll = (ts: number, pv: number, y: number, dh = 3000, vh = 900) => custom(ts, "afs.scroll", { pv, y, dh, vh });
export const error = (ts: number, pv: number, m: string, extra: Record<string, unknown> = {}) =>
  custom(ts, "afs.error", {
    pv,
    k: "error",
    m,
    src: "https://shop.test/assets/app.3f9a2b1c.js",
    ln: 1,
    col: 2345,
    st: `${m}\n    at pay (https://shop.test/assets/app.3f9a2b1c.js:1:2345)`,
    ...extra,
  });
export const hide = (ts: number, pv: number, k = "pagehide") => custom(ts, "afs.hide", { pv, k });
export const event = (ts: number, pv: number, n: string, p?: Record<string, unknown>) => custom(ts, "afs.event", { pv, n, p });

export function envelope(sid: string, seq: number, ev: unknown[], extra: Partial<Envelope> = {}): Envelope {
  const last = ev.reduce<number>((m, e) => Math.max(m, Number((e as { timestamp?: number } | null)?.timestamp) || 0), 0);
  return { v: 1, sid, seq, t: last + 10, ev, ...extra };
}
export const tag = (ts: number, pv: number, k: string, v: unknown) => custom(ts, "afs.tag", { pv, k, v: Array.isArray(v) ? v : [v] });
export const net = (ts: number, pv: number, m: string, u: string, st: number, ms = 120) => custom(ts, "afs.net", { pv, m, u, st, ms });
