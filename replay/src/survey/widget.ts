/**
 * afs-replay survey widget, served at /sv/<site_id>.<rev>.js with the site's active surveys inlined
 * as __AFSV__, lazy-loaded by the loader (src/recorder/loader.ts) only when the site has active
 * surveys (or a ?afsr_survey= preview). Bundled + minified by scripts/build-recorder.mjs
 * (dist/survey.txt).
 *
 * Safety on customers' pages:
 * - Survey text (the site owner's) and anything typed is put into the page with textContent and
 *   form values only: no innerHTML, no HTML strings, no eval; the accent colour is re-checked
 *   against #rgb/#rrggbb before it becomes a CSS custom property.
 * - Each widget lives in a closed Shadow DOM whose host carries data-afsr-block and
 *   data-afsr-ignore and gets its shadow root before it is attached, so neither rrweb nor our own
 *   listeners ever record the survey or the answers. Typing, input, clipboard and focus events stop
 *   at the shadow root, so the page's own bubble-phase listeners don't see them; a page script
 *   listening in the capture phase (or wrapping attachShadow / fetch first) still could: it is the
 *   site's own page, which is the trust boundary of an on-site survey.
 * - A text box takes the focus only when the visitor opened the survey, or moved on to a later
 *   question, and nothing else on the page has it. Styles go in through adoptedStyleSheets (no
 *   inline <style>, so a strict style-src CSP doesn't break it; a <style> is only the fallback).
 * - Answers travel only to POST <base>/f (text/plain, keepalive); the session id only when the
 *   survey links responses to sessions (auto) or the respondent ticked the box (ask).
 * - No cookies: frequency flags in sessionStorage / localStorage (afsr_sv_<id>).
 */

import { type El, stableSelector } from "../lib/describe";
import { globToRegExp } from "../lib/mask-rules";
import { type Answer, isAnswered, nextIndex, type Question } from "../lib/survey";

interface PS {
  id: string;
  v: number;
  kind: "popover" | "embedded" | "feedback";
  q: Question[];
  tg: { p?: string[]; xp?: string[]; d?: string[]; t?: Record<string, string>; id?: boolean; sr?: number };
  tr: { on: string; s?: number; pct?: number; sig?: string[] };
  fr: string;
  ap: { pos?: string; side?: string; theme?: string; accent?: string; str?: Record<string, string> };
  ls: string;
  gpc?: 1;
  sel?: string;
  el?: 1;
  test?: 1;
  /** preview token (test posts carry it) */
  pt?: string;
}
interface Cfg {
  site: string;
  base: string;
  s: PS[];
}
/** What the loader shares (window.__afsrSv): tags, identified, the recorded session, survey commands. */
interface Shared {
  T: Record<string, unknown>;
  U?: number;
  q: unknown[][];
  sid: () => string | null;
  h?: (c: unknown[]) => void;
}

declare const __AFSV__: Cfg;

const DEFAULT_STRINGS = {
  next: "Next",
  submit: "Send",
  thanks: "Thank you!",
  close: "Close",
  feedback: "Feedback",
  share_session: "Share my visit to this site with my answer, to help fix problems",
  other: "Other",
  pick: "Point at the part of the page you mean",
  picked: "Part of the page selected",
  skip: "Skip",
};

