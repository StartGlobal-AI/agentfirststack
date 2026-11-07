// The dashboard's views: the projects page's cards, a project's Overview numbers, and its
// Analytics, Tags, Replay and Mail tabs. The Worker renders shells (src/dashboard.ts,
// src/analytics-dashboard.ts, src/service-views.ts); this draws them from the services' own
// answers, read through the dashboard's read-only data route /dashboard/projects/:id/data/<service>/<path>.
//
// Everything a visitor can send (paths, referrers, campaigns, event and goal names) is set as text,
// never parsed as HTML. The CSP allows scripts from this origin only and no inline styles, so
// sizes are set through the CSSOM (el.style) and SVG attributes.
(() => {
  "use strict";
  const main = document.getElementById("main");
  if (!main) return;

  // ---------- DOM ----------

  const SVGNS = "http://www.w3.org/2000/svg";
  function add(node, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k === null || k === undefined || k === false) continue;
      node.append(k instanceof Node ? k : String(k));
    }
    return node;
  }
  /** el("div", {class, text, attrs, on, title}, ...children) */
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
      if (props.class) n.className = props.class;
      if (props.text !== undefined) n.textContent = String(props.text);
      if (props.title) n.title = props.title;
      if (props.attrs)
        for (const [k, v] of Object.entries(props.attrs))
          if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : String(v));
      if (props.on) for (const [k, v] of Object.entries(props.on)) n.addEventListener(k, v);
    }
    return add(n, kids);
  }
  function svg(tag, attrs, ...kids) {
    const n = document.createElementNS(SVGNS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, String(v));
    return add(n, kids);
  }
  const clear = (n) => {
    while (n.firstChild) n.firstChild.remove();
    return n;
  };
  let uid = 0;
  const nextId = (p) => `${p}-${++uid}`;

  // ---------- formatting ----------

  const nf = new Intl.NumberFormat("en-US");
  const compactNf = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
  const num = (n) =>
    n === null || n === undefined ? "–" : Math.abs(n) >= 10000 ? compactNf.format(n).toLowerCase() : nf.format(Math.round(n));
  const numFull = (n) => (n === null || n === undefined ? "–" : nf.format(Math.round(n)));
  function money(n, cur, { full = false } = {}) {
    if (n === null || n === undefined) return "–";
    const big = !full && Math.abs(n) >= 10000;
    const frac = n === 0 || Math.abs(n) >= 100 ? 0 : 2;
    const o = { notation: big ? "compact" : "standard", maximumFractionDigits: big ? 1 : frac, minimumFractionDigits: big ? 0 : frac };
    if (cur) {
      try {
        return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, ...o }).format(n).replace(/K$/, "k").replace(/M$/, "m");
      } catch {
        /* unknown code: plain number */
      }
    }
    return new Intl.NumberFormat("en-US", o).format(n).toLowerCase();
  }
  const pct = (n) => (n === null || n === undefined ? "–" : `${Math.abs(n) < 10 && n % 1 ? n.toFixed(2) : Math.round(n)}%`);
  function dur(s) {
    if (s === null || s === undefined) return "–";
    s = Math.round(s);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTHS_LONG = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const ymd = (d) => d.toISOString().slice(0, 10);
  const parseDay = (s) => new Date(`${s.slice(0, 10)}T00:00:00Z`);
  const addDays = (s, n) => ymd(new Date(parseDay(s).getTime() + n * 86400000));
  const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 86400000);
  const todayIn = (tz) => {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    } catch {
      return ymd(new Date());
    }
  };
  const dayShort = (s) => {
    const d = parseDay(s);
    return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]}`;
  };
  /** An axis label for a timeseries bucket ("2026-11-03", "2026-11-03 14:00", "2026-11"). */
  function bucketTick(date, interval) {
    if (interval === "hour") return date.slice(11, 16) === "00:00" ? dayShort(date) : date.slice(11, 16);
    if (interval === "month") {
      const [y, m] = date.split("-");
      return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`;
    }
    return dayShort(date);
  }
  function bucketTitle(date, interval) {
    if (interval === "month") {
      const [y, m] = date.split("-");
      return `${MONTHS_LONG[Number(m) - 1]} ${y}`;
    }
    const d = parseDay(date);
    const day = `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]}`;
    if (interval === "hour") return `${day}, ${date.slice(11, 16)}`;
    if (interval === "week") return `Week of ${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]}`;
    return day;
  }
  /** 0.4 -> "24m", 5 -> "5h", 50 -> "2.1d" */
  function hours(h) {
    if (h === null || h === undefined) return "–";
    if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
    if (h < 48) return `${Math.round(h)}h`;
    return `${(h / 24).toFixed(1)}d`;
  }
  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }

  let regionNames = null;
  try {
    regionNames = new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    /* old browser: codes */
  }
  const countryName = (cc) => {
    if (!cc || cc === "(none)") return "Unknown";
    try {
      return (regionNames && regionNames.of(cc)) || cc;
    } catch {
      return cc;
    }
  };
  const flag = (cc) => (/^[A-Z]{2}$/.test(cc || "") ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "🌐");
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  // ---------- colours (validated: see site/public/analytics.css) ----------

  const VISITORS = "#2f6bff";
  const REVENUE = "#ff6a2b";
  const REVENUE_2 = "#ffb08f";
  const PREVIOUS = "#8f99aa";
  /** Categorical, fixed order (goal lines, crawler categories). */
  const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
  const OTHER = "#b4bccb";
  /** Channels keep their colour whatever their rank. */
  const CHANNEL_COLOR = {
    Direct: "#2a78d6",
    "Organic Search": "#1baf7a",
    "Organic Social": "#e87ba4",
    Referral: "#eda100",
    "AI Assistants": "#6250d6",
    "Paid Search": "#eb6834",
    "Paid Social": "#e34948",
    Email: "#008300",
  };

  // ---------- motion ----------

  const prefersReduced = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  // "Calm" for a moment after showing a page whose data was already loaded in the background:
  // it appears as it is, with no skeletons, count-ups or draw-ins replaying.
  let calmUntil = 0;
  const reduced = () => prefersReduced.matches || performance.now() < calmUntil;
  const easeOut = (t) => 1 - (1 - t) ** 3;
  /** Run fn(progress 0..1) every frame for `ms` (at once with reduced motion). */
  function tween(ms, fn, { delay = 0, ease = easeOut } = {}) {
    if (reduced() || ms <= 0) {
      fn(1);
      return () => {};
    }
    let raf = 0;
    let start = 0;
    let stopped = false;
    const step = (now) => {
      if (stopped) return;
      if (!start) start = now + delay;
      const t = Math.min(1, Math.max(0, (now - start) / ms));
      fn(ease(t));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }
  /** Draw an SVG path from its start, over `ms`. */
  function drawIn(path, ms = 900, delay = 0) {
    if (reduced()) return;
    let len = 0;
    try {
      len = path.getTotalLength();
    } catch {
      return;
    }
    if (!len) return;
    path.setAttribute("stroke-dasharray", `${len} ${len}`);
    path.setAttribute("stroke-dashoffset", String(len));
    tween(
      ms,
      (p) => {
        path.setAttribute("stroke-dashoffset", String(len * (1 - p)));
        if (p === 1) {
          path.removeAttribute("stroke-dasharray");
          path.removeAttribute("stroke-dashoffset");
        }
      },
      { delay },
    );
  }
  // Entrance animations play once: their classes go when they finish, so a page that's put back on
  // screen (or a node that's moved) doesn't replay them.
  const ONCE = ["afa-enter", "afa-stagger", "afa-grow", "afa-feed-new", "afa-chip-new"];
  document.addEventListener(
    "animationend",
    (e) => {
      const t = e.target;
      if (t && t.classList) for (const c of ONCE) if (t.classList.contains(c)) t.classList.remove(c);
    },
    true,
  );
  /** Fade/rise an element in (CSS class with a stagger index). */
  function enter(node, i = 0) {
    if (reduced()) return node;
    node.style.setProperty("--i", String(i));
    node.classList.remove("afa-enter");
    void node.offsetWidth;
    node.classList.add("afa-enter");
    return node;
  }
  /** Bars set up with growTo() reach their size one frame after they're in the page. */
  function growTo(node, prop, value) {
    if (reduced()) {
      node.style[prop] = value;
      return node;
    }
    node.style[prop] = "0";
    node._grow = [prop, value];
    return node;
  }
  function grow(rootNode) {
    const nodes = [...rootNode.querySelectorAll("*")].filter((n) => n._grow);
    if (!nodes.length) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        nodes.forEach((n, i) => {
          n.style.transitionDelay = `${Math.min(i, 14) * 22}ms`;
          n.style[n._grow[0]] = n._grow[1];
          delete n._grow;
        }),
      ),
    );
  }
  /** Replace a box's content: the new content fades in, bars grow. */
  function swap(box, ...nodes) {
    clear(box);
    add(box, nodes);
    box.classList.remove("is-loading");
    box.removeAttribute("aria-busy");
    box.dataset.filled = "1";
    // Already-loaded data shows as it is: no row-by-row entrance either.
    if (reduced()) for (const n of box.querySelectorAll(".afa-stagger")) n.classList.remove("afa-stagger");
    enter(box);
    grow(box);
  }
  /** Loading: a skeleton the first time, after that the old content dimmed until the new arrives. */
  function busy(box, skel) {
    box.setAttribute("aria-busy", "true");
    if (box.dataset.filled) {
      // A refresh you didn't ask for (back on a tab after a while): the numbers just change.
      if (performance.now() >= calmUntil) box.classList.add("is-loading");
    } else {
      clear(box);
      add(box, [skel]);
    }
  }
  /** Count a number up (or down) to its new value. */
  const shown = new WeakMap();
  function countTo(node, value, format, ms = 700, fromValue) {
    const from = fromValue !== undefined ? fromValue : shown.get(node);
    shown.set(node, value);
    if (typeof value !== "number" || !Number.isFinite(value) || reduced()) {
      node.textContent = format(value);
      return;
    }
    const start = typeof from === "number" && Number.isFinite(from) ? from : 0;
    if (start === value) {
      node.textContent = format(value);
      return;
    }
    if (node._stop) node._stop();
    const decimals = value % 1 !== 0 || start % 1 !== 0;
    node._stop = tween(ms, (p) => {
      const v = start + (value - start) * p;
      node.textContent = format(p === 1 ? value : decimals ? v : Math.round(v));
    });
  }

  // A thin bar at the top while anything is loading.
  const progress = el("div", { class: "afa-progress", attrs: { "aria-hidden": "true" } }, el("span"));
  document.body.append(progress);
  let inFlight = 0;
  let progressStop = null;
  let progressHide = 0;
  function progressStart() {
    if (inFlight++ > 0) return;
    clearTimeout(progressHide);
    const bar = progress.firstChild;
    progress.classList.add("is-on");
    if (progressStop) progressStop();
    bar.style.transform = "scaleX(0.04)";
    progressStop = tween(
      4000,
      (p) => {
        bar.style.transform = `scaleX(${0.04 + 0.86 * p})`;
      },
      { ease: (t) => 1 - (1 - t) ** 4 },
    );
  }
  function progressDone() {
    if (--inFlight > 0) return;
    inFlight = 0;
    if (progressStop) progressStop();
    progress.firstChild.style.transform = "scaleX(1)";
    progressHide = setTimeout(() => progress.classList.remove("is-on"), 220);
  }

  // ---------- data ----------

  /**
   * Every answer is kept for a minute (live numbers for 5 seconds), shared by every view and tab, so
   * switching tabs or coming back doesn't ask again. Requests made in the background (prefetching
   * another tab) don't move the progress bar. Refresh buttons call invalidate() first.
   */
  const answers = new Map(); // url -> { at, promise }
  const dataUrl = (project, path, params) => {
    const u = new URL(`/dashboard/projects/${encodeURIComponent(project)}/data/${path}`, location.origin);
    for (const [k, v] of Object.entries(params || {})) if (v !== null && v !== undefined && v !== "") u.searchParams.set(k, String(v));
    return u;
  };
  function api(project, path, params, opts = {}) {
    const u = dataUrl(project, path, params);
    const key = u.href;
    const ttl = /\/realtime/.test(path) ? 5000 : 60000;
    const hit = answers.get(key);
    if (hit && !opts.fresh && Date.now() - hit.at < ttl) return hit.promise;
    // The progress bar is for what you're waiting on: not live counts polling, not background
    // loads, not a page that was ready before the click.
    const shows = !opts.bg && !/\/realtime/.test(path) && performance.now() >= calmUntil;
    if (shows) progressStart();
    const promise = apiCall(u).finally(() => {
      if (shows) progressDone();
    });
    answers.set(key, { at: Date.now(), promise });
    promise.catch(() => answers.delete(key));
    if (answers.size > 500) answers.delete(answers.keys().next().value);
    return promise;
  }
  /** Forget a project's answers (Refresh). */
  function invalidate(project) {
    const mark = `/dashboard/projects/${encodeURIComponent(project)}/data/`;
    for (const k of [...answers.keys()]) if (k.includes(mark)) answers.delete(k);
  }
  async function apiCall(u) {
    let r;
    try {
      r = await fetch(u, { headers: { accept: "application/json" }, credentials: "same-origin" });
    } catch {
      throw new Error("Couldn't reach the dashboard. Check your connection.");
    }
    let j = null;
    try {
      j = await r.json();
    } catch {
      /* the sign-in page, after the session ended */
    }
    if (!r.ok || !j) {
      const msg =
        j && j.error
          ? j.error.message
          : r.redirected || !j
            ? "Your session ended. Reload the page to sign in again."
            : `Analytics answered ${r.status}.`;
      const e = new Error(msg);
      e.hint = j && j.error ? j.error.hint : null;
      throw e;
    }
    return j;
  }

  /** Run fns (returning promises) at most `n` at a time. */
  async function pool(fns, n) {
    const out = new Array(fns.length);
    let i = 0;
    const worker = async () => {
      while (i < fns.length) {
        const k = i++;
        try {
          out[k] = await fns[k]();
        } catch (e) {
          out[k] = e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, fns.length) }, worker));
    return out;
  }

  // ---------- shared pieces ----------

  // One tooltip for everything. It fades in where it's first needed, then glides.
  const tip = el("div", { class: "afa-tip", attrs: { role: "tooltip", "aria-hidden": "true" } });
  document.body.append(tip);
  let tipOn = false;
  let tipKey = null;
  let tipOff = 0;
  /** key: when the same thing is hovered again, the content isn't rebuilt. */
  function showTip(x, y, ...content) {
    clearTimeout(tipOff);
    const key = content.length && typeof content[0] === "string" && content[0].startsWith("key:") ? content.shift() : null;
    if (!key || key !== tipKey) {
      clear(tip);
      add(tip, content);
      tipKey = key;
    }
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let left = x + 16;
    let top = y + 16;
    if (left + w > window.innerWidth - 8) left = x - w - 16;
    if (top + h > window.innerHeight - 8) top = y - h - 16;
    left = Math.max(8, left);
    top = Math.max(8, top);
    if (!tipOn) {
      tip.classList.add("no-anim");
      tip.style.transform = `translate(${left}px, ${top + 4}px)`;
      void tip.offsetWidth;
      tip.classList.remove("no-anim");
      tipOn = true;
    }
    tip.classList.add("is-on");
    tip.style.transform = `translate(${left}px, ${top}px)`;
  }
  const hideTip = () => {
    tip.classList.remove("is-on");
    tipKey = null;
    clearTimeout(tipOff);
    tipOff = setTimeout(() => {
      tipOn = false;
    }, 160);
  };
  const tipRow = (label, value, swatch) =>
    el(
      "div",
      { class: "afa-tip-row" },
      swatch ? el("span", { class: "afa-sw", attrs: { "data-c": "" } }) : null,
      el("span", { text: label }),
      el("b", { text: value }),
    );
  function swatchRow(color, label, value) {
    const row = tipRow(label, value, true);
    row.firstChild.style.background = color;
    return row;
  }

  function skeleton(cls) {
    return el("div", { class: `afa-skel ${cls || ""}`, attrs: { "aria-hidden": "true" } });
  }
  /** A skeleton bar of a given width and height. */
  const bone = (w, h, cls = "") => {
    const b = skeleton(`afa-bone ${cls}`);
    b.style.width = typeof w === "number" ? `${w}px` : w;
    b.style.height = `${h}px`;
    return b;
  };
  // Skeletons shaped like what replaces them, so nothing jumps when the data arrives.
  const SK = {
    kpis: (n = 7) =>
      Array.from({ length: n }, () => el("div", { class: "afa-kpi afa-kpi-skel" }, bone(64, 12), bone(92, 26), bone(38, 10))),
    chart: (h = 300) => {
      const box = el("div", { class: "afa-skel-chartbox", attrs: { "aria-hidden": "true" } });
      box.style.height = `${h}px`;
      for (let i = 0; i < 4; i++) box.append(el("span", { class: "afa-skel-grid" }));
      box.append(skeleton("afa-skel-wave"));
      return box;
    },
    rows: (n = 8) => {
      const widths = [100, 78, 64, 55, 47, 40, 34, 29, 25, 21];
      return el(
        "div",
        { class: "afa-skel-rows", attrs: { "aria-hidden": "true" } },
        Array.from({ length: n }, (_, i) =>
          el("div", { class: "afa-skel-row" }, bone(`${widths[i % widths.length]}%`, 35, "afa-bone-bar"), bone(22, 12)),
        ),
      );
    },
    donut: () => el("div", { class: "afa-donut-wrap", attrs: { "aria-hidden": "true" } }, skeleton("afa-skel-ring"), SK.rows(4)),
    table: (n = 8) =>
      el(
        "div",
        { class: "afa-skel-rows", attrs: { "aria-hidden": "true" } },
        Array.from({ length: n }, () =>
          el("div", { class: "afa-skel-trow" }, bone("34%", 12), bone("14%", 12), bone("12%", 12), bone("10%", 12)),
        ),
      ),
    card: () =>
      el(
        "div",
        { class: "afa-card afa-site-card afa-card-skel", attrs: { "aria-hidden": "true" } },
        bone(160, 18),
        bone("100%", 64),
        bone(110, 14),
      ),
  };
  /** Close a <dialog> with its closing animation. */
  function closeDialog(dlg) {
    if (!dlg.open || dlg.classList.contains("is-closing")) return;
    hideTip();
    if (reduced()) return dlg.close();
    dlg.classList.add("is-closing");
    setTimeout(() => dlg.close(), 170);
  }
  function openDialog(dlg) {
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      closeDialog(dlg);
    });
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) closeDialog(dlg); // the backdrop
    });
    dlg.addEventListener("close", () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }
  /** A highlight that slides to the selected tab. Returns update(). */
  function tabSlider(list) {
    const ind = el("span", { class: "afa-tab-ind no-anim", attrs: { "aria-hidden": "true" } });
    list.prepend(ind);
    let placed = false;
    const update = () => {
      const sel = list.querySelector('[aria-selected="true"]');
      if (!sel || !sel.offsetWidth) return;
      ind.style.width = `${sel.offsetWidth}px`;
      ind.style.height = `${sel.offsetHeight}px`;
      ind.style.transform = `translate(${sel.offsetLeft}px, ${sel.offsetTop}px)`;
      if (!placed) {
        placed = true;
        void ind.offsetWidth;
        requestAnimationFrame(() => ind.classList.remove("no-anim"));
      }
    };
    if (window.ResizeObserver) new ResizeObserver(update).observe(list);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(update);
    requestAnimationFrame(update);
    return update;
  }
  function errorBox(e, retry) {
    return el(
      "div",
      { class: "afa-error", attrs: { role: "status" } },
      el("p", { text: e.message || String(e) }),
      e.hint ? el("p", { class: "muted small", text: e.hint }) : null,
      retry ? el("button", { class: "btn btn-quiet btn-small", text: "Try again", attrs: { type: "button" }, on: { click: retry } }) : null,
    );
  }
  /** Copy text, with the button saying it worked (or how to copy by hand). */
  async function copyText(text, button, label = "Copy") {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      /* selected below instead */
    }
    if (!ok && button.previousElementSibling) {
      const range = document.createRange();
      range.selectNodeContents(button.previousElementSibling);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    button.classList.toggle("is-done", ok);
    clear(button).append(ok ? icon("check") : icon("copy"), ok ? "Copied" : "Press ⌘C");
    clearTimeout(button._t);
    button._t = setTimeout(() => {
      button.classList.remove("is-done");
      clear(button).append(icon("copy"), label);
    }, 1800);
  }
  /** A prompt for the person's agent, in a card with a Copy button. */
  function askCard(prompt, label = "Ask your agent") {
    const text = el("p", { class: "afa-askcard-text", text: prompt });
    const btn = el(
      "button",
      { class: "afa-copy", attrs: { type: "button", "aria-label": `Copy: ${prompt.slice(0, 80)}` } },
      icon("copy"),
      "Copy",
    );
    btn.addEventListener("click", () => copyText(prompt, btn));
    return el("div", { class: "afa-askcard" }, el("span", { class: "afa-askcard-label" }, icon("spark"), label), text, btn);
  }
  /**
   * An empty state: what's missing, why, and what to ask the agent.
   * empty(text, ask) or empty({ title, text, ask, icon, chips })
   */
  function empty(textOrOpts, ask) {
    const o = typeof textOrOpts === "string" ? { text: textOrOpts, ask } : textOrOpts;
    return el(
      "div",
      { class: `afa-empty${o.ask ? " has-ask" : ""}${o.chips ? " has-chips" : ""}` },
      o.icon ? el("span", { class: "afa-empty-icon", attrs: { "aria-hidden": "true" } }, icon(o.icon)) : null,
      o.title ? el("h3", { class: "afa-empty-title", text: o.title }) : null,
      o.text ? el("p", { class: "afa-empty-text", text: o.text }) : null,
      o.chips
        ? el(
            "div",
            { class: "afa-empty-chips" },
            o.chips.map((c) => el("span", { class: "afa-empty-chip" }, el("b", { text: c[0] }), el("span", { text: c[1] }))),
          )
        : null,
      o.ask ? askCard(o.ask) : null,
      o.more ? el("p", { class: "afa-empty-more" }, o.more) : null,
    );
  }

  /** A small menu under a button. items: [{label, hint?, on, current?}] or a node. */
  function menu(button, build) {
    let pop = null;
    const close = () => {
      if (!pop) return;
      const old = pop;
      if (reduced()) old.remove();
      else {
        old.classList.add("is-closing");
        setTimeout(() => old.remove(), 130);
      }
      pop = null;
      button.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", onKey, true);
    };
    const outside = (e) => {
      if (pop && !pop.contains(e.target) && !button.contains(e.target)) close();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        close();
        button.focus();
      }
    };
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => {
      if (pop) return close();
      pop = el("div", { class: "afa-menu" });
      add(pop, [build(close)]);
      button.parentElement.append(pop);
      const r = button.getBoundingClientRect();
      const pr = button.parentElement.getBoundingClientRect();
      pop.style.left = `${r.left - pr.left}px`;
      pop.style.top = `${r.bottom - pr.top + 6}px`;
      button.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", onKey, true);
      const first = pop.querySelector("button, a, input, select");
      if (first) first.focus();
    });
    return close;
  }
  const menuItem = (label, on, opts = {}) =>
    el(
      "button",
      {
        class: `afa-menu-item${opts.current ? " is-current" : ""}`,
        attrs: { type: "button", "aria-current": opts.current ? "true" : null },
        on: { click: on },
      },
      el("span", { text: label }),
      opts.dot ? el("span", { class: "afa-live-dot", attrs: { "aria-hidden": "true" } }) : null,
      opts.key ? el("kbd", { text: opts.key }) : null,
    );

  /**
   * Which site / container / inbox a tab shows: a menu when there are several, a plain label
   * when there's one. items: [{ id, label, href }].
   */
  function picker(label, items, currentId) {
    const ctl = el("div", { class: "afa-ctl afa-ctl-site" });
    const face = [
      el("span", { class: "afa-favicon", text: (label || "?").charAt(0).toUpperCase(), attrs: { "aria-hidden": "true" } }),
      el("span", { class: "afa-pick-text", text: label }),
    ];
    if (items.length < 2) {
      ctl.append(el("span", { class: "afa-btn afa-site-btn afa-static" }, face));
      return ctl;
    }
    const btn = el(
      "button",
      { class: "afa-btn afa-site-btn", attrs: { type: "button" } },
      face,
      el("span", { class: "afa-caret", attrs: { "aria-hidden": "true" } }),
    );
    ctl.append(btn);
    menu(btn, () =>
      el(
        "div",
        null,
        items.map((x) =>
          el(
            "a",
            {
              class: `afa-menu-item${x.id === currentId ? " is-current" : ""}`,
              attrs: { href: x.href, "aria-current": x.id === currentId ? "page" : null },
            },
            el("span", { text: x.label }),
          ),
        ),
      ),
    );
    return ctl;
  }

  // ---------- charts ----------

  /** A rounded number above v, with `n` steps. */
  function niceScale(max, n = 4) {
    if (!(max > 0)) return { max: n, step: 1 };
    const raw = max / n;
    const p = 10 ** Math.floor(Math.log10(raw));
    const f = raw / p;
    // 2.5 only when it stays a whole number (counts never get a 2.5 step)
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 && p >= 10 ? 2.5 : f <= 5 ? 5 : 10) * p;
    return { max: Math.ceil(max / step) * step || step * n, step };
  }
  /** Monotone cubic through points: smooth, never overshoots below zero. */
  function smooth(pts) {
    const n = pts.length;
    if (!n) return "";
    const f = (v) => Math.round(v * 10) / 10;
    if (n === 1) return `M${f(pts[0][0])},${f(pts[0][1])}`;
    const dx = [];
    const m = [];
    for (let i = 0; i < n - 1; i++) {
      dx[i] = pts[i + 1][0] - pts[i][0];
      m[i] = (pts[i + 1][1] - pts[i][1]) / (dx[i] || 1);
    }
    const t = [m[0]];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    t[n - 1] = m[n - 2];
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) {
        t[i] = 0;
        t[i + 1] = 0;
        continue;
      }
      const a = t[i] / m[i];
      const b = t[i + 1] / m[i];
      const s = a * a + b * b;
      if (s > 9) {
        const k = 3 / Math.sqrt(s);
        t[i] = k * a * m[i];
        t[i + 1] = k * b * m[i];
      }
    }
    let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += `C${f(pts[i][0] + h)},${f(pts[i][1] + t[i] * h)} ${f(pts[i + 1][0] - h)},${f(pts[i + 1][1] - t[i + 1] * h)} ${f(pts[i + 1][0])},${f(pts[i + 1][1])}`;
    }
    return d;
  }
  /** A bar with rounded top corners. */
  function barPath(x, y, w, h, r) {
    if (h <= 0) return "";
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function gradient(defs, color) {
    const id = nextId("afa-grad");
    defs.append(
      svg(
        "linearGradient",
        { id, x1: 0, y1: 0, x2: 0, y2: 1 },
        svg("stop", { offset: "0%", "stop-color": color, "stop-opacity": 0.2 }),
        svg("stop", { offset: "100%", "stop-color": color, "stop-opacity": 0.01 }),
      ),
    );
    return `url(#${id})`;
  }
  /**
   * Hover marks (crosshair, dots) that glide from bucket to bucket. place(fn) sets their
   * positions; the first time after being hidden they jump there instead of sliding in.
   */
  function hoverMarks(nodes) {
    let on = false;
    return {
      place(fn) {
        if (!on) for (const n of nodes) n.classList.add("no-anim");
        fn();
        if (!on) {
          void nodes[0].getBoundingClientRect();
          for (const n of nodes) n.classList.remove("no-anim");
        }
        on = true;
        for (const n of nodes) n.classList.add("is-on");
      },
      hide() {
        on = false;
        for (const n of nodes) n.classList.remove("is-on");
      },
    };
  }
  /** Fade an SVG node in over `ms`. */
  function fadeIn(node, ms = 600, delay = 0) {
    if (reduced()) return;
    node.setAttribute("opacity", "0");
    tween(ms, (p) => node.setAttribute("opacity", String(p)), { delay });
  }

  /** Redraw on resize; draw(width, first) animates only the first time. */
  function responsive(box, draw) {
    let w = 0;
    let first = true;
    const run = () => {
      const nw = Math.round(box.clientWidth);
      if (nw && nw !== w) {
        w = nw;
        draw(nw, first);
        first = false;
      }
    };
    if (window.ResizeObserver) new ResizeObserver(run).observe(box);
    else window.addEventListener("resize", run);
    requestAnimationFrame(run);
  }

  /**
   * The main chart: visitors as a smooth area (left scale), revenue as bars (right scale, new and
   * renewal stacked), the previous period as a dashed grey line. The bucket still in progress is
   * dashed. Hover shows the bucket's numbers.
   */
  function mainChart(box, ts, { currency, inProgress, compare }) {
    const rows = ts.results || [];
    const interval = ts.interval;
    const H = 300;
    const hasRev = rows.some((r) => (r.revenue || 0) > 0);
    const chartId = nextId("main");
    responsive(box, (W, first) => {
      clear(box);
      const padL = 40;
      const padR = hasRev ? 52 : 12;
      const padT = 14;
      const padB = 28;
      const pw = W - padL - padR;
      const ph = H - padT - padB;
      const n = rows.length || 1;
      const step = pw / n;
      const xs = rows.map((_, i) => padL + (i + 0.5) * step);
      const prevVals = compare ? rows.map((r) => (r.comparison && r.comparison.metrics ? r.comparison.metrics.visitors || 0 : 0)) : [];
      const vMax = niceScale(Math.max(1, ...rows.map((r) => r.visitors || 0), ...prevVals));
      const rMax = niceScale(Math.max(1, ...rows.map((r) => r.revenue || 0)));
      const yV = (v) => padT + ph - (v / vMax.max) * ph;
      const yR = (v) => padT + ph - (v / rMax.max) * ph;
      const s = svg("svg", {
        width: W,
        height: H,
        viewBox: `0 0 ${W} ${H}`,
        class: "afa-svg",
        role: "img",
        "aria-label": "Visitors and revenue over time",
      });
      const defs = svg("defs");
      s.append(defs);
      // grid and left labels
      for (let v = 0; v <= vMax.max + 1e-9; v += vMax.step) {
        const y = yV(v);
        s.append(svg("line", { x1: padL, x2: W - padR, y1: y, y2: y, class: v === 0 ? "afa-axis" : "afa-gridline" }));
        s.append(svg("text", { x: padL - 8, y: y + 4, "text-anchor": "end", class: "afa-tick" }, num(v)));
      }
      if (hasRev)
        for (let v = 0; v <= rMax.max + 1e-9; v += rMax.step)
          s.append(svg("text", { x: W - padR + 8, y: yR(v) + 4, class: "afa-tick" }, money(v, currency)));
      // x labels
      const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 86))));
      rows.forEach((r, i) => {
        if (i % every === 0)
          s.append(svg("text", { x: xs[i], y: H - 8, "text-anchor": "middle", class: "afa-tick" }, bucketTick(r.date, interval)));
      });
      // revenue bars
      const bw = Math.max(2, Math.min(26, step * 0.46));
      const bars = rows.map((r, i) => {
        const g = svg("g", { class: "afa-bar" });
        const nv = r.new_revenue || 0;
        const rv = r.renewal_revenue || 0;
        const total = r.revenue || 0;
        if (first && !reduced()) {
          g.classList.add("afa-grow");
          g.style.setProperty("--i", String(i));
        }
        if (total > 0) {
          const other = Math.max(0, total - nv - rv); // revenue events without a type count as new
          const newPart = nv + other;
          const x = xs[i] - bw / 2;
          const yTop = yR(total);
          const yMid = yR(newPart);
          if (rv > 0) g.append(svg("path", { d: barPath(x, yTop, bw, yMid - yTop, 4), fill: REVENUE_2 }));
          g.append(
            svg("path", {
              d: rv > 0 ? `M${x},${yR(0)}V${yMid}H${x + bw}V${yR(0)}Z` : barPath(x, yMid, bw, yR(0) - yMid, 4),
              fill: REVENUE,
            }),
          );
        }
        s.append(g);
        return g;
      });
      // previous period
      const anim = [];
      if (compare && rows.length > 1) {
        const prev = svg("path", { d: smooth(prevVals.map((v, i) => [xs[i], yV(v)])), class: "afa-line-prev", stroke: PREVIOUS });
        s.append(prev);
        anim.push(() => fadeIn(prev, 700, 300));
      }
      // visitors
      const pts = rows.map((r, i) => [xs[i], yV(r.visitors || 0)]);
      if (pts.length) {
        const fill = gradient(defs, VISITORS);
        const area = `${smooth(pts)}L${pts[pts.length - 1][0]},${yV(0)}L${pts[0][0]},${yV(0)}Z`;
        const areaPath = svg("path", { d: area, fill, class: "afa-area" });
        s.append(areaPath);
        const solid = inProgress && pts.length > 1 ? pts.slice(0, -1) : pts;
        const line = svg("path", { d: smooth(solid), class: "afa-line", stroke: VISITORS });
        s.append(line);
        anim.push(
          () => drawIn(line, 1100),
          () => fadeIn(areaPath, 900, 250),
        );
        if (inProgress && pts.length > 1) {
          const a = pts[pts.length - 2];
          const b = pts[pts.length - 1];
          const dash = svg("path", { d: `M${a[0]},${a[1]}L${b[0]},${b[1]}`, class: "afa-line afa-line-dash", stroke: VISITORS });
          s.append(dash);
          anim.push(() => fadeIn(dash, 300, 1000));
        }
        if (pts.length === 1) s.append(svg("circle", { cx: pts[0][0], cy: pts[0][1], r: 4, fill: VISITORS }));
      }
      // hover: the crosshair and dot glide between buckets (CSS transitions on transform)
      const cross = svg("line", { x1: 0, x2: 0, y1: padT, y2: padT + ph, class: "afa-cross afa-hover" });
      const dot = svg("circle", { cx: 0, cy: 0, r: 4.5, class: "afa-dot afa-hover", fill: VISITORS });
      const hit = svg("rect", { x: padL, y: padT, width: pw, height: ph, fill: "transparent", class: "afa-hit" });
      s.append(cross, dot, hit);
      const marks = hoverMarks([cross, dot]);
      const hide = () => {
        marks.hide();
        for (const b of bars) b.classList.remove("is-dim");
        hideTip();
      };
      hit.addEventListener("pointerleave", hide);
      hit.addEventListener("pointermove", (e) => {
        const rect = s.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const i = Math.max(0, Math.min(n - 1, Math.floor((mx - padL) / step)));
        const r = rows[i];
        if (!r) return;
        marks.place(() => {
          cross.style.transform = `translate(${xs[i]}px, 0)`;
          dot.style.transform = `translate(${xs[i]}px, ${yV(r.visitors || 0)}px)`;
        });
        bars.forEach((b, k) => b.classList.toggle("is-dim", k !== i));
        const v = r.visitors || 0;
        const nv = r.new_visitors || 0;
        const split = el("div", { class: "afa-tip-split" });
        const fillBar = el("span");
        fillBar.style.width = `${v ? Math.round((nv / v) * 100) : 0}%`;
        split.append(el("span", { class: "afa-tip-track" }, fillBar));
        split.append(
          el(
            "span",
            { class: "afa-tip-sub" },
            el("span", { text: `${numFull(nv)} new` }),
            el("span", { text: `${numFull(r.returning_visitors || 0)} returning` }),
          ),
        );
        const rev = r.revenue || 0;
        showTip(
          rect.left + xs[i],
          e.clientY,
          `key:${chartId}:${i}`,
          el("div", { class: "afa-tip-head", text: bucketTitle(r.date, interval) }),
          swatchRow(VISITORS, "Visitors", numFull(v)),
          v ? split : null,
          compare && r.comparison
            ? swatchRow(PREVIOUS, `Previous (${bucketTick(r.comparison.date, interval)})`, numFull(r.comparison.metrics.visitors || 0))
            : null,
          el("div", { class: "afa-tip-sep" }),
          tipRow("Revenue", money(rev, currency, { full: true })),
          rev ? swatchRow(REVENUE_2, "Renewal", money(r.renewal_revenue || 0, currency, { full: true })) : null,
          rev ? swatchRow(REVENUE, "New", money(rev - (r.renewal_revenue || 0), currency, { full: true })) : null,
          el("div", { class: "afa-tip-sep" }),
          tipRow("Revenue/visitor", money(r.revenue_per_visitor || 0, currency, { full: true })),
          tipRow("Conversion rate", pct(r.conversion_rate || 0)),
        );
      });
      box.append(s);
      if (first) for (const a of anim) a();
    });
    // The same numbers as a table, for screen readers.
    const t = el("table", { class: "sr-only" }, el("caption", { text: "Visitors and revenue per period" }));
    t.append(el("tr", null, el("th", { text: "Period" }), el("th", { text: "Visitors" }), el("th", { text: "Revenue" })));
    for (const r of rows)
      t.append(
        el(
          "tr",
          null,
          el("td", { text: r.date }),
          el("td", { text: numFull(r.visitors || 0) }),
          el("td", { text: money(r.revenue || 0, currency, { full: true }) }),
        ),
      );
    return t;
  }

  /** Several smooth lines (goals, crawler categories) with a hover that lists every value. */
  function linesChart(box, labels, series, { interval, height = 260, format = numFull }) {
    const chartId = nextId("lines");
    responsive(box, (W, first) => {
      clear(box);
      const H = height;
      const padL = 36;
      const padR = 12;
      const padT = 12;
      const padB = 26;
      const pw = W - padL - padR;
      const ph = H - padT - padB;
      const n = labels.length || 1;
      const xs = labels.map((_, i) => (n === 1 ? padL + pw / 2 : padL + (i / (n - 1)) * pw));
      const sc = niceScale(Math.max(1, ...series.flatMap((s) => s.values)));
      const y = (v) => padT + ph - (v / sc.max) * ph;
      const s = svg("svg", {
        width: W,
        height: H,
        viewBox: `0 0 ${W} ${H}`,
        class: "afa-svg",
        role: "img",
        "aria-label": series.map((x) => x.name).join(", "),
      });
      for (let v = 0; v <= sc.max + 1e-9; v += sc.step) {
        s.append(svg("line", { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: v === 0 ? "afa-axis" : "afa-gridline" }));
        s.append(svg("text", { x: padL - 8, y: y(v) + 4, "text-anchor": "end", class: "afa-tick" }, num(v)));
      }
      const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 86))));
      labels.forEach((l, i) => {
        if (i % every === 0)
          s.append(
            svg(
              "text",
              { x: xs[i], y: H - 7, "text-anchor": i === 0 && n > 1 ? "start" : "middle", class: "afa-tick" },
              bucketTick(l, interval),
            ),
          );
      });
      const lines = series.map((se) => {
        const p = svg("path", { d: smooth(se.values.map((v, i) => [xs[i], y(v)])), class: "afa-line afa-line-thin", stroke: se.color });
        s.append(p);
        return p;
      });
      const cross = svg("line", { x1: 0, x2: 0, y1: padT, y2: padT + ph, class: "afa-cross afa-hover" });
      const dots = series.map((se) => svg("circle", { cx: 0, cy: 0, r: 3.5, fill: se.color, class: "afa-dot afa-hover" }));
      const hit = svg("rect", { x: padL, y: padT, width: pw, height: ph, fill: "transparent", class: "afa-hit" });
      s.append(cross, ...dots, hit);
      const marks = hoverMarks([cross, ...dots]);
      hit.addEventListener("pointerleave", () => {
        marks.hide();
        hideTip();
      });
      hit.addEventListener("pointermove", (e) => {
        const rect = s.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const i = n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((mx - padL) / pw) * (n - 1))));
        marks.place(() => {
          cross.style.transform = `translate(${xs[i]}px, 0)`;
          series.forEach((se, k) => {
            dots[k].style.transform = `translate(${xs[i]}px, ${y(se.values[i] || 0)}px)`;
          });
        });
        const sorted = series.map((se) => ({ se, v: se.values[i] || 0 })).sort((a, b) => b.v - a.v);
        const total = sorted.reduce((a, x) => a + x.v, 0);
        showTip(
          rect.left + xs[i],
          e.clientY,
          `key:${chartId}:${i}`,
          el("div", { class: "afa-tip-head", text: bucketTitle(labels[i], interval) }),
          sorted.map((x) => swatchRow(x.se.color, x.se.name, format(x.v))),
          series.length > 1 ? [el("div", { class: "afa-tip-sep" }), tipRow("Total", format(total))] : null,
        );
      });
      box.append(s);
      if (first) lines.forEach((l, k) => drawIn(l, 1000, k * 90));
    });
  }

  /** A donut of rows by `metric`, coloured by `colorOf`. */
  function donut(rows, metric, colorOf, onPick) {
    const size = 184;
    const r = 84;
    const inner = 56;
    const total = rows.reduce((a, x) => a + (x[metric] || 0), 0);
    const s = svg("svg", {
      width: size,
      height: size,
      viewBox: `0 0 ${size} ${size}`,
      class: "afa-donut",
      role: "img",
      "aria-label": "Share by channel",
    });
    const c = size / 2;
    // Revealed by a mask that sweeps clockwise from 12 o'clock.
    const mid = (r + inner) / 2;
    const C = 2 * Math.PI * mid;
    const maskId = nextId("afa-sweep");
    const sweep = svg("circle", {
      cx: c,
      cy: c,
      r: mid,
      fill: "none",
      stroke: "#fff",
      "stroke-width": r - inner + 6,
      transform: `rotate(-90 ${c} ${c})`,
      "stroke-dasharray": `${C} ${C}`,
      "stroke-dashoffset": reduced() ? 0 : C,
    });
    s.append(svg("defs", null, svg("mask", { id: maskId, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: size, height: size }, sweep)));
    const slices = svg("g", { mask: `url(#${maskId})` });
    s.append(slices);
    tween(900, (p) => sweep.setAttribute("stroke-dashoffset", String(C * (1 - p))), { delay: 80 });
    let a0 = -Math.PI / 2;
    const arc = (a, b) => {
      const large = b - a > Math.PI ? 1 : 0;
      const p = (rad, ang) => `${c + rad * Math.cos(ang)},${c + rad * Math.sin(ang)}`;
      return `M${p(r, a)}A${r},${r} 0 ${large} 1 ${p(r, b)}L${p(inner, b)}A${inner},${inner} 0 ${large} 0 ${p(inner, a)}Z`;
    };
    if (!total) s.append(svg("circle", { cx: c, cy: c, r: (r + inner) / 2, fill: "none", stroke: "#e2e5ea", "stroke-width": r - inner }));
    for (const row of rows) {
      const v = row[metric] || 0;
      if (!v) continue;
      const frac = v / total;
      const a1 = a0 + frac * Math.PI * 2;
      // A whole ring is two half arcs (one arc can't start and end at the same point).
      const d = frac >= 0.9999 ? arc(a0, a0 + Math.PI) + arc(a0 + Math.PI, a0 + Math.PI * 2) : arc(a0, a1);
      const seg = svg("path", { d, fill: colorOf(row), class: `afa-slice${frac >= 0.9999 ? " is-whole" : ""}` });
      seg.addEventListener("pointermove", (e) =>
        showTip(
          e.clientX,
          e.clientY,
          el("div", { class: "afa-tip-head", text: row.value }),
          tipRow(
            metric === "revenue" ? "Revenue" : "Visitors",
            `${metric === "revenue" ? money(v, null, { full: true }) : numFull(v)} (${pct(frac * 100)})`,
          ),
        ),
      );
      seg.addEventListener("pointerleave", hideTip);
      seg.addEventListener("click", () => onPick(row));
      slices.append(seg);
      a0 = a1;
    }
    const centre = svg("text", { x: c, y: c - 2, "text-anchor": "middle", class: "afa-donut-num" }, num(total));
    s.append(centre);
    countTo(centre, total, num, 900);
    s.append(
      svg("text", { x: c, y: c + 16, "text-anchor": "middle", class: "afa-donut-label" }, metric === "revenue" ? "revenue" : "visitors"),
    );
    return s;
  }

  // ---------- periods ----------

  const PRESETS = [
    { key: "today", label: "Today", k: "T" },
    { key: "yesterday", label: "Yesterday", k: "Y" },
    { key: "24h", label: "Last 24 hours", k: "D" },
    { key: "7d", label: "Last 7 days", k: "W" },
    { key: "30d", label: "Last 30 days", k: "3" },
  ];
  const MORE = [
    { key: "mtd", label: "Month to date", k: "M" },
    { key: "90d", label: "Last 90 days" },
    { key: "ytd", label: "Year to date" },
    { key: "12mo", label: "Last 12 months" },
    { key: "all", label: "All time", k: "A" },
  ];
  const ALL_PRESETS = [...PRESETS, ...MORE];
  const presetLabel = (key) => (ALL_PRESETS.find((p) => p.key === key) || {}).label;
  function rangeLabel(from, to) {
    if (from.length > 10) {
      const f = new Date(from);
      const t = new Date(to);
      const hm = (d) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
      return `${f.getUTCDate()} ${MONTHS[f.getUTCMonth()]} ${hm(f)} – ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${hm(t)} UTC`;
    }
    const a = parseDay(from);
    const b = parseDay(to);
    if (from === to) return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()}`;
    const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
    return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]}${sameYear ? "" : ` ${a.getUTCFullYear()}`} – ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  }
  function autoInterval(period, from, to) {
    if (["today", "yesterday", "24h"].includes(period)) return "hour";
    if (["12mo", "ytd", "all"].includes(period)) return "month";
    if (from && to) {
      if (from.length > 10) return new Date(to) - new Date(from) <= 3 * 86400000 ? "hour" : "day";
      const d = daysBetween(from, to) + 1;
      if (d <= 2) return "hour";
      if (d <= 120) return "day";
      if (d <= 400) return "week";
      return "month";
    }
    return "day";
  }

  // ======================================================================
  // One site
  // ======================================================================

  function siteView(root, ctx) {
    const api = ctx.api;
    const project = root.dataset.project;
    const site = JSON.parse(root.dataset.site || "{}");
    const sites = JSON.parse(root.dataset.sites || "[]");
    const cur = site.currency || null;
    const tz = site.timezone || "UTC";
    const base = `analytics/sites/${site.id}`;

    // State lives in the URL, so a reload or a shared link shows the same view.
    const qs = ctx.search;
    const state = {
      period: qs.get("period") || (qs.get("from") ? null : "30d"),
      from: qs.get("from"),
      to: qs.get("to"),
      interval: qs.get("interval") || "auto",
      compare: qs.get("compare") === "1",
      // Which view of the site: traffic (the default), AI search, or page speed.
      view: ["ai", "speed"].includes(qs.get("view")) ? qs.get("view") : "traffic",
      filters: qs.getAll("f").flatMap((f) => {
        const i = f.indexOf("==");
        return i > 0 ? [{ key: f.slice(0, i), value: f.slice(i + 2) }] : [];
      }),
    };
    let chipKeys = new Set(); // filter chips already shown (new ones animate in)
    let resolved = null; // the period the API last answered with
    let lastRevenue = null;
    let gen = 0;

    function syncUrl() {
      const p = new URLSearchParams();
      if (state.period) p.set("period", state.period);
      else {
        p.set("from", state.from);
        p.set("to", state.to);
      }
      if (state.interval !== "auto") p.set("interval", state.interval);
      if (state.compare) p.set("compare", "1");
      if (state.view !== "traffic") p.set("view", state.view);
      for (const f of state.filters) p.append("f", `${f.key}==${f.value}`);
      ctx.replaceUrl(`${ctx.path}?${p}`);
    }
    function interval() {
      return state.interval !== "auto"
        ? state.interval
        : autoInterval(state.period, state.from || (resolved && resolved.from), state.to || (resolved && resolved.to));
    }
    /** Period and filters for every read. Goals go in `filters`, the rest as JSON leaves (any value is safe there). */
    function q(extra) {
      const o = {};
      if (state.period) o.period = state.period;
      else {
        o.from = state.from;
        o.to = state.to;
      }
      const goals = state.filters.filter((f) => f.key === "goal");
      const rest = state.filters.filter((f) => f.key !== "goal");
      const goalExtra = extra && extra.goalFilter;
      const goalFilters = [...goals.map((f) => f.value), ...(goalExtra ? [goalExtra] : [])];
      if (goalFilters.length) o.filters = goalFilters.map((g) => `goal==${g.replace(/[;|]/g, " ")}`).join(";");
      if (rest.length) o.filters_json = JSON.stringify(["and", rest.map((f) => ["==", f.key, [f.value.replace(/\*/g, "\\*")]])]);
      if (extra) for (const [k, v] of Object.entries(extra)) if (k !== "goalFilter") o[k] = v;
      return o;
    }
    function setPeriod(p) {
      if (typeof p === "string") {
        state.period = p;
        state.from = state.to = null;
      } else {
        state.period = null;
        state.from = p.from;
        state.to = p.to;
      }
      reload();
    }
    function addFilter(key, value) {
      if (value === null || value === undefined) return;
      state.filters = state.filters.filter((f) => f.key !== key).concat({ key, value: String(value) });
      reload();
    }
    function removeFilter(key) {
      state.filters = state.filters.filter((f) => f.key !== key);
      reload();
    }

    function shift(dir) {
      const r = resolved;
      if (!r) return;
      const today = todayIn(tz);
      if (r.name === "24h" || (state.from && state.from.length > 10)) {
        const len = r.end - r.start;
        const s0 = dir < 0 ? r.start - len : r.end;
        const s1 = Math.min(s0 + len, Date.now());
        if (s0 >= Date.now()) return;
        const iso = (ms) => `${new Date(ms).toISOString().slice(0, 16)}:00Z`;
        return setPeriod({ from: iso(s0), to: iso(s1) });
      }
      const from = r.from;
      const to = r.to;
      const firstOfMonth = from.slice(8) === "01";
      const endOfMonth = (s) => {
        const d = parseDay(`${s.slice(0, 7)}-01`);
        d.setUTCMonth(d.getUTCMonth() + 1);
        return addDays(ymd(d), -1);
      };
      let nf;
      let nt;
      if (
        r.name === "ytd" ||
        (from.slice(5) === "01-01" && (to.slice(5) === "12-31" || to === today) && from.slice(0, 4) === to.slice(0, 4))
      ) {
        const y = Number(from.slice(0, 4)) + dir;
        nf = `${y}-01-01`;
        nt = `${y}-12-31`;
      } else if (firstOfMonth && from.slice(0, 7) === to.slice(0, 7) && (to === endOfMonth(from) || to === today)) {
        const d = parseDay(from);
        d.setUTCMonth(d.getUTCMonth() + dir);
        nf = ymd(d);
        nt = endOfMonth(nf);
      } else {
        const len = daysBetween(from, to) + 1;
        nf = addDays(from, dir * len);
        nt = addDays(to, dir * len);
      }
      if (nf > today) return;
      if (nt > today) nt = today;
      setPeriod({ from: nf, to: nt });
    }

    // ----- layout -----
    clear(root);
    const bar = el("div", { class: "afa-bar" });
    const filterRow = el("div", { class: "afa-filters", attrs: { "aria-label": "Filters" } });
    const main = el("section", { class: "afa-card afa-main", attrs: { "aria-label": "Overview" } });
    const kpis = el("div", { class: "afa-kpis" });
    // The latest visitor, from the live stream: "Someone from Berlin opened /pricing from Google, just now."
    const ticker = el("p", { class: "afa-live-ticker", attrs: { hidden: "" } });
    const chartBox = el("div", { class: "afa-chart" });
    main.append(kpis, ticker, chartBox);
    const grid = el("div", { class: "afa-grid" });
    // AI search and page speed have views of their own, so they're one click away instead of at
    // the bottom of the traffic panels.
    const aiGrid = el("div", { class: "afa-grid" });
    const speedGrid = el("div", { class: "afa-grid" });
    const VIEWS = [
      ["traffic", "Traffic"],
      ["ai", "AI search"],
      ["speed", "Page speed"],
    ];
    const viewTabs = el("div", { class: "afa-tabs afa-views", attrs: { role: "tablist", "aria-label": "Analytics views" } });
    const viewBtns = VIEWS.map(([k, label]) => {
      const b = el("button", {
        class: "afa-tab",
        text: label,
        attrs: { type: "button", role: "tab" },
        on: {
          click: () => {
            if (state.view === k) return;
            state.view = k;
            syncUrl();
            paintViews();
            loadView(gen);
          },
        },
      });
      viewTabs.append(b);
      return b;
    });
    const viewSlide = tabSlider(viewTabs);
    function paintViews() {
      viewBtns.forEach((b, i) => b.setAttribute("aria-selected", String(VIEWS[i][0] === state.view)));
      main.hidden = grid.hidden = state.view !== "traffic";
      aiGrid.hidden = state.view !== "ai";
      speedGrid.hidden = state.view !== "speed";
      viewSlide();
    }
    root.append(bar, filterRow, viewTabs, main, grid, aiGrid, speedGrid);

    // ----- top bar -----
    const sitePick = picker(
      site.domain,
      sites.map((x) => ({ id: x.id, label: x.domain, href: `/dashboard/projects/${project}/analytics/${x.id}` })),
      site.id,
    );

    const periodCtl = el("div", { class: "afa-ctl afa-ctl-period" });
    const prev = el(
      "button",
      {
        class: "afa-btn afa-icon-btn",
        attrs: { type: "button", "aria-label": "Previous period", title: "Previous period" },
        on: { click: () => shift(-1) },
      },
      icon("left"),
    );
    const periodBtn = el("button", { class: "afa-btn afa-period-btn", attrs: { type: "button" } });
    const next = el(
      "button",
      {
        class: "afa-btn afa-icon-btn",
        attrs: { type: "button", "aria-label": "Next period", title: "Next period" },
        on: { click: () => shift(1) },
      },
      icon("right"),
    );
    periodCtl.append(prev, periodBtn, next);
    menu(periodBtn, (close) => {
      const pick = (key) => () => {
        close();
        setPeriod(key);
      };
      const box = el("div", { class: "afa-period-menu" });
      box.append(el("p", { class: "afa-menu-note" }, "Times in ", el("b", { text: tz })));
      for (const p of PRESETS) box.append(menuItem(p.label, pick(p.key), { current: state.period === p.key, key: p.k }));
      const more = el(
        "details",
        { class: "afa-more", attrs: { open: MORE.some((p) => p.key === state.period) ? true : null } },
        el("summary", { text: "More periods" }),
      );
      for (const p of MORE) more.append(menuItem(p.label, pick(p.key), { current: state.period === p.key, key: p.k }));
      box.append(more, el("div", { class: "afa-menu-sep" }));
      const today = todayIn(tz);
      const f = el("input", {
        attrs: {
          type: "date",
          max: today,
          value: state.from && state.from.length === 10 ? state.from : resolved ? resolved.from : "",
          "aria-label": "From",
        },
      });
      const t = el("input", {
        attrs: {
          type: "date",
          max: today,
          value: state.to && state.to.length === 10 ? state.to : resolved ? resolved.to : "",
          "aria-label": "To",
        },
      });
      const form = el(
        "form",
        {
          class: "afa-custom",
          on: {
            submit: (e) => {
              e.preventDefault();
              if (!f.value || !t.value) return;
              close();
              setPeriod(f.value <= t.value ? { from: f.value, to: t.value } : { from: t.value, to: f.value });
            },
          },
        },
        el("span", { class: "afa-menu-label", text: "Custom" }),
        el("div", { class: "afa-custom-fields" }, f, t),
        el("button", { class: "btn btn-quiet btn-small", text: "Apply", attrs: { type: "submit" } }),
      );
      box.append(form);
      return box;
    });

    const compareBtn = el(
      "button",
      {
        class: "afa-btn afa-compare",
        attrs: { type: "button", "aria-pressed": "false" },
        on: {
          click: () => {
            state.compare = !state.compare;
            reload({ only: "main" });
          },
        },
      },
      icon("plus"),
      el("span", { text: "Compare" }),
    );

    const intervalBtn = el("button", { class: "afa-btn", attrs: { type: "button" } });
    const intervalCtl = el("div", { class: "afa-ctl" }, intervalBtn);
    const INTERVALS = [
      ["hour", "Hourly"],
      ["day", "Daily"],
      ["week", "Weekly"],
      ["month", "Monthly"],
    ];
    menu(intervalBtn, (close) =>
      el(
        "div",
        null,
        INTERVALS.map(([k, label]) =>
          menuItem(
            label,
            () => {
              close();
              state.interval = k;
              reload({ only: "main" });
            },
            { current: interval() === k },
          ),
        ),
      ),
    );

    const filterBtn = el(
      "button",
      { class: "afa-btn afa-icon-btn", attrs: { type: "button", "aria-label": "Add a filter", title: "Filter" } },
      icon("filter"),
    );
    const filterCtl = el("div", { class: "afa-ctl" }, filterBtn);
    const FILTER_KEYS = [
      ["page", "Page"],
      ["entry_page", "Entry page"],
      ["hostname", "Hostname"],
      ["channel", "Channel"],
      ["referrer", "Referrer"],
      ["utm_source", "UTM source"],
      ["utm_medium", "UTM medium"],
      ["utm_campaign", "Campaign"],
      ["country", "Country (code, e.g. US)"],
      ["region", "Region"],
      ["city", "City"],
      ["device", "Device"],
      ["browser", "Browser"],
      ["os", "OS"],
      ["goal", "Goal"],
      ["event_name", "Event name"],
    ];
    menu(filterBtn, (close) => {
      const key = el(
        "select",
        { attrs: { "aria-label": "Property" } },
        FILTER_KEYS.map(([k, l]) => el("option", { text: l, attrs: { value: k } })),
      );
      const val = el("input", { attrs: { type: "text", placeholder: "Value", "aria-label": "Value", required: true, maxlength: 200 } });
      return el(
        "form",
        {
          class: "afa-filter-form",
          on: {
            submit: (e) => {
              e.preventDefault();
              if (!val.value.trim()) return;
              close();
              addFilter(key.value, val.value.trim());
            },
          },
        },
        el("span", { class: "afa-menu-label", text: "Show only visits where" }),
        key,
        el("span", { class: "afa-menu-label", text: "is" }),
        val,
        el("button", { class: "btn btn-primary btn-small", text: "Add filter", attrs: { type: "submit" } }),
        el("p", { class: "afa-menu-note", text: "Or click any row below." }),
      );
    });
    const refreshBtn = el(
      "button",
      {
        class: "afa-btn afa-icon-btn",
        attrs: { type: "button", "aria-label": "Refresh", title: "Refresh" },
        on: {
          click: () => {
            invalidate(project);
            reload();
            loadOnline();
          },
        },
      },
      icon("refresh"),
    );
    bar.append(sitePick, periodCtl, compareBtn, intervalCtl, filterCtl, refreshBtn);

    function paintBar() {
      clear(periodBtn).append(
        el("span", { text: state.period ? presetLabel(state.period) : rangeLabel(state.from, state.to) }),
        el("span", { class: "afa-caret", attrs: { "aria-hidden": "true" } }),
      );
      const today = todayIn(tz);
      next.disabled = !resolved || (resolved.to >= today && (!resolved.end || resolved.end >= Date.now() - 60000));
      prev.disabled = state.period === "all";
      compareBtn.setAttribute("aria-pressed", String(state.compare));
      compareBtn.classList.toggle("is-on", state.compare);
      clear(intervalBtn).append(
        el("span", { text: (INTERVALS.find(([k]) => k === interval()) || [0, "Daily"])[1] }),
        el("span", { class: "afa-caret", attrs: { "aria-hidden": "true" } }),
      );
      clear(filterRow);
      filterRow.hidden = !state.filters.length;
      const had = chipKeys;
      chipKeys = new Set(state.filters.map((f) => `${f.key}==${f.value}`));
      for (const f of state.filters) {
        const label = (FILTER_KEYS.find(([k]) => k === f.key) || [f.key, f.key.replace(/_/g, " ")])[1].replace(/ \(.*\)$/, "");
        const shown = f.key === "country" ? `${flag(f.value)} ${countryName(f.value)}` : f.value;
        filterRow.append(
          el(
            "span",
            { class: `afa-chip${had.has(`${f.key}==${f.value}`) ? "" : " afa-chip-new"}` },
            el("span", { class: "muted", text: `${label} is ` }),
            el("b", { text: shown }),
            el(
              "button",
              {
                class: "afa-chip-x",
                attrs: { type: "button", "aria-label": `Remove the ${label} filter` },
                on: { click: () => removeFilter(f.key) },
              },
              "×",
            ),
          ),
        );
      }
      if (state.filters.length > 1)
        filterRow.append(
          el("button", {
            class: "afa-link",
            text: "Clear all",
            attrs: { type: "button" },
            on: {
              click: () => {
                state.filters = [];
                reload();
              },
            },
          }),
        );
    }

    // ----- KPIs + chart -----
    const ONLINE = { value: null };
    async function loadOnline() {
      try {
        // The tile needs only the count: one recent event instead of 50.
        const r = await api(project, `${base}/realtime`, { limit: 1 });
        ONLINE.value = r.online ?? r.visitors_last_5m;
        LIVE.heardAt = Date.now();
      } catch {
        ONLINE.value = null;
      }
      paintOnline();
    }
    function paintOnline() {
      if (kpiTiles) countTo(kpiTiles.online, ONLINE.value, (v) => (v === null || v === undefined ? "–" : numFull(v)));
      dock.setOnline(ONLINE.value);
      paintTitle();
    }
    // The count in the browser tab's title, "(3) shop.test analytics", while this view is open.
    const TITLE_COUNT = /^\(\d[\d,]*\) /;
    function paintTitle() {
      if (!ctx.active) return;
      const bare = document.title.replace(TITLE_COUNT, "");
      document.title = ONLINE.value ? `(${numFull(ONLINE.value)}) ${bare}` : bare;
    }

    // ----- live: counts pushed by the site's object over a WebSocket; polling is the fallback -----
    const LIVE = { ws: null, retry: 0, timer: 0, heardAt: 0, latest: null };
    function liveConnect() {
      if (LIVE.ws || !ctx.active || document.hidden || typeof WebSocket !== "function") return;
      clearTimeout(LIVE.timer);
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      let ws;
      try {
        ws = new WebSocket(
          `${scheme}://${location.host}/dashboard/projects/${encodeURIComponent(project)}/live/analytics/${encodeURIComponent(site.id)}`,
        );
      } catch {
        return;
      }
      LIVE.ws = ws;
      let keepAlive = 0;
      ws.addEventListener("open", () => {
        LIVE.retry = 0;
        // Answered by the object without waking it; keeps proxies from closing a quiet socket.
        keepAlive = setInterval(() => ws.readyState === 1 && ws.send("ping"), 30000);
      });
      ws.addEventListener("message", (e) => {
        let m = null;
        try {
          m = JSON.parse(e.data);
        } catch {
          return; // "pong"
        }
        if (!m || typeof m.online !== "number") return;
        LIVE.heardAt = Date.now();
        ONLINE.value = m.online;
        paintOnline();
        if (m.pageviews > 0) pingDot();
        if (m.latest) {
          // Server clock to ours: how long ago it happened, as the server saw it.
          LIVE.latest = { ...m.latest, seenAt: Date.now() - Math.max(0, (m.at || m.latest.ts) - m.latest.ts) };
          paintTicker();
        }
      });
      ws.addEventListener("close", () => {
        clearInterval(keepAlive);
        if (LIVE.ws !== ws) return;
        LIVE.ws = null;
        if (!ctx.active || document.hidden) return;
        // Back off: 2 s, 4 s, ... up to a minute. The poll keeps the count going meanwhile.
        LIVE.timer = setTimeout(liveConnect, Math.min(60000, 2000 * 2 ** LIVE.retry++));
      });
    }
    function liveClose() {
      clearTimeout(LIVE.timer);
      const ws = LIVE.ws;
      LIVE.ws = null;
      if (ws) {
        try {
          ws.close(1000, "hidden");
        } catch {
          /* already closed */
        }
      }
    }
    const liveOpen = () => !!LIVE.ws && LIVE.ws.readyState === 1;
    function pingDot() {
      if (!kpiTiles || reduced()) return;
      const dot = kpiTiles.dot;
      dot.classList.remove("is-ping");
      void dot.offsetWidth; // restart the animation
      dot.classList.add("is-ping");
    }
    function paintTicker() {
      const x = LIVE.latest;
      const ago = x ? Date.now() - x.seenAt : Infinity;
      if (!x || ago > 30 * 60000) {
        ticker.hidden = true;
        return;
      }
      const where = x.city || (x.country ? countryName(x.country) : null);
      const page = !x.pathname ? "a page" : x.pathname.length > 60 ? `${x.pathname.slice(0, 59)}…` : x.pathname;
      const when = ago < 15000 ? "just now" : ago < 60000 ? `${Math.round(ago / 1000)} seconds ago` : `${Math.round(ago / 60000)} min ago`;
      ticker.textContent = `Someone${where ? ` from ${where}` : ""} opened ${page}${x.source ? ` from ${x.source}` : ""}, ${when}.`;
      ticker.hidden = false;
    }
    const KPI = [
      ["visitors", "Visitors", (v) => numFull(v)],
      ["revenue", "Revenue", (v) => money(v, cur)],
      ["conversion_rate", "Conversion rate", pct],
      ["revenue_per_visitor", "Revenue/visitor", (v) => money(v, cur)],
      ["bounce_rate", "Bounce rate", (v) => pct(v)],
      ["visit_duration", "Session time", dur],
    ];
    const LOWER_IS_BETTER = new Set(["bounce_rate"]);
    // The KPI tiles are built once; later periods count their numbers to the new values.
    let kpiTiles = null;
    function buildKpis() {
      const tiles = { nums: {}, chs: {}, nodes: [] };
      for (const [key, label] of KPI) {
        tiles.nums[key] = el("span", { class: "afa-kpi-num" });
        tiles.chs[key] = el("span", { class: "afa-kpi-ch is-flat", text: " " });
        tiles.nodes.push(
          el("div", { class: "afa-kpi" }, el("span", { class: "afa-kpi-label", text: label }), tiles.nums[key], tiles.chs[key]),
        );
      }
      tiles.online = el("button", {
        class: "afa-kpi-num afa-online-num afa-plain",
        text: "–",
        attrs: {
          type: "button",
          title: "Visitors seen in the last 5 minutes who haven't closed the page. Open the live view.",
        },
        on: { click: () => dock.openLive() },
      });
      // Still, and it pings once for each new pageview the live stream reports.
      tiles.dot = el("span", { class: "afa-live-dot is-still", attrs: { "aria-hidden": "true" } });
      tiles.nodes.push(
        el(
          "div",
          { class: "afa-kpi afa-kpi-online" },
          el("span", { class: "afa-kpi-label" }, "Online", tiles.dot),
          tiles.online,
          el("span", { class: "afa-kpi-ch is-flat", text: "on the site now" }),
        ),
      );
      return tiles;
    }
    function paintChange(node, key, c, stats, v) {
      const good = c === null || c === undefined || c === 0 ? null : LOWER_IS_BETTER.has(key) ? c < 0 : c > 0;
      clear(node);
      node.removeAttribute("title");
      if (c === null || c === undefined) {
        node.className = "afa-kpi-ch is-flat";
        node.textContent = stats.comparison && v ? "new" : " ";
        if (stats.comparison) node.title = "Nothing to compare with in the previous period";
      } else {
        node.className = `afa-kpi-ch ${good === null ? "is-flat" : good ? "is-good" : "is-bad"}`;
        node.title = `vs ${rangeLabel(stats.comparison.period.from, stats.comparison.period.to)}`;
        add(node, [
          `${Math.abs(Math.round(c))}%`,
          c ? el("span", { class: "afa-arrow", text: c > 0 ? "↑" : "↓", attrs: { "aria-label": c > 0 ? "up" : "down" } }) : null,
        ]);
      }
      enter(node);
    }
    async function loadMain(g) {
      busy(kpis, SK.kpis());
      busy(chartBox, SK.chart(330));
      const iv = interval();
      try {
        const [stats, ts] = await Promise.all([
          api(project, `${base}/stats`, q({ metrics: KPI.map((k) => k[0]).join(","), compare: "previous" })),
          api(
            project,
            `${base}/timeseries`,
            q({
              interval: iv,
              metrics: "visitors,new_visitors,returning_visitors,revenue,new_revenue,renewal_revenue,revenue_per_visitor,conversion_rate",
              compare: state.compare ? "previous" : null,
            }),
          ),
        ]);
        if (g !== gen) return;
        resolved = stats.period;
        lastRevenue = stats.metrics.revenue || 0;
        paintBar();
        if (!kpiTiles) {
          kpiTiles = buildKpis();
          swap(kpis, kpiTiles.nodes);
          kpiTiles.nodes.forEach((n, i) => enter(n, i));
        } else {
          kpis.classList.remove("is-loading");
          kpis.removeAttribute("aria-busy");
        }
        const ch = (stats.comparison && stats.comparison.change_percent) || {};
        for (const [key, , f] of KPI) {
          countTo(kpiTiles.nums[key], stats.metrics[key], f);
          paintChange(kpiTiles.chs[key], key, ch[key], stats, stats.metrics[key]);
        }
        countTo(kpiTiles.online, ONLINE.value, (v) => (v === null || v === undefined ? "–" : numFull(v)));
        const inProgress = stats.period.end > Date.now();
        const plot = el("div", { class: "afa-plot" });
        const table = mainChart(plot, ts, { currency: cur, inProgress, compare: state.compare });
        const legend = el("div", { class: "afa-legend" });
        legend.append(el("span", { class: "afa-legend-item" }, el("span", { class: "afa-key afa-key-line" }), "Visitors"));
        if ((ts.results || []).some((r) => r.revenue > 0))
          legend.append(el("span", { class: "afa-legend-item" }, el("span", { class: "afa-key afa-key-bar" }), "Revenue"));
        const prevPeriod = ts.comparison && ts.comparison.period;
        if (state.compare && prevPeriod)
          legend.append(
            el(
              "span",
              { class: "afa-legend-item" },
              el("span", { class: "afa-key afa-key-prev" }),
              `Previous period (${rangeLabel(prevPeriod.from, prevPeriod.to)})`,
            ),
          );
        const none =
          !stats.metrics.visitors && !(ts.results || []).some((r) => r.visitors)
            ? empty(
                "No visitors in this period.",
                stats.period.name === "all" ? "Install AgentFirstStack analytics on our site and check it's receiving events." : null,
              )
            : null;
        swap(chartBox, plot, table, legend, none);
      } catch (e) {
        if (g !== gen) return;
        kpis.classList.remove("is-loading");
        swap(
          chartBox,
          errorBox(e, () => reload({ only: "main" })),
        );
      }
    }

    // ----- breakdown panels -----
    const METRICS = "visitors,revenue,conversions,conversion_rate,revenue_per_visitor";
    const SORTS = [
      ["visitors", "Visitors"],
      ["revenue", "Revenue"],
      ["conversions", "Conversions"],
    ];
    const shownValue = (dim, row) => {
      const v = row.value;
      if (v === "(none)") return dim === "referrer" || dim === "source" ? "Direct / none" : "(not set)";
      if (dim === "country") return countryName(v);
      if (dim === "device") return cap(v);
      return v;
    };
    function rowIcon(dim, row) {
      if (dim === "country" || dim === "region" || dim === "city") {
        const cc = dim === "country" ? row.value : row.country;
        return el("span", { class: "afa-flag", text: flag(cc), attrs: { "aria-hidden": "true" } });
      }
      if (dim === "referrer" || dim === "source")
        return el("span", {
          class: "afa-favicon afa-favicon-sm",
          text:
            row.value === "(none)"
              ? "↗"
              : String(row.value)
                  .replace(/^www\./, "")
                  .charAt(0)
                  .toUpperCase(),
          attrs: { "aria-hidden": "true" },
        });
      if (dim === "channel") {
        const sw = el("span", { class: "afa-sw", attrs: { "aria-hidden": "true" } });
        sw.style.background = CHANNEL_COLOR[row.value] || OTHER;
        return sw;
      }
      return null;
    }
    function rowTip(e, dim, row, total) {
      showTip(
        e.clientX,
        e.clientY,
        el("div", { class: "afa-tip-head", text: shownValue(dim, row) }),
        tipRow("Visitors", `${numFull(row.visitors || 0)}${total ? ` (${pct(((row.visitors || 0) / total) * 100)})` : ""}`),
        tipRow("Revenue", money(row.revenue || 0, cur, { full: true })),
        tipRow("Revenue/visitor", money(row.revenue_per_visitor || 0, cur, { full: true })),
        tipRow("Conversions", numFull(row.conversions || 0)),
        tipRow("Conversion rate", pct(row.conversion_rate || 0)),
        el("div", { class: "afa-tip-sep" }),
        el("div", { class: "afa-tip-note", text: "Click to filter by this" }),
      );
    }
    /** Bar rows: visitors share (blue), revenue share (orange) after it. */
    function barRows(dim, rows, sort, totalVisitors, onPick) {
      const list = el("ul", { class: "afa-rows" });
      const metric = sort;
      const maxM = Math.max(1, ...rows.map((r) => r[metric] || 0));
      const maxRev = Math.max(0, ...rows.map((r) => r.revenue || 0));
      const revShare = maxRev > 0 && metric !== "revenue" ? 0.3 : 0;
      rows.forEach((row, i) => {
        const b = growTo(el("span", { class: "afa-row-bar" }), "width", `${((row[metric] || 0) / maxM) * (1 - revShare) * 100}%`);
        const rb = growTo(
          el("span", { class: "afa-row-rev" }),
          "width",
          revShare ? `${((row.revenue || 0) / maxRev) * revShare * 100}%` : "0",
        );
        const val = metric === "revenue" ? money(row.revenue || 0, cur) : num(row[metric] || 0);
        list.append(
          el(
            "li",
            { class: "afa-stagger", attrs: { "data-i": i } },
            el(
              "button",
              {
                class: "afa-row",
                attrs: { type: "button" },
                on: {
                  click: () => onPick(row),
                  pointermove: (e) => rowTip(e, dim, row, totalVisitors),
                  pointerleave: hideTip,
                },
              },
              el("span", { class: "afa-row-bars", attrs: { "aria-hidden": "true" } }, b, rb),
              el("span", { class: "afa-row-label" }, rowIcon(dim, row), el("span", { class: "afa-row-text", text: shownValue(dim, row) })),
              el("span", { class: "afa-row-val", text: val }),
            ),
          ),
        );
      });
      for (const li of list.children) li.style.setProperty("--i", li.getAttribute("data-i"));
      return list;
    }

    function detailsDialog(title, dim, sort) {
      const dlg = el("dialog", { class: "afa-dialog", attrs: { "aria-label": title } });
      const search = el("input", { attrs: { type: "search", placeholder: "Search", "aria-label": `Search ${title}` } });
      const body = el("div", { class: "afa-dialog-body" }, SK.table(10));
      dlg.append(
        el(
          "div",
          { class: "afa-dialog-head" },
          el("h2", { text: title }),
          search,
          el(
            "button",
            { class: "afa-btn afa-icon-btn", attrs: { type: "button", "aria-label": "Close" }, on: { click: () => closeDialog(dlg) } },
            icon("x"),
          ),
        ),
        body,
      );
      openDialog(dlg);
      api(project, `${base}/breakdown`, q({ breakdown: dim, metrics: `${METRICS},visits,pageviews,bounce_rate`, limit: 100, sort }))
        .then((r) => {
          const rows = r.results || [];
          const table = el("table", { class: "afa-table" });
          const cols = [
            ["Visitors", (x) => numFull(x.visitors)],
            ["Visits", (x) => numFull(x.visits)],
            ["Pageviews", (x) => numFull(x.pageviews)],
            ["Bounce", (x) => pct(x.bounce_rate)],
            ["Conv.", (x) => numFull(x.conversions)],
            ["Conv. rate", (x) => pct(x.conversion_rate)],
            ["Revenue", (x) => money(x.revenue || 0, cur)],
          ];
          table.append(
            el(
              "thead",
              null,
              el(
                "tr",
                null,
                el("th", { text: title }),
                cols.map(([h]) => el("th", { text: h, class: "num" })),
              ),
            ),
          );
          const tb = el("tbody");
          const trs = rows.map((x) => {
            const tr = el(
              "tr",
              {
                on: {
                  click: () => {
                    closeDialog(dlg);
                    pickFilter(dim, x);
                  },
                },
              },
              el(
                "td",
                null,
                el("span", { class: "afa-row-label" }, rowIcon(dim, x), el("span", { class: "afa-row-text", text: shownValue(dim, x) })),
              ),
              cols.map(([, f]) => el("td", { class: "num", text: f(x) })),
            );
            tr._k = `${shownValue(dim, x)} ${x.value}`.toLowerCase();
            return tr;
          });
          tb.append(...trs);
          table.append(tb);
          swap(
            body,
            rows.length ? table : empty("Nothing in this period."),
            r.next_offset
              ? el("p", {
                  class: "fine",
                  text: `Showing the top 100 of ${numFull(r.total_rows)}. Your agent can page through all of them (offset=).`,
                })
              : null,
          );
          search.addEventListener("input", () => {
            const s = search.value.trim().toLowerCase();
            for (const tr of trs) tr.hidden = !!s && !tr._k.includes(s);
          });
        })
        .catch((e) => swap(body, errorBox(e)));
    }

    function pickFilter(dim, row) {
      addFilter(dim === "goal" ? "goal" : dim, row.value);
    }

    /** A card with tabs, each a breakdown. */
    function breakdownCard({ tabs, cls }) {
      const card = el("section", { class: `afa-card afa-panel ${cls || ""}` });
      const tablist = el("div", { class: "afa-tabs", attrs: { role: "tablist" } });
      const sortBtn = el("button", { class: "afa-btn afa-btn-ghost afa-sort", attrs: { type: "button" } });
      const sortCtl = el("div", { class: "afa-ctl" }, sortBtn);
      const head = el("div", { class: "afa-panel-head" }, tablist, sortCtl);
      const body = el("div", { class: "afa-panel-body" });
      const foot = el("div", { class: "afa-panel-foot" });
      card.append(head, body, foot);
      let active = tabs[0];
      let sort = "visitors";
      let slide = null;
      const btns = tabs.map((t) => {
        const b = el("button", {
          class: "afa-tab",
          text: t.label,
          attrs: { type: "button", role: "tab" },
          on: {
            click: () => {
              active = t;
              paint();
              load();
            },
          },
        });
        tablist.append(b);
        return b;
      });
      menu(sortBtn, (close) =>
        el(
          "div",
          null,
          SORTS.map(([k, label]) =>
            menuItem(
              label,
              () => {
                close();
                sort = k;
                paint();
                load();
              },
              { current: sort === k },
            ),
          ),
        ),
      );
      function paint() {
        btns.forEach((b, i) => b.setAttribute("aria-selected", String(tabs[i] === active)));
        if (slide) slide();
        clear(sortBtn).append(el("span", { text: (SORTS.find(([k]) => k === sort) || [0, "Visitors"])[1] }), icon("sort"));
        clear(foot).append(
          el(
            "button",
            { class: "afa-details", attrs: { type: "button" }, on: { click: () => detailsDialog(active.label, active.dim, sort) } },
            icon("expand"),
            "Details",
          ),
        );
      }
      let mine = 0;
      async function load() {
        const g = ++mine;
        busy(body, active.donut ? SK.donut() : SK.rows(10));
        try {
          const r = await api(project, `${base}/breakdown`, q({ breakdown: active.dim, metrics: METRICS, limit: 10, sort }));
          if (g !== mine) return;
          const rows = r.results || [];
          if (!rows.length) return swap(body, empty(active.empty || "Nothing in this period."));
          const totalVisitors = totals.visitors;
          if (active.donut) {
            swap(
              body,
              el(
                "div",
                { class: "afa-donut-wrap" },
                donut(
                  rows,
                  sort === "revenue" ? "revenue" : "visitors",
                  (x) => CHANNEL_COLOR[x.value] || OTHER,
                  (x) => pickFilter(active.dim, x),
                ),
                barRows(active.dim, rows, sort, totalVisitors, (x) => pickFilter(active.dim, x)),
              ),
            );
          } else
            swap(
              body,
              barRows(active.dim, rows, sort, totalVisitors, (x) => pickFilter(active.dim, x)),
            );
        } catch (e) {
          if (g !== mine) return;
          swap(body, errorBox(e, load));
        }
      }
      slide = tabSlider(tablist);
      paint();
      return { card, load };
    }
    const totals = { visitors: 0 };

    const panels = [
      breakdownCard({
        tabs: [
          { label: "Channel", dim: "channel", donut: true },
          { label: "Referrer", dim: "referrer" },
          { label: "Campaign", dim: "utm_campaign", empty: "No campaign traffic (utm_campaign) in this period." },
          { label: "Keyword", dim: "utm_term", empty: "No keywords (utm_term) in this period." },
        ],
      }),
      breakdownCard({
        tabs: [
          { label: "Page", dim: "page" },
          { label: "Entry page", dim: "entry_page" },
          { label: "Exit page", dim: "exit_page" },
          { label: "Hostname", dim: "hostname" },
        ],
      }),
      breakdownCard({
        tabs: [
          { label: "Country", dim: "country" },
          { label: "Region", dim: "region" },
          { label: "City", dim: "city" },
        ],
      }),
      breakdownCard({
        tabs: [
          { label: "Browser", dim: "browser" },
          { label: "OS", dim: "os" },
          { label: "Device", dim: "device" },
        ],
      }),
    ];
    for (const p of panels) grid.append(p.card);

    // ----- goals, funnels, visitors -----
    const goalsCard = el("section", { class: "afa-card afa-wide" });
    const goalTabs = el("div", { class: "afa-tabs", attrs: { role: "tablist" } });
    const goalTools = el("div", { class: "afa-panel-tools" });
    const goalBody = el("div", { class: "afa-panel-body" });
    goalsCard.append(el("div", { class: "afa-panel-head" }, goalTabs, goalTools), goalBody);
    grid.append(goalsCard);
    const GOAL_TABS = [
      ["goal", "Goals"],
      ["funnel", "Funnels"],
      ["visitors", "Visitors"],
    ];
    let goalTab = "goal";
    const goalBtns = GOAL_TABS.map(([k, label]) => {
      const b = el("button", {
        class: "afa-tab",
        text: label,
        attrs: { type: "button", role: "tab" },
        on: {
          click: () => {
            goalTab = k;
            paintGoalTabs();
            loadGoals();
          },
        },
      });
      goalTabs.append(b);
      return b;
    });
    const goalSlide = tabSlider(goalTabs);
    const paintGoalTabs = () => {
      goalBtns.forEach((b, i) => b.setAttribute("aria-selected", String(GOAL_TABS[i][0] === goalTab)));
      goalSlide();
    };
    paintGoalTabs();
    const splitSkel = () =>
      el(
        "div",
        { class: "afa-split", attrs: { "aria-hidden": "true" } },
        SK.chart(260),
        el("div", { class: "afa-split-side" }, SK.rows(6)),
      );
    let goalGen = 0;
    let goalOrder = null; // goal names in creation order, for stable colours
    async function loadGoals() {
      const g = ++goalGen;
      clear(goalTools);
      if (goalBody.dataset.tab !== goalTab) delete goalBody.dataset.filled; // another kind of content: its own skeleton
      goalBody.dataset.tab = goalTab;
      busy(goalBody, goalTab === "goal" ? splitSkel() : goalTab === "funnel" ? SK.chart(260) : SK.table(8));
      try {
        if (goalTab === "goal") await drawGoals(g);
        else if (goalTab === "funnel") await drawFunnels(g);
        else await drawVisitors(g);
      } catch (e) {
        if (g !== goalGen) return;
        swap(goalBody, errorBox(e, loadGoals));
      }
    }
    async function drawGoals(g) {
      if (!goalOrder) {
        const list = await api(project, `${base}/goals`, {});
        goalOrder = (list.goals || []).map((x) => x.name);
      }
      const r = await api(project, `${base}/breakdown`, q({ breakdown: "goal", limit: 50, sort: "conversions" }));
      if (g !== goalGen) return;
      const rows = (r.results || []).filter((x) => x.conversions > 0 || x.visitors > 0).sort((a, b) => b.conversions - a.conversions);
      if (!rows.length) {
        swap(
          goalBody,
          empty(
            goalOrder.length ? "No goal was completed in this period." : "No goals yet.",
            goalOrder.length ? null : "Set up goals for our sign-ups and other key actions in AgentFirstStack analytics.",
          ),
        );
        return;
      }
      const colorOf = (name) => {
        const i = goalOrder.indexOf(name);
        return i >= 0 && i < SERIES.length ? SERIES[i] : OTHER;
      };
      const top = rows.slice(0, 8);
      const iv = interval();
      const series = await Promise.all(
        top.map((x) => api(project, `${base}/timeseries`, q({ interval: iv, metrics: "conversions", goalFilter: x.value }))),
      );
      if (g !== goalGen) return;
      const labels = (series[0] && series[0].results ? series[0].results : []).map((b) => b.date);
      const chart = el("div", { class: "afa-chart afa-chart-goals" });
      const list = el("ul", { class: "afa-rows afa-goal-list" });
      const maxC = Math.max(1, ...rows.map((x) => x.conversions));
      const search =
        rows.length > 8
          ? el("input", { class: "afa-search", attrs: { type: "search", placeholder: "Search goals", "aria-label": "Search goals" } })
          : null;
      if (search) goalTools.append(search);
      const items = rows.map((x, i) => {
        const b = growTo(el("span", { class: "afa-row-bar" }), "width", `${(x.conversions / maxC) * 100}%`);
        b.style.background = `${colorOf(x.value)}26`;
        const li = el(
          "li",
          { class: "afa-stagger" },
          el(
            "button",
            {
              class: "afa-row",
              attrs: { type: "button" },
              on: {
                click: () => addFilter("goal", x.value),
                pointermove: (e) =>
                  showTip(
                    e.clientX,
                    e.clientY,
                    el("div", { class: "afa-tip-head", text: x.value }),
                    tipRow("Completions", numFull(x.conversions)),
                    tipRow("Visitors", numFull(x.visitors)),
                    tipRow("Conversion rate", pct(x.conversion_rate)),
                    x.revenue ? tipRow("Revenue", money(x.revenue, cur, { full: true })) : null,
                    el("div", { class: "afa-tip-sep" }),
                    el("div", { class: "afa-tip-note", text: `${x.goal_type}: ${x.goal_match}` }),
                  ),
                pointerleave: hideTip,
              },
            },
            el("span", { class: "afa-row-bars", attrs: { "aria-hidden": "true" } }, b),
            el("span", { class: "afa-row-label" }, el("span", { class: "afa-row-text", text: x.value })),
            el("span", { class: "afa-row-val", text: num(x.conversions) }),
          ),
        );
        li._k = x.value.toLowerCase();
        li.style.setProperty("--i", String(i));
        return li;
      });
      list.append(...items);
      if (search)
        search.addEventListener("input", () => {
          const s = search.value.trim().toLowerCase();
          for (const li of items) li.hidden = !!s && !li._k.includes(s);
        });
      swap(goalBody, el("div", { class: "afa-split" }, chart, el("div", { class: "afa-split-side" }, list)));
      linesChart(
        chart,
        labels,
        top.map((x, i) => ({ name: x.value, color: colorOf(x.value), values: (series[i].results || []).map((b) => b.conversions || 0) })),
        { interval: iv },
      );
    }
    let funnelId = null;
    async function drawFunnels(g) {
      const list = await api(project, `${base}/funnels`, {});
      if (g !== goalGen) return;
      const funnels = list.funnels || [];
      if (!funnels.length) {
        swap(
          goalBody,
          empty(
            "No saved funnels yet.",
            "Save a funnel in AgentFirstStack analytics for our sign-up flow, from the first page to the sign-up.",
          ),
        );
        return;
      }
      if (!funnels.some((f) => f.id === funnelId)) funnelId = funnels[0].id;
      const sel = el(
        "select",
        {
          class: "afa-select",
          attrs: { "aria-label": "Funnel" },
          on: {
            change: () => {
              funnelId = sel.value;
              loadGoals();
            },
          },
        },
        funnels.map((f) => el("option", { text: f.name, attrs: { value: f.id, selected: f.id === funnelId ? true : null } })),
      );
      goalTools.append(sel);
      const r = await api(project, `${base}/funnels/${funnelId}`, q({}));
      if (g !== goalGen) return;
      const steps = r.steps || [];
      const first = Math.max(1, (steps[0] && steps[0].visitors) || 0);
      const wrap = el("ol", { class: "afa-funnel" });
      steps.forEach((st, i) => {
        const h = growTo(el("span", { class: "afa-funnel-fill" }), "height", `${Math.max(2, ((st.visitors || 0) / first) * 100)}%`);
        wrap.append(
          el(
            "li",
            { class: "afa-funnel-step" },
            el("span", { class: "afa-funnel-rate", text: i ? pct(st.conversion_rate) : "100%" }),
            el("span", { class: "afa-funnel-col", attrs: { "aria-hidden": "true" } }, h),
            el("span", { class: "afa-funnel-num", text: `${numFull(st.visitors || 0)} visitors` }),
            el("span", { class: "afa-funnel-label", text: st.label || st.name || st.step || `Step ${i + 1}` }),
            i && st.dropoff ? el("span", { class: "afa-funnel-drop", text: `−${numFull(st.dropoff)} (${pct(st.dropoff_rate)})` }) : null,
          ),
        );
      });
      swap(goalBody, wrap, r.note || (r.notes && r.notes.length) ? el("p", { class: "fine", text: r.note || r.notes.join(" ") }) : null);
    }
    async function drawVisitors(g) {
      const r = await api(project, `${base}/visitors`, q({ limit: 25 }));
      if (g !== goalGen) return;
      const vs = r.visitors || [];
      if (!vs.length) {
        swap(goalBody, empty("No visitors in this period."));
        return;
      }
      const table = el("table", { class: "afa-table" });
      table.append(
        el(
          "thead",
          null,
          el(
            "tr",
            null,
            ["Visitor", "Location", "Device", "Source", "Entry page", "Visits", "Pageviews", "Revenue", "Last seen"].map((h, i) =>
              el("th", { text: h, class: i >= 5 && i <= 7 ? "num" : null }),
            ),
          ),
        ),
      );
      const tb = el("tbody");
      vs.forEach((v, i) => {
        tb.append(
          el(
            "tr",
            { class: "afa-stagger", attrs: { "data-i": i } },
            el(
              "td",
              null,
              el("b", { text: v.name || v.id }),
              v.identified && v.user_id ? el("span", { class: "afa-tag", text: "identified" }) : null,
              v.customer ? el("span", { class: "afa-tag afa-tag-money", text: "customer" }) : null,
            ),
            el(
              "td",
              null,
              el("span", { class: "afa-flag", text: flag(v.country), attrs: { "aria-hidden": "true" } }),
              " ",
              v.city || countryName(v.country),
            ),
            el("td", { text: [cap(v.device), v.browser, v.os].filter(Boolean).join(" · ") }),
            el("td", { text: v.source || v.channel || "Direct" }),
            el("td", { class: "afa-mono", text: v.entry_page || "–" }),
            el("td", { class: "num", text: numFull(v.visits) }),
            el("td", { class: "num", text: numFull(v.pageviews) }),
            el("td", { class: "num", text: money(v.revenue || 0, cur) }),
            el("td", { text: ago(v.last_seen) }),
          ),
        );
      });
      for (const tr of tb.children) tr.style.setProperty("--i", tr.getAttribute("data-i"));
      table.append(tb);
      swap(
        goalBody,
        el("div", { class: "afa-table-wrap" }, table),
        r.identity && r.identity.note ? el("p", { class: "fine", text: r.identity.note }) : null,
      );
    }

    // ----- crawlers -----
    const crawlCard = el("section", { class: "afa-card afa-wide" });
    const crawlTabs = el("div", { class: "afa-tabs", attrs: { role: "tablist" } });
    const crawlBody = el("div", { class: "afa-panel-body" });
    crawlCard.append(
      el(
        "div",
        { class: "afa-panel-head is-stacked" },
        el("h2", { class: "afa-panel-h", text: "All crawlers" }),
        el("span", {
          class: "afa-panel-title",
          text: "Every bot your server reported, day by day: AI answers, AI search, training and search engines",
        }),
      ),
      el("div", { class: "afa-panel-tabs-row" }, crawlTabs),
      crawlBody,
    );
    aiGrid.append(crawlCard); // the AI search panel goes before it (aiGrid.prepend below)
    const CRAWL = [
      ["ai_assistant", "AI answers", SERIES[6]],
      ["ai_search", "AI search", SERIES[0]],
      ["ai_training", "Training", SERIES[1]],
      ["search", "Search engines", SERIES[2]],
    ];
    let crawlCat = "ai_assistant";
    let crawlGen = 0;
    const crawlCounts = {};
    const crawlBtns = CRAWL.map(([k, label]) => {
      crawlCounts[k] = el("span", { class: "afa-tab-count", text: "–" });
      const b = el(
        "button",
        {
          class: "afa-tab",
          attrs: { type: "button", role: "tab", "aria-selected": String(k === crawlCat) },
          on: {
            click: () => {
              crawlCat = k;
              paintCrawlTabs();
              loadCrawlers();
            },
          },
        },
        label,
        crawlCounts[k],
      );
      crawlTabs.append(b);
      return b;
    });
    const crawlSlide = tabSlider(crawlTabs);
    function paintCrawlTabs() {
      crawlBtns.forEach((b, i) => b.setAttribute("aria-selected", String(CRAWL[i][0] === crawlCat)));
      crawlSlide();
    }
    async function loadCrawlers() {
      const g = ++crawlGen;
      busy(
        crawlBody,
        el(
          "div",
          { class: "afa-split", attrs: { "aria-hidden": "true" } },
          SK.chart(240),
          el("div", { class: "afa-split-side" }, SK.rows(5)),
        ),
      );
      try {
        const p = q({});
        delete p.filters;
        delete p.filters_json; // crawler hits aren't visits: page / bot filters only
        const [all, bots] = await Promise.all([
          api(project, `${base}/crawlers`, { ...p, by: "category" }),
          api(project, `${base}/crawlers`, { ...p, by: "bot", category: crawlCat, limit: 10 }),
        ]);
        if (g !== crawlGen) return;
        const by = (all.totals && all.totals.by_category) || {};
        for (const [k] of CRAWL) countTo(crawlCounts[k], by[k] || 0, num);
        crawlSlide();
        if (!all.totals || !all.totals.hits) {
          swap(
            crawlBody,
            empty({
              icon: "bot",
              title: "See which AI bots read your site",
              text: "Bots don't run JavaScript, so the tracker never sees them. Your server can report each bot request in one fire-and-forget call, and they show up here by bot and page, never counted as visitors.",
              chips: [
                ["AI answers", "ChatGPT, Claude and Perplexity fetching a page for a user"],
                ["AI search", "OAI-SearchBot, PerplexityBot, Claude-SearchBot"],
                ["Training", "GPTBot, ClaudeBot, CCBot"],
                ["Search engines", "Googlebot, Bingbot, Applebot"],
              ],
              ask: `Report AI crawler and search bot visits from our server to AgentFirstStack analytics (site ${site.id}). Follow the "AI crawlers" section of https://analytics.agentfirststack.com/llms.txt: only send requests whose user agent matches its prefilter, fire and forget so pages aren't slowed down, then check a hit shows up with GET /v1/sites/${site.id}/crawlers.`,
            }),
          );
          return;
        }
        const series = all.series || [];
        const chart = el("div", { class: "afa-chart" });
        const rows = bots.results || [];
        const maxH = Math.max(1, ...rows.map((x) => x.hits));
        const list = el(
          "ul",
          { class: "afa-rows" },
          rows.map((x, i) => {
            const b = growTo(el("span", { class: "afa-row-bar" }), "width", `${(x.hits / maxH) * 100}%`);
            const li = el(
              "li",
              { class: "afa-stagger" },
              el(
                "div",
                {
                  class: "afa-row afa-row-static",
                  on: {
                    pointermove: (e) =>
                      showTip(
                        e.clientX,
                        e.clientY,
                        el("div", { class: "afa-tip-head", text: x.value }),
                        tipRow("Hits", numFull(x.hits)),
                        tipRow("Pages", numFull(x.pages)),
                        tipRow("Errors (4xx/5xx)", numFull(x.errors)),
                        tipRow("Last seen", x.last_seen ? ago(x.last_seen) : "–"),
                      ),
                    pointerleave: hideTip,
                  },
                },
                el("span", { class: "afa-row-bars", attrs: { "aria-hidden": "true" } }, b),
                el("span", { class: "afa-row-label" }, el("span", { class: "afa-row-text", text: x.value })),
                el("span", { class: "afa-row-val", text: num(x.hits) }),
              ),
            );
            li.style.setProperty("--i", String(i));
            return li;
          }),
        );
        swap(
          crawlBody,
          el(
            "div",
            { class: "afa-split" },
            chart,
            el("div", { class: "afa-split-side" }, rows.length ? list : empty("No bots of this kind in this period.")),
          ),
        );
        linesChart(
          chart,
          series.map((s) => s.date),
          CRAWL.map(([k, label, color]) => ({ name: label, color, values: series.map((s) => s[k] || 0) })),
          { interval: "day", height: 240 },
        );
      } catch (e) {
        if (g !== crawlGen) return;
        swap(crawlBody, errorBox(e, loadCrawlers));
      }
    }

    // ----- AI search and page speed: shared bits -----
    /** A % change chip like the KPI row's (green when it moved the good way). */
    function changeChip(c, lowerIsBetter, title) {
      if (c === null || c === undefined) return el("span", { class: "afa-kpi-ch is-flat", text: " " });
      const good = c === 0 ? null : lowerIsBetter ? c < 0 : c > 0;
      return el(
        "span",
        { class: `afa-kpi-ch ${good === null ? "is-flat" : good ? "is-good" : "is-bad"}`, title },
        `${Math.abs(Math.round(c))}%`,
        c ? el("span", { class: "afa-arrow", text: c > 0 ? "↑" : "↓", attrs: { "aria-label": c > 0 ? "up" : "down" } }) : null,
      );
    }
    const miniKpi = (label, value, ch) =>
      el(
        "div",
        { class: "afa-kpi" },
        el("span", { class: "afa-kpi-label", text: label }),
        el("span", { class: "afa-kpi-num", text: value }),
        ch,
      );
    const subHead = (text) => el("h3", { class: "afa-sub-h", text });
    /** The report ignores the dashboard's filters (it is about the whole site): say so when some are set. */
    const unfiltered = (what) =>
      state.filters.length
        ? el("p", { class: "fine afa-panel-note", text: `Filters don't apply to ${what}: it covers the whole site.` })
        : null;

    // ----- AI search -----
    const AI_COLOR = CHANNEL_COLOR["AI Assistants"];
    const aiCard = el("section", { class: "afa-card afa-wide" });
    const aiBody = el("div", { class: "afa-panel-body" });
    aiCard.append(
      el(
        "div",
        { class: "afa-panel-head is-stacked" },
        el("h2", { class: "afa-panel-h", text: "AI search" }),
        el("span", { class: "afa-panel-title", text: "Visitors that AI assistants send you, and the AI bots that read your pages" }),
      ),
      aiBody,
    );
    aiGrid.prepend(aiCard);
    let aiGen = 0;
    async function loadAiSearch() {
      const g = ++aiGen;
      busy(aiBody, el("div", null, el("div", { class: "afa-kpis", attrs: { "aria-hidden": "true" } }, SK.kpis(5)), splitSkel()));
      try {
        const p = q({ limit: 8, compare: "previous" });
        delete p.filters;
        delete p.filters_json;
        const r = await api(project, `${base}/ai-search`, p);
        if (g !== aiGen) return;
        const v = aiView(r);
        swap(aiBody, v.node);
        if (v.after) v.after();
      } catch (e) {
        if (g !== aiGen) return;
        swap(aiBody, errorBox(e, loadAiSearch));
      }
    }
    /** "1 read", "5 reads". */
    const reads = (n) => `${num(n)} ${n === 1 ? "read" : "reads"}`;
    /** A ranked list with a bar behind each row; label and value are plain text (visitor or bot sent). */
    function shareRows(rows, label, value, valueText, sub) {
      const max = Math.max(1, ...rows.map(value));
      return el(
        "ol",
        { class: "afa-ai-rows" },
        rows.map((x, i) => {
          const fill = growTo(
            el("span", { class: "afa-ai-row-bar", attrs: { "aria-hidden": "true" } }),
            "width",
            `${(value(x) / max) * 100}%`,
          );
          return el(
            "li",
            { class: "afa-stagger", attrs: { "data-i": i, style: `--i:${i}` } },
            fill,
            el(
              "span",
              { class: "afa-ai-row-label" },
              el("span", { class: "afa-mono", text: label(x) }),
              sub && sub(x) ? el("small", { text: sub(x) }) : null,
            ),
            el("b", { text: valueText(x) }),
          );
        }),
      );
    }
    const BOT_KINDS = [
      ["ai_assistant", "AI answers", "fetch a page while answering someone"],
      ["ai_search", "AI search", "index pages to cite in answers"],
      ["ai_training", "Training", "collect text to train models; they send no visitors"],
    ];
    function aiView(r) {
      const s = r.summary || {};
      const ch = (r.comparison && r.comparison.change_percent) || {};
      const vsTitle = r.comparison ? `vs ${rangeLabel(r.comparison.period.from, r.comparison.period.to)}` : null;
      const crawlers = r.crawlers || {};
      const vs = r.vs_other_channels || {};
      const ask = `Improve how AI assistants find, cite and send visitors to ${site.domain}: read GET /v1/sites/${site.id}/ai-search from AgentFirstStack analytics (MCP get_ai_search) and work through its next_steps.`;
      if (!s.ai_visitors && !s.ai_crawler_hits)
        return {
          node: el(
            "div",
            null,
            empty({
              icon: "spark",
              title: "See what AI assistants do with your site",
              text: crawlers.reporting
                ? "No visits from ChatGPT, Perplexity, Claude, Gemini or Copilot in this period, and no AI bot read a page. When they do, this shows where those visitors land and how they convert next to your other channels."
                : "Visits from ChatGPT, Perplexity, Claude, Gemini and Copilot show up here with what those visitors did, next to the AI bots that read your pages. Bots don't run JavaScript, so your server reports them in one fire-and-forget call.",
              ask: crawlers.reporting
                ? ask
                : `Report AI crawler visits from our server to AgentFirstStack analytics (site ${site.id}) following the "AI crawlers" section of https://analytics.agentfirststack.com/llms.txt, then read GET /v1/sites/${site.id}/ai-search and work through its next_steps.`,
            }),
            unfiltered("AI search"),
          ),
        };
      const aiM = vs.ai_assistants || {};
      const oth = vs.all_other_channels || {};
      const totals = crawlers.totals || {};
      const hasVisitors = s.ai_visitors > 0;
      const allVisitors = (aiM.visitors || 0) + (oth.visitors || 0);
      const pagesRead = s.ai_crawled_pages || totals.pages || 0;
      const botCount = s.ai_bots || totals.bots || 0;
      const quiet = (text) => el("span", { class: "afa-kpi-ch is-flat", text });
      const section = (title, ...kids) =>
        el("section", { class: "afa-ai-section" }, el("h3", { class: "afa-ai-section-h", text: title }), ...kids);

      // 1. From read to visit to conversion: the three steps this view is about.
      const stage = (n, label, value, sub) =>
        el(
          "div",
          { class: "afa-ai-stage" },
          el("span", { class: "afa-ai-stage-label" }, el("span", { class: "afa-ai-stage-n", text: String(n) }), label),
          el("span", { class: "afa-kpi-num", text: value }),
          sub,
        );
      const funnel = el(
        "div",
        { class: "afa-ai-funnel" },
        stage(
          1,
          "Read by AI bots",
          `${num(pagesRead)} ${pagesRead === 1 ? "page" : "pages"}`,
          crawlers.reporting
            ? quiet(`${reads(s.ai_crawler_hits || 0)} by ${num(botCount)} ${botCount === 1 ? "bot" : "bots"}`)
            : quiet("not reported"),
        ),
        stage(
          2,
          "Visitors from AI",
          num(s.ai_visitors),
          hasVisitors
            ? el(
                "span",
                { class: "afa-ai-sub" },
                quiet(`${pct(s.share_of_visitors)} of ${num(allVisitors)} visitors`),
                changeChip(ch.ai_visitors, false, vsTitle),
              )
            : quiet(`none of ${num(allVisitors)} visitors yet`),
        ),
        stage(3, "Converted", hasVisitors ? pct(s.ai_conversion_rate) : "–", quiet(`other channels ${pct(oth.conversion_rate || 0)}`)),
        s.ai_revenue || ch.ai_revenue
          ? stage(4, "Revenue from AI", money(s.ai_revenue, cur), changeChip(ch.ai_revenue, false, vsTitle))
          : null,
      );
      funnel.style.setProperty("--n", String(funnel.children.length));

      // 2. What AI bots read: the pages, who reads them, and the files that point bots around.
      const gaps = r.gaps || {};
      const unread = gaps.crawled_not_referred || [];
      const readPages = hasVisitors ? unread : (crawlers.top_pages || []).length ? crawlers.top_pages : unread;
      const pageList = el(
        "div",
        null,
        el("h4", { class: "afa-ai-h4", text: hasVisitors ? "Read, but no AI visitors landed there yet" : "Pages they read most" }),
        readPages.length
          ? shareRows(
              readPages.slice(0, 8),
              (x) => x.page,
              (x) => x.hits ?? x.ai_crawler_hits ?? 0,
              (x) => reads(x.hits ?? x.ai_crawler_hits ?? 0),
              (x) => (x.operators || []).slice(0, 3).join(", "),
            )
          : el("p", {
              class: "muted small",
              text: hasVisitors
                ? "Every page AI bots read also got AI visitors."
                : crawlers.reporting
                  ? "No AI bot read a page in this period."
                  : "Needs crawler hits from your server.",
            }),
      );
      const byKind = totals.by_category || {};
      const kindTotal = BOT_KINDS.reduce((n, [k]) => n + (byKind[k] || 0), 0);
      const kindColor = { ai_assistant: SERIES[6], ai_search: SERIES[0], ai_training: SERIES[1] };
      const kinds = kindTotal
        ? el(
            "div",
            null,
            el("h4", { class: "afa-ai-h4", text: "Who reads them" }),
            el(
              "div",
              {
                class: "afa-ai-stack",
                attrs: { role: "img", "aria-label": BOT_KINDS.map(([k, l]) => `${l}: ${reads(byKind[k] || 0)}`).join(", ") },
              },
              BOT_KINDS.filter(([k]) => byKind[k]).map(([k]) => {
                const seg = el("span");
                seg.style.flexGrow = String(byKind[k]);
                seg.style.background = kindColor[k];
                return seg;
              }),
            ),
            el(
              "ul",
              { class: "afa-ai-kind-list" },
              BOT_KINDS.map(([k, l, what]) =>
                el(
                  "li",
                  null,
                  swatchOf(kindColor[k]),
                  el("span", null, el("b", { text: l }), el("small", { text: what })),
                  el("span", { class: "afa-ai-kind-n", text: reads(byKind[k] || 0) }),
                ),
              ),
            ),
          )
        : null;
      const files = (crawlers.discovery_files || []).filter((f) => f.path);
      const fileList = files.length
        ? el(
            "div",
            null,
            el("h4", { class: "afa-ai-h4", text: "Files that guide them" }),
            el(
              "ul",
              { class: "afa-ai-files" },
              files.map((f) => {
                const state = f.errors
                  ? ["is-bad", `${num(f.errors)} failed`]
                  : f.hits
                    ? ["is-good", reads(f.hits)]
                    : ["is-none", "not read"];
                return el(
                  "li",
                  null,
                  el("span", { class: "afa-mono", text: f.path }),
                  el("span", { class: `afa-ai-file-state ${state[0]}`, text: state[1] }),
                );
              }),
            ),
          )
        : null;
      const readSection = section(
        "What AI bots read",
        el("div", { class: "afa-ai-two" }, pageList, el("div", { class: "afa-ai-side" }, kinds, fileList)),
      );

      // 3. Who arrived from AI assistants.
      const chart = el("div", { class: "afa-chart" });
      const sources = ((r.referrals && r.referrals.sources) || []).map((x) => ({ ...x, value: x.source }));
      const landed = ((r.referrals && r.referrals.landing_pages) || []).map((x) => ({ ...x, value: x.page }));
      const measures = [
        ["Conversion rate", "conversion_rate", pct],
        ["Engaged visits", "engagement_rate", pct],
        ["Pages per visit", "views_per_visit", (n) => (n === null || n === undefined ? "–" : n.toFixed(1))],
        ["Revenue per visitor", "revenue_per_visitor", (n) => money(n, cur)],
        ["Bounce rate", "bounce_rate", pct],
      ].filter(([, k]) => k !== "revenue_per_visitor" || aiM[k] || oth[k]);
      const pair = el(
        "div",
        { class: "afa-vs" },
        el(
          "div",
          { class: "afa-vs-legend" },
          el("span", null, swatchOf(AI_COLOR), "AI assistants"),
          el("span", null, swatchOf(PREVIOUS), "All other channels"),
        ),
        measures.map(([label, k, f]) => {
          const a = aiM[k] || 0;
          const b = oth[k] || 0;
          const max = Math.max(a, b) || 1;
          const line = (v, color, strong) => {
            const fill = growTo(el("span", { class: "afa-vs-fill" }), "width", `${(v / max) * 100}%`);
            fill.style.background = color;
            return el(
              "span",
              { class: "afa-vs-line" },
              el("span", { class: "afa-vs-track" }, fill),
              el(strong ? "b" : "span", { text: f(v) }),
            );
          };
          return el(
            "div",
            { class: "afa-vs-row" },
            el("span", { class: "afa-vs-label", text: label }),
            line(a, AI_COLOR, true),
            line(b, PREVIOUS, false),
          );
        }),
        vs.enough_data ? null : el("p", { class: "fine", text: "Fewer than 30 visitors on one side: read these as rough." }),
      );
      const visitSection = hasVisitors
        ? section(
            "Who arrived from AI assistants",
            el(
              "div",
              { class: "afa-split" },
              chart,
              el(
                "div",
                { class: "afa-split-side" },
                el("h4", { class: "afa-ai-h4", text: "Assistants that sent them" }),
                sources.length
                  ? barRows("source", sources, "visitors", s.ai_visitors, (x) => pickFilter("source", x))
                  : el("p", { class: "muted small", text: "Not known for these visits." }),
              ),
            ),
            el(
              "div",
              { class: "afa-ai-two" },
              el(
                "div",
                null,
                el("h4", { class: "afa-ai-h4", text: "Pages they landed on" }),
                landed.length
                  ? barRows("entry_page", landed, "visitors", s.ai_visitors, (x) => pickFilter("entry_page", x))
                  : el("p", { class: "muted small", text: "No landings yet." }),
              ),
              el("div", null, el("h4", { class: "afa-ai-h4", text: "Next to your other channels" }), pair),
            ),
          )
        : section(
            "Who arrived from AI assistants",
            el("p", {
              class: "afa-ai-none",
              text: "No one has arrived from ChatGPT, Perplexity, Claude, Gemini or Copilot in this period. When they do, this shows the assistants, the pages they landed on and how they convert next to your other channels.",
            }),
          );

      // 4. What to change, from the report's next steps.
      const steps = (r.next_steps || []).slice(0, 4);
      const changeSection = steps.length
        ? section(
            "What to change",
            el(
              "ul",
              { class: "afa-ai-step-list" },
              steps.map((t) => el("li", { text: t })),
            ),
          )
        : null;
      // The prompt for the agent sits to the right of the sections it acts on: next to "Who arrived"
      // and "What to change" while no one has, next to "What to change" once the visitors' chart
      // needs the full width.
      const askNode = changeSection ? askCard(ask) : null;
      if (askNode)
        askNode.insertBefore(
          el("p", {
            class: "afa-askcard-hint",
            text: "Paste it into Claude Code, Cursor or Codex: your agent reads the full report and works through these changes for you.",
          }),
          askNode.lastChild,
        );
      const side = askNode ? el("aside", { class: "afa-ai-ask" }, askNode) : null;
      const left = hasVisitors ? [changeSection] : [visitSection, changeSection];
      const bottom = el(
        "div",
        { class: `afa-ai-bottom${side ? "" : " is-single"}` },
        el("div", { class: "afa-ai-bottom-main" }, left),
        side,
      );

      return {
        node: el("div", { class: "afa-ai" }, funnel, readSection, hasVisitors ? visitSection : null, bottom, unfiltered("AI search")),
        after: () => {
          if (!hasVisitors) return;
          const series = r.series || [];
          linesChart(
            chart,
            series.map((x) => x.date),
            [{ name: "Visitors from AI", color: AI_COLOR, values: series.map((x) => x.ai_visitors || 0) }],
            { interval: "day", height: 220 },
          );
        },
      };
    }
    function swatchOf(color) {
      const sw = el("span", { class: "afa-sw", attrs: { "aria-hidden": "true" } });
      sw.style.background = color;
      return sw;
    }

    // ----- page speed (Core Web Vitals) -----
    // Status colours (good / needs improvement / poor), kept apart from the categorical series and
    // always shown with a shape and a word: circle, square, triangle, as Lighthouse does.
    const RATING = {
      good: { label: "Good", color: "#0ca30c", shape: "●" },
      needs_improvement: { label: "Needs improvement", color: "#fab219", shape: "■" },
      poor: { label: "Poor", color: "#d03b3b", shape: "▲" },
    };
    const VITALS = [
      ["lcp", "LCP", "Largest Contentful Paint", "How long the main content takes to show"],
      ["inp", "INP", "Interaction to Next Paint", "How fast the page answers a tap or click"],
      ["cls", "CLS", "Cumulative Layout Shift", "How much the layout jumps while loading"],
    ];
    const fmtVital = (m, v) => {
      if (v === null || v === undefined) return "–";
      if (m === "cls") return v.toFixed(2);
      if (m === "lcp" && v >= 1000) return `${(v / 1000).toFixed(1)} s`;
      return `${Math.round(v)} ms`;
    };
    const ratingTag = (rating) => {
      const r = RATING[rating];
      if (!r) return el("span", { class: "afa-rating is-none", text: "No data" });
      const shape = el("span", { class: "afa-rating-shape", text: r.shape, attrs: { "aria-hidden": "true" } });
      shape.style.color = r.color;
      return el("span", { class: "afa-rating" }, shape, r.label);
    };
    const vitalsCard = el("section", { class: "afa-card afa-wide" });
    const vitalsTabs = el("div", { class: "afa-tabs", attrs: { role: "tablist" } });
    const vitalsBody = el("div", { class: "afa-panel-body" });
    vitalsCard.append(
      el(
        "div",
        { class: "afa-panel-head is-stacked" },
        el("h2", { class: "afa-panel-h", text: "Page speed" }),
        el("span", {
          class: "afa-panel-title",
          text: "How fast your pages are for real visitors (Core Web Vitals), by page, device, country or browser",
        }),
      ),
      el("div", { class: "afa-panel-tabs-row" }, vitalsTabs),
      vitalsBody,
    );
    speedGrid.append(vitalsCard);
    const VITAL_TABS = [
      ["page", "Page"],
      ["device", "Device"],
      ["country", "Country"],
      ["browser", "Browser"],
    ];
    let vitalsDim = "page";
    let vitalsGen = 0;
    const vitalsBtns = VITAL_TABS.map(([k, label]) => {
      const b = el("button", {
        class: "afa-tab",
        text: label,
        attrs: { type: "button", role: "tab" },
        on: {
          click: () => {
            vitalsDim = k;
            paintVitalsTabs();
            loadVitals();
          },
        },
      });
      vitalsTabs.append(b);
      return b;
    });
    const vitalsSlide = tabSlider(vitalsTabs);
    function paintVitalsTabs() {
      vitalsBtns.forEach((b, i) => b.setAttribute("aria-selected", String(VITAL_TABS[i][0] === vitalsDim)));
      vitalsSlide();
    }
    paintVitalsTabs();
    async function loadVitals() {
      const g = ++vitalsGen;
      busy(vitalsBody, el("div", null, el("div", { class: "afa-vitals", attrs: { "aria-hidden": "true" } }, SK.kpis(3)), SK.table(6)));
      try {
        const r = await api(
          project,
          `${base}/web-vitals`,
          q({ breakdown: vitalsDim, limit: 15, ...(state.compare ? { compare: "previous" } : {}) }),
        );
        if (g !== vitalsGen) return;
        swap(vitalsBody, vitalsView(r));
      } catch (e) {
        if (g !== vitalsGen) return;
        swap(vitalsBody, errorBox(e, loadVitals));
      }
    }
    function vitalsView(r) {
      if (!r.page_loads)
        return empty({
          icon: "bulb",
          title: "Page speed, as your visitors see it",
          text:
            (r.coverage && r.coverage.pageviews) || totals.visitors
              ? "None of this period's pageviews carried Web Vitals yet. The tracker sends LCP, INP and CLS when a visitor leaves a page; browsers without the Performance APIs send none."
              : "LCP, INP and CLS arrive with the tracker's beacon when a visitor leaves a page, rated by Google's thresholds. Install the tracker and they start coming in.",
          ask: `Check page speed for ${site.domain}: read GET /v1/sites/${site.id}/web-vitals from AgentFirstStack analytics (MCP get_web_vitals) and tell me which pages fail Core Web Vitals and why.`,
        });
      const ch = (r.comparison && r.comparison.change_percent) || {};
      const vsTitle = r.comparison ? `vs ${rangeLabel(r.comparison.period.from, r.comparison.period.to)}` : null;
      const ASSESS = {
        passed: ["good", "Passes Core Web Vitals"],
        failed: ["poor", "Fails Core Web Vitals"],
        not_enough_data: [null, "Not enough page loads to assess yet"],
      };
      const [aRating, aText] = ASSESS[r.assessment] || ASSESS.not_enough_data;
      const head = el(
        "p",
        { class: "afa-vitals-assess" },
        aRating ? el("span", { class: "afa-rating-shape", text: RATING[aRating].shape, attrs: { "aria-hidden": "true" } }) : null,
        el("b", { text: aText }),
        el("span", { class: "muted", text: ` · p75 of ${numFull(r.page_loads)} page loads (Google's method)` }),
      );
      if (aRating) head.firstChild.style.color = RATING[aRating].color;
      const tiles = el(
        "div",
        { class: "afa-vitals" },
        VITALS.map(([k, short, name, what]) => {
          const m = (r.metrics && r.metrics[k]) || {};
          const dist = el("div", {
            class: "afa-dist",
            attrs: {
              role: "img",
              "aria-label": `${m.good || 0}% good, ${m.needs_improvement || 0}% needs improvement, ${m.poor || 0}% poor`,
            },
          });
          for (const band of ["good", "needs_improvement", "poor"]) {
            const share = m[band] || 0;
            if (!share) continue;
            const seg = growTo(el("span", { class: "afa-dist-seg" }), "width", `${share}%`);
            seg.style.background = RATING[band].color;
            dist.append(seg);
          }
          return el(
            "div",
            {
              class: "afa-vital",
              on: {
                pointermove: (e) =>
                  showTip(
                    e.clientX,
                    e.clientY,
                    el("div", { class: "afa-tip-head", text: name }),
                    swatchRow(RATING.good.color, "Good", pct(m.good || 0)),
                    swatchRow(RATING.needs_improvement.color, "Needs improvement", pct(m.needs_improvement || 0)),
                    swatchRow(RATING.poor.color, "Poor", pct(m.poor || 0)),
                    el("div", { class: "afa-tip-sep" }),
                    tipRow("Page loads", numFull(m.samples || 0)),
                    el("div", { class: "afa-tip-note", text: what }),
                  ),
                pointerleave: hideTip,
              },
            },
            el("span", { class: "afa-kpi-label" }, el("b", { text: short }), name),
            el("span", { class: "afa-vital-row" }, el("span", { class: "afa-kpi-num", text: fmtVital(k, m.p75) }), ratingTag(m.rating)),
            dist,
            el("span", {
              class: "afa-dist-text",
              text: `${pct(m.good || 0)} good · ${pct(m.needs_improvement || 0)} needs improvement · ${pct(m.poor || 0)} poor`,
            }),
            el(
              "span",
              { class: "afa-vital-foot" },
              `${numFull(m.samples || 0)} page loads`,
              m.samples && !m.enough_samples
                ? el("span", { class: "afa-tag", text: "too few to trust", title: "Under 30 page loads: the p75 can swing a lot." })
                : null,
              r.comparison ? changeChip(ch[`${k}_p75`], true, vsTitle) : null,
            ),
          );
        }),
      );
      const rows = r.results || [];
      const dimLabel = (VITAL_TABS.find(([k]) => k === vitalsDim) || [0, "Value"])[1];
      const cell = (x, k) => {
        const m = x[k] || {};
        if (m.p75 === null || m.p75 === undefined) return el("td", { class: "num muted", text: "–" });
        const rt = RATING[m.rating];
        const shape = el("span", { class: "afa-rating-shape", text: rt ? rt.shape : "", attrs: { "aria-hidden": "true" } });
        if (rt) shape.style.color = rt.color;
        return el(
          "td",
          {
            class: "num",
            title: `${rt ? rt.label : ""} · ${numFull(m.samples)} page loads${m.enough_samples ? "" : " (too few to trust)"}`,
          },
          shape,
          " ",
          el("span", { class: m.enough_samples ? null : "muted", text: fmtVital(k, m.p75) }),
        );
      };
      const label = (x) =>
        vitalsDim === "country" ? `${flag(x.value)} ${countryName(x.value)}` : vitalsDim === "device" ? cap(x.value) : x.value;
      const table = el(
        "table",
        { class: "afa-table" },
        el(
          "thead",
          null,
          el(
            "tr",
            null,
            el("th", { text: dimLabel }),
            el("th", { class: "num", text: "Page loads" }),
            VITALS.map(([, short]) => el("th", { class: "num", text: `${short} p75` })),
          ),
        ),
        el(
          "tbody",
          null,
          rows.map((x, i) => {
            const tr = el(
              "tr",
              { class: "afa-stagger" },
              el(
                "td",
                null,
                el(
                  "span",
                  { class: `afa-row-label${vitalsDim === "page" ? " afa-mono" : ""}` },
                  el("span", { class: "afa-row-text", text: label(x) }),
                ),
              ),
              el("td", { class: "num", text: numFull(x.page_loads) }),
              VITALS.map(([k]) => cell(x, k)),
            );
            tr.style.setProperty("--i", String(i));
            return tr;
          }),
        ),
      );
      const worst = (r.worst_pages || []).slice(0, 3);
      const short = (k) => (VITALS.find((v) => v[0] === k) || [k, k])[1];
      return el(
        "div",
        null,
        head,
        tiles,
        worst.length
          ? el(
              "p",
              { class: "afa-vitals-worst" },
              el("b", { text: "Slowest pages: " }),
              worst.map((w, i) => [
                i ? ", " : "",
                el("span", { class: "afa-mono", text: w.page }),
                ` (${short(w.worst_metric)} ${fmtVital(w.worst_metric, w[w.worst_metric].p75)})`,
              ]),
            )
          : null,
        rows.length ? el("div", { class: "afa-table-wrap" }, table) : empty("No page loads with vitals for this breakdown."),
        el("p", {
          class: "fine",
          text: "p75 = 75% of page loads were at least this fast. Good: LCP up to 2.5 s, INP up to 200 ms, CLS up to 0.1. INP is recorded only for interactions slower than 40 ms, so read it as an upper bound.",
        }),
        r.assessment === "failed"
          ? askCard(
              `Make ${site.domain} pass Core Web Vitals: read GET /v1/sites/${site.id}/web-vitals?breakdown=page (MCP get_web_vitals), run a lab test on the slowest page with GET /v1/sites/${site.id}/web-vitals/lab, and fix what it finds.`,
            )
          : null,
      );
    }

    // ----- dock: live view and insights -----
    const dock = buildDock();
    function buildDock() {
      const liveBtn = el(
        "button",
        { class: "afa-dock-btn", attrs: { type: "button" } },
        el("span", { class: "afa-live-dot", attrs: { "aria-hidden": "true" } }),
        el("span", { class: "afa-dock-live", text: "Live" }),
      );
      const insBtn = el("button", { class: "afa-dock-btn", attrs: { type: "button" } }, icon("bulb"), el("span", { text: "Insights" }));
      const d = el("nav", { class: "afa-dock", attrs: { "aria-label": "More views" } }, liveBtn, insBtn);
      ctx.attach(d);
      let sheet = null;
      let timer = null;
      const names = new Map();
      // Built once per opening; each poll counts the numbers and slides new activity in on top.
      let live = null;
      const evKey = (ev) => `${ev.ts}|${ev.visitor_id}|${ev.name}|${ev.pathname}`;
      function feedItem(ev) {
        const who = names.get(ev.visitor_id) || `Visitor ${String(ev.visitor_id || "").slice(0, 4)}`;
        const where = ev.city || countryName(ev.country);
        const time = el("span", { class: "afa-feed-time", text: ago(ev.ts) });
        const li = el(
          "li",
          null,
          el("span", { class: "afa-feed-icon", text: ev.name === "pageview" ? "◉" : "◆", attrs: { "aria-hidden": "true" } }),
          el(
            "span",
            null,
            el("b", { text: who }),
            where
              ? [" from ", el("span", { class: "afa-flag", text: flag(ev.country), attrs: { "aria-hidden": "true" } }), " ", where]
              : null,
            ev.name === "pageview" ? " viewed " : " did ",
            el("code", { text: ev.name === "pageview" ? ev.pathname || "/" : ev.name }),
            time,
          ),
        );
        li._key = evKey(ev);
        li._ts = ev.ts;
        li._time = time;
        return li;
      }
      function buildLive() {
        const big = el("b", { text: "0" });
        const word = el("span");
        const summary = el("p", { class: "muted small" });
        const groups = el("div", { class: "afa-live-groups" });
        const feed = el("ol", { class: "afa-feed" });
        const quiet = el("p", { class: "muted small", text: "Nothing yet. This updates every 10 seconds." });
        const node = el(
          "div",
          { class: "afa-live" },
          el("p", { class: "afa-live-big" }, el("span", { class: "afa-live-dot", attrs: { "aria-hidden": "true" } }), big, word),
          summary,
          groups,
          el("span", { class: "afa-menu-label", text: "Recent activity" }),
          feed,
          quiet,
        );
        return { node, big, word, summary, groups, feed, quiet };
      }
      async function paintLive(body) {
        try {
          const [rt, vs] = await Promise.all([
            api(project, `${base}/realtime`, {}),
            names.size ? null : api(project, `${base}/visitors`, { period: "today", limit: 100 }).catch(() => null),
          ]);
          if (!sheet) return;
          if (vs) for (const v of vs.visitors || []) names.set(v.visitor_id, v.name);
          const now = rt.online ?? rt.visitors_last_5m;
          ONLINE.value = now;
          setOnline(now);
          if (kpiTiles) countTo(kpiTiles.online, ONLINE.value, (v) => numFull(v));
          paintTitle();
          const first = !live;
          if (first) {
            live = buildLive();
            swap(body, live.node);
          }
          countTo(live.big, now, numFull);
          live.word.textContent = ` ${now === 1 ? "visitor" : "visitors"} on ${site.domain}`;
          live.summary.textContent = `Last 30 minutes: ${numFull(rt.visitors_last_30m)} visitors, ${numFull(rt.pageviews_last_30m)} pageviews.`;
          const group = (title, rows, dim) =>
            el(
              "div",
              { class: "afa-live-group" },
              el("span", { class: "afa-menu-label", text: title }),
              rows.length
                ? el(
                    "div",
                    { class: "afa-pills" },
                    rows
                      .slice(0, 6)
                      .map((x) =>
                        el(
                          "span",
                          { class: "afa-pill" },
                          dim === "country" ? `${flag(x.value)} ${countryName(x.value)}` : shownValue(dim, x),
                          el("b", { text: ` ${x.visitors}` }),
                        ),
                      ),
                  )
                : el("span", { class: "muted small", text: "None" }),
            );
          const groupsNow = [
            group("Sources", rt.top_sources_last_30m || [], "source"),
            group("Countries", rt.top_countries_last_30m || [], "country"),
            group("Pages", rt.top_pages_last_30m || [], "page"),
          ];
          const sig = JSON.stringify([rt.top_sources_last_30m, rt.top_countries_last_30m, rt.top_pages_last_30m]);
          if (live.groups._sig !== sig) {
            live.groups._sig = sig;
            clear(live.groups);
            add(live.groups, groupsNow);
            if (!first) enter(live.groups);
          }
          // New activity slides in on top; the rest just gets its "ago" refreshed.
          const have = new Set([...live.feed.children].map((li) => li._key));
          const fresh = (rt.recent_events || []).slice(0, 30).filter((ev) => !have.has(evKey(ev)));
          for (const ev of fresh.reverse()) {
            const li = feedItem(ev);
            if (!first) li.classList.add("afa-feed-new");
            live.feed.prepend(li);
          }
          while (live.feed.children.length > 30) live.feed.lastChild.remove();
          for (const li of live.feed.children) li._time.textContent = ago(li._ts);
          live.quiet.hidden = live.feed.children.length > 0;
        } catch (e) {
          if (!live) swap(body, errorBox(e));
        }
      }
      function openLive() {
        if (sheet) return;
        const body = el(
          "div",
          { class: "afa-sheet-body" },
          el(
            "div",
            { attrs: { "aria-hidden": "true" }, class: "afa-live-skel" },
            bone(220, 30),
            bone(260, 12),
            bone("100%", 52),
            bone("100%", 52),
            SK.rows(5),
          ),
        );
        sheet = el(
          "aside",
          { class: "afa-sheet", attrs: { "aria-label": "Live visitors", role: "dialog" } },
          el(
            "div",
            { class: "afa-dialog-head" },
            el("h2", { text: "Live" }),
            el(
              "button",
              { class: "afa-btn afa-icon-btn", attrs: { type: "button", "aria-label": "Close the live view" }, on: { click: closeLive } },
              icon("x"),
            ),
          ),
          body,
        );
        live = null;
        document.body.append(sheet);
        liveBtn.setAttribute("aria-expanded", "true");
        paintLive(body);
        timer = setInterval(() => paintLive(body), 10000);
        sheet.querySelector("button").focus();
      }
      function closeLive(quiet) {
        if (!sheet) return;
        clearInterval(timer);
        const old = sheet;
        sheet = null;
        live = null;
        if (reduced()) old.remove();
        else {
          old.classList.add("is-closing");
          setTimeout(() => old.remove(), 200);
        }
        liveBtn.setAttribute("aria-expanded", "false");
        if (quiet !== true) liveBtn.focus();
      }
      ctx.listen(document, "keydown", (e) => {
        if (e.key === "Escape" && sheet) closeLive();
      });
      ctx.onHide(() => closeLive(true));
      liveBtn.addEventListener("click", () => (sheet ? closeLive() : openLive()));
      ctx.cleanups.push(() => closeLive(true));
      insBtn.addEventListener("click", openInsights);
      function setOnline(n) {
        liveBtn.querySelector(".afa-dock-live").textContent = n === null || n === undefined ? "Live" : `${numFull(n)} online`;
      }
      return { setOnline, openLive };
    }

    async function openInsights() {
      const dlg = el("dialog", { class: "afa-dialog afa-insights", attrs: { "aria-label": "Insights" } });
      const goalSel = el(
        "select",
        { class: "afa-select", attrs: { "aria-label": "What counts as converting" } },
        el("option", { text: "Converting = a purchase", attrs: { value: "" } }),
      );
      const insSkel = () =>
        el(
          "div",
          { class: "afa-ins-grid", attrs: { "aria-hidden": "true" } },
          Array.from({ length: 8 }, (_, i) =>
            el(
              "div",
              { class: `afa-ins afa-ins-skel${i === 4 || i === 5 ? " afa-ins-wide" : ""}` },
              bone(110, 12),
              bone(80, 34),
              bone("70%", 12),
            ),
          ),
        );
      const body = el("div", { class: "afa-dialog-body" }, insSkel());
      dlg.append(
        el(
          "div",
          { class: "afa-dialog-head" },
          el(
            "h2",
            null,
            "Insights ",
            el("span", {
              class: "muted",
              text: `· ${site.domain} · ${state.period ? presetLabel(state.period) : rangeLabel(state.from, state.to)}`,
            }),
          ),
          goalSel,
          el(
            "button",
            { class: "afa-btn afa-icon-btn", attrs: { type: "button", "aria-label": "Close" }, on: { click: () => closeDialog(dlg) } },
            icon("x"),
          ),
        ),
        body,
      );
      openDialog(dlg);
      try {
        const gl = await api(project, `${base}/goals`, {});
        for (const x of gl.goals || []) goalSel.append(el("option", { text: `Converting = ${x.name}`, attrs: { value: x.name } }));
        // No revenue in this period: start from the goal completed most, not an empty purchase view.
        if (lastRevenue === 0 && (gl.goals || []).length) {
          const top = await api(project, `${base}/breakdown`, q({ breakdown: "goal", sort: "conversions", limit: 1 })).catch(() => null);
          const best = top && top.results && top.results[0];
          goalSel.value = best && best.conversions ? best.value : gl.goals[0].name;
        }
      } catch {
        /* purchases only */
      }
      let mine = 0;
      const paint = async () => {
        const g = ++mine;
        busy(body, insSkel());
        try {
          const goal = goalSel.value;
          const r = await api(project, `${base}/insights`, q(goal ? { goal } : {}));
          if (g !== mine) return;
          const grid = insightsGrid(r, goal);
          swap(body, grid);
          [...grid.children].forEach((c, i) => enter(c, i));
        } catch (e) {
          if (g !== mine) return;
          swap(body, errorBox(e, paint));
        }
      };
      goalSel.addEventListener("change", paint);
      paint();
    }
    function insightsGrid(r, goal) {
      const k = r.kpis || {};
      const conv = goal ? "complete it" : "buy";
      const g = el("div", { class: "afa-ins-grid" });
      const card = (cls, ...kids) => el("div", { class: `afa-ins ${cls || ""}` }, ...kids);
      /** A big number that counts up (value + format), or a fixed string. */
      const big = (v, fmt, label) => {
        const b = el("b");
        if (typeof v === "number" && fmt) countTo(b, v, fmt, 900);
        else b.textContent = v === null || v === undefined ? "–" : String(fmt ? fmt(v) : v);
        return el("div", { class: "afa-ins-big" }, b, el("span", { text: label }));
      };
      g.append(
        card(
          "afa-ins-pair",
          big(k.avg_daily_visitors, num, "visitors a day, on average"),
          goal
            ? big(k.converters, numFull, `visitors completed ${goal}`)
            : big(k.avg_daily_revenue, (v) => money(v, cur), "revenue a day, on average"),
        ),
      );
      g.append(card("", big(k.conversion_rate, pct, goal ? `of visitors completed ${goal}` : "of visitors bought")));
      const ttc = r.time_to_convert || {};
      g.append(card("", big(hours(ttc.median_hours), null, `median time to ${conv}`)));
      // revenue share
      const shares = r.revenue_share || {};
      const shareCard = (dim, label) => {
        const rows = shares[dim] || [];
        if (!rows.length)
          return card(
            "afa-ins-share",
            el("span", { class: "afa-menu-label", text: `Revenue by ${label}` }),
            el("p", { class: "muted small", text: "No revenue in this period." }),
          );
        const top = rows[0];
        return card(
          "afa-ins-share",
          el("span", { class: "afa-menu-label", text: `Revenue by ${label}` }),
          el(
            "p",
            { class: "afa-ins-line" },
            el("b", { text: `${pct(top.share)} ` }),
            `from ${dim === "device" ? cap(top.value) : top.value} (${money(top.revenue, cur)})`,
          ),
          el("p", {
            class: "muted small",
            text: rows
              .slice(1, 3)
              .map((x) => `${pct(x.share)} ${dim === "device" ? cap(x.value) : x.value}`)
              .join(", "),
          }),
        );
      };
      g.append(shareCard("device", "device"), shareCard("os", "OS"), shareCard("browser", "browser"));
      const ranked = (title, data, label) => {
        const cols = el("div", { class: "afa-ins-cols" });
        const col = (head, rows, f) =>
          el(
            "div",
            null,
            el("span", { class: "afa-menu-label", text: head }),
            rows.length
              ? el(
                  "ol",
                  { class: "afa-ins-list" },
                  rows.map((x) => el("li", null, el("span", { text: label(x.value) }), el("b", { text: f(x) }))),
                )
              : el("p", { class: "muted small", text: "Not enough data." }),
          );
        cols.append(
          col(`Top ${title} by revenue`, (data && data.by_revenue) || [], (x) => money(x.revenue, cur)),
          col(`Top ${title} by conversion rate`, (data && data.by_conversion_rate) || [], (x) => pct(x.conversion_rate)),
        );
        return card("afa-ins-wide", cols);
      };
      g.append(
        ranked("sources", r.top_sources, (v) => (v === "(none)" ? "Direct" : v)),
        ranked("countries", r.top_countries, (v) => `${flag(v)} ${countryName(v)}`),
      );
      const hist = (title, rows) => {
        const max = Math.max(1, ...rows.map((x) => x.count));
        return card(
          "afa-ins-hist",
          el("span", { class: "afa-menu-label", text: title }),
          el(
            "div",
            { class: "afa-hist" },
            rows.map((x) => {
              const b = growTo(el("span", { class: "afa-hist-bar" }), "height", `${Math.max(x.count ? 4 : 1, (x.count / max) * 100)}%`);
              return el(
                "div",
                { class: "afa-hist-col", title: `${x.label}: ${numFull(x.count)} (${pct(x.share)})` },
                el("span", { class: "afa-hist-track" }, b),
                el("span", { class: "afa-hist-label", text: x.label }),
              );
            }),
          ),
        );
      };
      g.append(hist(`Days to ${conv}`, ttc.days_histogram || []), hist(`Visits to ${conv}`, ttc.visits_histogram || []));
      g.append(card("", big(ttc.first_visit_rate, pct, `${conv === "buy" ? "of buyers buy" : "complete it"} on their first visit`)));
      const evs = r.top_converting_events || [];
      g.append(
        card(
          "afa-ins-wide",
          el("span", { class: "afa-menu-label", text: "Events whose visitors convert most" }),
          evs.length
            ? el(
                "ol",
                { class: "afa-ins-list" },
                evs
                  .slice(0, 6)
                  .map((x) =>
                    el(
                      "li",
                      null,
                      el("code", { text: x.event }),
                      el("b", { text: `${pct(x.conversion_rate)}${x.lift ? ` · ${x.lift}× the average` : ""}` }),
                    ),
                  ),
              )
            : el("p", { class: "muted small", text: "Not enough conversions to compare events." }),
        ),
      );
      // heatmap
      const hm = r.heatmap;
      if (hm && hm.values) {
        const max = Math.max(1, ...hm.values.flat());
        const t = el("div", { class: "afa-heat", attrs: { role: "table", "aria-label": `Visitors by weekday and hour (${hm.timezone})` } });
        t.append(el("span", { class: "afa-heat-corner" }), ...hm.days.map((d) => el("span", { class: "afa-heat-day", text: d })));
        hm.hours.forEach((h, hi) => {
          t.append(el("span", { class: "afa-heat-hour", text: hi % 3 === 0 ? `${String(h).padStart(2, "0")}h` : "" }));
          hm.days.forEach((d, di) => {
            const v = hm.values[di][hi] || 0;
            const c = el("span", { class: "afa-heat-cell", title: `${d} ${String(h).padStart(2, "0")}:00 · ${numFull(v)} visitors` });
            c.style.background = v ? `rgba(255, 106, 43, ${0.12 + 0.88 * (v / max)})` : "";
            c.style.setProperty("--i", String(di + hi * 0.35)); // a wave from the top left
            t.append(c);
          });
        });
        g.append(card("afa-ins-heat", el("span", { class: "afa-menu-label", text: `When visitors come (${hm.timezone})` }), t));
      }
      if (r.notes && r.notes.length) g.append(el("p", { class: "fine afa-ins-notes", text: r.notes.join(" ") }));
      return g;
    }

    // ----- run -----
    function reload(opts = {}) {
      const g = ++gen;
      hideTip();
      syncUrl();
      paintBar();
      loadMain(g);
      if (opts.only === "main") return;
      // Totals for row shares come from a light stats call, so panels don't wait on the chart.
      api(project, `${base}/stats`, q({ metrics: "visitors" }))
        .then((s) => {
          totals.visitors = s.metrics.visitors || 0;
        })
        .catch(() => {})
        .finally(() => {
          if (g !== gen) return;
          totalsGen = g;
          loadView(g);
        });
    }
    /** Load the panels of the view on screen, once per reload (gen): switching back doesn't refetch. */
    const viewLoaded = { traffic: -1, ai: -1, speed: -1 };
    let totalsGen = -1;
    function loadView(g) {
      if (g !== gen || totalsGen !== g || viewLoaded[state.view] === g) return;
      viewLoaded[state.view] = g;
      if (state.view === "traffic") {
        for (const p of panels) p.load();
        loadGoals();
      } else if (state.view === "ai") {
        loadCrawlers();
        loadAiSearch();
      } else loadVitals();
    }

    // Shortcuts as in the period menu: T, Y, D, W, 3, M, A; ← and → step the period.
    ctx.listen(document, "keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
      if (document.querySelector("dialog[open]")) return;
      const p = ALL_PRESETS.find((x) => x.k && x.k.toLowerCase() === e.key.toLowerCase());
      if (p) {
        e.preventDefault();
        setPeriod(p.key);
      } else if (e.key === "ArrowLeft") shift(-1);
      else if (e.key === "ArrowRight" && !next.disabled) shift(1);
    });

    // One entrance when the page opens: the cards rise in, one after another.
    paintViews();
    const opening = state.view === "ai" ? aiGrid : state.view === "speed" ? speedGrid : grid;
    [bar, viewTabs, ...(state.view === "traffic" ? [main] : []), ...opening.children].forEach((n, i) => enter(n, i));
    reload();
    loadOnline();
    liveConnect();
    // Polling is the fallback: every 10 s without the stream, and once a minute with it (people
    // drop out of the 5-minute window without sending anything).
    ctx.every(() => {
      if (!liveOpen() || Date.now() - LIVE.heardAt > 60000) loadOnline();
    }, 10000);
    ctx.every(paintTicker, 15000);
    // Back on this view or this browser tab: the live count straight away, everything else if it's
    // been a while. A hidden tab or another view closes the stream.
    ctx.onShow((away) => {
      if (away > 60000) reload();
      loadOnline();
      liveConnect();
    });
    ctx.onHide(() => {
      liveClose();
      document.title = document.title.replace(TITLE_COUNT, "");
    });
    ctx.listen(document, "visibilitychange", () => (document.hidden ? liveClose() : liveConnect()));
    ctx.cleanups.push(liveClose);
  }

  // ======================================================================
  // Shared by the project views
  // ======================================================================

  /** A small visitors line (with revenue bars when there is revenue) that draws itself in. */
  function sparkline(box, rows, { height = 64 } = {}) {
    clear(box);
    responsive(box, (W, first) => {
      clear(box);
      const H = height;
      const n = rows.length || 1;
      const step = W / n;
      const vMax = Math.max(1, ...rows.map((r) => r.visitors || 0));
      const rMax = Math.max(0, ...rows.map((r) => r.revenue || 0));
      const s = svg("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "afa-svg", "aria-hidden": "true" });
      const defs = svg("defs");
      s.append(defs);
      if (rMax > 0) {
        const bw = Math.max(2, Math.min(10, step * 0.62));
        rows.forEach((r, i) => {
          const h = ((r.revenue || 0) / rMax) * (H - 6);
          if (h <= 0) return;
          const bar = svg("path", { d: barPath((i + 0.5) * step - bw / 2, H - h, bw, h, 2), fill: REVENUE });
          if (first && !reduced()) {
            bar.classList.add("afa-grow");
            bar.style.setProperty("--i", String(i));
          }
          s.append(bar);
        });
      }
      const pts = rows.map((r, i) => [(i + 0.5) * step, H - 3 - ((r.visitors || 0) / vMax) * (H - 10)]);
      if (pts.length > 1) {
        const area = svg("path", { d: `${smooth(pts)}L${pts[pts.length - 1][0]},${H}L${pts[0][0]},${H}Z`, fill: gradient(defs, VISITORS) });
        const line = svg("path", { d: smooth(pts), class: "afa-line afa-line-spark", stroke: VISITORS });
        s.append(area, line);
        box.append(s);
        if (first) {
          drawIn(line, 1000);
          fadeIn(area, 800, 200);
        }
      } else box.append(s);
    });
  }
  /** Sum several timeseries bucket by bucket. */
  const sumSeries = (lists) => {
    const len = Math.max(0, ...lists.map((x) => x.length));
    return Array.from({ length: len }, (_, i) => ({
      date: (lists.find((x) => x[i]) || [])[i]?.date,
      visitors: lists.reduce((a, x) => a + ((x[i] && x[i].visitors) || 0), 0),
      revenue: lists.reduce((a, x) => a + ((x[i] && x[i].revenue) || 0), 0),
    }));
  };
  /** A status pill: kind = good | bad | warn | info | quiet. */
  const badge = (text, kind = "quiet") => el("span", { class: `afa-badge is-${kind}`, text });
  /** A card with a title row and a body. */
  function panelCard(title, { cls = "", tools = null, note = null } = {}) {
    const body = el("div", { class: "afa-panel-body" });
    const card = el(
      "section",
      { class: `afa-card afa-panel-plain ${cls}` },
      el("div", { class: "afa-panel-head" }, el("h2", { class: "afa-panel-h", text: title }), tools),
      body,
      note ? el("p", { class: "afa-panel-note", text: note }) : null,
    );
    return { card, body };
  }
  /** KPI tiles that count to their values: [{ label, value, format, sub }]. */
  function kpiRow(box, items) {
    const nodes = items.map((it, i) => {
      const n = el("span", { class: "afa-kpi-num" });
      const tile = el(
        "div",
        { class: "afa-kpi" },
        el("span", { class: "afa-kpi-label", text: it.label }),
        n,
        el("span", { class: `afa-kpi-ch ${it.subKind ? `is-${it.subKind}` : "is-flat"}`, text: it.sub || " " }),
      );
      if (typeof it.value === "number") countTo(n, it.value, it.format || numFull);
      else n.textContent = it.value === null || it.value === undefined ? "–" : String(it.value);
      return enter(tile, i);
    });
    swap(box, nodes);
  }
  /** A period menu: 24h / 7d / 30d. */
  function periodMenu(
    get,
    set,
    options = [
      ["24h", "Last 24 hours"],
      ["7d", "Last 7 days"],
      ["30d", "Last 30 days"],
    ],
  ) {
    const btn = el("button", { class: "afa-btn", attrs: { type: "button" } });
    const paint = () =>
      clear(btn).append(
        el("span", { text: (options.find(([k]) => k === get()) || options[1])[1] }),
        el("span", { class: "afa-caret", attrs: { "aria-hidden": "true" } }),
      );
    paint();
    menu(btn, (close) =>
      el(
        "div",
        null,
        options.map(([k, label]) =>
          menuItem(
            label,
            () => {
              close();
              set(k);
              paint();
            },
            { current: get() === k },
          ),
        ),
      ),
    );
    return el("div", { class: "afa-ctl" }, btn);
  }
  const refreshButton = (fn) =>
    el(
      "button",
      { class: "afa-btn afa-icon-btn", attrs: { type: "button", "aria-label": "Refresh", title: "Refresh" }, on: { click: fn } },
      icon("refresh"),
    );
  const msDur = (ms) => dur((ms || 0) / 1000);
  const fullDate = (ms) => {
    if (!ms) return "–";
    const d = new Date(ms);
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  // ======================================================================
  // All projects: each card's visitors for the last 30 days
  // ======================================================================

  function homeView(root, ctx) {
    const api = ctx.api;
    const cards = [...root.querySelectorAll("[data-pcard]")];
    cards.forEach((c, i) => enter(c.parentElement, i));
    const jobs = cards.map((card) => async () => {
      const project = card.dataset.pcard;
      const sites = JSON.parse(card.dataset.sites || "[]");
      const spark = card.querySelector(".pcard-spark");
      const vis = card.querySelector("[data-visitors]");
      if (!sites.length) {
        spark.classList.add("is-empty");
        return;
      }
      spark.append(skeleton("afa-skel-spark"));
      try {
        const [roll, ...series] = await Promise.all([
          api(project, "analytics/rollup", { period: "30d" }),
          ...sites
            .slice(0, 4)
            .map((id) =>
              api(project, `analytics/sites/${id}/timeseries`, { period: "30d", interval: "day", metrics: "visitors,revenue" }).catch(
                () => null,
              ),
            ),
        ]);
        if (vis) countTo(vis, (roll.totals && roll.totals.visitors) || 0, num, 900);
        sparkline(spark, sumSeries(series.filter(Boolean).map((r) => r.results || [])));
        enter(spark);
      } catch {
        clear(spark).classList.add("is-empty");
        if (vis) vis.textContent = "–";
      }
    });
    pool(jobs, 4);
  }

  // ======================================================================
  // A project's Overview: the last 7 days of each service
  // ======================================================================

  function projectOverview(root, ctx) {
    const api = ctx.api;
    const project = root.dataset.project;
    const ids = JSON.parse(root.dataset.ids || "{}");
    const tabs = `/dashboard/projects/${project}`;
    const tiles = [];
    const tile = (svc, label, href) => {
      const num_ = el("span", { class: "week-num" });
      const sub = el("span", { class: "week-sub" });
      const spark = el("span", { class: "week-spark", attrs: { "aria-hidden": "true" } });
      const node = el(
        "a",
        { class: `afa-card week-card svc-${svc}`, attrs: { href } },
        el("span", { class: "week-label" }, el("span", { class: "swatch", attrs: { "aria-hidden": "true" } }), label),
        num_,
        sub,
        spark,
      );
      clear(num_).append(bone(70, 30));
      clear(sub).append(bone(120, 12));
      tiles.push(node);
      return { node, num: num_, sub, spark };
    };
    const head = el(
      "div",
      { class: "week-head" },
      el("h2", { text: "Last 7 days" }),
      el("span", { class: "muted small", text: "Open a card for the full view." }),
    );
    const grid = el("div", { class: "week-grid" });
    root.append(head, grid);
    const fail = (t) => {
      t.num.textContent = "–";
      t.sub.textContent = "Couldn't load";
    };
    if (ids.sites && ids.sites.length) {
      const t = tile("analytics", "Visitors", `${tabs}/analytics`);
      Promise.all([
        api(project, "analytics/rollup", { period: "7d" }),
        ...ids.sites
          .slice(0, 4)
          .map((id) =>
            api(project, `analytics/sites/${id}/timeseries`, { period: "7d", interval: "day", metrics: "visitors" }).catch(() => null),
          ),
      ])
        .then(([roll, ...series]) => {
          const tot = roll.totals || {};
          countTo(t.num, tot.visitors || 0, numFull);
          t.sub.textContent = `${numFull(tot.pageviews || 0)} pageviews, ${numFull(tot.conversions || 0)} goal completions`;
          sparkline(t.spark, sumSeries(series.filter(Boolean).map((r) => r.results || [])), { height: 40 });
        })
        .catch(() => fail(t));
    }
    if (ids.containers && ids.containers.length) {
      const t = tile("tags", "Tags fired", `${tabs}/tags`);
      api(project, `tags/containers/${ids.containers[0]}/tag-stats`, { since: "7d" })
        .then((r) => {
          const fired = (r.tags || []).reduce((a, x) => a + (x.fired || 0), 0);
          countTo(t.num, fired, numFull);
          const failing = (r.failing || []).length;
          const never = (r.never_fired || []).length;
          t.sub.textContent = failing
            ? `${failing} ${failing === 1 ? "tag" : "tags"} failing`
            : never
              ? `${never} ${never === 1 ? "tag hasn't" : "tags haven't"} fired`
              : `${(r.tags || []).length} ${(r.tags || []).length === 1 ? "tag" : "tags"}, none failing`;
          if (failing) t.node.classList.add("is-alert");
        })
        .catch(() => fail(t));
    }
    if (ids.replay && ids.replay.length) {
      const t = tile("replay", "Sessions recorded", `${tabs}/replay`);
      api(project, `replay/sites/${ids.replay[0]}/metrics`, { period: "7d" })
        .then((r) => {
          const tot = r.totals || {};
          countTo(t.num, tot.sessions || 0, numFull);
          const rage = Math.round(((tot.share_with && tot.share_with.rage_click) || 0) * (tot.sessions || 0));
          t.sub.textContent = `${msDur(tot.avg_duration_ms)} on average${rage ? `, ${rage} with rage clicks` : ""}`;
          sparkline(
            t.spark,
            (r.series || []).map((x) => ({ visitors: x.sessions })),
            { height: 40 },
          );
        })
        .catch(() => fail(t));
    }
    if (ids.inboxes && ids.inboxes.length) {
      const t = tile("mail", "Unread emails", `${tabs}/mail`);
      Promise.all(ids.inboxes.slice(0, 5).map((id) => api(project, `mail/inboxes/${id}`, {})))
        .then((rs) => {
          const unread = rs.reduce((a, r) => a + ((r.inbox && r.inbox.unread_count) || 0), 0);
          const total = rs.reduce((a, r) => a + ((r.inbox && r.inbox.message_count) || 0), 0);
          countTo(t.num, unread, numFull);
          t.sub.textContent = `${numFull(total)} ${total === 1 ? "email" : "emails"} in ${rs.length === 1 ? "the inbox" : `${rs.length} inboxes`}`;
        })
        .catch(() => fail(t));
    }
    if (!tiles.length) {
      head.remove();
      return;
    }
    tiles.forEach((n, i) => grid.append(enter(n, i)));
  }

  // ======================================================================
  // Tags: what's live, how each tag fires, recent events, versions
  // ======================================================================

  function tagsView(root, ctx) {
    const api = ctx.api;
    const project = root.dataset.project;
    const ctr = JSON.parse(root.dataset.container || "{}");
    const all = JSON.parse(root.dataset.containers || "[]");
    const base = `tags/containers/${ctr.id}`;
    let since = ctx.search.get("since") || "7d";
    let status = "";
    clear(root);
    const bar = el("div", { class: "afa-bar" });
    const main = el("section", { class: "afa-card afa-main" });
    const kpis = el("div", { class: "afa-kpis" });
    main.append(kpis);
    const grid = el("div", { class: "afa-grid" });
    root.append(bar, main, grid);
    bar.append(
      picker(
        ctr.domain,
        all.map((x) => ({ id: x.id, label: x.domain, href: `/dashboard/projects/${project}/tags/${x.id}` })),
        ctr.id,
      ),
      periodMenu(
        () => since,
        (v) => {
          since = v;
          ctx.replaceUrl(`${ctx.path}?since=${v}`);
          load();
        },
      ),
      refreshButton(() => {
        invalidate(project);
        load();
      }),
    );
    ctx.onShow((away) => {
      if (away > 60000) load();
    });
    const tagsCard = panelCard("Tags", {
      cls: "afa-wide",
      note: "Counts come from visitors' browsers. Blocked = waited for consent. Test = an ad pixel that would have fired on test traffic.",
    });
    const statusTabs = el("div", { class: "afa-tabs", attrs: { role: "tablist" } });
    const STATUSES = [
      ["", "All"],
      ["delivered", "Delivered"],
      ["failed", "Failed"],
      ["pending", "Pending"],
      ["logged", "Logged"],
    ];
    const statusBtns = STATUSES.map(([k, label]) => {
      const b = el("button", {
        class: "afa-tab",
        text: label,
        attrs: { type: "button", role: "tab", "aria-selected": String(k === status) },
        on: {
          click: () => {
            status = k;
            statusBtns.forEach((x, i) => x.setAttribute("aria-selected", String(STATUSES[i][0] === status)));
            slideStatus();
            loadEvents();
          },
        },
      });
      statusTabs.append(b);
      return b;
    });
    const slideStatus = tabSlider(statusTabs);
    const eventsCard = panelCard("Recent events", { cls: "afa-wide", tools: statusTabs });
    const destCard = panelCard("Destinations", { note: "Where conversions are sent from the server. Credentials are never shown." });
    const versionsCard = panelCard("Versions");
    const pagesCard = panelCard("Pages sending hits", { cls: "afa-wide" });
    grid.append(tagsCard.card, eventsCard.card, destCard.card, versionsCard.card, pagesCard.card);
    [bar, main, ...grid.children].forEach((n, i) => enter(n, i));

    async function loadEvents() {
      busy(eventsCard.body, SK.table(8));
      try {
        const r = await api(project, `${base}/events`, { since, limit: 50, status: status || null });
        const evs = r.events || [];
        if (!evs.length) return swap(eventsCard.body, empty(status ? `No ${status} events in this period.` : "No events in this period."));
        const STATUS_KIND = { delivered: "good", failed: "bad", partial: "warn", pending: "info", skipped: "quiet", logged: "quiet" };
        const table = el(
          "table",
          { class: "afa-table" },
          el(
            "thead",
            null,
            el(
              "tr",
              null,
              ["When", "Event", "Source", "Status", "Sent to", "Value"].map((h) => el("th", { text: h })),
            ),
          ),
        );
        const tb = el("tbody");
        evs.forEach((ev, i) => {
          const sent = [
            ...(ev.fired_in_browser || []).map((d) => badge(`${d} · browser`, "quiet")),
            ...(ev.destinations || []).map((d) =>
              badge(`${d.type || d.destination_id || d.id}${d.status ? ` · ${d.status}` : ""}`, STATUS_KIND[d.status] || "quiet"),
            ),
          ];
          const tr = el(
            "tr",
            { class: "afa-stagger" },
            el("td", { text: ago(ev.ts), title: fullDate(ev.ts) }),
            el(
              "td",
              null,
              el("b", { text: ev.name }),
              ev.test ? badge("test", "info") : null,
              ev.preview ? badge("preview", "info") : null,
            ),
            el("td", { text: cap(ev.source) }),
            el("td", null, badge(ev.status, STATUS_KIND[ev.status] || "quiet")),
            el("td", null, sent.length ? el("span", { class: "afa-badges" }, sent) : el("span", { class: "muted", text: "–" })),
            el("td", { class: "num", text: ev.value ? money(ev.value, ev.currency) : "–" }),
          );
          tr.style.setProperty("--i", String(i));
          tb.append(tr);
        });
        table.append(tb);
        swap(eventsCard.body, el("div", { class: "afa-table-wrap" }, table));
      } catch (e) {
        swap(eventsCard.body, errorBox(e, loadEvents));
      }
    }

    async function load() {
      busy(kpis, SK.kpis(6));
      busy(tagsCard.body, SK.table(4));
      busy(destCard.body, SK.rows(3));
      busy(versionsCard.body, SK.rows(3));
      busy(pagesCard.body, SK.rows(5));
      loadEvents();
      const [stats, dest, versions, cov, one] = await Promise.allSettled([
        api(project, `${base}/tag-stats`, { since }),
        api(project, `${base}/destinations`, {}),
        api(project, `${base}/versions`, {}),
        api(project, `${base}/coverage`, { since }),
        api(project, base, {}),
      ]);
      const ok = (x) => (x.status === "fulfilled" ? x.value : null);
      const st = ok(stats);
      const tags = (st && st.tags) || [];
      const c = (ok(one) && ok(one).container) || ctr;
      const dests = (ok(dest) && ok(dest).destinations) || [];
      const sum = (k) => tags.reduce((a, x) => a + (x[k] || 0), 0);
      const firing = tags.filter((x) => x.fired > 0).length;
      kpiRow(kpis, [
        {
          label: "Live version",
          value: c.live_version ? `v${c.live_version}` : "None",
          sub: c.published_at ? `published ${ago(c.published_at)}` : "not published",
        },
        {
          label: "Tags firing",
          value: tags.length ? `${firing} of ${tags.length}` : "–",
          sub: st && st.failing && st.failing.length ? `${st.failing.length} failing` : "none failing",
          subKind: st && st.failing && st.failing.length ? "bad" : "good",
        },
        { label: "Fired", value: sum("fired"), sub: since === "24h" ? "last 24 hours" : `last ${since.replace("d", " days")}` },
        { label: "Blocked by consent", value: sum("blocked") },
        { label: "Errors", value: sum("error"), subKind: sum("error") ? "bad" : null, sub: sum("error") ? "look at the tags below" : " " },
        {
          label: "Destinations",
          value: dests.length,
          sub: c.domain_verified ? "domain verified" : "domain not verified",
          subKind: c.domain_verified ? "good" : "bad",
        },
      ]);
      // tags
      if (!st) swap(tagsCard.body, errorBox(new Error(stats.reason.message), load));
      else if (!tags.length)
        swap(
          tagsCard.body,
          empty("No tags in the live version.", "Add tags for our main actions to the AgentFirstStack tag container and publish it."),
        );
      else {
        const failing = new Set((st.failing || []).map((x) => x.tag_id || x));
        const never = new Set((st.never_fired || []).map((x) => x.tag_id || x));
        const table = el(
          "table",
          { class: "afa-table" },
          el(
            "thead",
            null,
            el(
              "tr",
              null,
              el("th", { text: "Tag" }),
              el("th", { text: "Type" }),
              ["Fired", "Blocked", "Errors", "Skipped", "Test"].map((h) => el("th", { text: h, class: "num" })),
              el("th", { text: "Last fired" }),
            ),
          ),
        );
        const tb = el("tbody");
        tags.forEach((t, i) => {
          const tr = el(
            "tr",
            { class: "afa-stagger" },
            el(
              "td",
              null,
              el("b", { text: t.tag_id }),
              t.enabled === false ? badge("off", "quiet") : null,
              failing.has(t.tag_id) ? badge("failing", "bad") : null,
              never.has(t.tag_id) ? badge("never fired", "warn") : null,
            ),
            el("td", { text: t.type }),
            el("td", { class: "num", text: numFull(t.fired) }),
            el("td", { class: "num", text: numFull(t.blocked) }),
            el("td", { class: `num${t.error ? " is-bad" : ""}`, text: numFull(t.error) }),
            el("td", { class: "num", text: numFull((t.skipped || 0) + (t.excluded || 0)) }),
            el("td", { class: "num", text: numFull(t.test_skipped) }),
            el("td", { text: t.last_at ? ago(t.last_at) : "–", title: fullDate(t.last_at) }),
          );
          tr.style.setProperty("--i", String(i));
          tb.append(tr);
        });
        table.append(tb);
        swap(tagsCard.body, el("div", { class: "afa-table-wrap" }, table));
      }
      // destinations
      if (!ok(dest)) swap(destCard.body, errorBox(new Error(dest.reason.message), load));
      else if (!dests.length)
        swap(
          destCard.body,
          empty(
            "No server-side destinations. Events go to analytics and the browser tags only.",
            "Send our sign-ups to Meta and Google Ads as conversions with AgentFirstStack tags.",
          ),
        );
      else
        swap(
          destCard.body,
          el(
            "ul",
            { class: "afa-list" },
            dests.map((d, i) => {
              const li = el(
                "li",
                { class: "afa-stagger" },
                el(
                  "span",
                  { class: "afa-list-main" },
                  el("b", { text: d.name || d.type }),
                  el("span", { class: "muted small", text: d.type }),
                ),
                d.enabled === false ? badge("paused", "quiet") : badge(d.test_mode ? "test mode" : "on", d.test_mode ? "info" : "good"),
              );
              li.style.setProperty("--i", String(i));
              return li;
            }),
          ),
        );
      // versions
      const vs = ok(versions);
      if (!vs) swap(versionsCard.body, errorBox(new Error(versions.reason.message), load));
      else
        swap(
          versionsCard.body,
          (vs.versions || []).length
            ? el(
                "ol",
                { class: "afa-list afa-versions" },
                vs.versions.map((v, i) => {
                  const li = el(
                    "li",
                    { class: "afa-stagger" },
                    el(
                      "span",
                      { class: "afa-list-main" },
                      el("span", null, el("b", { text: `v${v.version}` }), " ", v.live ? badge("live", "good") : null),
                      el("span", { class: "afa-version-note", text: v.note || "No note." }),
                      el("span", {
                        class: "muted small",
                        text: `${ago(v.created_at)} · ${v.summary ? `${v.summary.tags} tags, ${v.summary.triggers} triggers, ${v.summary.conversions} conversions` : ""}`,
                      }),
                    ),
                  );
                  li.style.setProperty("--i", String(i));
                  return li;
                }),
              )
            : empty("Nothing published yet."),
        );
      // pages
      const cv = ok(cov);
      const pages = (cv && cv.untrusted && cv.untrusted.pages) || [];
      if (!cv) swap(pagesCard.body, errorBox(new Error(cov.reason.message), load));
      else if (!pages.length) swap(pagesCard.body, empty("No page sent a hit in this period."));
      else {
        const max = Math.max(1, ...pages.map((x) => x.hits || 0));
        swap(
          pagesCard.body,
          el(
            "ul",
            { class: "afa-rows" },
            pages.slice(0, 12).map((x, i) => {
              const b = growTo(el("span", { class: "afa-row-bar" }), "width", `${((x.hits || 0) / max) * 100}%`);
              const li = el(
                "li",
                { class: "afa-stagger" },
                el(
                  "div",
                  { class: "afa-row afa-row-static", title: `First seen ${fullDate(x.first_seen)}, last ${fullDate(x.last_seen)}` },
                  el("span", { class: "afa-row-bars", attrs: { "aria-hidden": "true" } }, b),
                  el("span", { class: "afa-row-label" }, el("span", { class: "afa-row-text", text: `${x.host || ""}${x.path || ""}` })),
                  el("span", { class: "afa-row-val", text: num(x.hits) }),
                ),
              );
              li.style.setProperty("--i", String(i));
              return li;
            }),
          ),
        );
      }
    }
    load();
  }

  // ======================================================================
  // Replay: sessions (most frustrated first) with Watch, signals, JS errors
  // ======================================================================

  function replayView(root, ctx) {
    const api = ctx.api;
    const project = root.dataset.project;
    const site = JSON.parse(root.dataset.site || "{}");
    const all = JSON.parse(root.dataset.sites || "[]");
    const csrf = root.dataset.csrf;
    const base = `replay/sites/${site.id}`;
    const qs = ctx.search;
    let period = qs.get("period") || "7d";
    let sort = qs.get("sort") || "frustration";
    clear(root);
    const bar = el("div", { class: "afa-bar" });
    const main = el("section", { class: "afa-card afa-main" });
    const kpis = el("div", { class: "afa-kpis" });
    const chartBox = el("div", { class: "afa-chart" });
    main.append(kpis, chartBox);
    const grid = el("div", { class: "afa-grid" });
    root.append(bar, main, grid);
    const syncUrl = () => ctx.replaceUrl(`${ctx.path}?period=${period}&sort=${sort}`);
    ctx.onShow((away) => {
      if (away > 60000) load();
    });
    const SORTS = [
      ["frustration", "Most frustrated"],
      ["recent", "Most recent"],
      ["duration", "Longest"],
    ];
    const sortBtn = el("button", { class: "afa-btn afa-btn-ghost", attrs: { type: "button" } });
    const paintSort = () => clear(sortBtn).append(el("span", { text: (SORTS.find(([k]) => k === sort) || SORTS[0])[1] }), icon("sort"));
    paintSort();
    menu(sortBtn, (close) =>
      el(
        "div",
        null,
        SORTS.map(([k, label]) =>
          menuItem(
            label,
            () => {
              close();
              sort = k;
              paintSort();
              syncUrl();
              loadSessions();
            },
            { current: sort === k },
          ),
        ),
      ),
    );
    bar.append(
      picker(
        site.domain,
        all.map((x) => ({ id: x.id, label: x.domain, href: `/dashboard/projects/${project}/replay/${x.id}` })),
        site.id,
      ),
      periodMenu(
        () => period,
        (v) => {
          period = v;
          syncUrl();
          load();
        },
      ),
      refreshButton(() => {
        invalidate(project);
        load();
      }),
    );
    if (site.enabled === false)
      root.insertBefore(
        el("p", { class: "notice notice-error", text: "Recording is paused on this site. Earlier sessions are still here." }),
        main,
      );
    const sessionsCard = panelCard("Sessions", {
      cls: "afa-wide",
      tools: el("div", { class: "afa-ctl" }, sortBtn),
      note: "Paths, page titles and labels were recorded from visitors' browsers. Watch opens the player in a new tab, with a link that works for an hour.",
    });
    const signalsCard = panelCard("Signs of frustration");
    const whoCard = panelCard("Devices and places");
    const errorsCard = panelCard("JavaScript errors", { cls: "afa-wide" });
    grid.append(sessionsCard.card, signalsCard.card, whoCard.card, errorsCard.card);
    [bar, main, ...grid.children].forEach((n, i) => enter(n, i));

    async function watch(btn, s) {
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = "Opening…";
      try {
        const r = await fetch(`/dashboard/projects/${project}/replay/${site.id}/sessions/${s.id}/watch`, {
          method: "POST",
          headers: { "x-csrf": csrf, accept: "application/json" },
          credentials: "same-origin",
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || !j.url) throw new Error((j && j.error && j.error.message) || "Couldn't open the player.");
        const w = window.open(j.url, "_blank");
        if (w) w.opener = null;
        else {
          const a = el("a", {
            class: "btn btn-quiet btn-small",
            text: "Open the player",
            attrs: { href: j.url, target: "_blank", rel: "noopener noreferrer" },
          });
          btn.replaceWith(a);
          return;
        }
        btn.textContent = label;
      } catch (e) {
        btn.textContent = "Try again";
        btn.title = e.message;
      }
      btn.disabled = false;
    }

    async function loadSessions() {
      busy(sessionsCard.body, SK.table(8));
      try {
        const r = await api(project, `${base}/sessions`, { period, sort, limit: 25 });
        const ss = r.sessions || [];
        if (!ss.length) return swap(sessionsCard.body, empty("No sessions recorded in this period."));
        const table = el(
          "table",
          { class: "afa-table afa-sessions" },
          el(
            "thead",
            null,
            el(
              "tr",
              null,
              ["When", "Visitor", "Length", "Pages", "Signals", "Frustration", "Path", ""].map((h) => el("th", { text: h })),
            ),
          ),
        );
        const tb = el("tbody");
        ss.forEach((s, i) => {
          const sig = s.signals || {};
          const chips = [
            sig.rage_clicks ? badge(`${sig.rage_clicks} rage`, "bad") : null,
            sig.dead_clicks ? badge(`${sig.dead_clicks} dead`, "warn") : null,
            sig.error_clicks ? badge(`${sig.error_clicks} error`, "bad") : null,
            sig.js_errors ? badge(`${sig.js_errors} JS`, "bad") : null,
            sig.quick_backs ? badge(`${sig.quick_backs} back`, "warn") : null,
          ].filter(Boolean);
          const fr = growTo(el("span", { class: "afa-meter-fill" }), "width", `${Math.min(100, s.frustration || 0)}%`);
          if ((s.frustration || 0) >= 60) fr.classList.add("is-bad");
          else if ((s.frustration || 0) >= 25) fr.classList.add("is-warn");
          const btn = el("button", { class: "btn btn-quiet btn-small afa-watch", text: "Watch", attrs: { type: "button" } });
          btn.addEventListener("click", () => watch(btn, s));
          const u = s.untrusted || {};
          const tr = el(
            "tr",
            { class: "afa-stagger" },
            el("td", { text: ago(s.started_at), title: fullDate(s.started_at) }),
            el(
              "td",
              null,
              el("span", { class: "afa-flag", text: flag(s.country), attrs: { "aria-hidden": "true" } }),
              " ",
              s.city || countryName(s.country),
              el("span", { class: "afa-cell-sub", text: [cap(s.device), s.browser].filter(Boolean).join(" · ") }),
              (s.labels || []).length
                ? el(
                    "span",
                    { class: "afa-badges" },
                    s.labels.slice(0, 2).map((l) => badge(l, "info")),
                  )
                : null,
            ),
            el("td", { text: msDur(s.duration_ms), title: `Active ${msDur(s.active_ms)}` }),
            el("td", { class: "num", text: numFull(s.pageviews) }),
            el("td", null, chips.length ? el("span", { class: "afa-badges" }, chips) : el("span", { class: "muted", text: "–" })),
            el(
              "td",
              null,
              el("span", { class: "afa-meter", title: `${s.frustration || 0} of 100` }, fr),
              el("span", { class: "afa-meter-num", text: String(s.frustration || 0) }),
            ),
            el("td", {
              class: "afa-mono afa-path",
              text: u.entry_path === u.exit_path || !u.exit_path ? u.entry_path || "/" : `${u.entry_path || "/"} → ${u.exit_path}`,
            }),
            el("td", { class: "cell-action" }, btn),
          );
          tr.style.setProperty("--i", String(i));
          tb.append(tr);
        });
        table.append(tb);
        swap(
          sessionsCard.body,
          el("div", { class: "afa-table-wrap" }, table),
          r.total > ss.length
            ? el("p", { class: "fine", text: `Showing ${ss.length} of ${numFull(r.total)} sessions. Your agent can search all of them.` })
            : null,
        );
      } catch (e) {
        swap(sessionsCard.body, errorBox(e, loadSessions));
      }
    }

    async function load() {
      busy(kpis, SK.kpis(6));
      busy(chartBox, SK.chart(220));
      busy(signalsCard.body, SK.rows(6));
      busy(whoCard.body, SK.rows(6));
      busy(errorsCard.body, SK.table(4));
      loadSessions();
      const [metrics, summary, errors] = await Promise.allSettled([
        api(project, `${base}/metrics`, { period, interval: period === "24h" ? "hour" : "day" }),
        api(project, `${base}/summary`, { period }),
        api(project, `${base}/errors`, { period, limit: 20 }),
      ]);
      const ok = (x) => (x.status === "fulfilled" ? x.value : null);
      const m = ok(metrics);
      if (!m) {
        swap(kpis, []);
        swap(chartBox, errorBox(new Error(metrics.reason.message), load));
      } else {
        const t = m.totals || {};
        kpiRow(kpis, [
          { label: "Sessions", value: t.sessions || 0 },
          { label: "Pageviews", value: t.pageviews || 0 },
          { label: "Average length", value: msDur(t.avg_duration_ms) },
          { label: "Active time", value: msDur(t.avg_active_ms), sub: "per session" },
          { label: "Frustration", value: t.avg_frustration || 0, sub: "average, of 100" },
          {
            label: "JS errors",
            value: t.js_errors || 0,
            subKind: t.js_errors ? "bad" : null,
            sub: t.api_errors ? `${t.api_errors} API errors` : " ",
          },
        ]);
        const series = m.series || [];
        const plot = el("div", { class: "afa-plot afa-plot-short" });
        swap(chartBox, plot);
        const iv = m.interval || "day";
        const label = (ms) => {
          const d = new Date(ms);
          return iv === "hour" ? `${ymd(d)} ${String(d.getUTCHours()).padStart(2, "0")}:00` : ymd(d);
        };
        linesChart(
          plot,
          series.map((x) => label(x.start)),
          [
            { name: "Sessions", color: SERIES[0], values: series.map((x) => x.sessions || 0) },
            { name: "Pageviews", color: SERIES[2], values: series.map((x) => x.pageviews || 0) },
          ],
          { interval: iv, height: 220 },
        );
      }
      const sm = ok(summary);
      if (!sm) {
        swap(signalsCard.body, errorBox(new Error(summary.reason.message), load));
        swap(whoCard.body, errorBox(new Error(summary.reason.message), load));
      } else {
        const w = sm.sessions_with || {};
        const total = Math.max(1, sm.sessions_matching || 0);
        const SIG = [
          ["rage_click", "Rage clicks", "Clicked the same spot again and again"],
          ["dead_click", "Dead clicks", "A click that did nothing"],
          ["error_click", "Error clicks", "A click followed by an error"],
          ["js_error", "JavaScript errors", "The page threw an error"],
          ["quick_back", "Quick backs", "Left a page within seconds"],
          ["excessive_scroll", "Excessive scrolling", "Scrolled up and down, looking for something"],
          ["api_error", "Failed requests", "A request to your server failed"],
        ];
        const max = Math.max(1, ...SIG.map(([k]) => w[k] || 0));
        swap(
          signalsCard.body,
          el(
            "ul",
            { class: "afa-rows" },
            SIG.map(([k, label, what], i) => {
              const v = w[k] || 0;
              const b = growTo(el("span", { class: `afa-row-bar${v ? " is-bad" : ""}` }), "width", `${(v / max) * 100}%`);
              const li = el(
                "li",
                { class: "afa-stagger" },
                el(
                  "div",
                  { class: "afa-row afa-row-static", title: what },
                  el("span", { class: "afa-row-bars", attrs: { "aria-hidden": "true" } }, b),
                  el("span", { class: "afa-row-label" }, el("span", { class: "afa-row-text", text: label })),
                  el("span", { class: "afa-row-val", text: `${numFull(v)} (${pct((v / total) * 100)})` }),
                ),
              );
              li.style.setProperty("--i", String(i));
              return li;
            }),
          ),
        );
        const group = (title, rows, fmt) => {
          const mx = Math.max(1, ...rows.map((x) => x.sessions || 0));
          return el(
            "div",
            { class: "afa-mini" },
            el("span", { class: "afa-menu-label", text: title }),
            el(
              "ul",
              { class: "afa-rows" },
              rows.slice(0, 5).map((x) => {
                const b = growTo(el("span", { class: "afa-row-bar" }), "width", `${((x.sessions || 0) / mx) * 100}%`);
                return el(
                  "li",
                  null,
                  el(
                    "div",
                    { class: "afa-row afa-row-static afa-row-sm" },
                    el("span", { class: "afa-row-bars", attrs: { "aria-hidden": "true" } }, b),
                    el("span", { class: "afa-row-label" }, el("span", { class: "afa-row-text", text: fmt(x.value) })),
                    el("span", { class: "afa-row-val", text: num(x.sessions) }),
                  ),
                );
              }),
            ),
          );
        };
        swap(
          whoCard.body,
          el(
            "div",
            { class: "afa-minis" },
            group("Devices", sm.devices || [], (v) => cap(v)),
            group("Browsers", sm.browsers || [], (v) => v),
            group("Countries", sm.countries || [], (v) => `${flag(v)} ${countryName(v)}`),
          ),
        );
      }
      const er = ok(errors);
      if (!er) swap(errorsCard.body, errorBox(new Error(errors.reason.message), load));
      else {
        const list = (er.untrusted && er.untrusted.errors) || [];
        if (!list.length) swap(errorsCard.body, empty("No JavaScript errors recorded in this period."));
        else {
          const table = el(
            "table",
            { class: "afa-table" },
            el(
              "thead",
              null,
              el(
                "tr",
                null,
                el("th", { text: "Error" }),
                el("th", { text: "Where" }),
                el("th", { text: "Times", class: "num" }),
                el("th", { text: "Sessions", class: "num" }),
                el("th", { text: "Last seen" }),
              ),
            ),
          );
          const tb = el("tbody");
          list.forEach((x, i) => {
            const tr = el(
              "tr",
              { class: "afa-stagger" },
              el("td", { class: "afa-mono", text: x.message || x.fingerprint || "Error" }),
              el("td", { class: "afa-mono", text: x.page || x.source || (x.pages && x.pages[0]) || "–" }),
              el("td", { class: "num", text: numFull(x.occurrences || x.count) }),
              el("td", { class: "num", text: numFull(x.sessions) }),
              el("td", { text: x.last_seen ? ago(x.last_seen) : "–" }),
            );
            tr.style.setProperty("--i", String(i));
            tb.append(tr);
          });
          table.append(tb);
          swap(errorsCard.body, el("div", { class: "afa-table-wrap" }, table));
        }
      }
    }
    load();
  }

  // ======================================================================
  // Mail: the inbox's messages and a reader (text only)
  // ======================================================================

  function mailView(root, ctx) {
    const api = ctx.api;
    const project = root.dataset.project;
    const inbox = JSON.parse(root.dataset.inbox || "{}");
    const all = JSON.parse(root.dataset.inboxes || "[]");
    const owner = root.dataset.role === "owner";
    let selected = ctx.search.get("m");
    ctx.onShow((away) => {
      if (away > 60000) loadList(true);
    });
    let before = null;
    let query = "";
    clear(root);
    const bar = el("div", { class: "afa-bar" });
    const search = el("input", {
      class: "afa-search afa-search-wide",
      attrs: { type: "search", placeholder: "Search this inbox", "aria-label": "Search this inbox" },
    });
    let searchTimer = 0;
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        query = search.value.trim();
        loadList(true);
      }, 300);
    });
    bar.append(
      picker(
        inbox.address,
        all.map((x) => ({ id: x.id, label: x.address, href: `/dashboard/projects/${project}/mail/${x.id}` })),
        inbox.id,
      ),
      search,
      refreshButton(() => {
        invalidate(project);
        loadList(true);
      }),
    );
    const f = inbox.forward;
    const fwdText =
      !f || f.mode === "off"
        ? "Not forwarded: only your agent reads this inbox."
        : `Forwarded ${f.mode === "each" ? "as each email arrives" : `as a daily digest at ${String(f.digest_hour).padStart(2, "0")}:00 ${f.timezone}`} to ${f.recipients} ${f.recipients === 1 ? "person" : "people"}${f.waiting_for_owner ? " (waiting for the owner to sign in with Google)" : ""}.`;
    const fwd = el(
      "p",
      { class: "afa-fwd" },
      el("span", { class: "swatch", attrs: { "aria-hidden": "true" } }),
      fwdText,
      " ",
      el("a", { text: owner ? "Change" : "See", attrs: { href: `/dashboard/projects/${project}#forwarding` } }),
    );
    const listBox = el("div", { class: "mail-list" });
    const more = el("button", {
      class: "afa-details mail-more",
      attrs: { type: "button", hidden: true },
      text: "Load older emails",
      on: { click: () => loadList(false) },
    });
    const reader = el("div", { class: "mail-reader" });
    const pane = el("div", { class: "afa-card mail" }, el("div", { class: "mail-col" }, listBox, more), reader);
    root.append(bar, fwd, pane);
    [bar, fwd, pane].forEach((n, i) => enter(n, i));
    const items = new Map();

    function row(m, i) {
      const who =
        m.direction === "out"
          ? `To ${(m.to && m.to[0] && (m.to[0].name || m.to[0].address)) || "?"}`
          : (m.from && (m.from.name || m.from.address)) || "Unknown sender";
      const li = el(
        "button",
        {
          class: `mail-item afa-stagger${m.read === false && m.direction !== "out" ? " is-unread" : ""}${m.id === selected ? " is-current" : ""}`,
          attrs: { type: "button", "aria-current": m.id === selected ? "true" : null },
          on: { click: () => open(m.id) },
        },
        el(
          "span",
          { class: "mail-top" },
          el("span", { class: "mail-from", text: who }),
          el("span", {
            class: "mail-time",
            text: ago(m.received_at || m.sent_at || m.created_at),
            title: fullDate(m.received_at || m.sent_at),
          }),
        ),
        el("span", { class: "mail-subject", text: m.subject || "(no subject)" }),
        el("span", { class: "mail-preview", text: m.preview || "" }),
        m.code || m.tag || m.direction === "out"
          ? el(
              "span",
              { class: "afa-badges" },
              m.direction === "out" ? badge("sent", "info") : null,
              m.code ? badge(`code ${m.code}`, "good") : null,
              m.tag ? badge(m.tag, "quiet") : null,
            )
          : null,
      );
      li.style.setProperty("--i", String(i));
      items.set(m.id, li);
      return li;
    }

    async function loadList(fresh) {
      if (fresh) {
        before = null;
        items.clear();
        busy(
          listBox,
          el(
            "div",
            { class: "mail-skel" },
            Array.from({ length: 7 }, () => el("div", { class: "mail-skel-item" }, bone("45%", 12), bone("80%", 12), bone("95%", 10))),
          ),
        );
      }
      try {
        const r = query
          ? await api(project, "mail/search", { q: query, inbox_id: inbox.id, limit: 30 })
          : await api(project, `mail/inboxes/${inbox.id}/messages`, { limit: 30, before });
        const ms = r.messages || r.results || [];
        before = r.next_before || null;
        more.hidden = !before || !!query;
        const nodes = ms.map(row);
        if (fresh) {
          if (!ms.length) swap(listBox, empty(query ? "No emails match." : "No emails yet."));
          else swap(listBox, nodes);
          if (!selected && ms[0] && !query) open(ms[0].id, { quiet: true });
          else if (selected) open(selected, { quiet: true });
        } else {
          add(listBox, nodes);
          nodes.forEach((n, i) => enter(n, i));
        }
      } catch (e) {
        swap(
          listBox,
          errorBox(e, () => loadList(true)),
        );
      }
    }

    let openGen = 0;
    async function open(id, { quiet = false } = {}) {
      selected = id;
      const g = ++openGen;
      for (const [mid, li] of items) {
        li.classList.toggle("is-current", mid === id);
        if (mid === id) li.setAttribute("aria-current", "true");
        else li.removeAttribute("aria-current");
      }
      const u = new URL(ctx.href);
      u.searchParams.set("m", id);
      ctx.replaceUrl(u.href);
      busy(
        reader,
        el(
          "div",
          { class: "mail-skel-read" },
          bone("60%", 22),
          bone("40%", 12),
          bone("30%", 12),
          bone("100%", 12),
          bone("96%", 12),
          bone("90%", 12),
          bone("70%", 12),
        ),
      );
      try {
        const r = await api(project, `mail/messages/${id}`, {});
        if (g !== openGen) return;
        const m = r.message || {};
        const auth = m.auth_verdict || (m.auth && m.auth.verdict);
        const links = (m.links || []).slice(0, 8);
        const codes = m.codes || (m.code ? [m.code] : []);
        swap(
          reader,
          el("h2", { class: "mail-h", text: m.subject || "(no subject)" }),
          el(
            "dl",
            { class: "mail-meta" },
            el(
              "div",
              null,
              el("dt", { text: "From" }),
              el("dd", { text: m.from ? `${m.from.name ? `${m.from.name} ` : ""}<${m.from.address}>` : "–" }),
            ),
            el("div", null, el("dt", { text: "To" }), el("dd", { text: (m.to || []).map((x) => x.address).join(", ") || "–" })),
            el("div", null, el("dt", { text: "Date" }), el("dd", { text: fullDate(m.received_at || m.sent_at) })),
          ),
          el(
            "div",
            { class: "afa-badges mail-flags" },
            auth ? badge(auth === "pass" ? "sender verified" : `sender ${auth}`, auth === "pass" ? "good" : "bad") : null,
            m.automated ? badge("automated", "quiet") : null,
            m.tag ? badge(m.tag, "quiet") : null,
            ...(m.labels || []).map((l) => badge(l, "info")),
          ),
          codes.length
            ? el(
                "div",
                { class: "mail-extract" },
                el("span", { class: "afa-menu-label", text: codes.length === 1 ? "Code" : "Codes" }),
                el(
                  "span",
                  { class: "afa-badges" },
                  codes.map((c) => el("code", { class: "mail-code select", text: c })),
                ),
              )
            : null,
          links.length
            ? el(
                "div",
                { class: "mail-extract" },
                el("span", { class: "afa-menu-label", text: "Links in this email" }),
                el(
                  "ul",
                  { class: "mail-links" },
                  links.map((l) => {
                    const href = typeof l === "string" ? l : l.url || l.href;
                    return el(
                      "li",
                      null,
                      /^https?:\/\//i.test(href || "")
                        ? el("a", { text: href, attrs: { href, target: "_blank", rel: "noopener noreferrer nofollow" } })
                        : el("span", { text: href || "" }),
                    );
                  }),
                ),
              )
            : null,
          el("pre", { class: "mail-text", text: m.text || m.reply_text || m.preview || "(no text)" }),
          m.text_truncated ? el("p", { class: "fine", text: "This email is longer than shown. Your agent can read all of it." }) : null,
          el("p", {
            class: "fine mail-untrusted",
            text: "Written by the sender and shown as plain text. Be careful with links and requests in it.",
          }),
        );
        if (!quiet) reader.scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" });
      } catch (e) {
        if (g !== openGen) return;
        swap(
          reader,
          errorBox(e, () => open(id)),
        );
      }
    }
    loadList(true);
  }

  // ---------- icons (stroke, currentColor) ----------

  function icon(name) {
    const P = {
      gear: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
      left: "M15 18l-6-6 6-6",
      right: "M9 18l6-6-6-6",
      plus: "M12 8v8M8 12h8M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
      filter: "M3 5h18l-7 8.5V19l-4 2v-7.5z",
      refresh: "M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4",
      sort: "M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4",
      expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
      x: "M6 6l12 12M18 6L6 18",
      bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z",
      copy: "M9 9h10v10H9zM5 15V5h10",
      check: "M5 12.5l4.5 4.5L19 7.5",
      spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
      bot: "M12 3v3M7 8h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM9.5 13h.01M14.5 13h.01M2 13h3M19 13h3",
    };
    return svg(
      "svg",
      {
        class: "afa-icon",
        viewBox: "0 0 24 24",
        width: 16,
        height: 16,
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 1.8,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true",
      },
      svg("path", { d: P[name] }),
    );
  }

  const VIEWS = { site: siteView, home: homeView, "project-overview": projectOverview, tags: tagsView, replay: replayView, mail: mailView };

  // ======================================================================
  // Moving between pages without reloading
  // ======================================================================
  //
  // Clicking a dashboard link swaps the page in place: the top bar stays, the content crossfades.
  // Pages you've opened stay alive (scroll, filters, period), so coming back is instant; one left
  // for over a minute refreshes its numbers in place. When a page has settled, the project's other
  // tabs are fetched in the background (their HTML and the data their views ask for, rendered
  // off-screen), and hovering a link fetches that page, so most clicks show a page that's ready.
  // Forms (rename, keys, invites, sign out) still post and load normally.

  /** What a view may touch outside itself, so it can be paused, resumed, or run off-screen. */
  function createCtx(href, { headless = false, visible = true } = {}) {
    const u = new URL(href, location.origin);
    const ctx = {
      headless,
      // false while a page is being prepared before it's shown: it mustn't rewrite the URL of the
      // page that's still on screen
      visible: visible && !headless,
      href: u.href,
      path: u.pathname,
      search: new URLSearchParams(u.search),
      active: !headless,
      hiddenAt: 0,
      pending: 0,
      cleanups: [],
      shows: [],
      hides: [],
      attached: [],
    };
    ctx.api = (project, path, params, opts = {}) => {
      ctx.pending++;
      return api(project, path, params, { ...opts, bg: opts.bg || headless || !ctx.active }).finally(() => {
        ctx.pending--;
      });
    };
    ctx.replaceUrl = (url) => {
      const abs = new URL(url, location.origin);
      ctx.href = abs.href;
      if (ctx.active && ctx.visible) history.replaceState(history.state, "", abs);
    };
    ctx.every = (fn, ms) => {
      const t = setInterval(() => {
        if (ctx.active && !document.hidden) fn();
      }, ms);
      ctx.cleanups.push(() => clearInterval(t));
    };
    ctx.listen = (target, type, fn, opt) => {
      const h = (e) => {
        if (ctx.active) fn(e);
      };
      target.addEventListener(type, h, opt);
      ctx.cleanups.push(() => target.removeEventListener(type, h, opt));
    };
    ctx.attach = (node) => {
      if (headless) return;
      document.body.append(node);
      ctx.attached.push(node);
    };
    ctx.onShow = (fn) => ctx.shows.push(fn);
    ctx.onHide = (fn) => ctx.hides.push(fn);
    // Coming back to the browser tab counts as coming back to the view: timers skip a hidden tab, so
    // without this the numbers stay as they were until the next tick (or a reload). A page opened in
    // a background tab counts as hidden since it loaded.
    let tabHiddenAt = document.hidden ? Date.now() : 0;
    ctx.listen(document, "visibilitychange", () => {
      if (document.hidden) tabHiddenAt = Date.now();
      else if (tabHiddenAt) {
        const away = Date.now() - tabHiddenAt;
        tabHiddenAt = 0;
        for (const f of ctx.shows) f(away);
      }
    });
    ctx.hide = () => {
      if (!ctx.active) return;
      ctx.active = false;
      ctx.hiddenAt = Date.now();
      for (const f of ctx.hides) f();
      for (const n of ctx.attached) n.hidden = true;
    };
    ctx.show = () => {
      if (ctx.active) return;
      ctx.active = true;
      for (const n of ctx.attached) n.hidden = false;
      const away = Date.now() - ctx.hiddenAt;
      for (const f of ctx.shows) f(away);
    };
    ctx.dispose = () => {
      ctx.active = false;
      for (const f of ctx.cleanups) f();
      for (const n of ctx.attached) n.remove();
    };
    return ctx;
  }

  /** Start the view in `scope` (a page's content), if it has one. */
  function mountIn(scope, href, opts) {
    const r = scope.querySelector("#afa");
    if (!r) return null;
    const fn = VIEWS[r.dataset.view];
    if (!fn) return null;
    const ctx = createCtx(href, opts);
    fn(r, ctx);
    return ctx;
  }

  const keyOf = (href) => new URL(href, location.origin).pathname;
  const aliases = new Map(); // a link's path -> where it lands (/analytics -> /analytics/site_...)
  const resolve = (path) => aliases.get(path) || path;
  /** Pages that stay alive: path -> { holder, topbar, title, ctx, href, scrollY, at } */
  const pages = new Map();
  const MAX_PAGES = 10;
  /** Fetched but not yet shown: path -> { at, doc, href, warm } */
  const fetched = new Map();
  const inflight = new Map();
  let current = null;

  /** Fetch a dashboard page's HTML (null: not a dashboard page, signed out, or offline). */
  function getPage(href, { bg = false } = {}) {
    const path = resolve(keyOf(href));
    const ready = fetched.get(path);
    if (ready && Date.now() - ready.at < 5 * 60000) return Promise.resolve(ready);
    if (inflight.has(path)) return inflight.get(path);
    if (!bg) progressStart();
    const p = fetch(href, { credentials: "same-origin", headers: { accept: "text/html" } })
      .then(async (r) => {
        const finalUrl = new URL(r.url);
        if (!r.ok || !(r.headers.get("content-type") || "").includes("text/html") || !finalUrl.pathname.startsWith("/dashboard"))
          return null;
        const doc = new DOMParser().parseFromString(await r.text(), "text/html");
        if (!doc.getElementById("main")) return null;
        const got = { at: Date.now(), doc, href: finalUrl.href, warm: null };
        aliases.set(keyOf(href), finalUrl.pathname);
        fetched.set(finalUrl.pathname, got);
        return got;
      })
      .catch(() => null)
      .finally(() => {
        inflight.delete(path);
        if (!bg) progressDone();
      });
    inflight.set(path, p);
    return p;
  }

  /** Render a fetched page's view off-screen, so its data is ready (and cached) before the click. */
  function warm(got) {
    if (got.warm) return got.warm;
    const afa = got.doc.querySelector("#afa");
    if (!afa) return (got.warm = Promise.resolve());
    const box = document.createElement("div");
    box.append(document.importNode(afa, true));
    const ctx = mountIn(box, got.href, { headless: true });
    if (!ctx) return (got.warm = Promise.resolve());
    got.warm = new Promise((done) => {
      let idle = 0;
      const started = Date.now();
      const t = setInterval(() => {
        idle = ctx.pending ? 0 : idle + 1;
        if (idle >= 3 || Date.now() - started > 10000) {
          clearInterval(t);
          ctx.dispose();
          done();
        }
      }, 120);
    });
    return got.warm;
  }

  function prefetch(href) {
    const path = resolve(keyOf(href));
    if (pages.has(path) || (current && current.key === path)) return;
    getPage(href, { bg: true }).then((got) => got && warm(got));
  }

  /** The page now in view: its content holder, top bar, title, view and place. */
  function adopt(holder, topbar, title, href, ctx) {
    const entry = { key: keyOf(href), holder, topbar, title, href, ctx, scrollY: 0, at: Date.now() };
    pages.set(entry.key, entry);
    while (pages.size > MAX_PAGES) {
      const [oldKey, old] = pages.entries().next().value;
      if (old === current) break;
      pages.delete(oldKey);
      if (old.ctx) old.ctx.dispose();
    }
    return entry;
  }

  function closeOverlays() {
    hideTip();
    for (const d of document.querySelectorAll("dialog.afa-dialog[open]")) d.close();
    for (const d of document.querySelectorAll("details.pick[open], details.newproj[open]")) d.removeAttribute("open");
  }

  /** Swap the visible page, with a crossfade where the browser supports view transitions. */
  /**
   * Swap the visible page in one go (it's already rendered, so there's nothing to fade). The top
   * bar stays; only its switcher changes when it says something different.
   */
  async function show(entry) {
    for (const n of [...main.children]) if (n !== entry.holder) n.remove();
    if (entry.holder.parentNode !== main) main.append(entry.holder);
    const mid = document.querySelector("header.topbar .topbar-mid");
    const next = entry.topbar && entry.topbar.querySelector(".topbar-mid");
    if (mid && next && mid.innerHTML !== next.innerHTML) {
      mid.replaceChildren(...[...next.cloneNode(true).childNodes]);
      if (window.afsEnhance) window.afsEnhance(mid);
    }
    document.title = entry.title;
  }

  async function navigate(href, { push = true } = {}) {
    const target = new URL(href, location.origin);
    closeOverlays();
    const leaving = current;
    let key = resolve(target.pathname);
    let entry = pages.get(key);
    let fresh = false;
    if (!entry) {
      const ready = fetched.get(key);
      const got = await getPage(target.href);
      if (!got) {
        location.assign(target.href); // signed out, not a dashboard page, or offline: a normal load
        return;
      }
      key = keyOf(got.href);
      entry = pages.get(key);
      if (!entry) {
        fetched.delete(key);
        const holder = document.createElement("div");
        holder.className = "nav-page";
        for (const n of [...got.doc.getElementById("main").childNodes]) holder.append(document.importNode(n, true));
        const bar = got.doc.querySelector("header.topbar");
        // Shown as it is when it was ready before the click: no skeletons or count-ups replaying.
        if (ready && ready.warm) calmUntil = performance.now() + 900;
        const ctx = mountIn(holder, push ? got.href : target.href, { visible: false });
        entry = adopt(holder, bar ? document.importNode(bar, true) : null, got.doc.title, got.href, ctx);
        fresh = true;
      }
    }
    if (leaving && leaving !== entry) {
      leaving.scrollY = window.scrollY;
      if (leaving.ctx) leaving.ctx.hide();
    }
    current = entry;
    const url = push ? (entry.ctx ? entry.ctx.href : entry.href) : target.href;
    if (push) history.pushState({ afs: 1 }, "", url);
    if (entry.ctx && !push) entry.ctx.href = url;
    await show(entry);
    document.documentElement.classList.add("afa-nav");
    if (entry.ctx) {
      entry.ctx.visible = true;
      if (!fresh) {
        calmUntil = performance.now() + 4000; // its refresh, if any, swaps numbers without fanfare
        entry.ctx.show();
      }
    }
    if (fresh && window.afsEnhance) window.afsEnhance(entry.holder);
    if (target.hash) document.getElementById(target.hash.slice(1))?.scrollIntoView();
    else window.scrollTo(0, push && fresh ? 0 : entry.scrollY || 0);
    main.focus({ preventScroll: true });
    schedulePrefetch();
  }

  // The project's other tabs, once this page has settled.
  let prefetchTimer = 0;
  function schedulePrefetch() {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => {
      const run = () => {
        const links = [...document.querySelectorAll(".ptabs a[href], a.pcard[href]")].slice(0, 8);
        let i = 0;
        const next = () => {
          if (i >= links.length) return;
          const href = links[i++].href;
          const path = resolve(keyOf(href));
          if (pages.has(path) || fetched.has(path)) return next();
          getPage(href, { bg: true })
            .then((got) => got && warm(got))
            .finally(() => setTimeout(next, 150));
        };
        next();
      };
      if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 3000 });
      else run();
    }, 1200);
  }

  const isDashLink = (a) => {
    if (!a || !a.href || (a.target && a.target !== "_self") || a.hasAttribute("download")) return null;
    const u = new URL(a.href, location.href);
    if (u.origin !== location.origin || !u.pathname.startsWith("/dashboard")) return null;
    if (u.pathname === location.pathname && u.search === location.search && u.hash) return null; // an anchor on this page
    return u;
  };
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest("a[href]");
    const u = isDashLink(a);
    if (!u) return;
    e.preventDefault();
    navigate(u.href);
  });
  // Hovering (or focusing) a link fetches its page.
  let hoverTimer = 0;
  const intent = (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    const u = isDashLink(a);
    if (!u) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => prefetch(u.href), 60);
  };
  document.addEventListener("pointerover", intent);
  document.addEventListener("focusin", intent);
  window.addEventListener("popstate", () => navigate(location.href, { push: false }));

  // This page: wrap its content so it can be kept, start its view, then look ahead.
  main.setAttribute("tabindex", "-1");
  const first = document.createElement("div");
  first.className = "nav-page";
  for (const n of [...main.childNodes]) first.append(n);
  main.append(first);
  history.replaceState({ afs: 1 }, "", location.href);
  // A copy of this page's top bar: the live one's switcher changes as you move between pages.
  const firstBar = document.querySelector("header.topbar");
  current = adopt(first, firstBar ? firstBar.cloneNode(true) : null, document.title, location.href, mountIn(first, location.href));
  schedulePrefetch();
})();
