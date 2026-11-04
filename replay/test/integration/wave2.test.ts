import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ReplaySiteDO } from "../../src/do/site-do";
import type { Bindings } from "../../src/env";
import { click, custom, error, meta, mousemove, page, snapshot } from "../fixtures/rrweb";
import { call, E, hosted, newSid, newSite, postF, sendChunk, signup, tool } from "./helpers";

const stubOf = (site: string) => E.SITE.get(E.SITE.idFromName(site));
const maintainNow = (site: string) =>
  runInDurableObject(stubOf(site), async (i: ReplaySiteDO) => {
    await i.maintain(undefined, { now: Date.now() + 120_000 });
  });

describe("wave 2, 1: residuals", () => {
  it("chunk ingest and survey posts refuse plain-http origins", async () => {
    const { key, site } = await newSite("shop.test");
    const T = Date.now() - 10_000;
    const r = await sendChunk(site, newSid(), 0, [meta(T), page(T + 5, 1, "/")], { origin: "http://shop.test" });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: "origin_not_https", stop: true });
    const sv = (
      await call("POST", `/v1/sites/${site}/surveys`, {
        key,
        body: { name: "S", kind: "popover", template: "free_text", status: "active" },
      })
    ).json.survey.id;
    expect((await postF({ s: site, sv, imp: 1 }, { origin: "http://shop.test" })).json.error).toBe("origin_not_allowed");
  });

  it("starring copies the recording to starred/, playback survives the original's expiry, unstarring deletes the copy", async () => {
    const { key, site } = await newSite("shop.test");
    const sid = newSid();
    const T = Date.now() - 60_000;
    await sendChunk(site, sid, 0, [meta(T), snapshot(T + 1), page(T + 5, 1, "/")]);
    await sendChunk(site, sid, 1, [mousemove(T + 1000), mousemove(T + 2000)]);
    const star = await call("PATCH", `/v1/sites/${site}/sessions/${sid}`, { key, body: { starred: true } });
    expect(star.json.starred).toBe(true);
    const copies = await E.CHUNKS.list({ prefix: `starred/${site}/${sid}/` });
    expect(copies.objects.map((o) => o.key)).toEqual([`starred/${site}/${sid}/000000`, `starred/${site}/${sid}/000001`]);
    expect((await call("GET", `/v1/sites/${site}`, { key })).json.data.starred_copy_bytes).toBeGreaterThan(0);
    // the lifecycle rule expires the originals: the share link plays from the copy
    await E.CHUNKS.delete([`${site}/${sid}/000000`, `${site}/${sid}/000001`]);
    const link = (await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: sid } })).json.link.url as string;
    const token = link.split("/play/")[1];
    expect((await call("GET", `/play/${token}/chunks/0`)).status).toBe(200);
    expect((await call("GET", `/v1/sites/${site}/sessions/${sid}/events`, { key })).text).toContain('"type":2');
    // unstar: the copies are deleted by the site's maintenance
    await call("PATCH", `/v1/sites/${site}/sessions/${sid}`, { key, body: { starred: false } });
    await maintainNow(site);
    expect((await E.CHUNKS.list({ prefix: `starred/${site}/` })).objects).toHaveLength(0);
  });

  it("a privacy deletion removes starred copies; MAX_STARRED_BYTES_PER_SITE caps them", async () => {
    const { key, site } = await newSite("shop.test");
    const sid = newSid();
    const T = Date.now() - 60_000;
    await sendChunk(site, sid, 0, [meta(T), snapshot(T + 1), page(T + 5, 1, "/")]);
    const capped = await call("PATCH", `/v1/sites/${site}/sessions/${sid}`, {
      key,
      body: { starred: true },
      env: hosted({ MAX_STARRED_BYTES_PER_SITE: "1" }),
    });
    expect(capped.json.error.code).toBe("quota_exceeded");
    await call("PATCH", `/v1/sites/${site}/sessions/${sid}`, { key, body: { starred: true } });
    expect((await E.CHUNKS.list({ prefix: `starred/${site}/` })).objects).toHaveLength(1);
    await call("DELETE", `/v1/sites/${site}/sessions/${sid}`, { key });
    expect((await E.CHUNKS.list({ prefix: `starred/${site}/` })).objects).toHaveLength(0);
  });
});

