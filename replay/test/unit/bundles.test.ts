import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { QUEUE_STUB } from "../../src/service/install";

// The built bundles (pnpm test runs scripts/build-recorder.mjs first).
const LOADER = readFileSync(new URL("../../dist/loader.txt", import.meta.url), "utf8");
const RECORDER = readFileSync(new URL("../../dist/recorder.txt", import.meta.url), "utf8");
const PLAYER = readFileSync(new URL("../../dist/player.txt", import.meta.url), "utf8");

const SITE = "rsite_0123456789abcdef";
const CFG = {
  site: SITE,
  rec: "/recorder.abc123.js",
  sr: 1,
  mask: "strict",
  unmask: "",
  maskSel: "",
  block: "",
  ex: [],
  maxMs: 30 * 60_000,
  idleMs: 300_000,
  consent: false,
  errors: true,
  on: true,
  base: "https://replay.test",
};

/** A fake browser with just what the loader touches; returns what it did. */
function browser(
  opts: {
    cfg?: Partial<typeof CFG>;
    src?: string;
    search?: string;
    dnt?: boolean;
    gpc?: boolean;
    random?: number;
    session?: Record<string, string>;
    local?: Record<string, string>;
    now?: number;
    stubCalls?: string;
    dataLayer?: unknown[];
    /** more globals (e.g. a CMP's __tcfapi) */
    globals?: Record<string, unknown>;
  } = {},
) {
  const injected: { src: string; async: boolean }[] = [];
  const session: Record<string, string> = { ...(opts.session ?? {}) };
  const local: Record<string, string> = { ...(opts.local ?? {}) };
  const store = (m: Record<string, string>) => ({
    getItem: (k: string) => m[k] ?? null,
    setItem: (k: string, v: string) => (m[k] = v),
    removeItem: (k: string) => delete m[k],
  });
  class ErrorEvent {}
  const ctx: Record<string, unknown> = {
    JSON,
    Math: Object.assign(Object.create(Math), { random: () => opts.random ?? 0.5 }),
    Date: { now: () => opts.now ?? 1_800_000_000_000 },
    Uint8Array,
    crypto: { getRandomValues: (a: Uint8Array) => a.map((_, i) => i * 7) },
    ErrorEvent,
    location: { search: opts.search ?? "" },
    navigator: { doNotTrack: opts.dnt ? "1" : null, globalPrivacyControl: !!opts.gpc },
    sessionStorage: store(session),
    localStorage: store(local),
    setTimeout: (f: () => void) => f(),
    addEventListener: () => {},
    document: {
      currentScript: { src: opts.src ?? `https://replay.test/r/${SITE}.js` },
      readyState: "complete",
      head: { appendChild: (s: { src: string; async: boolean }) => injected.push({ src: s.src, async: s.async }) },
      createElement: () => ({ src: "", async: false }),
    },
  };
  ctx.window = ctx;
  if (opts.dataLayer) ctx.dataLayer = opts.dataLayer;
  Object.assign(ctx, opts.globals ?? {});
  if (opts.stubCalls) {
    runInNewContext(QUEUE_STUB.replace(/^<script>|<\/script>$/g, ""), ctx);
    runInNewContext(opts.stubCalls, ctx);
  }
  runInNewContext(`(function(){var __AFSR__=${JSON.stringify({ ...CFG, ...opts.cfg })};\n${LOADER}\n})();`, ctx);
  const afsr = ctx.afsr as ((...a: unknown[]) => void) & { sessionId: () => string | null; status: () => string };
  return { afsr, injected, session, ctx, boot: ctx.__afsrBoot as { queue: unknown[][] } | undefined };
}

