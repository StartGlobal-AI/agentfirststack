import type { ConsentBanner } from "../config/schema";
import { DEFAULT_BANNER_TEXT } from "../lib/banner-text";

/**
 * The consent banner UI (consent_banner), bundled on its own (dist/consent-ui.txt, served at
 * <base>/cb/<version>.js) and loaded by the runtime only for a visitor who must see it (asked and
 * no current choice, afst('consent','open'), a data-afst-consent-open link, ?afst_consent=open)
 * or for the optional reopen button. Everything consent does happens in the runtime (core.ts
 * cbChoose); this file only draws the choice and hands it back through window.__afst_cbh.
 *
 * Law-shaped on purpose: "Reject all" looks exactly like "Accept all" on the first layer, the
 * settings layer has one unticked box per category (or the visitor's current choice when
 * reopened), necessary is always on, and closing without choosing changes nothing.
 * Accessible: a labelled dialog in a shadow root (the site's CSS can't break it), focus moved in
 * and restored, Tab kept inside modal layers, Escape leaves the settings layer, visible focus,
 * 44 px targets, no motion with prefers-reduced-motion, stacked buttons on small screens.
 */
export interface BannerHost {
  b: ConsentBanner;
  /** 0 first layer, 1 settings layer, -1 only the reopen button. */
  l: number;
  /** The visitor's consent id ("" before the first choice). */
  id: string;
  /** Asked and no choice yet: leaving the settings layer goes back to the first layer, not away. */
  p?: boolean;
  /** The current state per category: analytics, ads, personalization. */
  c: boolean[];
  done(analytics: boolean, ads: boolean, personalization: boolean, method: string, language?: string): void;
}

const CATS = ["analytics", "ads", "personalization"] as const;

const CSS = `*{box-sizing:border-box}
.w{position:fixed;z-index:2147483646;font-size:15px;line-height:1.5;color:var(--fg);text-align:left}
.bottom{left:0;right:0;bottom:0}.top{left:0;right:0;top:0}
.bottom-left{left:16px;bottom:16px;max-width:440px}.bottom-right{right:16px;bottom:16px;max-width:440px}
.m{inset:0;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.5)}
.d{position:relative;background:var(--bg);color:var(--fg);box-shadow:0 4px 24px rgba(0,0,0,.25);padding:20px 24px;max-height:100vh;overflow:auto}
.card .d,.m .d{border-radius:12px}.m .d{width:100%;max-width:560px;max-height:calc(100vh - 32px)}
.in{max-width:1100px;margin:0 auto}
h2{font-size:18px;line-height:1.3;margin:0 0 8px;font-weight:600;color:inherit}
p{margin:0 0 12px}a{color:inherit;text-decoration:underline}
.bt{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
button{font:inherit;cursor:pointer;border-radius:8px;padding:10px 18px;min-height:44px;margin:0}
.b{background:var(--ac);color:var(--at);border:2px solid var(--ac);font-weight:600;flex:1 1 auto}
.s{background:transparent;color:var(--fg);border:2px solid currentColor;flex:1 1 auto}
:focus-visible{outline:3px solid var(--ac);outline-offset:2px}.b:focus-visible{outline-color:var(--fg)}
.d:focus{outline:none}.d:focus-visible{outline:3px solid var(--ac)}
ul{list-style:none;margin:0 0 12px;padding:0}li{border-top:1px solid rgba(127,127,127,.35);padding:12px 0}
label{display:flex;align-items:center;gap:10px;font-weight:600;cursor:pointer;min-height:28px}
input{width:20px;height:20px;margin:0;flex:none;accent-color:var(--ac)}
li p{margin:4px 0 0 30px;font-size:14px;opacity:.85}.on{margin-left:auto;font-size:13px;font-weight:400;opacity:.85}
.id{font-size:12px;opacity:.75;word-break:break-all}
.x{position:absolute;top:6px;right:6px;background:transparent;border:0;color:var(--fg);font-size:24px;line-height:1;padding:8px 12px}
.r{position:fixed;left:16px;bottom:16px;z-index:2147483646;background:var(--bg);color:var(--fg);border:1px solid rgba(127,127,127,.5);border-radius:999px;padding:8px 14px;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.2)}
@media (max-width:600px){.bottom-left,.bottom-right{left:8px;right:8px;max-width:none}.bt{flex-direction:column}.bt button{width:100%}.d{padding:16px}}
@media (prefers-reduced-motion:no-preference){.d{animation:afst-in .2s ease-out}@keyframes afst-in{from{opacity:0;transform:translateY(8px)}}}`;

