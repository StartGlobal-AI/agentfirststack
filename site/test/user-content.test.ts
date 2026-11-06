import { describe, expect, it } from "vitest";
import { call, testEnv } from "./helpers";

describe("the user-content domain outside the share pages", () => {
  const env = testEnv({ USER_CONTENT_BASE_URL: "https://uc.test", PUBLIC_BASE_URL: "https://afs.test" });

  it("answers its root with a page saying what the domain is and where to report a page", async () => {
    const r = await call("GET", "https://uc.test/", { env });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("x-robots-tag")).toBe("noindex");
    expect(r.text).toContain("<h1>uc.test</h1>");
    expect(r.text).toContain('href="https://afs.test/report-abuse"');
    // Without the platform's own origin it names no link rather than a wrong one.
    const bare = await call("GET", "https://uc.test/", { env: testEnv({ USER_CONTENT_BASE_URL: "https://uc.test" }) });
    expect(bare.status).toBe(200);
    expect(bare.text).not.toContain("href=");
  });

  it("keeps crawlers off, and serves nothing of the platform: no API, sign-in, MCP or pages", async () => {
    const robots = await call("GET", "https://uc.test/robots.txt", { env });
    expect(robots.text).toBe("User-agent: *\nDisallow: /\n");
    for (const [method, path] of [
      ["POST", "/v1/signup"],
      ["GET", "/v1/usage"],
      ["GET", "/signin"],
      ["POST", "/mcp"],
      ["GET", "/llms.txt"],
      ["GET", "/pricing"],
    ] as const) {
      const r = await call(method, `https://uc.test${path}`, { env, body: method === "POST" ? "{}" : undefined });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.text).toBe("Not found.\n");
    }
  });

  it("leaves the platform's own host alone, and is off without USER_CONTENT_BASE_URL", async () => {
    expect((await call("GET", "/llms.txt", { env })).status).toBe(200);
    expect((await call("GET", "https://uc.test/llms.txt")).status).toBe(200);
  });
});
