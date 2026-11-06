import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const B = "http://analytics.test";

async function call(path: string, init: RequestInit & { key?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const res = await SELF.fetch(`${B}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function newSite(domain: string) {
  const key = (await call("/v1/signup", { method: "POST" })).body.api_key as string;
  const created = await call("/v1/sites", { method: "POST", key, json: { domain } });
  return { key, site: created.body.site.id as string, pk: created.body.install.first_party_proxy.proxy_key as string };
}

/** A browser beacon through the first-party proxy (so each test visitor has its own IP). */
const beacon = (pk: string, ip: string, payload: Record<string, unknown>, geo: Record<string, string> = {}) =>
  call("/e", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      "user-agent": UA,
      "content-type": "text/plain",
      "x-forwarded-for": ip,
      "x-afs-proxy-key": pk,
      ...Object.fromEntries(Object.entries(geo).map(([k, v]) => [`x-dev-geo-${k}`, v])),
    },
  });

const online = async (key: string, site: string) => (await call(`/v1/sites/${site}/realtime`, { key })).body.online as number;

/** Open the stream and collect its messages; next() waits for the next one. */
async function stream(key: string, site: string) {
  const res = await SELF.fetch(`${B}/v1/sites/${site}/realtime/stream`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${key}` },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const queue: any[] = [];
  const waiting: ((m: any) => void)[] = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    const w = waiting.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const next = () =>
    queue.length
      ? Promise.resolve(queue.shift())
      : new Promise<any>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("no live message within 5 s")), 5000);
          waiting.push((m) => {
            clearTimeout(t);
            resolve(m);
          });
        });
  return { ws, next };
}

describe("live online count and stream", () => {
  it("drops a visitor who closes the page, keeps one who moves to another page, and leaves cost no budget", async () => {
    const { key, site, pk } = await newSite("live-a.test");
    expect((await beacon(pk, "10.0.0.1", { s: site, u: "https://live-a.test/" })).body.ok).toBe(true);
    expect((await beacon(pk, "10.0.0.2", { s: site, u: "https://live-a.test/" })).body.ok).toBe(true);
    expect(await online(key, site)).toBe(2);

    // Visitor 1 moves to /pricing, then the old page's leave arrives: still online.
    await beacon(pk, "10.0.0.1", { s: site, u: "https://live-a.test/pricing" });
    await beacon(pk, "10.0.0.1", { s: site, n: "engagement", u: "https://live-a.test/", e: 0, l: 1 });
    expect(await online(key, site)).toBe(2);

    // Visitor 2 closes the tab (under a second visible): gone at once, while visitors_last_5m still counts them.
    expect((await beacon(pk, "10.0.0.2", { s: site, n: "engagement", u: "https://live-a.test/", e: 400, l: 1 })).body.ok).toBe(true);
    const rt = (await call(`/v1/sites/${site}/realtime`, { key })).body;
    expect(rt).toMatchObject({ online: 1, visitors_last_5m: 2 });

    // A hidden tab (engagement without l) doesn't remove anyone.
    await beacon(pk, "10.0.0.1", { s: site, n: "engagement", u: "https://live-a.test/pricing", e: 3000 });
    expect(await online(key, site)).toBe(1);

    // Coming back (a new pageview) puts visitor 2 back.
    await beacon(pk, "10.0.0.2", { s: site, u: "https://live-a.test/" });
    expect(await online(key, site)).toBe(2);

    // Budget: 4 pageviews + 1 engagement beacon; the leave-only beacons (e < 1 s) weren't counted.
    const usage = (await call("/v1/usage", { key })).body.limits;
    expect(usage.events_per_site_per_day.used).toBe(5);
  });

  it("streams a snapshot, then an update within a second of each event, to the site's own keys only", async () => {
    const { key, site, pk } = await newSite("live-b.test");
    // Not a WebSocket: a hint, not a hang.
    const plain = await call(`/v1/sites/${site}/realtime/stream`, { key });
    expect(plain.status).toBe(426);
    expect(plain.body.error.hint).toContain("/realtime");
    // Another project's key can't open it.
    const other = await newSite("live-c.test");
    const denied = await SELF.fetch(`${B}/v1/sites/${site}/realtime/stream`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${other.key}` },
    });
    expect(denied.status).toBe(404);

    const { ws, next } = await stream(key, site);
    expect(await next()).toMatchObject({ type: "snapshot", online: 0, visitors_last_5m: 0 });

    await beacon(
      pk,
      "10.1.0.1",
      { s: site, u: "https://live-b.test/pricing", r: "https://www.google.com/" },
      { country: "DE", city: "Berlin" },
    );
    const up = await next();
    expect(up).toMatchObject({
      type: "update",
      online: 1,
      pageviews: 1,
      latest: { pathname: "/pricing", country: "DE", city: "Berlin", source: "Google" },
    });

    // Test traffic doesn't show; the visitor closing the page does, at most a second later.
    await beacon(pk, "10.1.0.2", { s: site, u: "https://live-b.test/", dbg: 1 });
    await beacon(pk, "10.1.0.1", { s: site, n: "engagement", u: "https://live-b.test/pricing", e: 0, l: 1 });
    const gone = await next();
    expect(gone).toMatchObject({ type: "update", online: 0, pageviews: 0, latest: null });
    ws.close(1000, "done");
  });
});
