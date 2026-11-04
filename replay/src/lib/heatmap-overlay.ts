/**
 * The overlay drawn over a recorded snapshot for a heatmap image: click dots, scroll-reach bands or
 * attention bands, plus a legend. Static HTML and CSS only (the render runs with JavaScript off);
 * positions are percentages of the document, so they land where they were recorded whatever the
 * rendered height. Every recorded value (the page path) is escaped.
 */

import { escapeHtml } from "./snapshot-html";

export const HEATMAP_IMAGE_TYPES = ["click", "scroll", "attention"] as const;
export type HeatmapImageType = (typeof HEATMAP_IMAGE_TYPES)[number];

export interface ClickDot {
  /** percentages of the document's width and height */
  x_pct: number;
  y_pct: number;
  n: number;
  rage: number;
  dead: number;
  error: number;
}

export interface OverlayData {
  type: HeatmapImageType;
  dots: ClickDot[];
  /** share of pageviews that scrolled at least pct% of the document */
  reach: { pct: number; share: number }[];
  attention: { from_pct: number; to_pct: number; time_share: number }[];
  legend: { path: string; device: string; range: string; clicks: number; pageviews: number; snapshot_at: string };
}

const Z = "2147483646";
const r1 = (n: number) => Math.round(n * 10) / 10;

/** CSS that makes the overlay span the whole document (the root becomes its containing block). */
export const OVERLAY_HEAD = `<style>html{position:relative!important;min-height:100%}#afs-hm{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:${Z};overflow:hidden}#afs-hm *{box-sizing:border-box}#afs-hm .d{position:absolute;border-radius:50%;transform:translate(-50%,-50%)}#afs-hm .b{position:absolute;left:0;width:100%}#afs-hm .t{position:absolute;right:8px;font:600 12px/1.2 system-ui,sans-serif;color:#fff;background:rgba(17,24,39,.85);padding:2px 6px;border-radius:4px}#afs-lg{position:absolute;left:8px;top:8px;z-index:2147483647;font:13px/1.35 system-ui,sans-serif;color:#111827;background:rgba(255,255,255,.94);border:1px solid #d1d5db;border-radius:6px;padding:6px 10px;max-width:560px;pointer-events:none}#afs-lg b{font-weight:600}#afs-lg i{display:inline-block;width:10px;height:10px;border-radius:50%;margin:0 4px 0 10px;vertical-align:-1px}</style>`;

function dots(list: ClickDot[]): string {
  const max = list.reduce((m, d) => Math.max(m, d.n), 1);
  return list
    .map((d) => {
      const k = d.n / max;
      const size = Math.round(10 + 26 * Math.sqrt(k));
      // the dominant signal colours the dot: rage red, error purple, dead amber, else blue
      const c = d.rage * 2 >= d.n ? "220,38,38" : d.error * 2 >= d.n ? "147,51,234" : d.dead * 2 >= d.n ? "245,158,11" : "37,99,235";
      const a = r1(0.35 + 0.5 * k);
      return `<div class="d" style="left:${r1(d.x_pct)}%;top:${r1(d.y_pct)}%;width:${size}px;height:${size}px;background:rgba(${c},${a});box-shadow:0 0 ${Math.round(size / 2)}px rgba(${c},${a})"></div>`;
    })
    .join("");
}

function scrollBands(reach: OverlayData["reach"]): string {
  // band [p-10, p): the share that reached p-10 (0 = everyone); darker = fewer saw it
  let prev = 1;
  return reach
    .map((r) => {
      const from = r.pct - 10;
      const seen = prev;
      prev = r.share;
      const a = r1(Math.min(0.75, (1 - seen) * 0.75));
      return `<div class="b" style="top:${from}%;height:10%;background:rgba(17,24,39,${a});border-top:1px dashed rgba(255,255,255,.6)"><span class="t" style="top:4px">${Math.round(seen * 100)}% reached</span></div>`;
    })
    .join("");
}

function attentionBands(bands: OverlayData["attention"]): string {
  const max = bands.reduce((m, b) => Math.max(m, b.time_share), 0) || 1;
  return bands
    .map((b) => {
      const k = b.time_share / max;
      // warm = most attention, cool = least
      const c = k > 0.66 ? "239,68,68" : k > 0.33 ? "250,204,21" : "59,130,246";
      return `<div class="b" style="top:${r1(b.from_pct)}%;height:${r1(b.to_pct - b.from_pct)}%;background:rgba(${c},${r1(0.15 + 0.35 * k)})"><span class="t" style="top:4px">${Math.round(b.time_share * 100)}% of time</span></div>`;
    })
    .join("");
}

export function overlayHtml(d: OverlayData): string {
  const body = d.type === "click" ? dots(d.dots) : d.type === "scroll" ? scrollBands(d.reach) : attentionBands(d.attention);
  const L = d.legend;
  const keys =
    d.type === "click"
      ? `<br><i style="background:#2563eb"></i>clicks<i style="background:#dc2626"></i>rage<i style="background:#f59e0b"></i>dead<i style="background:#9333ea"></i>error`
      : d.type === "scroll"
        ? "<br>darker = fewer visitors scrolled that far"
        : "<br>share of visible time per tenth of the page";
  const legend = `<div id="afs-lg"><b>${d.type} heatmap</b> · ${escapeHtml(L.path.slice(0, 120))} · ${escapeHtml(L.device)} · ${escapeHtml(L.range)}<br>${L.clicks} clicks · ${L.pageviews} pageviews · snapshot ${escapeHtml(L.snapshot_at)} (masked)${keys}</div>`;
  return `<div id="afs-hm">${body}</div>${legend}`;
}