describe("bundles", () => {
  // Raised from 3000 / 1500 for the parity release: survey loading and command routing (the widget
  // itself is lazy), Google Consent Mode, afsr('upgrade') and afsr('start') live in the loader
  // because they decide before the recorder loads. Raised from 3600 / 1800 in wave 2 for IAB TCF v2
  // consent (the __tcfapi listener, ~350 bytes): consent decides whether the recorder loads at all.
  it("stay small: loader < 3.95 KB (1.95 KB gzip), recorder < 32 KB gzip, player < 90 KB gzip", () => {
    expect(LOADER.length).toBeLessThan(3950);
    expect(gzipSync(LOADER).length).toBeLessThan(1950);
    expect(RECORDER.startsWith("/*! afs-replay recorder")).toBe(true);
    expect(gzipSync(RECORDER).length).toBeLessThan(32 * 1024);
    expect(PLAYER.startsWith("/*! afs-replay player")).toBe(true);
    expect(gzipSync(PLAYER).length).toBeLessThan(90 * 1024);
  });
  it("the recorder bundle carries the masking it promises", () => {
    // rrweb's mask-all-text switch, our built-in selectors, and the always-masked input rule.
    for (const s of [
      '"*"',
      "[data-afsr-unmask]",
      "[data-afsr-mask]",
      "[data-afsr-block]",
      "[data-afsr-ignore]",
      "data-afsr-survey", // pointer moves and clicks over the survey widget are dropped
      "one-time-code",
      "CompressionStream",
      "sendBeacon",
    ])
      expect(RECORDER).toContain(s);
    expect(RECORDER).not.toMatch(/document\.cookie/);
  });
});

describe("loader (/r/<site>.js)", () => {
  it("records a sampled tab: a per-tab session in sessionStorage, the recorder from its own base", () => {
    const b = browser();
    expect(b.afsr.status()).toBe("loading");
    expect(b.afsr.sessionId()).toMatch(/^rs_[0-9a-z]{16}$/);
    expect(b.injected).toEqual([{ src: "https://replay.test/recorder.abc123.js", async: true }]);
    const saved = JSON.parse(b.session[`afsr_${SITE}`]!);
    expect(saved).toMatchObject({ id: b.afsr.sessionId(), seq: 0, pv: 0, on: 1 });
    expect(b.ctx.document).not.toHaveProperty("cookie");
  });

  it("follows a first-party proxy prefix", () => {
    expect(browser({ src: `https://shop.test/_r/r/${SITE}.js` }).injected[0]!.src).toBe("https://shop.test/_r/recorder.abc123.js");
  });

  it("never records with Global Privacy Control or Do Not Track, when disabled, or opted out", () => {
    for (const [o, status] of [
      [{ gpc: true }, "dnt"],
      [{ dnt: true }, "dnt"],
      [{ cfg: { on: false } }, "disabled"],
      [{ local: { afsr_ignore: "1" } }, "ignored"],
    ] as const) {
      const b = browser(o as Parameters<typeof browser>[0]);
      expect(b.afsr.status()).toBe(status);
      expect(b.afsr.sessionId()).toBeNull();
      expect(b.injected).toHaveLength(0);
    }
  });

  it("samples per tab; ?afsr=1 forces recording (and marks it forced)", () => {
    const out = browser({ cfg: { sr: 0.1 }, random: 0.5 });
    expect(out.afsr.status()).toBe("not_sampled");
    expect(out.injected).toHaveLength(0);
    const forced = browser({ cfg: { sr: 0 }, search: "?utm_source=x&afsr=1" });
    expect(forced.afsr.status()).toBe("loading");
    expect(JSON.parse(forced.session[`afsr_${SITE}`]!)).toMatchObject({ on: 1, f: 1 });
  });

  it("continues the tab's session across page loads, starts a new one after 30 idle minutes", () => {
    const now = 1_800_000_000_000;
    const state = (last: number) => ({
      [`afsr_${SITE}`]: JSON.stringify({ id: "rs_aaaaaaaaaaaaaaaa", t0: last - 1000, last, seq: 7, pv: 3, on: 1 }),
    });
    expect(browser({ now, session: state(now - 60_000) }).afsr.sessionId()).toBe("rs_aaaaaaaaaaaaaaaa");
    expect(browser({ now, session: state(now - 31 * 60_000) }).afsr.sessionId()).not.toBe("rs_aaaaaaaaaaaaaaaa");
    const long = {
      [`afsr_${SITE}`]: JSON.stringify({ id: "rs_aaaaaaaaaaaaaaaa", t0: now - 31 * 60_000, last: now - 1000, seq: 7, pv: 3, on: 1 }),
    };
    const b = browser({ now, session: long });
    expect(b.afsr.status()).toBe("stopped:max_duration");
    expect(b.injected).toHaveLength(0);
  });

  it("with require_consent waits for afsr('consent', true); calls queued before load are kept", () => {
    const b = browser({ cfg: { consent: true } });
    expect(b.afsr.status()).toBe("consent_pending");
    expect(b.afsr.sessionId()).toBeNull();
    expect(b.injected).toHaveLength(0);
    b.afsr("consent", true);
    expect(b.injected).toHaveLength(1);
    const early = browser({ cfg: { consent: true }, stubCalls: "afsr('identify', 'u_9'); afsr('consent', true); afsr('event', 'x')" });
    expect(early.injected).toHaveLength(1);
    expect(early.boot!.queue).toEqual([
      ["identify", "u_9"],
      ["event", "x"],
    ]);
    const denied = browser({ cfg: { consent: true }, stubCalls: "afsr('consent', false)" });
    expect(denied.afsr.status()).toBe("stopped:consent");
    expect(denied.injected).toHaveLength(0);
  });
});

