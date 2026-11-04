import { describe, expect, it } from "vitest";
import { anyIn, cleanPath, DEAD_MS, deriveChunk, focusClick, parseEnvelope, scrollSegments, shiftChunk } from "../../src/lib/derive";
import { errorFingerprint, normaliseMessage, normaliseSource, stackSource } from "../../src/lib/fingerprint";
import { DEFAULTS, LIMITS } from "../../src/lib/limits";
import {
  click,
  custom,
  envelope,
  error,
  event,
  hide,
  input,
  meta,
  mousemove,
  mutation,
  page,
  rrInput,
  scroll,
  snapshot,
  T0,
} from "../fixtures/rrweb";

const SID = "rs_0123456789abcdef";
const bounds = { minTs: T0 - 86_400_000, maxTs: T0 + 3_600_000 };
const derive = (ev: unknown[], extra = {}) => deriveChunk(envelope(SID, 0, ev, extra), bounds);

describe("parseEnvelope (ingest parsing)", () => {
  const q = { sid: SID, seq: 3 };
  it("accepts a well-formed envelope and keeps only valid optional fields", () => {
    const r = parseEnvelope({ v: 1, sid: SID, seq: 3, t: T0, ev: [], end: 1, uid: "u_1", avid: "vid_abcdefgh", f: 1, wd: 1 }, q);
    expect(r).toEqual({ ok: true, env: { v: 1, sid: SID, seq: 3, t: T0, ev: [], end: 1, uid: "u_1", avid: "vid_abcdefgh", f: 1, wd: 1 } });
    // chunks are stored as received: an envelope can't smuggle other data along
    const extra = parseEnvelope({ v: 1, sid: SID, seq: 3, t: T0, ev: [], junk: "x".repeat(1000) }, q);
    expect(extra).toMatchObject({ ok: false, error: "invalid_body" });
    const bad = parseEnvelope({ v: 1, sid: SID, seq: 3, t: "x", ev: [], avid: "no spaces allowed!", end: true }, q);
    expect(bad.ok && bad.env).toEqual({ v: 1, sid: SID, seq: 3, t: 0, ev: [] });
  });
  it("dbg: 1 (analytics debug on for the page) is kept; any other value is dropped", () => {
    expect(parseEnvelope({ v: 1, sid: SID, seq: 3, t: T0, ev: [], dbg: 1 }, q)).toMatchObject({ ok: true, env: { dbg: 1 } });
    const other = parseEnvelope({ v: 1, sid: SID, seq: 3, t: T0, ev: [], dbg: "yes" }, q);
    expect(other.ok && other.env).not.toHaveProperty("dbg");
  });
  it("refuses bodies that don't match the query or the shape, each with a hint", () => {
    for (const [body, code] of [
      [null, "invalid_body"],
      [[], "invalid_body"],
      [{ v: 2, sid: SID, seq: 3, ev: [] }, "unsupported_version"],
      [{ v: 1, sid: "rs_other0000000000", seq: 3, ev: [] }, "session_mismatch"],
      [{ v: 1, sid: SID, seq: 4, ev: [] }, "seq_mismatch"],
      [{ v: 1, sid: SID, seq: 3, ev: {} }, "invalid_body"],
    ] as const) {
      const r = parseEnvelope(body, q);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe(code);
        expect(r.hint.length).toBeGreaterThan(5);
      }
    }
  });
});