describe("wave 2, 2: IAB TCF v2 consent", () => {
  it("consent_source tcf puts the required purposes in the loader; tcf_purposes is validated", async () => {
    const { key, site } = await newSite("shop.test", { require_consent: "eea", consent_source: "tcf" });
    const s = (await call("GET", `/v1/sites/${site}`, { key })).json.site;
    expect(s).toMatchObject({ require_consent: "eea", consent_source: "tcf", tcf_purposes: [1, 8] });
    const de = await call("GET", `/r/${site}.js`, { headers: { "x-dev-geo-country": "DE" } });
    expect(de.text).toContain('"consent":true');
    expect(de.text).toContain('"tcf":[1,8]');
    expect(de.text).toContain("__tcfapi");
    const up = await call("PATCH", `/v1/sites/${site}`, { key, body: { tcf_purposes: [10, 1, 10] } });
    expect(up.json.site.tcf_purposes).toEqual([1, 10]);
    expect((await call("GET", `/r/${site}.js`, { headers: { "x-dev-geo-country": "DE" } })).text).toContain('"tcf":[1,10]');
    for (const bad of [[8], [1], [2, 1], [1, 4]]) {
      const r = await call("PATCH", `/v1/sites/${site}`, { key, body: { tcf_purposes: bad } });
      expect(r.status).toBe(400);
      expect(r.json.error.hint).toBeTruthy();
    }
    expect((await call("PATCH", `/v1/sites/${site}`, { key, body: { tcf_purposes: null } })).json.site.tcf_purposes).toEqual([1, 8]);
    // gcm sites don't get tcf, and a tcf site without require_consent is told it does nothing yet
    const other = await newSite("other.test", { consent_source: "gcm" });
    expect((await call("GET", `/r/${other.site}.js`)).text).not.toContain('"tcf"');
    const note = await call("PATCH", `/v1/sites/${other.site}`, { key: other.key, body: { consent_source: "tcf" } });
    expect(note.json.notes.join(" ")).toContain("require_consent");
  });
});

