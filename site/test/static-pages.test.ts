import { describe, expect, it } from "vitest";
import headersFile from "../public/_headers?raw";
import { ASSET_HEADER_RULES } from "../src/static-pages";
import { call, serviceCalls, testEnv } from "./helpers";

const OWN = { OWN_ANALYTICS_ACCOUNT_ID: "acct_ownsite0000000", OWN_ANALYTICS_SITE_ID: "site_ownsite0000000" };
const CRAWLS = `/v1/sites/${OWN.OWN_ANALYTICS_SITE_ID}/crawls`;
const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** public/_headers as rules: a path line, then indented "Name: value" lines. */
function parseHeaders(text: string) {
  const rules: { match: string; headers: Record<string, string> }[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) rules.push({ match: line.trim(), headers: {} });
    else {
      const i = line.indexOf(":");
      rules[rules.length - 1]!.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return rules;
}

const crawlsSent = () => serviceCalls.filter((s) => s.path === CRAWLS);

describe("static pages through the Worker", () => {
  it("applies the same header rules as public/_headers", () => {
    expect(ASSET_HEADER_RULES).toEqual(parseHeaders(headersFile));
  });

  it("serves pages from public/ with their headers, and keeps API misses a JSON 404", async () => {
    const page = await call("GET", "/guides");
    expect(page.status).toBe(200);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    const llms = await call("GET", "/llms.txt");
    expect(llms.headers.get("access-control-allow-origin")).toBe("*");
    expect((await call("GET", "/index.md")).headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    // The Worker's own HTML for "/" gets them too.
    expect((await call("GET", "/")).headers.get("x-frame-options")).toBe("DENY");
    const miss = await call("GET", "/v1/no-such-route");
    expect(miss.status).toBe(404);
    expect(miss.json.error).toBeTruthy();
  });

  it("reports AI crawler and search bot visits to the site's own analytics, and nothing else", async () => {
    const env = testEnv(OWN);
    const before = crawlsSent().length;
    const r = await call("GET", "/guides", { env, headers: { "user-agent": GPTBOT } });
    expect(r.status).toBe(200);
    const sent = crawlsSent().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ service: "analytics", account: OWN.OWN_ANALYTICS_ACCOUNT_ID, authorization: null });
    expect(JSON.parse(sent[0]!.body ?? "{}")).toEqual({ user_agent: GPTBOT, path: "/guides", status: 200 });
    // A 404 is reported with its status.
    await call("GET", "/no-such-page", { env, headers: { "user-agent": GPTBOT } });
    expect(JSON.parse(crawlsSent().at(-1)!.body ?? "{}")).toMatchObject({ path: "/no-such-page", status: 404 });

    // People, the API, the gateway and the dashboard: not reported.
    const n = crawlsSent().length;
    await call("GET", "/guides", { env, headers: { "user-agent": CHROME } });
    await call("GET", "/v1/me", { env, headers: { "user-agent": GPTBOT } });
    await call("GET", "/dashboard", { env, headers: { "user-agent": GPTBOT } });
    expect(crawlsSent().length).toBe(n);
    // Off without the deployment's own analytics.
    await call("GET", "/guides", { headers: { "user-agent": GPTBOT } });
    expect(crawlsSent().length).toBe(n);
  });
});