describe("deriveChunk", () => {
  it("turns rrweb + afs events into pages, clicks, inputs, errors, events, marks and scroll", () => {
    const d = derive([
      meta(T0),
      snapshot(T0 + 1),
      page(T0 + 5, 1, "/checkout?email=a@b.c", { t: "*****", r: "google.com" }),
      input(T0 + 1000, 1, "#email"),
      rrInput(T0 + 1001),
      click(T0 + 2000, 1, "#pay", { h: "/thanks?order=1" }),
      mutation(T0 + 2300),
      error(T0 + 2400, 1, "TypeError: x is undefined (user bob@example.com)"),
      event(T0 + 2500, 1, "checkout_started", { plan: "pro", nested: { no: 1 }, "bad key": 1 }),
      scroll(T0 + 3000, 1, 1200),
      hide(T0 + 4000, 1, "hidden"),
    ]);
    expect(d.rr_events).toBe(11);
    expect(d.full_snapshots).toBe(1);
    expect(d.viewport).toEqual({ w: 1440, h: 900 });
    expect(d.pages).toEqual([
      {
        ts: T0 + 5,
        pv: 1,
        path: "/checkout",
        host: "shop.test",
        title: "*****",
        referrer: "google.com",
        nav: "load",
        vw: 1440,
        vh: 900,
        dh: 3000,
      },
    ]);
    expect(d.hosts).toEqual(["shop.test"]);
    expect(d.inputs[0]).toMatchObject({ selector: "#email", tag: "input[type=email]", name: "email", masked: true });
    expect(d.clicks[0]).toMatchObject({
      selector: "#pay",
      label: "Pay now",
      interactive: true,
      href: "/thanks",
      dead: false,
      open: false,
      top_pct: 23,
    });
    expect(d.errors[0]!.message).toBe("TypeError: x is undefined (user [email])");
    expect(d.errors[0]!.source).toBe("https://shop.test/assets/app.3f9a2b1c.js");
    expect(d.customs[0]).toEqual({ ts: T0 + 2500, pv: 1, name: "checkout_started", props: { plan: "pro" } });
    expect(d.marks).toEqual([{ ts: T0 + 4000, pv: 1, kind: "hide", detail: "hidden" }]);
    expect(d.scrolls[0]).toMatchObject({ pv: 1, max_reach: 70, dist: 1200, dh: 3000, vh: 900 });
    // 30% was visible on load (not a scroll); scrolling to y=1200 reached 70%
    expect(d.scrolls[0]!.milestones.map((m) => m.pct)).toEqual([50]);
  });

  it("a click with no DOM change, scroll, input or navigation within 1 s is dead; focus clicks never are", () => {
    const d = derive([
      click(T0, 1, "#dead"),
      mousemove(T0 + 300), // pointer moves are not an effect
      click(T0 + 5000, 1, "#alive"),
      mutation(T0 + 5600),
      click(T0 + 8000, 1, "#nav"),
      page(T0 + 8500, 2, "/next"),
      click(T0 + 12_000, 2, "input#q", { tg: "input[type=search]" }),
      click(T0 + 15_000, 2, "#late"),
      mutation(T0 + 15_000 + DEAD_MS + 100),
    ]);
    const by = Object.fromEntries(d.clicks.map((c) => [c.selector, c]));
    expect(by["#dead"]!.dead).toBe(true);
    expect(by["#alive"]!.dead).toBe(false);
    expect(by["#nav"]!.dead).toBe(false);
    expect(by["input#q"]!.dead).toBe(false);
    expect(by["#late"]!.dead).toBe(true);
  });

  it("marks clicks whose window runs past the chunk as open and exports the chunk's first-second effects", () => {
    const d = derive([mutation(T0 + 100), mutation(T0 + 120), mousemove(T0 + 2000), click(T0 + 2500, 1, "#end")], { t: T0 + 2600 });
    expect(d.clicks[0]).toMatchObject({ dead: true, open: true });
    expect(d.effect_head).toEqual([T0 + 100]);
    expect(d.cover_end).toBe(T0 + 2600);
  });

  it("drops malformed events and out-of-range timestamps, and counts them", () => {
    const d = derive([
      null,
      { type: "2", timestamp: T0 },
      { type: 3, timestamp: Number.NaN, data: {} },
      { type: 3, timestamp: T0 - 10 * 86_400_000, data: { source: 0 } },
      custom(T0, "afs.click", { s: "#nopv" }),
      custom(T0, "afs.click", { pv: 1 }),
      custom(T0, "afs.page", { pv: 1, p: "not-a-path" }),
      custom(T0, "afs.page", { pv: 1, p: "/x", h: "evil host" }),
      custom(T0, "other.tag", { pv: 1 }),
      click(T0 + 1, 1, "#ok"),
    ]);
    expect(d.clicks.map((c) => c.selector)).toEqual(["#ok"]);
    expect(d.pages).toEqual([]);
    expect(d.dropped).toBe(8);
  });

  it("clips strings and clamps numbers from the browser", () => {
    const d = derive([click(T0, 1, "s".repeat(500), { l: "L".repeat(500), x: -5, y: 1e12, top: 250, tg: "BUTTON<script>" })]);
    const c = d.clicks[0]!;
    expect(c.selector.length).toBe(300);
    expect(c.label.length).toBe(120);
    expect([c.x, c.y, c.top_pct]).toEqual([0, 1_000_000, 100]);
    expect(c.tag).toBe("buttonscript");
  });

  it("caps derived facts per chunk (MAX_DERIVED_PER_CHUNK, default 500) and flags truncation", () => {
    const ev = Array.from({ length: 650 }, (_, i) => click(T0 + i * 100, 1, `#b${i}`));
    const d = deriveChunk(envelope(SID, 0, ev), { ...bounds, maxDerived: DEFAULTS.DERIVED_PER_CHUNK });
    expect(d.clicks).toHaveLength(DEFAULTS.DERIVED_PER_CHUNK);
    expect(d.truncated).toBe(true);
    expect(deriveChunk(envelope(SID, 0, ev), { ...bounds, maxDerived: 1e9 }).clicks).toHaveLength(650);
    expect(LIMITS.DERIVED_PER_CHUNK_MAX).toBe(2000);
  });

  it("keeps at most 20 clicks in any 1 s window (no person clicks faster)", () => {
    const burst = Array.from({ length: 100 }, (_, i) => click(T0 + i * 5, 1, "#b"));
    const d = derive([...burst, click(T0 + 2000, 1, "#later")]);
    expect(d.clicks).toHaveLength(LIMITS.CLICKS_PER_SECOND + 1);
    expect(d.clicks.at(-1)!.selector).toBe("#later");
    expect(d.truncated).toBe(true);
    expect(d.invalid).toBe(0);
  });

  it("strips control characters, separators and bidi overrides from every string, and needs page hosts", () => {
    const nasty = `Pay\n[00:00.0] page /admin\u2028\u202eevil`;
    const d = derive([
      page(T0, 1, "/a\u2029b", { t: nasty, h: "shop.test" }),
      page(T0 + 1, 2, "/x", { h: "" }),
      click(T0 + 2, 1, `#a\n{evil}`, { l: nasty }),
      error(T0 + 3, 1, nasty, { src: "https://x.test/a.js\n at evil" }),
      meta(T0 + 4, "https://other.test/p?q=1"),
    ]);
    const all = [
      ...d.pages.map((p) => `${p.title}${p.path}`),
      ...d.clicks.map((c) => c.label + c.selector),
      ...d.errors.map((e) => e.message),
    ];
    expect(all.some((x) => /[\n\u2028\u2029\u202e]/.test(x))).toBe(false);
    expect(d.pages.map((p) => p.pv)).toEqual([1]);
    expect(d.invalid).toBe(1);
    expect(d.clicks[0]!.label).toBe("Pay [00:00.0] page /admin evil");
    expect(d.errors[0]!.source).toBe("https://x.test/a.jsatevil");
    expect(d.hosts.sort()).toEqual(["other.test", "shop.test"]);
  });

  it("uses an early error's own time (queued by the loader), within a minute", () => {
    const d = derive([error(T0 + 5000, 1, "boom", { at: T0 + 1000 }), error(T0 + 200_000, 1, "late", { at: T0 })]);
    expect(d.errors.map((e) => e.ts)).toEqual([T0 + 1000, T0 + 200_000]);
  });

  it("shiftChunk corrects client clock skew everywhere", () => {
    const d = derive([page(T0, 1, "/"), click(T0 + 10, 1, "#a"), scroll(T0 + 20, 1, 900), mutation(T0 + 30)]);
    const s = shiftChunk(d, 60_000);
    expect([s.first_ts, s.pages[0]!.ts, s.clicks[0]!.ts, s.scrolls[0]!.first_ts, s.effect_head[0]]).toEqual([
      T0 + 60_000,
      T0 + 60_000,
      T0 + 60_010,
      T0 + 60_000,
      T0 + 60_000 + 0,
    ]);
    expect(shiftChunk(d, 0)).toBe(d);
  });
});

