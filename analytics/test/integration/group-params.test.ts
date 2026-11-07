import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
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
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}
let accountKey: string | null = null;
async function newSite(domain: string, json: Record<string, unknown>) {
  accountKey ??= (await call("/v1/signup", { method: "POST" })).body.api_key as string;
  const created = await call("/v1/sites", { method: "POST", key: accountKey, json: { domain, ...json } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { key: accountKey, site: created.body.site.id as string, proxyKey: created.body.install.first_party_proxy.proxy_key as string };
}
const beacon = (proxyKey: string, payload: Record<string, unknown>, ip: string) =>
  call("/_a/e", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "user-agent": UA, "content-type": "text/plain", "x-forwarded-for": ip, "x-afs-proxy-key": proxyKey },
  });

// Content and channel groups compile to a CASE over the path or the source. With a bound
// parameter per pattern, a site with many groups went past the Durable Object's 100-parameter
// limit and every breakdown or filter on them answered 500. The settings allow 50 content groups
// and 30 channel groups of up to 80 patterns, so the largest allowed settings must still query.
describe("many content and channel groups", () => {
  it("breaks down and filters by content_group with the maximum 50 groups", async () => {
    const content_groups = Array.from({ length: 50 }, (_, i) => ({ name: `Group ${i % 7}`, match: `/section-${i}*` }));
    content_groups[49] = { name: "Docs", match: "/docs*" };
    const { key, site, proxyKey } = await newSite("groups.test", { content_groups });
    await beacon(proxyKey, { s: site, u: "https://groups.test/docs/start" }, "10.7.0.1");
    await beacon(proxyKey, { s: site, u: "https://groups.test/section-3/x" }, "10.7.0.2");
    const by = await call(`/v1/sites/${site}/breakdown?breakdown=content_group&period=today&debug=include`, { key });
    expect(by.status, JSON.stringify(by.body)).toBe(200);
    expect(by.body.results.map((r: { value: string }) => r.value)).toEqual(expect.arrayContaining(["Docs", "Group 3"]));
    const filtered = await call(`/v1/sites/${site}/stats?period=today&debug=include&filters=content_group==Docs`, { key });
    expect(filtered.status, JSON.stringify(filtered.body)).toBe(200);
    expect(filtered.body.metrics.visitors).toBe(1);
  });

  it("breaks down by channel_group with many patterns", async () => {
    const channel_groups = Array.from({ length: 30 }, (_, i) => ({
      name: `Rule ${i}`,
      source: Array.from({ length: 20 }, (_, j) => `src-${i}-${j}`),
      medium: Array.from({ length: 20 }, (_, j) => `med-${i}-${j}`),
    }));
    const { key, site, proxyKey } = await newSite("channels.test", { channel_groups });
    await beacon(proxyKey, { s: site, u: "https://channels.test/?utm_source=src-2-5&utm_medium=med-2-1" }, "10.7.1.1");
    const by = await call(`/v1/sites/${site}/breakdown?breakdown=channel_group&period=today&debug=include`, { key });
    expect(by.status, JSON.stringify(by.body)).toBe(200);
    expect(by.body.results.map((r: { value: string }) => r.value)).toContain("Rule 2");
  });
});
