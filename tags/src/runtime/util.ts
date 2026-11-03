export const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && Object.prototype.toString.call(v) === "[object Object]";

export const isArgs = (v: unknown): v is ArrayLike<unknown> =>
  !!v && typeof v === "object" && (Object.prototype.toString.call(v) === "[object Arguments]" || Array.isArray(v));

/** Dot path lookup ("ecommerce.items.0.price"). */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** GTM-style model merge: plain objects merge recursively, everything else replaces. */
export function deepMerge(target: Record<string, unknown>, src: Record<string, unknown>) {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (isObj(v)) {
      if (!isObj(target[k])) target[k] = {};
      deepMerge(target[k] as Record<string, unknown>, v);
    } else target[k] = v;
  }
}

/** Snapshot plain data (objects/arrays copied, other values by reference). */
export function snapshot<T>(v: T, depth = 0): T {
  if (depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => snapshot(x, depth + 1)) as unknown as T;
  if (isObj(v)) {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) o[k] = snapshot(v[k], depth + 1);
    return o as T;
  }
  return v;
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export function rnd(n: number): string {
  let s = "";
  const c = typeof crypto !== "undefined" && crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(n)) : null;
  for (let i = 0; i < n; i++) s += ALPHABET[(c ? c[i]! : Math.floor(Math.random() * 256)) & 31];
  return s;
}

export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  let s = v.replace(/[^\d.,-]/g, "");
  // "1.234,56" -> 1234.56 ; "1,234.56" -> 1234.56
  if (/,\d{1,2}$/.test(s) && s.indexOf(".") !== -1 && s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

export function readCookie(doc: Document, name: string): string | undefined {
  const parts = (doc.cookie || "").split(/;\s*/);
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i > 0 && p.slice(0, i) === name) {
      try {
        return decodeURIComponent(p.slice(i + 1));
      } catch {
        return p.slice(i + 1);
      }
    }
  }
  return undefined;
}

export function writeCookie(doc: Document, name: string, value: string, days: number, domain?: string, secure?: boolean) {
  let c = `${name}=${encodeURIComponent(value)}; Max-Age=${Math.round(days * 86400)}; Path=/; SameSite=Lax`;
  if (domain) c += `; Domain=${domain}`;
  if (secure) c += "; Secure";
  doc.cookie = c;
}

export function interpolate(v: unknown, get: (name: string) => unknown): unknown {
  if (typeof v === "string") {
    const whole = /^\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}$/.exec(v);
    if (whole) return get(whole[1]!) ?? "";
    return v.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, (_, n: string) => {
      const x = get(n);
      return x == null ? "" : String(x);
    });
  }
  if (Array.isArray(v)) return v.map((x) => interpolate(x, get));
  if (isObj(v)) {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) o[k] = interpolate(v[k], get);
    return o;
  }
  return v;
}

export function textOf(el: Element | null | undefined): string {
  if (!el) return "";
  const t = (el as HTMLElement).innerText ?? el.textContent ?? "";
  return String(t).replace(/\s+/g, " ").trim().slice(0, 200);
}

export function closest(el: Element | null | undefined, sel: string): Element | null {
  if (!el) return null;
  try {
    return el.closest ? el.closest(sel) : null;
  } catch {
    return null;
  }
}

export function matches(el: Element | null | undefined, sel: string): boolean {
  if (!el) return false;
  try {
    return !!el.matches && el.matches(sel);
  } catch {
    return false;
  }
}
