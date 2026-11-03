import { describe, expect, it } from "vitest";
import { detectRage, errorClicks, excessiveScroll, frustrationScore, quickBacks } from "../../src/lib/signals";

const c = (ts: number, selector = "#pay", x = 100, y = 100, pv = 1) => ({ ts, pv, selector, x, y });

describe("rage clicks", () => {
  it(">= 3 clicks within 1 s on the same element is one burst", () => {
    const r = detectRage([c(0), c(300), c(600)]);
    expect(r.rage).toEqual([true, true, true]);
    expect(r.start).toEqual([true, false, false]);
  });
  it("two clicks, or three spread over more than 1 s, are not rage", () => {
    expect(detectRage([c(0), c(300)]).rage).toEqual([false, false]);
    expect(detectRage([c(0), c(600), c(1200)]).rage).toEqual([false, false, false]);
  });
  it("a long burst stays one burst; a pause starts a new one", () => {
    const r = detectRage([c(0), c(400), c(800), c(1200), c(1600), c(5000), c(5200), c(5400)]);
    expect(r.rage.every(Boolean)).toBe(true);
    expect(r.start).toEqual([true, false, false, false, false, true, false, false]);
  });
  it("same element by selector, or a different selector within 30 px; other elements and pageviews don't count", () => {
    expect(detectRage([c(0, "#a", 10, 10), c(200, "#b", 30, 20), c(400, "#c", 15, 25)]).rage).toEqual([true, true, true]);
    expect(detectRage([c(0, "#a", 10, 10), c(200, "#b", 300, 20), c(400, "#c", 600, 25)]).rage).toEqual([false, false, false]);
    expect(detectRage([c(0, "#a", 0, 0, 1), c(200, "#a", 0, 0, 2), c(400, "#a", 0, 0, 3)]).rage).toEqual([false, false, false]);
  });
  it("interleaved bursts on two elements are counted separately", () => {
    const r = detectRage([
      c(0, "#a", 0, 0),
      c(100, "#b", 500, 0),
      c(200, "#a", 0, 0),
      c(300, "#b", 500, 0),
      c(400, "#a", 0, 0),
      c(500, "#b", 500, 0),
    ]);
    expect(r.rage.every(Boolean)).toBe(true);
    expect(r.start.filter(Boolean)).toHaveLength(2);
  });
});

describe("error clicks", () => {
  it("an error within 1 s after a click links to the latest click before it", () => {
    const r = errorClicks([{ ts: 0 }, { ts: 500 }, { ts: 5000 }], [{ ts: 700 }, { ts: 3000 }, { ts: 5000 }]);
    expect(r.clickHit).toEqual([false, true, true]);
    expect(r.errorClick).toEqual([1, -1, 2]);
  });
  it("errors before any click are not error clicks", () => {
    expect(errorClicks([{ ts: 1000 }], [{ ts: 500 }]).errorClick).toEqual([-1]);
  });
});

describe("quick backs", () => {
  const p = (pv: number, ts: number, path: string) => ({ pv, ts, path });
  it("A -> B -> A within 7 s flags B", () => {
    expect(quickBacks([p(1, 0, "/pricing"), p(2, 10_000, "/enterprise"), p(3, 13_000, "/pricing")])).toEqual([false, true, false]);
  });
  it("staying longer, going somewhere else, or reloading are not quick backs", () => {
    expect(quickBacks([p(1, 0, "/a"), p(2, 1000, "/b"), p(3, 9000, "/a")])).toEqual([false, false, false]);
    expect(quickBacks([p(1, 0, "/a"), p(2, 1000, "/b"), p(3, 2000, "/c")])).toEqual([false, false, false]);
    expect(quickBacks([p(1, 0, "/a"), p(2, 1000, "/a"), p(3, 2000, "/a")])).toEqual([false, false, false]);
  });
});

describe("excessive scrolling", () => {
  it("needs repeated reversals and a long distance on a scrollable page", () => {
    expect(excessiveScroll({ dist: 6000, reversals: 5, doc_h: 3000, view_h: 900 })).toBe(true);
    expect(excessiveScroll({ dist: 6000, reversals: 2, doc_h: 3000, view_h: 900 })).toBe(false);
    expect(excessiveScroll({ dist: 3000, reversals: 6, doc_h: 3000, view_h: 900 })).toBe(false);
    expect(excessiveScroll({ dist: 9000, reversals: 9, doc_h: 1000, view_h: 900 })).toBe(false); // barely scrollable
    expect(excessiveScroll({ dist: 9000, reversals: 9, doc_h: null, view_h: null })).toBe(false);
  });
});

describe("frustration score", () => {
  const zero = { rage_clicks: 0, dead_clicks: 0, dead_interactive: 0, error_clicks: 0, errors: 0, quick_backs: 0, excessive_scrolls: 0 };
  it("is 0 for a calm session and capped at 100", () => {
    expect(frustrationScore(zero)).toBe(0);
    expect(frustrationScore({ ...zero, rage_clicks: 9 })).toBe(100);
  });
  it("weights rage and error clicks over plain dead clicks on text", () => {
    expect(frustrationScore({ ...zero, rage_clicks: 1 })).toBe(25);
    expect(frustrationScore({ ...zero, error_clicks: 1, errors: 1 })).toBe(28);
    expect(frustrationScore({ ...zero, dead_clicks: 3, dead_interactive: 0 })).toBe(6);
    expect(frustrationScore({ ...zero, dead_clicks: 3, dead_interactive: 3 })).toBe(30);
    expect(frustrationScore({ ...zero, dead_clicks: 50 })).toBe(10);
    expect(frustrationScore({ ...zero, errors: 20 })).toBe(32);
  });
});