export function render(h: BannerHost) {
  const d = document;
  if (!d.body) return void d.addEventListener("DOMContentLoaded", () => render(h));
  const b: Partial<ConsentBanner> = h.b || {};
  const langs = b.languages || {};
  // The text: <html lang>, then the browser's languages ("de-at" falls back to "de").
  let lang = "";
  const nav = navigator as Navigator & { languages?: readonly string[] };
  for (const t of [d.documentElement.lang, ...(nav.languages || [nav.language])]) {
    const l = String(t || "").toLowerCase();
    const short = l.split("-")[0]!;
    lang = langs[l] ? l : langs[short] ? short : "";
    if (lang) break;
  }
  const T = { ...DEFAULT_BANNER_TEXT, ...b.text, ...(lang ? langs[lang] : {}) };
  const cats = CATS.filter((k) => !b.categories || b.categories.indexOf(k) !== -1);
  const col = b.colors || {};
  const pos = b.position || "bottom";

  let host = d.getElementById("afst-consent");
  if (!host) {
    host = d.createElement("div");
    host.setAttribute("id", "afst-consent");
    d.body.appendChild(host);
  }
  const vars: [string, string | undefined, string][] = [
    ["--bg", col.background, "#ffffff"],
    ["--fg", col.text, "#1f2328"],
    ["--ac", col.accent, "#1a56db"],
    ["--at", col.accent_text, "#ffffff"],
  ];
  for (const [k, v, def] of vars) host.style.setProperty(k, v || def);
  const root = host.shadowRoot || host.attachShadow({ mode: "open" });
  const back = d.activeElement as HTMLElement | null;

  const el = (tag: string, attrs: Record<string, string> = {}, kids: (Node | string | null | false)[] = []) => {
    const e = d.createElement(tag);
    for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]!);
    for (const k of kids) if (k) e.appendChild(typeof k === "string" ? d.createTextNode(k) : k);
    return e;
  };
  const btn = (cls: string, text: string, f: () => void, label?: string) => {
    const e = el("button", { type: "button", class: cls, ...(label ? { "aria-label": label } : {}) }, [text]);
    e.addEventListener("click", f);
    return e;
  };
  const clear = () => {
    root.textContent = "";
    root.appendChild(el("style", {}, [CSS]));
  };
  const reopen = () => {
    clear();
    root.appendChild(btn("r", T.reopen, () => show(1, false)));
  };
  const close = (refocus: boolean) => {
    clear();
    if (b.reopen_button) reopen();
    if (refocus && back && back.focus)
      try {
        back.focus();
      } catch {
        /* gone */
      }
  };
  const choose = (a: boolean, ads: boolean, p: boolean, m: string) => {
    close(true);
    h.done(a, ads, p, m, lang || undefined);
  };
  const all = (on: boolean) => () =>
    choose(
      on && cats.indexOf("analytics") !== -1,
      on && cats.indexOf("ads") !== -1,
      on && cats.indexOf("personalization") !== -1,
      on ? "accept_all" : "reject_all",
    );

  /** l 0: first layer; l 1: settings (fromFirst: opened from the first layer, so Escape goes back to it). */
  function show(l: number, fromFirst: boolean) {
    clear();
    const modal = l === 1 || pos === "center";
    const wrap = el("div", { class: `w ${modal ? "m" : `${pos}${/left|right/.test(pos) ? " card" : ""}`}` });
    const dlg = el("div", {
      class: "d",
      role: "dialog",
      "aria-modal": String(modal),
      "aria-labelledby": "afst-t",
      "aria-describedby": "afst-m",
      tabindex: "-1",
      ...(lang ? { lang } : {}),
    });
    const privacy = b.privacy_url ? el("a", { href: b.privacy_url, target: "_blank", rel: "noopener" }, [T.privacy]) : null;
    const body = el("p", { id: "afst-m" }, [T.body, privacy && " ", privacy]);
    const reject = btn("b", T.reject, all(false));
    const accept = btn("b", T.accept, all(true));
    let content: Node[];
    if (l === 0)
      content = [
        el("h2", { id: "afst-t" }, [T.title]),
        body,
        el("div", { class: "bt" }, [reject, accept, btn("s", T.settings, () => show(1, true))]),
      ];
    else {
      const boxes: Record<string, HTMLInputElement> = {};
      const item = (k: string, desc: string, on: boolean, fixed: boolean) => {
        const box = el("input", { type: "checkbox", id: `afst-c-${k}`, "aria-describedby": `afst-d-${k}` }) as HTMLInputElement;
        box.checked = on;
        if (fixed) box.disabled = true;
        else boxes[k] = box;
        return el("li", {}, [
          el("label", { for: `afst-c-${k}` }, [
            box,
            (T as Record<string, string>)[k]!,
            fixed && el("span", { class: "on" }, [T.always_on]),
          ]),
          el("p", { id: `afst-d-${k}` }, [desc]),
        ]);
      };
      const list = el("ul", {}, [
        item("necessary", T.necessary_desc, true, true),
        ...cats.map((k) => item(k, (T as Record<string, string>)[`${k}_desc`]!, !!h.c[CATS.indexOf(k)], false)),
      ]);
      const save = btn("s", T.save, () =>
        choose(!!boxes.analytics?.checked, !!boxes.ads?.checked, !!boxes.personalization?.checked, "custom"),
      );
      content = [
        el("h2", { id: "afst-t" }, [T.settings_title]),
        body,
        list,
        h.id ? el("p", { class: "id" }, [`${T.consent_id}: ${h.id}`]) : null,
        el("div", { class: "bt" }, [reject, accept, save]),
        // The first visit's settings go back to the first layer; a reopened one just closes.
        btn("x", "×", () => (fromFirst ? show(0, false) : close(true)), T.close),
      ].filter((x): x is HTMLElement => !!x);
    }
    const inner = !modal && /^(bottom|top)$/.test(pos) ? [el("div", { class: "in" }, content)] : content;
    for (const n of inner) dlg.appendChild(n);
    wrap.appendChild(dlg);
    wrap.addEventListener("keydown", (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === "Escape" && l === 1) {
        e.preventDefault();
        if (fromFirst) show(0, false);
        else close(true);
      } else if (k === "Tab" && modal) {
        // Keep focus inside a modal layer.
        const f = Array.prototype.slice.call(dlg.querySelectorAll("button,a[href],input:not([disabled])")) as HTMLElement[];
        const first = f[0];
        const last = f[f.length - 1];
        const at = (root as ShadowRoot).activeElement;
        if ((e as KeyboardEvent).shiftKey && (at === first || at === dlg)) {
          e.preventDefault();
          last?.focus();
        } else if (!(e as KeyboardEvent).shiftKey && at === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    });
    root.appendChild(wrap);
    try {
      (dlg as HTMLElement).focus({ preventScroll: true });
    } catch {
      /* old browser */
    }
  }

  if (h.l < 0) reopen();
  else show(h.l, !!h.p && h.l === 1);
}