describe("loader: consent mode, upgrade, start (parity)", () => {
  it("consent_source gcm follows analytics_storage: default denied waits, an update granted starts", () => {
    const b = browser({ cfg: { consent: true, gcm: 1 } as never, dataLayer: [["consent", "default", { analytics_storage: "denied" }]] });
    expect(b.afsr.status()).toBe("consent_pending");
    expect(b.injected).toHaveLength(0);
    (b.ctx.dataLayer as { push: (...x: unknown[]) => void }).push(["consent", "update", { analytics_storage: "granted" }]);
    expect(b.injected).toHaveLength(1);
    const granted = browser({
      cfg: { consent: true, gcm: 1 } as never,
      dataLayer: [["consent", "default", { analytics_storage: "granted" }]],
    });
    expect(granted.injected).toHaveLength(1);
    // without gcm, dataLayer means nothing
    expect(
      browser({ cfg: { consent: true }, dataLayer: [["consent", "default", { analytics_storage: "granted" }]] }).injected,
    ).toHaveLength(0);
  });

  /** A fake IAB TCF v2 CMP: addEventListener calls back at once with `first`, then on every emit. */
  function cmp(first: Record<string, unknown>) {
    const listeners: ((t: unknown, ok: boolean) => void)[] = [];
    const calls: unknown[][] = [];
    const __tcfapi = (cmd: string, version: number, cb: (t: unknown, ok: boolean) => void) => {
      calls.push([cmd, version]);
      if (cmd === "addEventListener" && version === 2) {
        listeners.push(cb);
        cb(first, true);
      }
    };
    return { globals: { __tcfapi }, calls, emit: (t: Record<string, unknown>) => listeners.forEach((l) => l(t, true)) };
  }
  const yes = (...ids: number[]) => Object.fromEntries(ids.map((i) => [String(i), true]));
  const TCF = { consent: true, tcf: [1, 8] } as never;

  it("consent_source tcf: purposes 1 and 8 with consent start recording; the CMP's UI or a partial choice waits", () => {
    const loaded = cmp({ gdprApplies: true, eventStatus: "tcloaded", purpose: { consents: yes(1, 8) } });
    const b = browser({ cfg: TCF, globals: loaded.globals });
    expect(loaded.calls).toEqual([["addEventListener", 2]]);
    expect(b.injected).toHaveLength(1);

    const shown = cmp({ gdprApplies: true, eventStatus: "cmpuishown", purpose: { consents: yes(1, 8) } });
    const w = browser({ cfg: TCF, globals: shown.globals });
    expect(w.afsr.status()).toBe("consent_pending"); // the banner is up: not a choice yet
    shown.emit({ gdprApplies: true, eventStatus: "useractioncomplete", purpose: { consents: yes(1) } });
    expect(w.injected).toHaveLength(0); // purpose 8 refused
    shown.emit({ gdprApplies: true, eventStatus: "useractioncomplete", purpose: { consents: yes(1, 8) } });
    expect(w.injected).toHaveLength(1);
  });

  it("consent_source tcf: legitimate interest never counts; the publisher's own consents do; GDPR not applying records", () => {
    const li = cmp({
      gdprApplies: true,
      eventStatus: "tcloaded",
      purpose: { consents: yes(1), legitimateInterests: yes(8) },
    });
    expect(browser({ cfg: TCF, globals: li.globals }).injected).toHaveLength(0);
    const pub = cmp({ gdprApplies: true, eventStatus: "tcloaded", purpose: { consents: {} }, publisher: { consents: yes(1, 8) } });
    expect(browser({ cfg: TCF, globals: pub.globals }).injected).toHaveLength(1);
    const outside = cmp({ gdprApplies: false });
    expect(browser({ cfg: TCF, globals: outside.globals }).injected).toHaveLength(1);
    // tcf_purposes [1, 10]: purpose 8 alone isn't enough
    const custom = { consent: true, tcf: [1, 10] } as never;
    expect(
      browser({ cfg: custom, globals: cmp({ gdprApplies: true, eventStatus: "tcloaded", purpose: { consents: yes(1, 8) } }).globals })
        .injected,
    ).toHaveLength(0);
    expect(
      browser({ cfg: custom, globals: cmp({ gdprApplies: true, eventStatus: "tcloaded", purpose: { consents: yes(1, 10) } }).globals })
        .injected,
    ).toHaveLength(1);
  });

  it("consent_source tcf without a CMP on the page waits (no consent assumed); afsr('consent', true) still works", () => {
    const b = browser({ cfg: TCF });
    expect(b.afsr.status()).toBe("consent_pending");
    b.afsr("consent", true);
    expect(b.injected).toHaveLength(1);
    // without tcf in the config a CMP means nothing
    expect(browser({ cfg: { consent: true }, globals: cmp({ gdprApplies: false }).globals }).injected).toHaveLength(0);
  });

  it("afsr('upgrade', reason) records a tab that wasn't sampled in, also when called before the loader", () => {
    const b = browser({ cfg: { sr: 0 } });
    expect(b.afsr.status()).toBe("not_sampled");
    b.afsr("upgrade", "checkout_error");
    expect(b.injected).toHaveLength(1);
    expect(JSON.parse(b.session[`afsr_${SITE}`]!)).toMatchObject({ on: 1, up: "checkout_error" });
    const early = browser({ cfg: { sr: 0 }, stubCalls: "afsr('upgrade', 'vip')" });
    expect(early.injected).toHaveLength(1);
    // upgrade still waits for consent
    const c = browser({ cfg: { sr: 0, consent: true } });
    c.afsr("upgrade", "x");
    expect(c.afsr.status()).toBe("consent_pending");
  });

  it("afsr('start') resumes a tab stopped by afsr('stop') or consent, never one stopped by a limit", () => {
    const state = (stop: string) => ({
      [`afsr_${SITE}`]: JSON.stringify({
        id: "rs_aaaaaaaaaaaaaaaa",
        t0: 1_800_000_000_000 - 1000,
        last: 1_800_000_000_000 - 500,
        seq: 3,
        pv: 1,
        on: 1,
        stop,
      }),
    });
    const b = browser({ session: state("stop") });
    expect(b.afsr.status()).toBe("stopped:stop");
    b.afsr("start");
    expect(b.injected).toHaveLength(1);
    const limited = browser({ session: state("daily_session_limit") });
    limited.afsr("start");
    expect(limited.injected).toHaveLength(0);
    const denied = browser({ cfg: { consent: true }, stubCalls: "afsr('consent', false)" });
    expect(denied.afsr.status()).toBe("stopped:consent");
    denied.afsr("consent", true);
    expect(denied.injected).toHaveLength(1);
  });
});
