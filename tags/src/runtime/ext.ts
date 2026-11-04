import type { Trigger } from "../config/schema";
import { CLICK_IDS } from "../lib/clickids";
import type { RawUserData } from "../lib/pii";
import { tcfConsent } from "../lib/consent";
import { LINK_PARAM, linkerValue, readLinker } from "../lib/linker";
import type { Ext, Runtime } from "./core";
import type { EventCtx } from "./types";
import { closest, matches } from "./util";

/**
 * Optional runtime features, bundled separately (dist/runtime-ext.txt) and served only to
 * containers that use them (service/script.ts needsExt): video and js_error triggers,
 * wait_for_tags_ms, cross-domain linking (settings.cross_domain), IAB TCF v2 (consent.tcf) and
 * conversions[].user_data "auto".
 */

type AnyFn = (...a: unknown[]) => unknown;
type W = Window & Record<string, unknown>;

// ------------------------------------------------------------------ cross-domain linking

const hostMatch = (host: string, list: string[]) =>
  list.some((x) => (x.slice(0, 2) === "*." ? host === x.slice(2) || host.slice(-(x.length - 1)) === x.slice(1) : host === x));

function linkIdentity(rt: Runtime) {
  const w = rt.w;
  if (!rt.cfg.settings?.cross_domain?.length) return;
  let u: URL;
  try {
    u = new URL(w.location.href);
  } catch {
    return;
  }
  const raw = u.searchParams.get(LINK_PARAM);
  if (!raw) return;
  const got = readLinker(raw, (w.navigator as Navigator)?.userAgent ?? "", Date.now());
  if (got) {
    // A visitor who already has an id here keeps it; click ids fill in what this site lacks.
    if (rt.newVisitor && got.v && /^[A-Za-z0-9_.-]{6,64}$/.test(got.v)) {
      rt.visitorId = got.v;
      rt.newVisitor = false;
    }
    for (const k of CLICK_IDS) {
      const v = got.c?.[k];
      if (typeof v === "string" && !rt.clickIds[k] && /^[A-Za-z0-9._~-]{4,500}$/.test(v)) rt.clickIds[k] = v;
    }
    rt.log("info", "cross-domain link: identity carried over", { visitor_id: rt.visitorId, click_ids: Object.keys(got.c ?? {}) });
  } else rt.log("warn", "cross-domain link parameter expired or not from this browser; ignored");
  u.searchParams.delete(LINK_PARAM);
  try {
    w.history.replaceState(w.history.state, "", u.pathname + u.search + u.hash);
  } catch {
    /* ignore */
  }
}

function linkListeners(rt: Runtime) {
  const w = rt.w;
  const hosts = rt.cfg.settings?.cross_domain ?? [];
  if (!hosts.length) return;
  const value = () =>
    rt.canStore()
      ? linkerValue(
          { v: rt.visitorId, ...(rt.consent.ad_storage === "granted" && Object.keys(rt.clickIds).length ? { c: rt.clickIds } : {}) },
          (w.navigator as Navigator)?.userAgent ?? "",
          Date.now(),
        )
      : null;
  const decorate = (href: string): string | null => {
    let u: URL;
    try {
      u = new URL(href, w.location.href);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(u.protocol) || u.hostname === w.location.hostname || !hostMatch(u.hostname, hosts)) return null;
    const v = value();
    if (!v) return null;
    u.searchParams.set(LINK_PARAM, v);
    return u.href;
  };
  const onLink = (e: Event) => {
    const a = closest(e.target as Element, "a[href]") as HTMLAnchorElement | null;
    const next = a && decorate(a.href);
    if (next) a!.href = next;
  };
  rt.d.addEventListener("mousedown", onLink, true);
  rt.d.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && onLink(e), true);
  rt.d.addEventListener("click", onLink, true);
  if (rt.cfg.settings?.cross_domain_forms)
    rt.d.addEventListener(
      "submit",
      (e) => {
        const f = e.target as HTMLFormElement;
        const next = f && decorate(f.getAttribute("action") || "");
        if (!next) return;
        if ((f.getAttribute("method") || "get").toLowerCase() === "get") {
          let input = f.querySelector(`input[name=${LINK_PARAM}]`) as HTMLInputElement | null;
          if (!input) {
            input = rt.d.createElement("input");
            input.type = "hidden";
            input.name = LINK_PARAM;
            f.appendChild(input);
          }
          input.value = new URL(next).searchParams.get(LINK_PARAM) ?? "";
        } else f.setAttribute("action", next);
      },
      true,
    );
}

