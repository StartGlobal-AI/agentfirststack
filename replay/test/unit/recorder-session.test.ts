import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

// The recorder (src/recorder/recorder.ts) bundled with rrweb's record replaced by a stub: starting
// a recording emits a meta event and a full snapshot (type 2), as rrweb does; custom events go to
// the same emit. That's enough to drive the recorder's session and upload logic without a DOM.
const RRWEB_STUB = `
const g = globalThis;
export const record = Object.assign(
  (o) => {
    g.__rec = o;
    g.__starts = (g.__starts || 0) + 1;
    o.emit({ type: 4, timestamp: Date.now(), data: { href: "https://shop.test/", width: 1, height: 1 } });
    o.emit({ type: 2, timestamp: Date.now(), data: { node: { type: 0, id: 1, childNodes: [] } } });
    return () => { g.__rec = null; };
  },
  {
    addCustomEvent: (tag, payload) => g.__rec && g.__rec.emit({ type: 5, timestamp: Date.now(), data: { tag, payload } }),
    mirror: { getNode: () => null },
  },
);`;

let RECORDER = "";
beforeAll(async () => {
  const out = await build({
    entryPoints: [new URL("../../src/recorder/recorder.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "iife",
    target: ["es2020"],
    logLevel: "silent",
    plugins: [
      {
        name: "rrweb-stub",
        setup(b) {
          b.onResolve({ filter: /^@rrweb\/record$/ }, () => ({ path: "rrweb-stub", namespace: "stub" }));
          b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: RRWEB_STUB, loader: "js" }));
        },
      },
    ],
  });
  RECORDER = out.outputFiles[0]!.text;
});

const SITE = "rsite_0123456789abcdef";
const OLD = "rs_aaaaaaaaaaaaaaaa";

interface Sent {
  sid: string;
  q: number;
  env: { sid: string; seq: number; ev: { type: number; data: { tag?: string; payload?: { pv?: number } } }[] };
}

