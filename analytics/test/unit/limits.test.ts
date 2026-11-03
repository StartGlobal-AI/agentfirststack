import { afterEach, describe, expect, it, vi } from "vitest";
import { readCapped } from "../../src/lib/body";
import type { Ctx, SiteRow } from "../../src/service/context";
import { MAX_PAGE_BYTES, MAX_SCRIPT_BYTES, fetchCapped, verifyInstall } from "../../src/service/verify";

/** A stream that would go on forever, counting how many chunks were pulled from it. */
function endless(chunkBytes: number) {
  const s = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      s.pulled++;
      c.enqueue(new Uint8Array(chunkBytes).fill(97));
    },
    cancel() {
      s.cancelled = true;
    },
  });
  return { stream, s };
}

describe("readCapped", () => {
  it("returns small bodies whole", async () => {
    const r = await readCapped(new Response("hello").body, 16);
    expect(new TextDecoder().decode(r.bytes)).toBe("hello");
    expect(r.truncated).toBe(false);
    expect((await readCapped(null, 16)).bytes.byteLength).toBe(0);
  });
  it("stops at the cap and cancels the rest, even for an endless stream", async () => {
    const { stream, s } = endless(4096);
    const r = await readCapped(stream, 16 * 1024);
    expect(r).toMatchObject({ truncated: true });
    expect(r.bytes.byteLength).toBe(16 * 1024);
    expect(s.pulled).toBeLessThanOrEqual(6); // 16 KB of 4 KB chunks (+ the stream's read-ahead), not more
    expect(s.cancelled).toBe(true);
  });
  it("exactly the cap is not truncated", async () => {
    const r = await readCapped(new Response(new Uint8Array(1024)).body, 1024);
    expect(r).toMatchObject({ truncated: false });
  });
});

type Route = (url: URL) => Response;
function stubFetch(route: Route) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    calls.push(input);
    expect(init?.redirect).toBe("manual");
    return route(new URL(input));
  });
  return calls;
}
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });

afterEach(() => vi.unstubAllGlobals());

describe("verify: fetchCapped", () => {
  const onSite = (u: URL) => u.hostname === "shop.test" || u.hostname.endsWith(".shop.test");

  it("follows up to 3 redirects on allowed hosts", async () => {
    const calls = stubFetch((u) => {
      const n = Number(u.searchParams.get("n") ?? 0);
      return n < 3 ? redirect(`https://www.shop.test/?n=${n + 1}`) : html("final");
    });
    const r = await fetchCapped(new URL("https://shop.test/"), { maxBytes: 100, allowed: onSite });
    expect(r).toMatchObject({ status: 200, text: "final", finalUrl: "https://www.shop.test/?n=3" });
    expect(calls).toHaveLength(4);
  });

  it("refuses a 4th redirect", async () => {
    stubFetch((u) => redirect(`/next${u.pathname}`));
    const r = await fetchCapped(new URL("https://shop.test/"), { maxBytes: 100, allowed: onSite });
    expect(r).toMatchObject({ error: expect.stringContaining("more than 3 redirects") });
  });

  it("refuses a redirect to another host, never fetching it", async () => {
    const calls = stubFetch((u) => (u.hostname === "shop.test" ? redirect("http://169.254.169.254/latest/meta-data") : html("secret")));
    const r = await fetchCapped(new URL("https://shop.test/"), { maxBytes: 100, allowed: onSite });
    expect(r).toMatchObject({ error: expect.stringContaining("http://169.254.169.254") });
    expect(calls).toEqual(["https://shop.test/"]);
  });

  it("refuses non-http redirects", async () => {
    stubFetch(() => redirect("file:///etc/passwd"));
    expect(await fetchCapped(new URL("https://shop.test/"), { maxBytes: 100, allowed: () => true })).toHaveProperty("error");
  });

  it("reads at most maxBytes of the body", async () => {
    const { stream, s } = endless(64 * 1024);
    stubFetch(() => new Response(stream));
    const r = await fetchCapped(new URL("https://shop.test/"), { maxBytes: MAX_PAGE_BYTES, allowed: onSite });
    expect("text" in r && r.text.length).toBe(MAX_PAGE_BYTES);
    expect(s.cancelled).toBe(true);
  });
});