const CSS = `:host{all:initial}
.box{font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1d1d1f;background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);padding:16px;width:320px;max-width:calc(100vw - 32px);box-sizing:border-box;position:relative}
.box.fixed{position:fixed;z-index:2147483646}
.br{right:16px;bottom:16px}.bl{left:16px;bottom:16px}.ce{left:50%;top:50%;transform:translate(-50%,-50%)}
.side{right:16px;top:50%;transform:translateY(-50%)}.side.l{left:16px;right:auto}
.inline{width:auto;max-width:none;box-shadow:none;border:1px solid #ddd}
.dark{background:#1f1f22;color:#f2f2f5}
@media (prefers-color-scheme:dark){.auto{background:#1f1f22;color:#f2f2f5}}
.x{position:absolute;right:8px;top:6px;border:0;background:none;font-size:18px;cursor:pointer;color:inherit;opacity:.6}
.t{margin:0 18px 12px 0;font-weight:600}
.row{display:flex;flex-wrap:wrap;gap:6px}
button.o{border:1px solid #ccc;background:transparent;color:inherit;border-radius:8px;padding:6px 10px;cursor:pointer;font:inherit}
button.o[aria-pressed=true],button.o:hover{border-color:var(--a,#2a6df4);background:var(--a,#2a6df4);color:#fff}
.sc button.o{min-width:28px;padding:6px 0;flex:1}
.lab{display:flex;justify-content:space-between;font-size:12px;opacity:.7;margin-top:4px}
textarea,input.tx{width:100%;box-sizing:border-box;font:inherit;padding:8px;border:1px solid #ccc;border-radius:8px;background:transparent;color:inherit}
textarea{min-height:80px;resize:vertical}
.ft{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;align-items:center}
button.p{border:0;background:var(--a,#2a6df4);color:#fff;border-radius:8px;padding:8px 14px;cursor:pointer;font:inherit}
button.p:disabled{opacity:.4;cursor:default}
button.l{border:0;background:none;color:inherit;text-decoration:underline;cursor:pointer;font:inherit;font-size:12px;opacity:.8;padding:0}
label.ck{display:flex;gap:6px;font-size:12px;margin-top:10px;align-items:flex-start}
.tab{position:fixed;z-index:2147483645;top:50%;right:0;transform:translateY(-50%) rotate(-90deg);transform-origin:100% 100%;border:0;background:var(--a,#2a6df4);color:#fff;padding:6px 12px;border-radius:8px 8px 0 0;font:600 13px system-ui,sans-serif;cursor:pointer}
.tab.l{left:0;right:auto;transform:translateY(-50%) rotate(90deg);transform-origin:0 100%}
.pk{position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:transparent}
.hl{position:fixed;pointer-events:none;border:2px solid var(--a,#2a6df4);border-radius:4px;background:rgba(42,109,244,.08)}
.cx{position:fixed;top:12px;left:50%;transform:translateX(-50%)}`;

