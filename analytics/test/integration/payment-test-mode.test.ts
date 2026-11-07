import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// A setup's test purchase must not show as revenue: payments sent with livemode: false or
// debug: true are stored like test traffic, out of reports unless debug=include.
type Init = RequestInit & { key?: string; json?: unknown };
async function call(path: string, init: Init = {}) {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const res = await SELF.fetch(
    new Request(`http://analytics.test${path}`, {
      ...init,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    }),
  );
  return { status: res.status, body: (await res.json()) as any };
}

describe("test payments", () => {
  it("livemode: false and debug: true are kept but left out of revenue; a live payment counts", async () => {
    const key = (await call("/v1/signup", { method: "POST" })).body.api_key as string;
    const site = (await call("/v1/sites", { method: "POST", key, json: { domain: "pay-test.test" } })).body.site.id as string;
    const pay = (json: Record<string, unknown>) => call(`/v1/sites/${site}/payments`, { method: "POST", key, json });
    expect((await pay({ id: "t1", amount: 204, currency: "USD", livemode: false })).status).toBe(202);
    expect((await pay({ id: "t2", amount: 10, currency: "USD", debug: true })).status).toBe(202);
    const revenue = async (q = "") => (await call(`/v1/sites/${site}/stats?period=today${q}`, { key })).body.metrics.revenue;
    expect(await revenue()).toBe(0);
    expect(await revenue("&debug=include")).toBe(214);
    const listed = (await call(`/v1/sites/${site}/payments?period=today`, { key })).body;
    expect(JSON.stringify(listed)).toContain('"livemode":false');
    expect((await pay({ id: "live1", amount: 49, currency: "USD" })).status).toBe(202);
    expect(await revenue()).toBe(49);
  });
});