describe("verifyInstall: what it fetches", () => {
  const site: SiteRow = {
    id: "site_0123456789abcdef",
    account_id: "acc_1",
    domain: "shop.test",
    name: null,
    timezone: "UTC",
    visitor_id_mode: "cookieless",
    retention_days: 30,
    allowed_hostnames: JSON.stringify(["cdn.partner.test"]),
    respect_dnt: 0,
    created_at: 0,
    updated_at: 0,
  };
  const summary = {
    total_events: 0,
    events_last_24h: 0,
    browser_events: 0,
    server_events: 0,
    first_event_at: null,
    last_event_at: null,
    last_event: null,
    dropped_last_7d: {},
    warnings_last_7d: {} as Record<string, { count: number; last_at: number | null }>,
    untrusted: {
      notice: "",
      last_event: null,
      hostnames_last_7d: [],
      drop_samples: {} as Record<string, string>,
      warning_samples: {} as Record<string, string>,
    },
  };
  const ctx = (sum = summary): Ctx =>
    ({
      accountId: "acc_1",
      baseUrl: "https://analytics.example.net",
      env: {
        DB: { prepare: (q: string) => ({ bind: () => ({ first: async () => (q.includes("FROM sites") ? site : null) }) }) },
        SITE: {
          idFromName: () => "id",
          get: () => ({
            summary: async () => sum,
            paymentsSummary: async () => ({ payments_30d: 0, unlinked_30d: 0, test_mode_30d: 0, last_payment_at: null }),
          }),
        },
      },
    }) as unknown as Ctx;
  const page = (src: string) => html(`<html><head><script defer src="${src}" data-site="${site.id}"></script></head></html>`);
  const tracker = () => new Response("/*! afs-analytics */ ...");

  it.each([
    ["https://analytics.example.net/s.js", true],
    ["/_a/s.js", true],
    // allowed_hostnames aren't proven to be the owner's: never fetched
    ["https://cdn.partner.test/s.js", false],
    ["https://www.shop.test/s.js", true],
    ["http://www.shop.test/s.js", false],
    ["https://www.shop.test:8443/s.js", false],
    ["https://evil.test/s.js", false],
    ["http://127.0.0.1:8080/s.js", false],
  ])("script src %s fetched: %s", async (src, fetched) => {
    const calls = stubFetch((u) => (u.pathname.endsWith("s.js") ? tracker() : page(src)));
    const r = await verifyInstall(ctx(), site.id, {});
    const check = r.checks.find((c) => c.id === "script_loads")!;
    expect(calls.length).toBe(fetched ? 2 : 1);
    expect(check.ok).toBe(fetched);
    if (!fetched) expect(check.detail).toContain("not fetched");
  });

  it("caps the script read at 256 KB", async () => {
    const { stream, s } = endless(64 * 1024);
    stubFetch((u) => (u.pathname.endsWith("s.js") ? new Response(stream) : page("/_a/s.js")));
    const r = await verifyInstall(ctx(), site.id, {});
    expect(r.checks.find((c) => c.id === "script_loads")!.ok).toBe(false);
    expect(s.pulled).toBeLessThanOrEqual(MAX_SCRIPT_BYTES / (64 * 1024) + 2);
  });

  it("a page that redirects off the site is reported, not followed", async () => {
    const calls = stubFetch(() => redirect("https://elsewhere.test/"));
    const r = await verifyInstall(ctx(), site.id, {});
    expect(r.checks[0]).toMatchObject({ id: "page_reachable", ok: false });
    expect(calls).toEqual(["https://shop.test/"]);
  });

  it("reports proxied events that arrived without a valid proxy key", async () => {
    stubFetch(() => page("/_a/s.js"));
    const sum = { ...summary, warnings_last_7d: { proxy_key_missing: { count: 3, last_at: 1 } } };
    const r = await verifyInstall(ctx(sum), site.id, {});
    expect(r.checks.find((c) => c.id === "proxy_key")).toMatchObject({ ok: false, detail: expect.stringContaining("3 events") });
    expect(r.fixes.join(" ")).toContain("x-afs-proxy-key");
    expect(r.warnings_last_7d).toEqual(sum.warnings_last_7d);
  });
});
