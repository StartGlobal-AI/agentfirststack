import { describe, expect, it } from "vitest";
import { call, testEnv } from "./helpers";

/** A service that answers with what it was sent. */
const echo = (name: string) =>
  ({
    fetch: async (input: RequestInfo, init?: RequestInit) => {
      const req = new Request(input, init);
      return Response.json({
        service: name,
        url: req.url,
        method: req.method,
        headers: Object.fromEntries(req.headers),
        body: req.method === "POST" ? await req.text() : null,
      });
    },
  }) as unknown as Fetcher;

describe("our pages' first-party paths", () => {
  const env = testEnv({
    ANALYTICS: echo("analytics"),
    TAGS: echo("tags"),
    OWN_ANALYTICS_PROXY_KEY: "pk_analytics_test",
    OWN_TAGS_PROXY_KEY: "pk_tags_test",
  });

  it("sends /_a/* to analytics and /_t/* to tags with the proxy key and the visitor's IP and geo, never the visitor's own x-afs headers", async () => {
    const s = await call("GET", "/_a/s.js", { env, ip: "203.0.113.7", cf: { country: "DE", city: "Berlin" } });
    expect(s.json).toMatchObject({ service: "analytics", url: "https://analytics.internal/_a/s.js", method: "GET" });
    expect(s.json.headers).toMatchObject({
      "x-afs-proxy-key": "pk_analytics_test",
      "x-forwarded-for": "203.0.113.7",
      "x-afs-geo-country": "DE",
      "x-afs-geo-city": "Berlin",
    });

    const e = await call("POST", "/_a/e", {
      env,
      body: '{"s":"site_x","u":"https://agentfirststack.com/"}',
      headers: { "x-afs-proxy-key": "forged", "x-afs-geo-country": "US", cookie: "session=secret" },
    });
    expect(e.json.headers["x-afs-proxy-key"]).toBe("pk_analytics_test");
    expect(e.json.headers["x-afs-geo-country"]).toBeUndefined();
    expect(e.json.headers.cookie).toBeUndefined();
    expect(e.json.body).toContain("site_x");

    const t = await call("POST", "/_t/collect?x=1", { env, body: "{}" });
    expect(t.json).toMatchObject({ service: "tags", url: "https://tags.internal/_t/collect?x=1" });
    expect(t.json.headers["x-afs-proxy-key"]).toBe("pk_tags_test");
  });

  it("is a plain 404 without the keys", async () => {
    expect((await call("GET", "/_a/s.js", { env: testEnv({ ANALYTICS: echo("analytics") }) })).status).toBe(404);
  });
});