/** A fake page running the recorder for a tab whose session (OLD, 3 chunks sent) came from an earlier page load. */
function page(answer: (n: number, sent: Sent) => Record<string, unknown>, opts: { hold?: boolean } = {}) {
  const sent: Sent[] = [];
  /** with hold: answers wait here until the test releases them */
  const held: (() => void)[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let rnd = 0;
  const session: Record<string, string> = {};
  const now = Date.now();
  const S = { id: OLD, t0: now - 60_000, last: now - 1000, seq: 3, pv: 2, on: 1 as const };
  const boot = {
    C: {
      site: SITE,
      rec: "/recorder.x.js",
      sr: 1,
      mask: "strict",
      unmask: "",
      maskSel: "",
      block: "",
      ex: [],
      maxMs: 1_800_000,
      idleMs: 300_000,
    },
    S,
    base: "https://replay.test",
    queue: [] as unknown[][],
    state: "loading",
    save: () => (session[`afsr_${SITE}`] = JSON.stringify(S)),
    cmd: undefined as undefined | ((c: unknown[]) => void),
  };
  const noop = () => {};
  const ctx: Record<string, unknown> = {
    __afsrBoot: boot,
    URL,
    console,
    innerWidth: 1200,
    innerHeight: 800,
    scrollY: 0,
    location: { pathname: "/pricing", hostname: "shop.test", host: "shop.test", href: "https://shop.test/pricing", search: "" },
    navigator: {},
    history: { pushState: noop, replaceState: noop },
    performance: { getEntriesByType: () => [] },
    crypto: { getRandomValues: (a: Uint8Array) => a.map(() => (rnd += 7)) },
    sessionStorage: { getItem: () => null },
    document: {
      querySelector: () => null,
      addEventListener: noop,
      documentElement: { scrollHeight: 2000, scrollWidth: 1200 },
      body: { scrollHeight: 2000, scrollWidth: 1200 },
      title: "",
      referrer: "",
      visibilityState: "visible",
    },
    addEventListener: noop,
    setInterval: noop,
    setTimeout: (f: () => void) => {
      timers.set(nextTimer, f);
      return nextTimer++;
    },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: (url: string, init: { body: string }) => {
      const u = new URL(url);
      const s: Sent = { sid: u.searchParams.get("sid")!, q: Number(u.searchParams.get("q")), env: JSON.parse(init.body) };
      sent.push(s);
      const body = answer(sent.length, s);
      const res = { json: () => Promise.resolve(body) };
      return opts.hold ? new Promise((r) => held.push(() => r(res))) : Promise.resolve(res);
    },
  };
  ctx.window = ctx;
  runInNewContext(RECORDER, ctx);
  /** Run due timers (the flush), then let the upload's promise chain settle. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const tick = async () => {
    const due = [...timers.values()];
    timers.clear();
    for (const f of due) f();
    await settle();
  };
  /** Deliver the next held answer. */
  const release = async () => {
    held.shift()!();
    await settle();
  };
  return { sent, S, boot, session, tick, release, starts: () => ctx.__starts as number };
}

const MISMATCH = { ok: false, error: "session_mismatch", hint: "This session id belongs to another browser.", stop: true };

describe("recorder: session_mismatch", () => {
  it("starts a new session (new id, seq 0, full snapshot, the page) and keeps recording", async () => {
    const p = page((n) => (n === 1 ? MISMATCH : { ok: true }));
    await p.tick();
    // The first chunk went out under the old session and was refused.
    expect(p.sent[0]).toMatchObject({ sid: OLD, q: 3 });
    // A new session replaced it, saved for the tab's next page loads.
    expect(p.S.id).toMatch(/^rs_[0-9a-z]{16}$/);
    expect(p.S.id).not.toBe(OLD);
    expect(JSON.parse(p.session[`afsr_${SITE}`]!).id).toBe(p.S.id);
    expect(p.starts()).toBe(2);
    await p.tick();
    const first = p.sent[1]!;
    expect(first).toMatchObject({ sid: p.S.id, q: 0 });
    expect(first.env.sid).toBe(p.S.id);
    // a full snapshot and the page it is on (pageview 1 of the new session), as a new session's first chunk must carry
    expect(first.env.ev.some((e) => e.type === 2)).toBe(true);
    const pageEv = first.env.ev.find((e) => e.type === 5 && e.data.tag === "afs.page");
    expect(pageEv?.data.payload?.pv).toBe(1);
    expect(p.boot.state).toBe("recording");
    // Still recording: the next events go out under the new session.
    p.boot.cmd!(["event", "signup"]);
    await p.tick();
    expect(p.sent[2]).toMatchObject({ sid: p.S.id, q: 1 });
    expect(p.boot.state).toBe("recording");
    expect(p.S).not.toHaveProperty("stop");
  });

  it("ignores refusals of the replaced session's chunks, and stops after two new sessions in one page load", async () => {
    const p = page(() => MISMATCH);
    await p.tick(); // refused -> new session 1
    const one = p.S.id;
    expect(one).not.toBe(OLD);
    await p.tick(); // refused -> new session 2
    const two = p.S.id;
    expect(two).not.toBe(one);
    expect(p.boot.state).toBe("recording");
    await p.tick(); // refused a third time: recording stops as before
    expect(p.boot.state).toBe("stopped:session_mismatch");
    expect(p.S).toMatchObject({ id: two, stop: "session_mismatch" });
    expect(p.sent.map((s) => s.sid)).toEqual([OLD, one, two]);

    // Two chunks of the old session in flight: the first refusal starts a new session, the second
    // (a late answer for the replaced session) changes nothing.
    const q = page((n) => (n <= 2 ? MISMATCH : { ok: true }), { hold: true });
    await q.tick();
    q.boot.cmd!(["event", "early"]);
    await q.tick();
    expect(q.sent.map((s) => [s.sid, s.q])).toEqual([
      [OLD, 3],
      [OLD, 4],
    ]);
    await q.release();
    const fresh = q.S.id;
    expect(fresh).not.toBe(OLD);
    await q.release();
    expect(q.S.id).toBe(fresh);
    expect(q.starts()).toBe(2);
    expect(q.boot.state).toBe("recording");
  });
});
