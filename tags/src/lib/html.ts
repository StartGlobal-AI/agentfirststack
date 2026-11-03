/* custom_html templating (used by the browser runtime; DOM-free so Worker tests can import it). */

/**
 * HTML-encode a value for custom_html. Everything except letters, digits and `_ . , : @ -`
 * becomes a numeric character reference, which covers & < > " ' and backtick, plus spaces, `=`
 * and `/` (unquoted attributes), and backslash, `$`, `{`, `(` (script text, where entities are
 * not decoded, so they stay inert). In HTML text and attributes the browser decodes them back,
 * so the value displays unchanged.
 */
export function escapeHtml(s: string): string {
  let out = "";
  for (const ch of s) out += /^[A-Za-z0-9_.,:@-]$/.test(ch) ? ch : `&#${ch.codePointAt(0)};`;
  return out;
}

/** URL schemes that run code when a value lands in href/src (browsers ignore whitespace/controls in them). */
const SCRIPT_URL = /^(?:javascript|vbscript):/i;

/**
 * `{{var}}` templating for custom_html: values come from the page (url_param, cookie, dom_*,
 * data_layer...) and are attacker-controllable, so each is HTML-encoded, and a value that is a
 * javascript:/vbscript: URL is dropped. Only the tag's own template is HTML.
 */
export function interpolateHtml(template: string, get: (name: string) => unknown): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, (_, n: string) => {
    const x = get(n);
    if (x == null) return "";
    const v = String(x);
    if (SCRIPT_URL.test(v.replace(/[\u0000-\u0020\u007f-\u009f]/g, ""))) return "";
    return escapeHtml(v);
  });
}
