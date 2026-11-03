import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

const B = "https://tags.test";

async function json(res: Response) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

describe("tags Worker (workerd, D1, ContainerDO, Queue)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("signup -> container -> draft -> publish -> /c/:id.js -> /collect -> server event -> delivered webhook", async () => {
    // Outbound webhook delivery happens in this isolate, so mock global fetch for the hook host.
    const hooks: { url: string; body: unknown; sig: string | null }[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://hooks.test/")) {
        hooks.push({ url, body: JSON.parse(String(init?.body)), sig: new Headers(init?.headers).get("x-signature") });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    });

    const signup = await json(await SELF.fetch(`${B}/v1/signup`, { method: "POST" }));
    const H = { authorization: `Bearer ${signup.api_key}`, "content-type": "application/json" };
    expect(signup.api_key).toMatch(/^(tags|afs)_/);

    const created = await SELF.fetch(`${B}/v1/containers`, { method: "POST", headers: H, body: JSON.stringify({ domain: "shop.test" }) });
    expect(created.status).toBe(201);
    const C = (await json(created)).container.id as string;
    const again = await SELF.fetch(`${B}/v1/containers`, { method: "POST", headers: H, body: JSON.stringify({ domain: "www.shop.test" }) });
    expect(again.status).toBe(200);

    const dest = await json(
      await SELF.fetch(`${B}/v1/containers/${C}/destinations`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ type: "webhook", credentials: { url: "https://hooks.test/conv", secret: "integration-secret-123" } }),
      }),
    );
    expect(dest.destination.credentials).toEqual({ configured: true, url: "https://hooks.test/conv" });

    const draft = {
      variables: [{ name: "v", type: "data_layer", key: "ecommerce.value" }],
      triggers: [
        { id: "all_pages", type: "page_view" },
        { id: "p", type: "custom_event", event: "purchase" },
      ],
      tags: [{ id: "meta", type: "meta_pixel", params: { pixel_id: "1234567890123456" }, triggers: ["all_pages"] }],
      conversions: [
        { name: "purchase", trigger: "p", value: "v", currency: "USD", send_to: { meta: { event_name: "Purchase" } }, server: true },
      ],
      consent: { mode: "none", regions: { EEA: { ad_storage: "denied" }, GB: { ad_storage: "denied" } } },
    };
    const put = await json(await SELF.fetch(`${B}/v1/containers/${C}/draft`, { method: "PUT", headers: H, body: JSON.stringify(draft) }));
    expect(put.validation.valid).toBe(true);
    const pub = await SELF.fetch(`${B}/v1/containers/${C}/publish`, { method: "POST", headers: H, body: "{}" });
    expect(pub.status).toBe(201);

    const js = await SELF.fetch(`${B}/x/y/c/${C}.js`);
    expect(js.status).toBe(200);
    expect(await js.text()).toContain('"1234567890123456"');

    const hit = (body: object) =>
      SELF.fetch(`${B}/collect`, {
        method: "POST",
        headers: { origin: "https://shop.test", "user-agent": "Mozilla/5.0 Chrome/130" },
        body: JSON.stringify({ container_id: C, ...body }),
      });
    const consent = { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" };
    expect((await hit({ type: "visit", visitor_id: "vis_integration1", click_ids: { gclid: "GCLID-INT-1" }, consent })).status).toBe(200);
    const conv = await json(
      await hit({
        type: "conversion",
        event_id: "evt_integration_1",
        name: "purchase",
        visitor_id: "vis_integration1",
        value: 10,
        currency: "USD",
        consent,
      }),
    );
    expect(conv.destinations).toEqual([{ type: "webhook", status: "queued" }]);

    const srv = await json(
      await SELF.fetch(`${B}/v1/containers/${C}/events`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          events: [{ name: "purchase", order_id: "O-9", value: 99, currency: "USD", visitor_id: "vis_integration1" }],
        }),
      }),
    );
    expect(srv.results[0]).toMatchObject({ status: "accepted", joined: { by: "visitor_id", click_ids: ["gclid"] } });

    let events: { name: string; destinations: { status: string }[] }[] = [];
    for (let i = 0; i < 50; i++) {
      events = (await json(await SELF.fetch(`${B}/v1/containers/${C}/events`, { headers: H }))).events;
      if (events.length === 2 && events.every((e) => e.destinations[0]?.status === "delivered")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(events.map((e) => e.destinations[0]?.status)).toEqual(["delivered", "delivered"]);
    expect(hooks).toHaveLength(2);
    expect(hooks.every((h) => h.sig?.startsWith("sha256="))).toBe(true);
    expect(hooks.map((h) => (h.body as { event: { click_ids: { gclid?: string } } }).event.click_ids.gclid)).toEqual([
      "GCLID-INT-1",
      "GCLID-INT-1",
    ]);
  });

  it("MCP tools/list hides write tools from read-only keys", async () => {
    const signup = await json(await SELF.fetch(`${B}/v1/signup`, { method: "POST" }));
    const key = await json(
      await SELF.fetch(`${B}/v1/keys`, {
        method: "POST",
        headers: { authorization: `Bearer ${signup.api_key}` },
        body: JSON.stringify({ scope: "read" }),
      }),
    );
    const list = async (k: string) =>
      (
        await json(
          await SELF.fetch(`${B}/mcp`, {
            method: "POST",
            headers: { authorization: `Bearer ${k}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          }),
        )
      ).result.tools.map((t: { name: string }) => t.name) as string[];
    const full = await list(signup.api_key);
    const read = await list(key.api_key);
    expect(full).toContain("publish");
    expect(read).not.toContain("publish");
    expect(read).toContain("get_event_log");
  });
});