describe("wave 2, 3: replay signals to a tags container", () => {
  const TOKEN = "internal-test-token";
  const CTR = "ctr_0000000000000001";
  /** A stand-in for the tags Worker: GET /v1/containers/:id and POST .../events; a container of another account is a 404, as there. */
  function tagsStub(account: string, containers: string[]) {
    const posts: { container: string; events: Record<string, any>[] }[] = [];
    const calls: string[] = [];
    const state = { status: 202 };
    const fetcher = {
      fetch: async (req: Request) => {
        const u = new URL(req.url);
        calls.push(`${req.method} ${u.host}${u.pathname}`);
        if (u.host !== "tags.internal" || req.headers.get("x-afs-internal") !== TOKEN || !req.headers.get("x-afs-account"))
          return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
        const m = /^\/v1\/containers\/(ctr_[0-9a-z]+)(\/events)?$/.exec(u.pathname);
        const mine = req.headers.get("x-afs-account") === account;
        if (!m || !mine || !containers.includes(m[1]!)) return Response.json({ error: { code: "not_found" } }, { status: 404 });
        if (req.method === "GET" && !m[2]) return Response.json({ container: { id: m[1], domain: "shop.test" } });
        if (req.method === "POST" && m[2]) {
          if (state.status !== 202) return Response.json({ error: { code: "unavailable" } }, { status: state.status });
          const b = (await req.json()) as { events: Record<string, any>[] };
          posts.push({ container: m[1]!, events: b.events });
          return Response.json({ accepted: b.events.length, duplicates: 0, results: [] }, { status: 202 });
        }
        return new Response("no", { status: 405 });
      },
    } as unknown as Fetcher;
    return { env: hosted({ TAGS: fetcher, INTERNAL_TOKEN: TOKEN }), posts, calls, state };
  }
  /** Run the DO's tags batch now with the stub as its TAGS binding (the alarm would, 15 s later). */
  const flushTags = (site: string, env: Bindings) =>
    runInDurableObject(stubOf(site), async (i: ReplaySiteDO) => {
      const o = i as unknown as { env: Bindings; runTags(now: number): Promise<void>; setMeta(k: string, v: number | null): void };
      const was = o.env;
      o.env = env;
      try {
        o.setMeta("tags_at", 1); // due now, past any backoff
        await o.runTags(Date.now());
      } finally {
        o.env = was;
      }
    });
  const rage = (T: number) => [click(T, 1, "#pay"), click(T + 200, 1, "#pay"), click(T + 400, 1, "#pay")];

  it("links a container of the same account only; needs the TAGS binding", async () => {
    const { key, site, account } = await newSite("shop.test");
    expect((await call("PATCH", `/v1/sites/${site}`, { key, body: { tags_container_id: CTR } })).json.error.code).toBe(
      "tags_not_available",
    );
    const t = tagsStub(account, [CTR]);
    const bad = await call("PATCH", `/v1/sites/${site}`, { key, body: { tags_container_id: "ctr_0000000000000999" }, env: t.env });
    expect(bad.status).toBe(400);
    expect(bad.json.error.hint).toContain("GET /v1/containers");
    expect((await call("PATCH", `/v1/sites/${site}`, { key, body: { tags_container_id: "nope" }, env: t.env })).status).toBe(400);
    // another account's container is a 404 at tags (internal auth carries this site's account)
    const other = await signup();
    const theirs = tagsStub(other.account, [CTR]);
    expect((await call("PATCH", `/v1/sites/${site}`, { key, body: { tags_container_id: CTR }, env: theirs.env })).status).toBe(400);
    const ok = await call("PATCH", `/v1/sites/${site}`, {
      key,
      body: { tags_container_id: CTR, tags_signals: ["rage_click", "js_error", "survey_response"] },
      env: t.env,
    });
    expect(ok.status).toBe(200);
    expect(ok.json.site).toMatchObject({
      tags_container_id: CTR,
      tags_signals: ["rage_click", "js_error", "survey_response"],
      tags_forwarding: "on",
    });
    expect(ok.json.notes.join(" ")).toContain(`/v1/containers/${CTR}/events`);
    expect(t.calls).toContain(`GET tags.internal/v1/containers/${CTR}`);
    // the loader tells the recorder to carry the tags visitor id; without the binding it doesn't
    expect((await call("GET", `/r/${site}.js`, { env: t.env })).text).toContain('"tg":1');
    expect((await call("GET", `/r/${site}.js`)).text).not.toContain('"tg":1');
  });

  it("queues chosen signals at ingest and sends them in one batch over internal auth; retries keep them", async () => {
    const { key, site, account } = await newSite("shop.test");
    const t = tagsStub(account, [CTR]);
    await call("PATCH", `/v1/sites/${site}`, {
      key,
      body: { tags_container_id: CTR, tags_signals: ["rage_click", "js_error"] },
      env: t.env,
    });
    const T = Date.now() - 30_000;
    const a = newSid();
    const b = newSid();
    const vid = "vid_test.1700000000";
    expect(
      (
        await sendChunk(site, a, 0, [meta(T), page(T + 5, 1, "/checkout"), ...rage(T + 1000), error(T + 2000, 1, "Error: boom")], {
          env: t.env,
          extra: { end: 1, tvid: vid },
        })
      ).status,
    ).toBe(202);
    await sendChunk(site, b, 0, [meta(T), page(T + 5, 1, "/cart"), ...rage(T + 1000)], { env: t.env, extra: { end: 1 } });
    const before = (await call("GET", `/v1/sites/${site}`, { key })).json.data;
    expect(before.tags_forwarding.queued).toBe(3);
    expect(before.usage_today.tags_events).toBe(3);
    // the tags service is down: nothing is lost
    t.state.status = 503;
    await flushTags(site, t.env);
    expect((await call("GET", `/v1/sites/${site}`, { key })).json.data.tags_forwarding).toMatchObject({
      queued: 3,
      last: { status: 503, sent: 0 },
    });
    t.state.status = 202;
    await flushTags(site, t.env);
    expect(t.posts).toHaveLength(1);
    const events = t.posts[0]!.events;
    expect(events.map((e) => e.name).sort()).toEqual(["js_error", "rage_click", "rage_click"]);
    const fromA = events.filter((e) => e.params.replay_session_id === a);
    expect(fromA.every((e) => e.visitor_id === vid && !e.consent)).toBe(true);
    const fromB = events.find((e) => e.params.replay_session_id === b)!;
    expect(fromB.consent).toMatchObject({ ad_storage: "denied", ad_user_data: "denied" });
    expect(fromB.page_url).toBe("https://shop.test/cart");
    for (const e of events) {
      expect(e.event_id).toMatch(/^rp\.rs_/);
      expect(e).not.toHaveProperty("ip");
      expect(e).not.toHaveProperty("user_agent");
    }
    const after = (await call("GET", `/v1/sites/${site}`, { key })).json;
    expect(after.data.tags_forwarding).toMatchObject({ queued: 0, last: { status: 202, sent: 3 } });
    expect(after.limits.tags_events_per_day).toBe(500);
  });

  it("completed survey answers with an NPS score go too (scores only); unlinking and privacy deletion drop what is queued", async () => {
    const { key, site, account } = await newSite("shop.test");
    const t = tagsStub(account, [CTR]);
    await call("PATCH", `/v1/sites/${site}`, { key, body: { tags_container_id: CTR }, env: t.env });
    const sv = (
      await call("POST", `/v1/sites/${site}/surveys`, { key, body: { name: "NPS", kind: "popover", template: "nps", status: "active" } })
    ).json.survey.id;
    expect((await call("GET", `/sv/${site}.x.js`, { env: t.env })).text).toContain('"tg":1');
    const r = await postF(
      { s: site, sv, ver: 1, r: "0000000000000abc", a: { q1: 10, q2: "Love it, call me" }, d: 1, p: "/", tv: "vid_test.1700000000" },
      { env: t.env },
    );
    expect(r.status).toBe(202);
    // partial answers and answers without a score aren't sent
    await postF({ s: site, sv, ver: 1, r: "0000000000000abd", a: { q2: "no score" }, d: 0, p: "/" }, { env: t.env });
    await flushTags(site, t.env);
    expect(t.posts).toHaveLength(1);
    const [e] = t.posts[0]!.events;
    expect(e).toMatchObject({ name: "survey_response", event_id: "rp.rsr_0000000000000abc", visitor_id: "vid_test.1700000000" });
    expect(e!.params).toEqual({ source: "afs_replay", survey_id: sv, nps_score: 10, nps_group: "promoter" });
    expect(JSON.stringify(e)).not.toContain("Love it");

    // queued, then unlinked: dropped
    const T = Date.now() - 30_000;
    await sendChunk(site, newSid(), 0, [meta(T), page(T + 5, 1, "/"), ...rage(T + 1000)], { env: t.env, extra: { end: 1 } });
    expect((await call("GET", `/v1/sites/${site}`, { key })).json.data.tags_forwarding.queued).toBe(1);
    const off = await call("PATCH", `/v1/sites/${site}`, { key, body: { tags_container_id: null }, env: t.env });
    expect(off.json.site.tags_forwarding).toBe("off");
    expect((await call("GET", `/v1/sites/${site}`, { key })).json.data.tags_forwarding.queued).toBe(0);
    // a privacy deletion takes the session's queued events with it
    await call("PATCH", `/v1/sites/${site}`, { key, body: { tags_container_id: CTR }, env: t.env });
    const s2 = newSid();
    await sendChunk(site, s2, 0, [meta(T), page(T + 5, 1, "/"), ...rage(T + 1000)], { env: t.env, extra: { end: 1 } });
    expect((await call("GET", `/v1/sites/${site}`, { key })).json.data.tags_forwarding.queued).toBe(1);
    const del = await call("DELETE", `/v1/sites/${site}/sessions/${s2}`, { key });
    expect(del.json.note).toContain("tags container");
    expect((await call("GET", `/v1/sites/${site}`, { key })).json.data.tags_forwarding.queued).toBe(0);
  });

  it("an envelope's tvid must look like a tags visitor id; unknown fields are still refused", async () => {
    const { site } = await newSite("shop.test");
    const T = Date.now() - 10_000;
    expect((await sendChunk(site, newSid(), 0, [meta(T), page(T + 5, 1, "/")], { extra: { tvid: "vid_test.1700000000" } })).status).toBe(
      202,
    );
    expect((await sendChunk(site, newSid(), 0, [meta(T), page(T + 5, 1, "/")], { extra: { tvid: "<script>" } })).status).toBe(202);
    expect((await sendChunk(site, newSid(), 0, [meta(T), page(T + 5, 1, "/")], { extra: { tvx: "x" } })).status).toBe(400);
    void custom;
  });
});

