/**
 * Share links on a user-content host (USER_CONTENT_BASE_URL, routes/public.ts): new links point
 * there, the host serves the player and nothing else, the old /play/ URLs answer 301 while valid.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { app } from "../../src/index";
import { click, page, snapshot } from "../fixtures/rrweb";
import { call, hosted, newSid, newSite, sendChunk, setPause } from "./helpers";

const UC = "https://usercontent.test";
const env = hosted({ USER_CONTENT_BASE_URL: UC, AUTH_ISSUER: "https://platform.test" } as Partial<Bindings>);

/** A request to any host (the helpers' call() always goes to the service host). */
async function at(url: string, init: { method?: string; env?: Bindings } = {}) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(url, { method: init.method ?? "GET", redirect: "manual" }), init.env ?? env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, headers: res.headers, text: new TextDecoder().decode(await res.arrayBuffer()) };
}

async function recorded(domain: string) {
  const s = await newSite(domain);
  const sid = newSid();
  const T = Date.now() - 60_000;
  await sendChunk(s.site, sid, 0, [snapshot(T), page(T, 1, "/", { h: domain })], { origin: `https://${domain}` });
  await sendChunk(s.site, sid, 1, [click(T + 500, 1, "#a")], { origin: `https://${domain}` });
  return { ...s, sid };
}

describe("share links on the user-content host", () => {
  it("new links point there; the player, its assets, data and chunks are served there with the same headers", async () => {
    const { key, site, sid } = await recorded("uc-shop.test");
    const made = await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: sid }, env });
    expect(made.status).toBe(201);
    const url = made.json.link.url as string;
    expect(url).toMatch(/^https:\/\/usercontent\.test\/r\/rpt_[0-9a-z]{32}$/);

    const pg = await at(url);
    expect(pg.status).toBe(200);
    expect(pg.headers.get("x-robots-tag")).toContain("noindex");
    const csp = pg.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("https://uc-shop.test");
    expect(pg.headers.get("set-cookie")).toBeNull();
    // Report abuse names the page's own (user-content) URL.
    expect(pg.text).toContain(`href="https://platform.test/report-abuse?url=${encodeURIComponent(url)}"`);
    const js = /<script defer src="([^"]+)"/.exec(pg.text)![1]!;
    const css = /<link rel="stylesheet" href="([^"]+)"/.exec(pg.text)![1]!;
    expect(js).toMatch(/^\/r\/assets\/player-[0-9a-f]+\.js$/);
    expect((await at(`${UC}${js}`)).text.startsWith("/*! afs-replay player")).toBe(true);
    expect((await at(`${UC}${css}`)).headers.get("content-type")).toContain("text/css");

    const data = await at(`${url}/data`);
    expect(JSON.parse(data.text).session).toMatchObject({ id: sid, site_domain: "uc-shop.test" });
    expect((await at(`${url}/chunks/0`)).status).toBe(200);

    // MCP names the same host.
    const tool = await call("POST", "/mcp", {
      key,
      env,
      headers: { accept: "application/json, text/event-stream" },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_replay_link", arguments: { site_id: site, session_id: sid } },
      },
    });
    expect(JSON.parse(tool.json.result.content[0].text).link.url.startsWith(`${UC}/r/rpt_`)).toBe(true);
    expect((await call("GET", "/llms.txt", { env })).text).toContain(`${UC}/r/<token>`);
  });

  it("serves nothing else: no API, MCP, signup, loader, recorder or ingest on that host", async () => {
    const { site } = await newSite("uc-only.test");
    for (const path of [
      "/",
      "/llms.txt",
      "/v1/sites",
      "/mcp",
      "/v1/signup",
      `/r/${site}.js`,
      "/i",
      "/play/rpt_x",
      "/assets/player-x.js",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const r = await at(`${UC}${path}`, { method: path === "/v1/signup" || path === "/i" ? "POST" : "GET" });
      expect(r.status, path).toBe(404);
    }
    // The service host still serves them.
    expect((await call("GET", `/r/${site}.js`, { env })).status).toBe(200);
  });

  it("an old /play/ URL answers 301 to the new one while valid; expired, revoked and paused links answer as before", async () => {
    const { key, account, site, sid } = await recorded("uc-old.test");
    // Made before the move: on the service host.
    const old = (await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: sid } })).json.link;
    const path = new URL(old.url).pathname;
    expect(path).toMatch(/^\/play\/rpt_/);
    const token = path.slice("/play/".length);

    const moved = await call("GET", path, { env });
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe(`${UC}/r/${token}`);
    expect(moved.headers.get("cache-control")).toBe("no-store");
    expect(moved.headers.get("x-robots-tag")).toContain("noindex");
    // The same token works on the new host; the old data and chunk URLs keep answering (open players).
    expect((await at(`${UC}/r/${token}`)).status).toBe(200);
    expect((await call("GET", `${path}/data`, { env })).status).toBe(200);
    // Without the var nothing moves.
    expect((await call("GET", path)).status).toBe(200);

    await setPause(account, "replay.share_links", "a phishing report");
    const paused = await call("GET", path, { env });
    expect(paused.status).toBe(403);
    expect(paused.text).toContain("Report abuse");
    const pausedNew = await at(`${UC}/r/${token}`);
    expect(pausedNew.status).toBe(403);
    expect(pausedNew.text).toContain("paused");
    expect(pausedNew.headers.get("x-robots-tag")).toContain("noindex");
    await setPause(account, "replay.share_links", "", true);

    await call("DELETE", `/v1/sites/${site}/links/${old.id}`, { key });
    const gone = await call("GET", path, { env });
    expect(gone.status).toBe(404);
    expect(gone.text).toContain("expired or was revoked");
    expect((await at(`${UC}/r/${token}`)).status).toBe(404);
  });
});