// ------------------------------------------------------------------ IAB TCF v2

function tcf(rt: Runtime) {
  if (!rt.cfg.consent?.tcf) return;
  const w = rt.w;
  const attach = (tries: number) => {
    const api = w.__tcfapi as AnyFn | undefined;
    if (typeof api !== "function") {
      if (tries < 20) w.setTimeout(() => attach(tries + 1), 250);
      else rt.log("warn", "consent.tcf is on but the page has no __tcfapi (TCF CMP)");
      return;
    }
    api("addEventListener", 2, (td: Record<string, unknown> | null, ok: boolean) => {
      if (!ok || !td) return;
      rt.tcf = { gdpr_applies: !!td.gdprApplies, tc_string: typeof td.tcString === "string" ? td.tcString.slice(0, 2000) : undefined };
      if (td.gdprApplies && (td.eventStatus === "tcloaded" || td.eventStatus === "useractioncomplete"))
        rt.updateConsent(tcfConsent(td as never), `TCF (${td.eventStatus})`);
    });
  };
  attach(0);
}

// ------------------------------------------------------------------ wait_for_tags_ms

function waitForTags(rt: Runtime, ctx: EventCtx, fired: Record<string, EventCtx>) {
  const ev = ctx.ev as (MouseEvent & { defaultPrevented: boolean }) | undefined;
  if (!ev || ev.defaultPrevented || (ctx.type !== "click" && ctx.type !== "form_submit")) return;
  let wait = 0;
  for (const t of rt.cfg.triggers)
    if (fired[t.id] && t.type === ctx.type && (t.type === "click" || t.type === "form_submit"))
      wait = Math.max(wait, t.wait_for_tags_ms ?? 0);
  if (!wait) return;
  const w = rt.w;
  let resume: () => void;
  if (ctx.type === "click") {
    const a = closest(ctx.el, "a[href]") as HTMLAnchorElement | null;
    const newWindow = (a?.getAttribute("target") || "_self") !== "_self";
    if (!a || newWindow || ev.button || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || a.getAttribute("download") !== null) return;
    if (!/^https?:/.test(a.href)) return;
    resume = () => {
      w.location.href = a.href;
    };
  } else {
    const f = ctx.form as HTMLFormElement | null;
    if (!f || (f.getAttribute("target") || "_self") !== "_self") return;
    // The prototype's submit(): a field named "submit" can't shadow it, and it doesn't re-fire submit.
    resume = () => (w.HTMLFormElement as unknown as typeof HTMLFormElement).prototype.submit.call(f);
  }
  ev.preventDefault();
  const start = Date.now();
  rt.log("info", `holding ${ctx.type} up to ${wait}ms for tags`);
  const tick = () => {
    const pending = Object.keys(rt.scripts).some((s) => rt.scripts[s] === "pending");
    if (pending && Date.now() - start < wait) w.setTimeout(tick, 50);
    else resume();
  };
  w.setTimeout(tick, 50);
}

// ------------------------------------------------------------------ video (YouTube + HTML5)

type VideoInfo = { url?: string; title?: string; duration?: number; current?: number; el: Element };