describe("wave 2, 4: heatmap images", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]); // the PNG signature: enough for a fake
  /** A stand-in for the Browser Rendering binding: records each screenshot request. */
  function browserStub(status = 200) {
    const calls: { action: string; opts: Record<string, any> }[] = [];
    const BROWSER = {
      quickAction: async (action: string, opts: Record<string, any>) => {
        calls.push({ action, opts });
        return status === 200
          ? new Response(PNG, { headers: { "content-type": "image/png", "x-browser-ms-used": "1234" } })
          : Response.json({ success: false, errors: [{ message: "busy" }] }, { status, headers: { "x-browser-ms-used": "10" } });
      },
    } as unknown as BrowserRun;
    return { env: hosted({ BROWSER }), calls };
  }
  const doc = {
    type: 0,
    childNodes: [
      {
        type: 2,
        tagName: "html",
        attributes: {},
        childNodes: [
          {
            type: 2,
            tagName: "head",
            attributes: {},
            childNodes: [{ type: 2, tagName: "script", attributes: {}, childNodes: [{ type: 3, textContent: "x()" }] }],
          },
          {
            type: 2,
            tagName: "body",
            attributes: {},
            childNodes: [{ type: 2, tagName: "button", attributes: { id: "buy" }, childNodes: [{ type: 3, textContent: "***" }] }],
          },
        ],
      },
    ],
  };
  const record = async (site: string) => {
    const T = Date.now() - 60_000;
    const sid = newSid();
    await sendChunk(site, sid, 0, [
      meta(T, "https://shop.test/pricing", 1280, 800),
      { type: 2, timestamp: T + 1, data: { node: doc, initialOffset: { top: 0, left: 0 } } },
      page(T + 5, 1, "/pricing", { dh: 2400 }),
      click(T + 1000, 1, "#buy", { x: 640, y: 600, w: 1280, dh: 2400 }),
    ]);
    return sid;
  };

  it("needs a verified site, the BROWSER binding and a stored snapshot", async () => {
    const b = browserStub();
    const unverified = await newSite("shop.test", {}, undefined, { verified: false });
    expect(
      (await call("GET", `/v1/sites/${unverified.site}/heatmap/image?page=/pricing`, { key: unverified.key, env: b.env })).json.error.code,
    ).toBe("domain_not_verified");
    const { key, site } = await newSite("shop.test");
    // the template declares BROWSER (local mode under test): a deployment without it
    const off = await call("GET", `/v1/sites/${site}/heatmap/image?page=/pricing`, { key, env: hosted({ BROWSER: undefined }) });
    expect(off.status).toBe(503);
    expect(off.json.error).toMatchObject({ code: "heatmap_images_unavailable" });
    expect(off.json.error.hint).toContain("/heatmap");
    const none = await call("GET", `/v1/sites/${site}/heatmap/image?page=/pricing`, { key, env: b.env });
    expect(none.status).toBe(404);
    expect(none.json.error.code).toBe("no_snapshot");
    expect(b.calls).toHaveLength(0);
  });

  it("renders the masked snapshot with the overlay (JS off, site hosts only), caches it for a day, counts renders", async () => {
    const { key, site, account } = await newSite("shop.test");
    const sid = await record(site);
    const b = browserStub();
    const r = await call("GET", `/v1/sites/${site}/heatmap/image?page=/pricing&type=click`, { key, env: b.env });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-afs-heatmap-cache")).toBe("miss");
    expect(r.headers.get("x-afs-heatmap-snapshot-session")).toBe(sid);
    expect(b.calls).toHaveLength(1);
    const o = b.calls[0]!.opts;
    expect(b.calls[0]!.action).toBe("screenshot");
    expect(o.setJavaScriptEnabled).toBe(false);
    expect(o.viewport).toMatchObject({ width: 1280, height: 2400 });
    expect(o.allowRequestPattern).toContain("^data:image/");
    expect(o.html).toContain('<base href="https://shop.test/pricing">');
    expect(o.html).toContain('id="afs-hm"');
    expect(o.html).toContain("left:50.3%"); // the click at x 640 of 1280
    expect(o.html).not.toContain("<script");
    // the same page, device, type and period again: from the cache, no browser time
    const again = await call("GET", `/v1/sites/${site}/heatmap/image?page=/pricing&type=click`, { key, env: b.env });
    expect(again.headers.get("x-afs-heatmap-cache")).toBe("hit");
    expect(b.calls).toHaveLength(1);
    expect((await E.CHUNKS.list({ prefix: `heatmaps/${site}/` })).objects).toHaveLength(1);
    const usage = await E.DB.prepare("SELECT scope, images, browser_ms FROM heatmap_image_usage WHERE scope IN (?, ?) ORDER BY scope")
      .bind(site, account)
      .all();
    expect(usage.results.map((x) => [x.images, x.browser_ms])).toEqual([
      [1, 1234],
      [1, 1234],
    ]);
    // MCP: where to fetch it, what it shows
    const t = await tool(key, "get_heatmap_image", { site_id: site, page: "/pricing", type: "click", include_base64: true }, b.env);
    expect(t.isError).toBe(false);
    expect(t.data.image).toMatchObject({ cached: true, content_type: "image/png", bytes: PNG.length, png_base64: "iVBORw0KGgoAAAAA" });
    expect(t.data.image.url).toContain(`/v1/sites/${site}/heatmap/image?`);
    expect(t.data.shows).toMatchObject({ type: "click", device: "desktop", clicks: 1, snapshot_session_id: sid });
    // a privacy deletion of the snapshot's session drops the cached images
    await call("DELETE", `/v1/sites/${site}/sessions/${sid}`, { key });
    expect((await E.CHUNKS.list({ prefix: `heatmaps/${site}/` })).objects).toHaveLength(0);
  });

  it("strict daily caps per site (UNCLAIMED_ too); a busy browser is a 503 with a hint", async () => {
    const { key, site } = await newSite("shop.test");
    await record(site);
    const b = browserStub();
    const capped = hosted({ ...b.env, MAX_HEATMAP_IMAGES_PER_SITE_PER_DAY: "1" });
    expect((await call("GET", `/v1/sites/${site}/heatmap/image?page=/pricing&type=scroll`, { key, env: capped })).status).toBe(200);
    const over = await call("GET", `/v1/sites/${site}/heatmap/image?page=/pricing&type=attention`, { key, env: capped });
    expect(over.status).toBe(429);
    expect(over.json.error).toMatchObject({ code: "heatmap_image_limit" });
    expect(over.json.error.hint).toContain("cached");
    // cached ones still come back past the cap
    expect((await call("GET", `/v1/sites/${site}/heatmap/image?page=/pricing&type=scroll`, { key, env: capped })).status).toBe(200);
    const unclaimed = hosted({ ...b.env, UNCLAIMED_MAX_HEATMAP_IMAGES_PER_ACCOUNT_PER_DAY: "1" } as Partial<Bindings>);
    expect((await call("GET", `/v1/sites/${site}/heatmap/image?page=/pricing&type=attention`, { key, env: unclaimed })).status).toBe(429);
    const other = await newSite("shop.test");
    await record(other.site);
    const busy = browserStub(429);
    const r = await call("GET", `/v1/sites/${other.site}/heatmap/image?page=/pricing`, { key: other.key, env: busy.env });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("browser_busy");
  });
});

