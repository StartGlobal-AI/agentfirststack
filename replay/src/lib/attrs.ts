/**
 * Element attributes as the recorder lets them leave the browser: an allowlist. Pure and DOM-free
 * (the recorder passes the element's text rule), so it is unit-tested in Node.
 *   - kept as they are: structure, layout and state (class, id, type, name, role, width, ...);
 *   - masked by the element's text rule: text people read (title, alt, placeholder, aria-label,
 *     ...) and data-* / aria-* values, except a vocabulary of UI states ("open", "true", ...),
 *     short numbers and aria id references;
 *   - scrubbed: links (no query, id-like path segments as :id, mailto:/tel: as the bare scheme),
 *     resources (no query), srcset, url() in style attributes and inlined stylesheets;
 *   - dropped: everything else (event handlers, nonce, integrity, srcdoc, unknown attributes,
 *     <meta content> other than viewport/color-scheme/theme-color).
 * SVG elements keep their geometry and presentation attributes.
 */
import { applyRule, maskAll, scrubCss, scrubLink, scrubResource, scrubSrcset, type TextRule } from "./mask-rules";

const words = (s: string) => new Set(s.split(" "));

const KEEP = words(
  "class id type name role rel media sizes width height colspan rowspan span dir lang tabindex for disabled checked selected readonly required multiple hidden open draggable contenteditable spellcheck autocomplete inputmode enterkeyhint target loading decoding crossorigin referrerpolicy as charset cols rows maxlength minlength min max step size start reversed scope headers align valign bgcolor border cellpadding cellspacing frameborder allowfullscreen controls autoplay loop muted playsinline preload kind srclang default shape coords accept form method novalidate enctype list popover inert slot part translate is wrap high low optimum",
);
const TEXT = words(
  "title alt placeholder label abbr summary download datetime aria-label aria-description aria-placeholder aria-valuetext aria-roledescription aria-braillelabel aria-brailleroledescription",
);
const LINKS = words("href action formaction cite");
const RESOURCES = words("src poster background data xlink:href manifest longdesc icon lowsrc");
/** UI state words a data-* / aria-* value keeps in every mode (styling hooks like data-state="open"). */
const STATE = words(
  "true false on off yes no open opened closed close active inactive checked unchecked selected unselected visible invisible hidden shown expanded collapsed enabled disabled horizontal vertical top bottom left right start end center middle before after mixed none auto dark light system primary secondary tertiary loading loaded idle error success warning info danger small medium large xs sm md lg xl xxl default page step location date time polite assertive grid list ltr rtl",
);
const ARIA_REFS = /^aria-(labelledby|describedby|controls|owns|activedescendant|details|errormessage|flowto)$/;
const shortNumber = (v: string) => /^-?\d{1,4}(\.\d+)?$/.test(v);

function value(k: string, v: string, tag: string, rule: () => TextRule): string | null {
  if (k.startsWith("rr_")) return v; // rrweb's own (placeholder sizes, scroll positions, media state)
  if (k === "_csstext" || k === "style") return scrubCss(v);
  if (k === "srcset" || k === "imagesrcset") return scrubSrcset(v);
  if (LINKS.has(k)) return scrubLink(v);
  if (RESOURCES.has(k)) return scrubResource(v);
  if (TEXT.has(k)) return applyRule(rule(), v);
  // input/textarea/select values come masked from rrweb's maskInputFn; other values are text
  if (k === "value") return tag === "input" || tag === "textarea" || tag === "select" || shortNumber(v) ? v : applyRule(rule(), v);
  if (k.startsWith("data-") || k.startsWith("aria-"))
    return STATE.has(v.toLowerCase()) || shortNumber(v) || ARIA_REFS.test(k) ? v : applyRule(rule(), v);
  return KEEP.has(k) ? v : null;
}

/** Scrub `attrs` in place (a snapshot node's attributes, or an attribute mutation's changes). */
export function scrubAttributes(
  tag: string,
  attrs: Record<string, unknown>,
  opts: { rule: () => TextRule; svg: boolean; metaName?: string | null },
): void {
  const t = tag.toLowerCase();
  for (const key of Object.keys(attrs)) {
    const k = key.toLowerCase();
    const v = attrs[key];
    if (k.startsWith("on") || k === "nonce" || k === "srcdoc" || k === "integrity") {
      delete attrs[key];
      continue;
    }
    if (typeof v !== "string") {
      // rrweb sends style changes as {property: value | false}: their url()s too
      if (k === "style" && v && typeof v === "object")
        for (const [p, x] of Object.entries(v as Record<string, unknown>))
          if (typeof x === "string") (v as Record<string, unknown>)[p] = scrubCss(x);
      continue; // booleans, and null (= attribute removed)
    }
    let out: string | null;
    if (t === "meta" && k === "content")
      out = /^(viewport|color-scheme|theme-color)$/i.test(String(attrs.name ?? opts.metaName ?? "")) ? v : null;
    else if (opts.svg && !TEXT.has(k) && !LINKS.has(k) && !RESOURCES.has(k) && !k.startsWith("data-") && !k.startsWith("aria-"))
      out = k === "style" ? scrubCss(v) : v; // geometry and presentation
    else out = value(k, v, t, opts.rule);
    if (out === null) delete attrs[key];
    else attrs[key] = out;
  }
  if (t === "input" && String(attrs.type).toLowerCase() === "hidden" && typeof attrs.value === "string") attrs.value = maskAll(attrs.value);
}