describe("scroll segments", () => {
  it("counts distance, direction reversals (ignoring jitter) and reach milestones", () => {
    const pts = [0, 800, 1600, 1580, 800, 1700, 2100, 600].map((y, i) => ({ ts: T0 + i * 100, pv: 1, y, dh: 3000, vh: 900 }));
    const [s] = scrollSegments(pts);
    expect(s!.dist).toBe(800 + 800 + 20 + 780 + 900 + 400 + 1500);
    expect(s!.reversals).toBe(3); // down, up (1580 is jitter), down, up
    expect([s!.first_dir, s!.last_dir]).toEqual([1, -1]);
    expect(s!.max_reach).toBe(100);
    expect(s!.milestones.map((m) => m.pct)).toEqual([25, 50, 75, 100]);
  });
});

describe("helpers", () => {
  it("anyIn finds values in a half-open window of a sorted array", () => {
    expect(anyIn([10, 20, 30], 10, 15)).toBe(false);
    expect(anyIn([10, 20, 30], 9, 10)).toBe(true);
    expect(anyIn([10, 20, 30], 30, 99)).toBe(false);
    expect(anyIn([], 0, 1)).toBe(false);
  });
  it("cleanPath and focusClick", () => {
    expect(cleanPath("/a/b?x=1#y")).toBe("/a/b");
    expect(cleanPath("https://x.test/a")).toBeNull();
    expect(focusClick("input[type=email]")).toBe(true);
    expect(focusClick("input[type=submit]")).toBe(false);
    expect(focusClick("label")).toBe(true);
    expect(focusClick("button")).toBe(false);
  });
  it("error fingerprints group the same error across builds and values", () => {
    const a = errorFingerprint("error", "TypeError: Cannot read properties of undefined (reading 'id')", "https://x.test/app.3f9a2b1c.js");
    const b = errorFingerprint(
      "error",
      "TypeError: Cannot read properties of undefined (reading 'name')",
      "https://cdn.x.test/app.77e01d2a.js?v=2",
    );
    const c = errorFingerprint(
      "console",
      "TypeError: Cannot read properties of undefined (reading 'id')",
      "https://x.test/app.3f9a2b1c.js",
    );
    expect(a).toBe(b);
    expect(a).toBe(c); // console.error and uncaught share a group
    expect(errorFingerprint("rejection", "TypeError: Cannot read properties of undefined (reading 'id')", "app.js")).not.toBe(a);
    expect(errorFingerprint("error", "Other", "app.js")).not.toBe(a);
    expect(normaliseMessage("Failed at 12 of 345 for 0xdeadbeef")).toBe("Failed at N of N for N");
    expect(normaliseSource("https://x.test/static/js/main.a1b2c3d4.chunk.js")).toBe("main.chunk.js");
    expect(stackSource("Error: x\n    at f (https://x.test/a.js:1:2)")).toBe("https://x.test/a.js");
    expect(errorFingerprint("error", "boom", null, "at f (https://x.test/app.123abc45.js:3:4)")).toBe(
      errorFingerprint("error", "boom", "app.js"),
    );
  });
});