describe("wave 2, 5: opt-in email answers, impression budgets", () => {
  it("an email answer stays in its response: transcript, results and filters only know one was given; deletion by email", async () => {
    const { key, site } = await newSite("shop.test");
    const bad = await call("POST", `/v1/sites/${site}/surveys`, {
      key,
      body: { name: "Bad", kind: "popover", questions: [{ type: "email", text: "Follow up?", required: true }] },
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json.error)).toContain("consent_text");
    const sv = (
      await call("POST", `/v1/sites/${site}/surveys`, {
        key,
        body: {
          name: "Follow up",
          kind: "popover",
          status: "active",
          questions: [
            { type: "nps", text: "Recommend us?" },
            { type: "email", text: "Can we follow up?", consent_text: "You may email me about this answer only." },
          ],
        },
      })
    ).json.survey.id as string;
    const T = Date.now() - 30_000;
    const sid = newSid();
    await sendChunk(site, sid, 0, [meta(T), page(T + 5, 1, "/")]);
    // without consent: refused
    const no = await postF({
      s: site,
      sv,
      ver: 1,
      r: "00000000000000e1",
      a: { q1: 9, q2: { email: "person@example.test" } },
      d: 1,
      p: "/",
      sid,
    });
    expect(no.json.error).toBe("invalid_answer");
    const yes = await postF({
      s: site,
      sv,
      ver: 1,
      r: "00000000000000e2",
      a: { q1: 9, q2: { email: "Person@Example.test", consent: true } },
      d: 1,
      p: "/",
      sid,
    });
    expect(yes.status).toBe(202);
    const list = await call("GET", `/v1/sites/${site}/surveys/${sv}/responses`, { key });
    expect(JSON.stringify(list.json)).toContain("Person@Example.test");
    const transcript = await call("GET", `/v1/sites/${site}/sessions/${sid}/transcript`, { key });
    expect(transcript.text).toContain("(email given)");
    expect(transcript.text).not.toContain("Example.test");
    const results = await call("GET", `/v1/sites/${site}/surveys/${sv}/results`, { key });
    expect(JSON.stringify(results.json)).not.toContain("Example.test");
    expect(JSON.stringify(results.json)).toContain('"emails_given":1');
    const filter = await call("GET", `/v1/sites/${site}/sessions?survey_id=${sv}&survey_answer=q2=Person@Example.test`, { key });
    expect(filter.status).toBe(400);
    expect(filter.json.error.hint).toBeTruthy();
    // a data-access request and a deletion by the address (case-insensitive)
    const visitor = await call("GET", `/v1/sites/${site}/visitors?email=person@example.test`, { key });
    expect(visitor.json.untrusted.survey_responses).toHaveLength(1);
    // an unlinked response with the same address goes too
    await postF(
      { s: site, sv, ver: 1, r: "00000000000000e3", a: { q2: { email: "person@example.test", consent: true } }, d: 1, p: "/" },
      { ip: "203.0.113.52" },
    );
    const del = await call("POST", `/v1/sites/${site}/delete-visitor-data`, { key, body: { email: "person@example.test" } });
    expect(del.json).toMatchObject({ deleted_sessions: 1, session_ids: [sid], survey_responses_deleted_without_session: 1 });
    expect(JSON.stringify((await call("GET", `/v1/sites/${site}/surveys/${sv}/responses`, { key })).json)).not.toContain("xample.test");
    expect((await call("GET", `/v1/sites/${site}/sessions/${sid}/transcript`, { key })).status).toBe(404);
  });

  it("survey impressions count against the account's daily derived budget", async () => {
    const { key, site } = await newSite("shop.test");
    const sv = (
      await call("POST", `/v1/sites/${site}/surveys`, { key, body: { name: "S", kind: "popover", template: "nps", status: "active" } })
    ).json.survey.id;
    const env = hosted({ MAX_DERIVED_PER_ACCOUNT_PER_DAY: "1" });
    expect((await postF({ s: site, sv, ver: 1, imp: 1 }, { env })).status).toBe(202);
    const over = await postF({ s: site, sv, ver: 1, imp: 1 }, { env, ip: "203.0.113.51" });
    expect(over.status).toBe(429);
    expect(over.json.error).toBe("account_daily_limit");
    expect((await call("GET", `/v1/sites/${site}`, { key })).json.data.usage_today.derived_events).toBe(1);
  });
});