(() => {
  const w = window as unknown as Record<string, unknown> & { __afsrSv?: Shared; __afsrSvOn?: 1; doNotTrack?: string };
  const C = __AFSV__;
  if (w.__afsrSvOn || !C || !Array.isArray(C.s)) return;
  w.__afsrSvOn = 1;
  const d = document;
  const src = ((d.currentScript as HTMLScriptElement | null) || { src: "" }).src;
  const base = src ? src.replace(/\/sv\/[^/?#]+\.js([?#].*)?$/, "") : C.base;
  const boot: Shared = w.__afsrSv || { T: {}, q: [], sid: () => null };
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  const gpc = !!(nav.globalPrivacyControl || nav.doNotTrack === "1" || w.doNotTrack === "1");
  const store = (k: string) => {
    try {
      return w[k] as Storage;
    } catch {
      return null;
    }
  };
  const ss = store("sessionStorage");
  const ls = store("localStorage");
  const get = (s: Storage | null, k: string) => {
    try {
      return s ? s.getItem(k) : null;
    } catch {
      return null;
    }
  };
  const put = (s: Storage | null, k: string, v: string) => {
    try {
      if (s) s.setItem(k, v);
    } catch {
      /* storage blocked: the survey may show again */
    }
  };
  const ua = nav.userAgent || "";
  const device =
    /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))
      ? "tablet"
      : /Mobi|iPhone|Android/i.test(ua)
        ? "mobile"
        : "desktop";
  const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const post = (b: Record<string, unknown>) => {
    try {
      void fetch(`${base}/f`, {
        method: "POST",
        body: JSON.stringify({ v: 1, s: C.site, ...b }),
        keepalive: true,
        // never the site's cookies, also behind a first-party proxy
        credentials: "omit",
        headers: { "content-type": "text/plain" },
      }).catch(() => {});
    } catch {
      /* never break the page */
    }
  };
  const rid = () => {
    let s = "";
    for (const b of crypto.getRandomValues(new Uint8Array(16))) s += "0123456789abcdefghjkmnpqrstvwxyz"[b & 31];
    return s;
  };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const e = d.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const btn = (cls: string, text: string, on: () => void) => {
    const b = el("button", cls, text);
    b.type = "button";
    b.addEventListener("click", on);
    return b;
  };
  const hosts = new WeakSet<EventTarget>();
  /** A closed shadow root on a fresh host, attached before the host enters the page (rrweb never sees it). */
  const mount = (accent: string | undefined, into?: Element | null) => {
    const host = el("div");
    host.setAttribute("data-afsr-block", "");
    host.setAttribute("data-afsr-ignore", "");
    hosts.add(host);
    if (accent && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(accent)) host.style.setProperty("--a", accent);
    const root = host.attachShadow({ mode: "closed" });
    // What is typed into the survey stays in it: these events don't bubble out to the page's own
    // listeners (capture-phase listeners on window/document still see the retargeted event).
    for (const t of [
      "keydown",
      "keyup",
      "keypress",
      "beforeinput",
      "input",
      "change",
      "paste",
      "copy",
      "cut",
      "compositionstart",
      "compositionupdate",
      "compositionend",
      "focusin",
      "focusout",
    ])
      root.addEventListener(t, (e) => e.stopPropagation());
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      root.appendChild(el("style", "", CSS));
    }
    (into || d.body || d.documentElement).appendChild(host);
    return { host, root };
  };

  const key = (sv: PS) => `afsr_sv_${sv.id}`;
  const tagHolds = (k: string, want: string) => {
    const v = boot.T[k];
    if (v === undefined || v === null) return false;
    return (Array.isArray(v) ? v : [v]).some((x) => String(x) === want);
  };
  /** Targeting and frequency (`always`: the feedback tab, which stays). */
  const eligible = (sv: PS, always = false) => {
    if (sv.test) return true;
    const p = location.pathname;
    const g = sv.tg;
    if (gpc && !sv.gpc) return false;
    if (g.p && !g.p.some((x) => globToRegExp(x).test(p))) return false;
    if (g.xp && g.xp.some((x) => globToRegExp(x).test(p))) return false;
    if (g.d && g.d.indexOf(device) === -1) return false;
    if (g.t) for (const k in g.t) if (!tagHolds(k, g.t[k]!)) return false;
    if (g.id !== undefined && !!boot.U !== g.id) return false;
    if (g.sr !== undefined) {
      const k = `afsr_svs_${sv.id}`;
      let v = get(ss, k);
      if (!v) put(ss, k, (v = Math.random() < g.sr ? "1" : "0"));
      if (v !== "1") return false;
    }
    const K = key(sv);
    if (always) return true;
    if (seen.has(sv.id)) return false;
    if (sv.fr === "once_per_tab") return !get(ss, K);
    if (sv.fr === "until_answered") return get(ls, K) !== "done" && !get(ss, K);
    return !get(ls, K);
  };
  // Shown on this page: storage may be blocked, so this is remembered here too.
  const seen = new Set<string>();
  const shown = (sv: PS) => {
    seen.add(sv.id);
    if (!sv.test) put(sv.fr === "once_per_visitor" ? ls : ss, key(sv), "1");
  };
  const answered = (sv: PS) => {
    if (!sv.test) put(sv.fr === "once_per_tab" ? ss : ls, key(sv), "done");
  };

  let popoverOpen = false;
  const live = new Set<string>();

  /** Show one survey: in a corner (popover, feedback panel) or inside `into` (embedded). */
  /** `byVisitor`: the visitor opened it (feedback tab, a manual call): only then may a text box take the focus. */
  const run = (sv: PS, into?: Element | null, byVisitor = false) => {
    if (live.has(sv.id) || (!into && popoverOpen)) return;
    live.add(sv.id);
    if (!into) popoverOpen = true;
    const S: typeof DEFAULT_STRINGS = { ...DEFAULT_STRINGS, ...(sv.ap.str || {}) };
    const qs = sv.q.map((q) => (q.randomize && q.choices ? { ...q, choices: [...q.choices].sort(() => Math.random() - 0.5) } : q));
    // no prototype: question ids like "constructor" can't read inherited values
    const answers: Record<string, Answer> = Object.create(null);
    const r = rid();
    let share = sv.ls === "auto";
    let picked: { s: string; top: number } | null = null;
    let finished = false;
    const m = mount(sv.ap.accent, into);
    const theme = sv.ap.theme === "dark" ? "dark" : sv.ap.theme === "light" ? "" : "auto";
    const pos =
      sv.kind === "feedback"
        ? `side${sv.ap.side === "left" ? " l" : ""}`
        : sv.ap.pos === "bottom_left"
          ? "bl"
          : sv.ap.pos === "center"
            ? "ce"
            : "br";
    const box = el("div", `box ${into ? "inline" : `fixed ${pos}`} ${theme}`);
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-live", "polite");
    m.root.appendChild(box);
    const send = (done: boolean) => {
      const a: Record<string, Answer> = Object.create(null);
      for (const k in answers) if (isAnswered(answers[k])) a[k] = answers[k];
      if (!done && !Object.keys(a).length) return;
      const sid = share ? boot.sid() : null;
      post({
        sv: sv.id,
        ver: sv.v,
        r,
        a,
        d: done ? 1 : 0,
        p: location.pathname,
        ...(sid ? { sid } : {}),
        ...(picked ? { el: picked } : {}),
        ...(sv.test ? { t: sv.pt } : {}),
      });
    };
    const close = () => {
      if (!finished) send(false);
      m.host.remove();
      live.delete(sv.id);
      if (!into) popoverOpen = false;
    };
    const finish = () => {
      finished = true;
      send(true);
      answered(sv);
      box.replaceChildren(el("p", "t", S.thanks));
      if (!into) setTimeout(close, 2500);
    };
    const show = (i: number) => {
      const q = qs[i]!;
      const next = () => {
        const j = nextIndex(qs, i, answers[q.id]);
        if (j < 0) finish();
        else show(j);
      };
      const x = btn("x", "\u00d7", close);
      x.setAttribute("aria-label", S.close);
      const body: HTMLElement[] = [x, el("p", "t", q.text)];
      const go = btn("p", S.next, next);
      // Next or Send depends on the answer (skip logic), so it follows each change.
      const ok = () => {
        go.disabled = !!q.required && !isAnswered(answers[q.id]);
        go.textContent = nextIndex(qs, i, answers[q.id]) < 0 ? S.submit : S.next;
      };
      const pick = (v: Answer, auto: boolean, group: HTMLElement, b: HTMLElement) => {
        answers[q.id] = v;
        for (const c of Array.from(group.children)) c.setAttribute("aria-pressed", String(c === b));
        ok();
        if (auto) setTimeout(next, 150);
      };
      const scale = (vals: (string | number)[], labels: string[], cls: string) => {
        const row = el("div", `row ${cls}`);
        vals.forEach((v, k) => {
          const b = btn("o", labels[k]!, () => pick(typeof v === "number" ? v : String(v), true, row, b));
          b.setAttribute("aria-label", String(v));
          b.setAttribute("aria-pressed", "false");
          row.appendChild(b);
        });
        return row;
      };
      if (q.type === "reaction") body.push(scale([1, 2, 3, 4, 5], ["\u{1F61E}", "\u{1F641}", "\u{1F610}", "\u{1F642}", "\u{1F60D}"], "sc"));
      else if (q.type === "nps" || q.type === "rating") {
        const max = q.type === "nps" ? 10 : (q.scale && q.scale.max) || 5;
        const vals = Array.from({ length: q.type === "nps" ? 11 : max }, (_, k) => (q.type === "nps" ? k : k + 1));
        const style = q.scale && q.scale.style;
        body.push(
          scale(
            vals,
            vals.map((v) => (style === "stars" ? "★" : String(v))),
            "sc",
          ),
        );
        const lab = el("div", "lab");
        lab.append(el("span", "", (q.scale && q.scale.min_label) || ""), el("span", "", (q.scale && q.scale.max_label) || ""));
        body.push(lab);
      } else if (q.type === "single_choice" || q.type === "multi_choice") {
        const multi = q.type === "multi_choice";
        const row = el("div", "row");
        const sel = new Set<string>();
        let other = "";
        const multiAnswer = () => (answers[q.id] = other ? [...sel, other] : [...sel]);
        for (const c of q.choices || []) {
          const b = btn("o", c, () => {
            if (!multi) return pick(c, !q.other, row, b);
            if (sel.has(c)) sel.delete(c);
            else sel.add(c);
            b.setAttribute("aria-pressed", String(sel.has(c)));
            multiAnswer();
            ok();
          });
          b.setAttribute("aria-pressed", "false");
          row.appendChild(b);
        }
        body.push(row);
        if (q.other) {
          const t = el("input", "tx");
          t.maxLength = 200;
          t.placeholder = S.other;
          t.addEventListener("input", () => {
            other = t.value.trim();
            if (multi) multiAnswer();
            else if (other) {
              answers[q.id] = other;
              for (const c of Array.from(row.children)) c.setAttribute("aria-pressed", "false");
            } else if (!(q.choices || []).includes(String(answers[q.id]))) delete answers[q.id];
            ok();
          });
          body.push(t);
        }
      } else if (q.type === "short_text" || q.type === "long_text") {
        const t = q.type === "long_text" ? el("textarea") : el("input", "tx");
        t.maxLength = q.type === "long_text" ? 2000 : 200;
        if (q.placeholder) t.placeholder = q.placeholder;
        t.addEventListener("input", () => {
          answers[q.id] = t.value.trim();
          ok();
        });
        body.push(t);
        // Never take the focus from what the visitor is doing on the page (they could be typing a password).
        if (byVisitor || i > 0)
          setTimeout(() => {
            const a = d.activeElement;
            if (!a || a === d.body || a === m.host) t.focus({ preventScroll: true });
          }, 0);
      }
      if (sv.ls === "ask") {
        const lab = el("label", "ck");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = share;
        cb.addEventListener("change", () => {
          share = cb.checked;
        });
        lab.append(cb, el("span", "", S.share_session));
        body.push(lab);
      }
      const ft = el("div", "ft");
      if (sv.el && sv.kind === "feedback") ft.append(btn("l", picked ? S.picked : S.pick, () => pickElement(box, () => show(i))));
      if (!q.required && q.type !== "statement" && !isAnswered(answers[q.id])) ft.append(btn("l", S.skip, next));
      ft.append(go);
      body.push(ft);
      ok();
      box.replaceChildren(...body);
    };
    /**
     * Feedback: the visitor points at the part of the page they mean; only its stable selector and
     * position are kept. A transparent overlay in our shadow root takes every pointer event (the
     * page gets none: no menu opens, no button fires) and finds the element under it.
     */
    const pickElement = (box: HTMLElement, back: () => void) => {
      box.style.visibility = "hidden";
      const hl = el("div", "hl");
      const layer = el("div", "pk");
      const cancel = btn("p cx", S.close, () => done());
      layer.append(hl, cancel);
      m.root.appendChild(layer);
      const under = (e: MouseEvent): Element | null => {
        for (const t of d.elementsFromPoint ? d.elementsFromPoint(e.clientX, e.clientY) : [])
          if (!hosts.has(t) && t !== d.documentElement && t !== d.body) return t;
        return null;
      };
      let watch = 0;
      const done = () => {
        clearInterval(watch);
        d.removeEventListener("keydown", esc, true);
        layer.remove();
        box.style.visibility = "";
        if (m.host.isConnected) back();
      };
      layer.addEventListener("mousemove", (e) => {
        const t = under(e);
        if (!t) return;
        const b = t.getBoundingClientRect();
        hl.style.cssText = `left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px`;
      });
      layer.addEventListener("click", (e) => {
        if (e.target === cancel) return;
        e.preventDefault();
        const t = under(e);
        if (!t) return;
        const h = Math.max(d.documentElement.scrollHeight, 1);
        picked = {
          s: stableSelector(t as unknown as El).slice(0, 300),
          top: Math.max(0, Math.min(100, Math.round(((t.getBoundingClientRect().top + scrollY) / h) * 100))),
        };
        done();
      });
      const esc = (e: KeyboardEvent) => {
        if (e.key === "Escape") done();
      };
      d.addEventListener("keydown", esc, true);
      // the page removed the widget: stop
      watch = setInterval(() => {
        if (!m.host.isConnected) done();
      }, 1000) as unknown as number;
    };
    post({ sv: sv.id, ver: sv.v, imp: 1, ...(sv.test ? { t: sv.pt } : {}) });
    shown(sv);
    if (qs.length) show(0);
  };

  // ---------------------------------------------------------------- triggers
  const t0 = Date.now();
  let lastClick = 0;
  let clicks: { t: number; x: number; y: number }[] = [];
  const frustrated: ((sig: string) => void)[] = [];
  d.addEventListener(
    "click",
    (e) => {
      if (hosts.has(e.target as EventTarget)) return;
      const now = (lastClick = Date.now());
      clicks = clicks.filter((c) => now - c.t <= 1000);
      clicks.push({ t: now, x: e.clientX, y: e.clientY });
      if (clicks.filter((c) => Math.hypot(c.x - e.clientX, c.y - e.clientY) <= 30).length >= 3) for (const f of frustrated) f("rage_click");
    },
    true,
  );
  addEventListener(
    "error",
    (e) => {
      if (e instanceof ErrorEvent && Date.now() - lastClick <= 1000) for (const f of frustrated) f("error_click");
    },
    true,
  );

  // Listener triggers (scroll, exit intent, frustration) are attached once and check the current
  // page when they fire; load and delay triggers run again on each SPA path.
  const attached = new Set<string>();
  const arm = (sv: PS) => {
    const t = sv.tr;
    const go = () => {
      if (eligible(sv)) run(sv);
    };
    if (sv.test || t.on === "load") return go();
    if (t.on === "delay" || (t.on === "exit_intent" && touch)) {
      const at = location.pathname;
      return void setTimeout(() => location.pathname === at && go(), (t.s === undefined ? 10 : t.s) * 1000);
    }
    if (attached.has(sv.id)) return;
    attached.add(sv.id);
    if (t.on === "scroll")
      return addEventListener(
        "scroll",
        () => {
          const h = Math.max(d.documentElement.scrollHeight, 1);
          if (((scrollY + innerHeight) / h) * 100 >= (t.pct || 50)) go();
        },
        { passive: true },
      );
    if (t.on === "exit_intent")
      return d.addEventListener("mouseout", (e) => {
        if (!e.relatedTarget && e.clientY <= 0 && Date.now() - t0 >= 5000) go();
      });
    if (t.on === "frustration") frustrated.push((sig) => (!t.sig || t.sig.indexOf(sig) !== -1) && go());
  };

  const embed = (sv: PS, tries = 0) => {
    let target: Element | null = null;
    try {
      target = sv.sel ? d.querySelector(sv.sel) : null;
    } catch {
      return;
    }
    if (target) {
      if (eligible(sv)) run(sv, target);
    } else if (tries < 20) setTimeout(() => embed(sv, tries + 1), 500);
  };

  let tab: HTMLElement | null = null;
  const feedback = (sv: PS) => {
    // off the targeted pages (SPA navigation) the tab goes
    if (tab && !eligible(sv, true)) {
      tab.remove();
      tab = null;
    }
    if (tab || !eligible(sv, true)) return;
    const m = mount(sv.ap.accent);
    const b = btn(
      `tab${sv.ap.side === "left" ? " l" : ""}`,
      ({ ...DEFAULT_STRINGS, ...(sv.ap.str || {}) } as typeof DEFAULT_STRINGS).feedback,
      () => run(sv, null, true),
    );
    m.root.appendChild(b);
    tab = m.host;
  };

  const start = () => {
    for (const sv of C.s) {
      if (sv.kind === "embedded") embed(sv);
      else if (sv.kind === "feedback") feedback(sv);
      else if (sv.tr.on !== "manual" || sv.test) arm(sv);
    }
  };
  // SPA navigation: page-targeted surveys get their chance on the new path.
  let path = location.pathname;
  setInterval(() => {
    if (location.pathname === path) return;
    path = location.pathname;
    start();
  }, 1000);

  boot.h = (c) => {
    if (c[0] === "survey") {
      const sv = C.s.find((x) => x.id === c[1]);
      if (sv && sv.kind !== "embedded" && eligible(sv)) run(sv, null, true);
    } else if (c[0] === "feedback") {
      const sv = C.s.find((x) => x.kind === "feedback");
      if (sv && eligible(sv, true)) run(sv, null, true);
    }
  };
  start();
  for (const c of boot.q.splice(0)) boot.h(c);
})();
