/**
 * An rrweb full snapshot (the serialized DOM the recorder took in the visitor's browser, already
 * masked there: text as asterisks in strict mode, input values masked, blocked elements as empty
 * boxes of their size) back to static HTML, for rendering a heatmap image. Nothing runs: scripts,
 * event handlers, frames, objects and javascript: URLs are dropped; stylesheets rrweb inlined
 * (_cssText) become <style>; blocked elements and frames become grey boxes of their recorded size.
 * Pure: the caller renders it with JavaScript disabled and requests limited to the site's hosts.
 */

/** rrweb-snapshot's NodeType. */
const DOCUMENT = 0;
const DOCTYPE = 1;
const ELEMENT = 2;
const TEXT = 3;
const CDATA = 4;
const COMMENT = 5;

export interface SnapNode {
  type: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SnapNode[];
  textContent?: string;
  isStyle?: boolean;
  isSVG?: boolean;
  isShadowHost?: boolean;
  isShadow?: boolean;
}

export interface HtmlOptions {
  /** <base href>: the recorded page's URL, so relative URLs resolve */
  baseHref: string;
  /** our own markup: first in <head> and last in <body> */
  head: string;
  bodyEnd: string;
  /** stop past this many characters (null result) */
  maxChars: number;
}

const DROP = new Set(["script", "noscript", "template", "base", "portal"]);
/** replaced by a grey box of their size: their content isn't in the snapshot (or would run) */
const BOX = new Set(["iframe", "frame", "object", "embed", "applet", "video", "audio", "canvas"]);
const VOID = new Set(["area", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const URL_ATTRS = new Set(["href", "src", "xlink:href", "poster", "background", "action", "formaction", "data", "cite"]);
const ATTR_NAME = /^[a-zA-Z_:][-a-zA-Z0-9_:.]{0,60}$/;
const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]{0,60}$/;

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** CSS kept as text inside <style>: it must not close the element (a "<" is a CSS escape there). */
const safeCss = (s: string) => s.replace(/</g, "\\3c ");

/** A URL attribute that can't run anything: http(s), relative, or an image data URL. */
function safeUrl(v: string): boolean {
  const t = v.replace(/[\u0000- ]+/g, "").toLowerCase();
  if (/^(javascript|vbscript|file|blob|filesystem):/.test(t)) return false;
  if (t.startsWith("data:")) return /^data:image\/(png|jpe?g|gif|webp|svg\+xml|avif)[;,]/.test(t);
  return true;
}

const px = (v: unknown): string | null => {
  const s = typeof v === "number" ? `${v}px` : typeof v === "string" ? v : "";
  return /^\d{1,5}(\.\d+)?px$/.test(s) ? s : null;
};

function box(a: Record<string, unknown>): string {
  const w = px(a.rr_width) ?? px(a.width && /^\d+$/.test(String(a.width)) ? `${a.width}px` : null) ?? "100%";
  const h = px(a.rr_height) ?? px(a.height && /^\d+$/.test(String(a.height)) ? `${a.height}px` : null) ?? "150px";
  return `<div style="display:inline-block;width:${w};height:${h};max-width:100%;background:#e5e7eb;outline:1px dashed #9ca3af"></div>`;
}

export function snapshotToHtml(root: SnapNode, o: HtmlOptions): string | null {
  const out: string[] = [];
  let size = 0;
  let headDone = false;
  let bodyDone = false;
  const push = (s: string) => {
    out.push(s);
    size += s.length;
    return size <= o.maxChars;
  };
  const headStart = `<base href="${escapeHtml(o.baseHref)}"><meta charset="utf-8">${o.head}`;

  const attrs = (tag: string, a: Record<string, unknown>): string => {
    let s = "";
    for (const [k0, v] of Object.entries(a)) {
      const k = k0.toLowerCase();
      if (!ATTR_NAME.test(k0) || k.startsWith("on") || k.startsWith("rr_") || k === "_csstext" || k === "srcdoc" || k === "integrity")
        continue;
      if (v === null || v === undefined || v === false) continue;
      if (tag === "meta" && (k === "http-equiv" || k === "content")) continue;
      const val = v === true ? "" : String(v);
      if (URL_ATTRS.has(k) && !safeUrl(val)) continue;
      if (k === "srcset" && /javascript:|data:(?!image\/)/i.test(val)) continue;
      if (k === "style" && /expression\s*\(|javascript:/i.test(val)) continue;
      s += v === true ? ` ${k0}` : ` ${k0}="${escapeHtml(val.slice(0, 20_000))}"`;
    }
    return s;
  };

  const walk = (n: SnapNode, inStyle: boolean, svg: boolean): boolean => {
    switch (n.type) {
      case DOCUMENT:
        for (const c of n.childNodes ?? []) if (!walk(c, false, false)) return false;
        return true;
      case DOCTYPE:
      case CDATA:
      case COMMENT:
        return true;
      case TEXT: {
        const t = String(n.textContent ?? "");
        return push(inStyle || n.isStyle ? safeCss(t) : escapeHtml(t));
      }
      case ELEMENT: {
        const tag0 = String(n.tagName ?? "");
        if (!TAG_NAME.test(tag0)) return true;
        const tag = tag0.toLowerCase();
        const a = n.attributes ?? {};
        if (DROP.has(tag)) return true;
        if (BOX.has(tag)) return push(box(a));
        if (tag === "link") {
          const rel = String(a.rel ?? "").toLowerCase();
          if (typeof a._cssText === "string") return push(`<style>${safeCss(a._cssText)}</style>`);
          if (rel !== "stylesheet") return true;
        }
        // a blocked element (data-afsr-block): rrweb kept only its size
        if (a.rr_width || a.rr_height) return push(box(a));
        const isSvg = svg || !!n.isSVG || tag === "svg";
        if (!push(`<${tag0}${attrs(tag, a)}>`)) return false;
        if (tag === "head" && !headDone) {
          headDone = true;
          if (!push(headStart)) return false;
        }
        if (tag === "style" && typeof a._cssText === "string") {
          if (!push(safeCss(a._cssText))) return false;
        } else {
          // shadow roots as declarative shadow DOM (no script needed)
          const kids = n.childNodes ?? [];
          const shadow = kids.filter((c) => c.isShadow);
          if (n.isShadowHost && shadow.length) {
            if (!push('<template shadowrootmode="open">')) return false;
            for (const c of shadow) if (!walk(c, tag === "style", isSvg)) return false;
            if (!push("</template>")) return false;
          }
          for (const c of kids) if (!c.isShadow && !walk(c, tag === "style", isSvg)) return false;
        }
        if (tag === "body" && !bodyDone) {
          bodyDone = true;
          if (!push(o.bodyEnd)) return false;
        }
        if (VOID.has(tag) && !isSvg) return true;
        return push(`</${tag0}>`);
      }
      default:
        return true;
    }
  };
  if (!walk(root, false, false)) return null;
  let html = out.join("");
  if (!headDone) html = `<head>${headStart}</head>${html}`;
  if (!bodyDone) html += o.bodyEnd;
  return `<!DOCTYPE html>${html}`;
}

/** The full snapshot (rrweb type 2) and the viewport (type 4 Meta) in a chunk's events. */
export function findSnapshot(
  events: unknown[],
): { node: SnapNode; href: string | null; width: number | null; height: number | null } | null {
  let href: string | null = null;
  let width: number | null = null;
  let height: number | null = null;
  for (const e of events) {
    const ev = e as { type?: number; data?: Record<string, unknown> };
    if (ev?.type === 4 && ev.data) {
      href = typeof ev.data.href === "string" ? ev.data.href : href;
      width = typeof ev.data.width === "number" ? ev.data.width : width;
      height = typeof ev.data.height === "number" ? ev.data.height : height;
    }
    if (ev?.type === 2 && ev.data && typeof ev.data.node === "object" && ev.data.node)
      return { node: ev.data.node as SnapNode, href, width, height };
  }
  return null;
}