function video(rt: Runtime) {
  const trigs = rt.cfg.triggers.filter((t): t is Extract<Trigger, { type: "video" }> => t.type === "video");
  if (!trigs.length) return;
  const w = rt.w;
  const d = rt.d;
  const visible = (el: Element) => {
    try {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.right > 0 && r.top < w.innerHeight && r.left < w.innerWidth;
    } catch {
      return false;
    }
  };
  const report = (provider: string, status: string, info: VideoInfo, marks: Record<string, boolean>) => {
    const pct = info.duration ? Math.round(((info.current ?? 0) / info.duration) * 100) : 0;
    for (const t of trigs) {
      if ((t.providers && t.providers.indexOf(provider as "youtube") === -1) || t.statuses.indexOf(status as "start") === -1) continue;
      if (t.selector && !matches(info.el, t.selector)) continue;
      const fire = (percent: number) =>
        rt.emit(
          rt.ctx("video", "video", {
            triggerId: t.id,
            el: info.el,
            vars: {
              video_provider: provider,
              video_status: status,
              video_url: info.url,
              video_title: info.title,
              video_duration: info.duration,
              video_current_time: info.current,
              video_percent: percent,
              video_visible: visible(info.el),
            },
          }),
        );
      if (status !== "progress") fire(pct);
      else
        for (const p of t.percentages ?? []) {
          const key = `${t.id}:${p}`;
          if (pct >= p && !marks[key]) {
            marks[key] = true;
            fire(p);
          }
        }
    }
  };

  // HTML5 media events don't bubble, but they reach the document in the capture phase.
  if (trigs.some((t) => !t.providers || t.providers.indexOf("html5") !== -1)) {
    const state = new WeakMap<Element, { started?: boolean; marks: Record<string, boolean> }>();
    const on = (type: string, status: (v: HTMLVideoElement, s: { started?: boolean }) => string | null) =>
      d.addEventListener(
        type,
        (e) => {
          const v = e.target as HTMLVideoElement;
          if (!v || v.tagName !== "VIDEO") return;
          const s = state.get(v) ?? { marks: {} };
          state.set(v, s);
          const st = status(v, s);
          if (st)
            report(
              "html5",
              st,
              {
                url: v.currentSrc || v.src,
                title: v.getAttribute("title") ?? undefined,
                duration: v.duration,
                current: v.currentTime,
                el: v,
              },
              s.marks,
            );
        },
        true,
      );
    on("play", (_, s) => (s.started ? null : ((s.started = true), "start")));
    on("pause", (v) => (v.ended ? null : "pause"));
    on("seeked", () => "seek");
    on("ended", () => "complete");
    on("timeupdate", () => "progress");
  }

  if (trigs.some((t) => !t.providers || t.providers.indexOf("youtube") !== -1)) {
    const done = new WeakSet<Element>();
    type Player = {
      getCurrentTime(): number;
      getDuration(): number;
      getVideoUrl(): string;
      getVideoData?(): { title?: string };
    };
    const attach = () => {
      const YT = w.YT as { Player?: new (el: Element, o: unknown) => Player } | undefined;
      if (!YT || !YT.Player) return;
      const frames = d.querySelectorAll('iframe[src*="youtube.com/embed"],iframe[src*="youtube-nocookie.com/embed"]');
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i]!;
        if (done.has(f)) continue;
        done.add(f);
        const marks: Record<string, boolean> = {};
        let started = false;
        let timer: number | undefined;
        let last = 0;
        let lastAt = 0;
        const info = (p: Player): VideoInfo => ({
          url: p.getVideoUrl(),
          title: p.getVideoData?.().title,
          duration: p.getDuration(),
          current: p.getCurrentTime(),
          el: f,
        });
        const player: Player = new YT.Player(f, {
          events: {
            onStateChange: (e: { data: number }) => {
              w.clearInterval(timer);
              if (e.data === 1) {
                if (!started) report("youtube", "start", info(player), marks);
                started = true;
                last = player.getCurrentTime();
                lastAt = Date.now();
                timer = w.setInterval(() => {
                  const now = player.getCurrentTime();
                  // A jump of more than 2s beyond the elapsed time is a seek.
                  if (Math.abs(now - last - (Date.now() - lastAt) / 1000) > 2) report("youtube", "seek", info(player), marks);
                  last = now;
                  lastAt = Date.now();
                  report("youtube", "progress", info(player), marks);
                }, 1000) as unknown as number;
              } else if (e.data === 2) report("youtube", "pause", info(player), marks);
              else if (e.data === 0) report("youtube", "complete", info(player), marks);
            },
          },
        });
      }
    };
    const scan = () => {
      const frames = d.querySelectorAll('iframe[src*="youtube.com/embed"],iframe[src*="youtube-nocookie.com/embed"]');
      if (!frames.length) return;
      // The iframe API needs enablejsapi=1 (GTM's "Add JavaScript API support"); setting it reloads the frame.
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i] as HTMLIFrameElement;
        if (!/[?&]enablejsapi=1/.test(f.src))
          f.src = `${f.src}${f.src.indexOf("?") === -1 ? "?" : "&"}enablejsapi=1&origin=${encodeURIComponent(w.location.origin)}`;
      }
      const YT = w.YT as { Player?: unknown } | undefined;
      if (YT && YT.Player) return attach();
      const prev = w.onYouTubeIframeAPIReady as (() => void) | undefined;
      w.onYouTubeIframeAPIReady = () => {
        if (typeof prev === "function") prev();
        attach();
      };
      rt.loadScript("https://www.youtube.com/iframe_api");
    };
    if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", scan);
    else scan();
    w.addEventListener("load", scan);
  }
}

// ------------------------------------------------------------------ js_error

const MAX_JS_ERRORS = 10;

function jsErrors(rt: Runtime) {
  if (!rt.has("js_error")) return;
  let n = 0;
  const err = (vars: Record<string, unknown>) => {
    if (n++ < MAX_JS_ERRORS) rt.emit(rt.ctx("js_error", "js_error", { vars }));
  };
  rt.w.addEventListener("error", (e) => {
    const ev = e as ErrorEvent;
    if (ev.message) err({ error_message: String(ev.message).slice(0, 300), error_url: ev.filename, error_line: ev.lineno });
  });
  rt.w.addEventListener("unhandledrejection", (e) => {
    const r = (e as PromiseRejectionEvent).reason as { message?: unknown } | undefined;
    err({ error_message: String(r && r.message !== undefined ? r.message : r).slice(0, 300) });
  });
}

// ------------------------------------------------------------------ user_data "auto"

/** The first email and the first phone field with a value in `root` (the submitted form, or the page). */
export function autoUserData(root: ParentNode): RawUserData {
  const out: RawUserData = {};
  let inputs: ArrayLike<Element> = [];
  try {
    inputs = root.querySelectorAll("input");
  } catch {
    /* ignore */
  }
  for (let i = 0; i < inputs.length; i++) {
    const el = inputs[i] as HTMLInputElement;
    const v = typeof el.value === "string" ? el.value.trim() : "";
    if (!v) continue;
    const type = (el.getAttribute("type") || "").toLowerCase();
    const hint = `${el.getAttribute("name") || ""} ${el.getAttribute("id") || ""} ${el.getAttribute("autocomplete") || ""}`;
    if (!out.email && (type === "email" || /e-?mail/i.test(hint)) && v.indexOf("@") > 0) out.email = v;
    else if (!out.phone && (type === "tel" || /phone|tel|mobile/i.test(hint)) && /\d{6}/.test(v.replace(/\D/g, ""))) out.phone = v;
  }
  return out;
}

export const ext: Ext = {
  identity: linkIdentity,
  listeners(rt) {
    linkListeners(rt);
    tcf(rt);
    video(rt);
    jsErrors(rt);
  },
  emitted: waitForTags,
  autoUserData,
};

export type { W };
