import { describe, expect, it } from "vitest";
import { click, error, event, hide, input, meta, mutation, page, scroll, snapshot } from "../fixtures/rrweb";
import { E, MOBILE_UA, call, gunzip, hosted, newSid, newSite, sendChunk, signup, tool } from "./helpers";

/** A realistic two-chunk checkout session: snapshot first, then interactions; ends with pagehide. */
async function recordCheckout(site: string, opts: { sid?: string; ua?: string; uid?: string } = {}) {
  const sid = opts.sid ?? newSid();
  const T = Date.now() - 120_000;
  const a = await sendChunk(
    site,
    sid,
    0,
    [meta(T, "https://shop.test/pricing"), snapshot(T + 1), page(T + 5, 1, "/pricing", { r: "google.com" })],
    {
      ua: opts.ua,
      extra: opts.uid ? { uid: opts.uid } : {},
    },
  );
  const b = await sendChunk(
    site,
    sid,
    1,
    [
      scroll(T + 1500, 1, 1500),
      click(T + 3000, 1, "#plans button.cta", { l: "Start trial" }),
      mutation(T + 3100),
      page(T + 3200, 2, "/checkout", { nav: "push", r: "/pricing" }),
      input(T + 5000, 2, "#email"),
      click(T + 8000, 2, "#pay", { l: "Pay", top: 70 }),
      click(T + 8200, 2, "#pay", { l: "Pay", top: 70 }),
      click(T + 8400, 2, "#pay", { l: "Pay", top: 70 }),
      error(T + 8500, 2, "TypeError: card is undefined"),
      event(T + 9000, 2, "checkout_failed"),
      hide(T + 12_000, 2, "pagehide"),
    ],
    { plain: true, ua: opts.ua, extra: { end: 1, ...(opts.uid ? { uid: opts.uid } : {}) } },
  );
  return { sid, a, b, T };
}

describe("signup and sites", () => {
  it("signup returns a key; sites are idempotent by domain and carry the snippet", async () => {
    const { key } = await signup();
    expect(key).toMatch(/^(rpy|afs)_/);
    const c = await call("POST", "/v1/sites", { key, body: { domain: "https://www.Shop.test/path" } });
    expect(c.status).toBe(201);
    expect(c.json.site).toMatchObject({
      domain: "shop.test",
      mask_mode: "strict",
      sample_rate: 1,
      retention_days: 30,
      enabled: true,
      analytics_forwarding: "off",
    });
    expect(c.json.site.snippet).toBe(`<script defer src="http://replay.test/r/${c.json.site.id}.js"></script>`);
    expect(c.json.install.code).toContain("afsr.q");
    expect(c.json.next_steps.join(" ")).toContain("?afsr=1");
    const again = await call("POST", "/v1/sites", { key, body: { domain: "shop.test" } });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ existing: true, site: { id: c.json.site.id } });
    expect((await call("GET", "/v1/sites", { key })).json.sites).toHaveLength(1);
    const g = await call("GET", `/v1/sites/${c.json.site.id}`, { key });
    expect(g.json.data).toMatchObject({ sessions_total: 0, dropped_last_7d: {} });
    for (const f of ["nextjs", "react", "astro", "wordpress", "gtm"]) {
      const i = await call("GET", `/v1/sites/${c.json.site.id}/install?framework=${f}`, { key });
      expect(i.json.code).toContain(`/r/${c.json.site.id}.js`);
    }
    expect((await call("GET", `/v1/sites/${c.json.site.id}/install?framework=vue`, { key })).status).toBe(400);
  });

  it("validates settings with hints and clamps to the deployment's caps", async () => {
    const { key, site } = await newSite("settings.test");
    const bad = await call("PATCH", `/v1/sites/${site}`, { key, body: { unmask_selectors: ["nav", "a{x}"] } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.hint).toContain("unmask_selectors[1]");
    expect((await call("PATCH", `/v1/sites/${site}`, { key, body: { sample_rate: 2 } })).json.error.details[0].path).toBe("sample_rate");
    expect((await call("PATCH", `/v1/sites/${site}`, { key, body: { exclude_paths: ["account"] } })).status).toBe(400);
    const capped = await call("PATCH", `/v1/sites/${site}`, {
      key,
      body: {
        sample_rate: 0.5,
        max_session_minutes: 90,
        retention_days: 90,
        unmask_selectors: ["nav", "button"],
        mask_mode: "balanced",
        exclude_paths: ["/account/*"],
      },
      env: hosted({ MAX_SAMPLE_RATE: "0.1", MAX_SESSION_MINUTES: "30", MAX_RETENTION_DAYS: "30" }),
    });
    expect(capped.status).toBe(200);
    expect(capped.json.site).toMatchObject({
      sample_rate: 0.1,
      max_session_minutes: 30,
      retention_days: 30,
      unmask_selectors: ["nav", "button"],
      mask_mode: "balanced",
    });
    expect(capped.json.notes).toHaveLength(3);
    const link = await call("PATCH", `/v1/sites/${site}`, { key, body: { analytics_site_id: "site_0123456789abcdef" } });
    expect(link.status).toBe(400);
    expect(link.json.error.code).toBe("analytics_not_available");
  });

  it("MAX_SITES_PER_ACCOUNT, unknown ids and auth answer with hints", async () => {
    const { key } = await signup();
    const env = hosted({ MAX_SITES_PER_ACCOUNT: "1" });
    expect((await call("POST", "/v1/sites", { key, body: { domain: "one.test" }, env })).status).toBe(201);
    const second = await call("POST", "/v1/sites", { key, body: { domain: "two.test" }, env });
    expect(second.status).toBe(403);
    expect(second.json.error.code).toBe("quota_exceeded");
    expect((await call("GET", "/v1/sites/rsite_doesnotexist0000", { key })).json.error.hint).toContain("GET /v1/sites");
    expect((await call("GET", "/v1/sites/site_0123456789abcdef", { key })).json.error.hint).toContain("rsite_");
    expect((await call("GET", "/v1/sites")).json.error.code).toBe("unauthorized");
    expect((await call("GET", "/nope")).json.error.hint).toContain("llms.txt");
    const other = await signup();
    const mine = await newSite("private.test");
    expect((await call("GET", `/v1/sites/${mine.site}`, { key: other.key })).status).toBe(404);
  });
});

describe("browser scripts", () => {
  it("serves the per-site loader with the site's config, ETag/304, and under a proxy prefix", async () => {
    const { key, site } = await newSite("loader.test", {
      mask_mode: "relaxed",
      mask_selectors: [".price"],
      exclude_paths: ["/admin*"],
      sample_rate: 0.25,
    });
    const r = await call("GET", `/r/${site}.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("javascript");
    expect(r.text.startsWith(`/*! afs-replay ${site} */`)).toBe(true);
    const cfg = JSON.parse(/var __AFSR__=(\{.*?\});\n/.exec(r.text)![1]!);
    expect(cfg).toMatchObject({
      site,
      sr: 0.25,
      mask: "relaxed",
      maskSel: ".price",
      ex: [],
      on: true,
      base: "http://replay.test",
    });
    // exclude_paths aren't listed in the public script
    expect(cfg.exh).toHaveLength(1);
    expect(r.text).not.toContain("/admin");
    expect(cfg.rec).toMatch(/^\/rec\/[0-9a-f]{12}\.js$/);
    const etag = r.headers.get("etag")!;
    expect((await call("GET", `/r/${site}.js`, { headers: { "if-none-match": etag } })).status).toBe(304);
    expect((await call("GET", `/_r/r/${site}.js`)).status).toBe(200);
    const rec = await call("GET", cfg.rec);
    expect(rec.text.startsWith("/*! afs-replay recorder")).toBe(true);
    expect(rec.headers.get("cache-control")).toContain("immutable");
    expect((await call("GET", "/recorder.000000000000.js")).headers.get("cache-control")).toBe("public, max-age=300");
    expect((await call("GET", "/r/rsite_doesnotexist0000.js")).status).toBe(404);
    expect((await call("GET", "/r/nope.js")).status).toBe(404);
    // settings changes reach the loader (the PATCH evicts the cached row)
    await call("PATCH", `/v1/sites/${site}`, { key, body: { enabled: false } });
    expect((await call("GET", `/r/${site}.js`)).text).toContain('"on":false');
  });
});

describe("ingest -> sessions, transcript, summary, heatmap, errors, funnel", () => {
  it("records a session end to end, gzip and plain chunks", async () => {
    const { key, site } = await newSite("shop.test");
    const { sid, a, b } = await recordCheckout(site, { uid: "u_42" });
    expect(a.status).toBe(202);
    expect(a.json).toMatchObject({ ok: true, new_session: true });
    expect(a.headers.get("access-control-allow-origin")).toBe("*");
    expect(b.json).toMatchObject({ ok: true, new_session: false });
    // chunks are in R2 as gzip under <site>/<session>/<seq>
    const obj = await E.CHUNKS.get(`${site}/${sid}/000001`);
    expect(JSON.parse(await gunzip(new Uint8Array(await obj!.arrayBuffer())))).toMatchObject({ sid, seq: 1, end: 1 });

    const list = await call("GET", `/v1/sites/${site}/sessions`, { key });
    expect(list.json.total).toBe(1);
    const s = list.json.sessions[0];
    expect(s).toMatchObject({
      id: sid,
      pageviews: 2,
      clicks: 4,
      inputs: 1,
      errors: 1,
      device: "desktop",
      browser: "Chrome",
      os: "Mac OS",
      ended: true,
    });
    expect(s.signals).toMatchObject({ rage_clicks: 1, error_clicks: 1, js_errors: 1 });
    expect(s.frustration).toBeGreaterThan(40);
    expect(s.untrusted).toEqual({ entry_path: "/pricing", exit_path: "/checkout", user_id: "u_42" });
    expect(list.json.notice).toContain("UNTRUSTED");

    const filtered = async (q: string) => (await call("GET", `/v1/sites/${site}/sessions?${q}`, { key })).json.total;
    expect(await filtered("signal=rage_click&page=/check*&device=desktop&has_error=true&min_duration=5")).toBe(1);
    expect(await filtered("signal=quick_back")).toBe(0);
    expect(await filtered("user_id=u_42&clicked=%23pay&event=checkout_failed")).toBe(1);
    expect((await call("GET", `/v1/sites/${site}/sessions?signal=nope`, { key })).status).toBe(400);
    expect((await call("GET", `/v1/sites/${site}/sessions?page=checkout`, { key })).json.error.hint).toContain("/checkout*");

    const one = await call("GET", `/v1/sites/${site}/sessions/${sid}`, { key });
    expect(one.json.pages.map((p: any) => p.untrusted.path)).toEqual(["/pricing", "/checkout"]);
    expect(one.json.chunks).toBe(2);

    const text = await call("GET", `/v1/sites/${site}/sessions/${sid}/transcript`, { key });
    expect(text.json.format).toBe("text");
    expect(text.json.transcript).toContain("<<<UNTRUSTED_REPLAY_TRANSCRIPT_");
    expect(text.json.transcript).toMatch(/click x3 in 0\.4s button "Pay" \{"#pay"\}\s+\[RAGE DEAD ERROR-CLICK\]/);
    expect(text.json.transcript).toContain('JS error "TypeError: card is undefined"');
    const json = await call("GET", `/v1/sites/${site}/sessions/${sid}/transcript?format=json&kinds=click,error`, { key });
    expect(json.json.untrusted.timeline.map((e: any) => e.kind)).toEqual(["click", "click", "error"]);

    const sum = await call("GET", `/v1/sites/${site}/summary?period=7d`, { key });
    expect(sum.json.sessions_considered).toBe(1);
    expect(sum.json.untrusted.top_rage_targets[0]).toMatchObject({ selector: "#pay", label: "Pay", example_session_ids: [sid] });
    expect(sum.json.untrusted.findings[0]).toContain("rage-clicked");
    expect((await call("GET", `/v1/sites/${site}/summary?session_ids=${sid},bad`, { key })).status).toBe(400);

    const heat = await call("GET", `/v1/sites/${site}/heatmap?page=/checkout`, { key });
    expect(heat.json.untrusted.elements[0]).toMatchObject({ selector: "#pay", clicks: 3, rage_share: 1, position_pct: 70 });
    expect(heat.json.scroll.pageviews).toBe(1);
    const scrollOnly = await call("GET", `/v1/sites/${site}/heatmap?page=/pricing&type=scroll`, { key });
    expect(scrollOnly.json.untrusted).toBeUndefined();
    expect(scrollOnly.json.scroll.reach.find((r: any) => r.pct === 80).share).toBe(1);
    expect((await call("GET", `/v1/sites/${site}/heatmap`, { key })).status).toBe(400);

    const errs = await call("GET", `/v1/sites/${site}/errors`, { key });
    expect(errs.json).toMatchObject({ occurrences: 1, sessions_with_errors: 1, groups: 1 });
    expect(errs.json.untrusted.errors[0]).toMatchObject({
      message: "TypeError: card is undefined",
      triggered_by: [{ selector: "#pay" }],
      after_click: 1,
    });
    const fp = errs.json.untrusted.errors[0].fingerprint;
    expect(await filtered(`error_fingerprint=${fp}`)).toBe(1);

    const funnel = await call("GET", `/v1/sites/${site}/funnel?steps=/pricing,/checkout,/thanks&drop_step=2`, { key });
    expect(funnel.json.untrusted.steps.map((s: any) => s.sessions)).toEqual([1, 1, 0]);
    expect(funnel.json.dropped).toMatchObject({ step: 2, total: 1 });
    expect(funnel.json.dropped.sessions[0].id).toBe(sid);
    expect(funnel.json.dropped.untrusted.top_rage_targets[0].selector).toBe("#pay");
    expect((await call("GET", `/v1/sites/${site}/funnel?steps=/a,goal:Buy`, { key })).json.error.hint).toContain("afsr('event'");
    expect((await call("GET", `/v1/sites/${site}/funnel?steps=/a,/b&drop_step=2`, { key })).status).toBe(400);
  });

  it("refuses what isn't the site's, oversized, malformed or automated, and counts the drops", async () => {
    const { key, site } = await newSite("guard.test");
    const sid = newSid();
    const T = Date.now() - 10_000;
    const ev = [page(T, 1, "/", { h: "guard.test" })];
    const o = { origin: "https://guard.test" };
    expect((await call("OPTIONS", "/i")).headers.get("access-control-allow-methods")).toContain("POST");
    expect((await sendChunk("rsite_bad", sid, 0, ev, o)).json).toMatchObject({ error: "bad_site_id", stop: true });
    expect((await sendChunk("rsite_doesnotexist0000", sid, 0, ev, o)).status).toBe(404);
    expect((await sendChunk(site, "rs_x", 0, ev, o)).json.error).toBe("bad_session_id");
    const foreign = await sendChunk(site, sid, 0, ev, { origin: "https://evil.test" });
    expect(foreign.status).toBe(403);
    expect(foreign.json).toMatchObject({ error: "origin_not_allowed", stop: true });
    const sub = await sendChunk(site, newSid(), 0, [page(T, 1, "/", { h: "www.guard.test" })], { origin: "https://www.guard.test" });
    expect(sub.status).toBe(202);
    const host = await sendChunk(site, newSid(), 0, [page(T, 1, "/", { h: "evil.test" })], o);
    expect(host.json.error).toBe("hostname_not_allowed");
    expect(
      (
        await call("POST", `/i?s=${site}&sid=${sid}&q=0&z=1`, {
          raw: "not gzip",
          headers: { "user-agent": "Mozilla/5.0 x", origin: "https://guard.test" },
        })
      ).json.error,
    ).toBe("invalid_gzip");
    expect(
      (await call("POST", `/i?s=${site}&sid=${sid}&q=0&z=0`, { raw: "{", headers: { origin: "https://guard.test" } })).json.error,
    ).toBe("invalid_json");
    expect((await sendChunk(site, sid, 0, ev, { ...o, extra: { seq: 5 } })).json.error).toBe("seq_mismatch");
    const bot = await sendChunk(site, sid, 0, ev, {
      ...o,
      ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/131.0 Safari/537.36",
    });
    expect(bot.json).toMatchObject({ ok: false, dropped: "bot", stop: true });
    expect((await sendChunk(site, sid, 0, ev, { ...o, extra: { wd: 1 } })).json.dropped).toBe("bot");
    // forced recordings (?afsr=1) are kept even from automated browsers, and marked
    const forced = await sendChunk(site, sid, 0, ev, { ...o, ua: "curl/8.0", extra: { f: 1 } });
    expect(forced.status).toBe(202);
    expect((await call("GET", `/v1/sites/${site}/sessions?forced=true`, { key })).json.total).toBe(1);
    const tiny = hosted({ MAX_CHUNK_BYTES: "100" });
    const big = await sendChunk(site, newSid(), 0, [...ev, ...Array.from({ length: 50 }, (_, i) => click(T + i, 1, `#b${i}`))], {
      ...o,
      plain: true,
      env: tiny,
    });
    expect(big.status).toBe(413);
    expect(big.json).toMatchObject({ error: "chunk_too_large", stop: true });
    const data = (await call("GET", `/v1/sites/${site}`, { key })).json.data;
    expect(Object.keys(data.dropped_last_7d).sort()).toEqual([
      "bot:user_agent",
      "bot:webdriver",
      "chunk_too_large",
      "hostname_not_allowed",
      "origin_not_allowed",
    ]);
    expect(data.dropped_last_7d.origin_not_allowed.sample).toBeUndefined();
    expect((await call("GET", `/v1/sites/${site}`, { key })).json.untrusted.drop_samples.origin_not_allowed).toBe("evil.test");
    // disabled sites tell the recorder to stop
    await call("PATCH", `/v1/sites/${site}`, { key, body: { enabled: false } });
    expect((await sendChunk(site, newSid(), 0, ev, o)).json).toMatchObject({ error: "disabled", stop: true });
  });

  it("MAX_SESSIONS_PER_SITE_PER_DAY and MAX_SESSION_BYTES stop recording with reasons", async () => {
    const { site } = await newSite("caps.test");
    const env = hosted({ MAX_SESSIONS_PER_SITE_PER_DAY: "1", MAX_SESSION_BYTES: "4000" });
    const T = Date.now() - 10_000;
    const o = { origin: "https://caps.test", env };
    const first = newSid();
    expect((await sendChunk(site, first, 0, [page(T, 1, "/", { h: "caps.test" })], o)).status).toBe(202);
    const second = await sendChunk(site, newSid(), 0, [page(T, 1, "/", { h: "caps.test" })], o);
    expect(second.status).toBe(429);
    expect(second.json).toMatchObject({ error: "daily_session_limit", stop: true });
    expect(second.json.hint).toContain("00:00 UTC");
    const heavy = Array.from({ length: 400 }, (_, i) =>
      click(T + i, 1, `#el-${i}-${"x".repeat(40)}`, { l: `label ${i} ${Math.random()}` }),
    );
    const r = await sendChunk(site, first, 1, heavy, o);
    expect(r.json).toMatchObject({ error: "session_bytes_limit", stop: true });
  });

  it("delete_session and delete_visitor_data remove recordings from the DO and R2", async () => {
    const { key, site } = await newSite("shop.test");
    const one = await recordCheckout(site);
    const two = await recordCheckout(site, { uid: "user-7" });
    const three = await recordCheckout(site, { uid: "user-7" });
    const del = await call("DELETE", `/v1/sites/${site}/sessions/${one.sid}`, { key });
    expect(del.json).toMatchObject({ deleted: one.sid, chunks_deleted: 2 });
    expect(await E.CHUNKS.get(`${site}/${one.sid}/000000`)).toBeNull();
    expect((await call("GET", `/v1/sites/${site}/sessions/${one.sid}`, { key })).status).toBe(404);
    expect((await call("POST", `/v1/sites/${site}/delete-visitor-data`, { key, body: {} })).json.error.hint).toContain("user_id");
    const v = await call("POST", `/v1/sites/${site}/delete-visitor-data`, { key, body: { user_id: "user-7" } });
    expect(v.json.deleted_sessions).toBe(2);
    expect(v.json.session_ids.sort()).toEqual([two.sid, three.sid].sort());
    expect((await call("GET", `/v1/sites/${site}/sessions`, { key })).json.total).toBe(0);
    const listed = await E.CHUNKS.list({ prefix: `${site}/` });
    expect(listed.objects).toHaveLength(0);
  });
});

describe("share links and the human player", () => {
  it("expiring, token-scoped, CSP-tight; revocable", async () => {
    const { key, site } = await newSite("shop.test");
    const { sid } = await recordCheckout(site, { ua: MOBILE_UA });
    const ro = (await call("POST", "/v1/keys", { key, body: { scope: "read" } })).json.api_key;
    expect((await call("POST", `/v1/sites/${site}/links`, { key: ro, body: { session_id: sid } })).status).toBe(403);
    expect((await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: "rs_doesnotexist0000" } })).status).toBe(404);
    const c = await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: sid, expires_in: 3600 } });
    expect(c.status).toBe(201);
    const url = new URL(c.json.link.url);
    expect(url.pathname).toMatch(/^\/play\/rpt_[0-9a-z]{32}$/);
    expect(c.json.link.expires_at - Date.now()).toBeGreaterThan(3500_000);

    const html = await call("GET", url.pathname);
    expect(html.status).toBe(200);
    const csp = html.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(html.headers.get("x-robots-tag")).toContain("noindex");
    expect(html.text).not.toMatch(/<script>(?!<\/script>)/); // no inline script
    const js = /<script defer src="([^"]+)"/.exec(html.text)![1]!;
    const css = /<link rel="stylesheet" href="([^"]+)"/.exec(html.text)![1]!;
    expect((await call("GET", js)).text.startsWith("/*! afs-replay player")).toBe(true);
    expect((await call("GET", css)).headers.get("content-type")).toContain("text/css");
    expect((await call("GET", "/assets/player-nope.js")).status).toBe(404);

    const data = await call("GET", `${url.pathname}/data`);
    expect(data.json.session).toMatchObject({ id: sid, site_domain: "shop.test", device: "mobile", pages: 2 });
    expect(data.json.chunks).toEqual([0, 1]);
    expect(data.json.timeline.some((e: any) => e.kind === "click" && e.signals.includes("rage_click"))).toBe(true);
    const chunk = await call("GET", `${url.pathname}/chunks/0`);
    expect(JSON.parse(await gunzip(chunk.bytes)).ev[1].type).toBe(2);
    expect((await call("GET", `${url.pathname}/chunks/9`)).status).toBe(404);

    const links = await call("GET", `/v1/sites/${site}/links?session_id=${sid}`, { key });
    expect(links.json.links[0]).toMatchObject({ id: c.json.link.id, active: true, views: 1 });
    expect(JSON.stringify(links.json)).not.toContain(url.pathname.slice(6));
    expect((await call("DELETE", `/v1/sites/${site}/links/${c.json.link.id}`, { key })).json.revoked).toBe(c.json.link.id);
    expect((await call("DELETE", `/v1/sites/${site}/links/${c.json.link.id}`, { key })).status).toBe(404);
    const gone = await call("GET", url.pathname);
    expect(gone.status).toBe(404);
    expect(gone.text).toContain("expired or was revoked");
    expect((await call("GET", `${url.pathname}/data`)).status).toBe(404);
    expect((await call("GET", "/play/rpt_short")).status).toBe(404);
  });

  it("MAX_LINKS_PER_SITE caps active links", async () => {
    const { key, site } = await newSite("shop.test");
    const { sid } = await recordCheckout(site);
    const env = hosted({ MAX_LINKS_PER_SITE: "1" });
    expect((await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: sid }, env })).status).toBe(201);
    expect((await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: sid }, env })).json.error.code).toBe("quota_exceeded");
  });
});

describe("MCP", () => {
  it("lists every tool for a full key, hides write tools from read keys, and calls the same services", async () => {
    const { key, site } = await newSite("shop.test");
    const { sid } = await recordCheckout(site);
    const names = async (k: string) => (await mcpList(k)).sort();
    const all = await names(key);
    // The complete list (with the parity tools) is asserted in parity.test.ts.
    expect(all).toEqual(
      expect.arrayContaining([
        "create_replay_link",
        "create_replay_site",
        "delete_replay_site",
        "delete_session",
        "delete_visitor_data",
        "get_funnel_dropoffs",
        "get_heatmap",
        "get_install_snippet",
        "get_replay_site",
        "get_session",
        "get_session_transcript",
        "list_errors",
        "list_replay_links",
        "list_replay_sites",
        "revoke_replay_link",
        "search_sessions",
        "summarize_sessions",
        "update_replay_site",
        "verify_install",
      ]),
    );
    const ro = (await call("POST", "/v1/keys", { key, body: { scope: "read" } })).json.api_key;
    expect(await names(ro)).toEqual(
      expect.arrayContaining([
        "get_funnel_dropoffs",
        "get_heatmap",
        "get_install_snippet",
        "get_replay_site",
        "get_session",
        "get_session_transcript",
        "list_errors",
        "list_replay_links",
        "list_replay_sites",
        "search_sessions",
        "summarize_sessions",
      ]),
    );
    for (const w of ["create_replay_site", "delete_session", "verify_install"]) expect(await names(ro)).not.toContain(w);
    const tools = (await mcpTools(key)) as { name: string; description: string }[];
    for (const n of [
      "search_sessions",
      "get_session",
      "get_session_transcript",
      "summarize_sessions",
      "get_heatmap",
      "list_errors",
      "get_funnel_dropoffs",
    ])
      expect(tools.find((t) => t.name === n)!.description).toMatch(/untrusted/i);

    const created = await tool(key, "create_replay_site", { domain: "shop.test" });
    expect(created.data).toMatchObject({ existing: true, site: { id: site } });
    const search = await tool(key, "search_sessions", { site_id: site, signal: "rage_click" });
    expect(search.data.sessions[0].id).toBe(sid);
    const tr = await tool(key, "get_session_transcript", { site_id: site, session_id: sid, kinds: ["error"] });
    expect(tr.data.transcript).toContain("card is undefined");
    const sum = await tool(key, "summarize_sessions", { site_id: site, session_ids: [sid] });
    expect(sum.data.sessions_considered).toBe(1);
    expect((await tool(key, "get_heatmap", { site_id: site, page: "/checkout", device: "desktop" })).data.clicks).toBe(3);
    expect((await tool(key, "list_errors", { site_id: site })).data.groups).toBe(1);
    expect(
      (await tool(key, "get_funnel_dropoffs", { site_id: site, steps: ["/pricing", "/checkout"] })).data.untrusted.steps[1].sessions,
    ).toBe(1);
    const link = await tool(key, "create_replay_link", { site_id: site, session_id: sid });
    expect(link.data.link.url).toContain("/play/rpt_");
    expect((await tool(key, "list_replay_links", { site_id: site })).data.links).toHaveLength(1);
    expect((await tool(key, "revoke_replay_link", { site_id: site, link_id: link.data.link.id })).data.revoked).toBe(link.data.link.id);
    const err = await tool(key, "get_session", { site_id: site, session_id: "rs_doesnotexist0000" });
    expect(err.isError).toBe(true);
    expect(err.data.error.hint).toBeTruthy();
    expect((await tool(key, "delete_session", { site_id: site, session_id: sid })).data.deleted).toBe(sid);
    expect((await tool(key, "delete_visitor_data", { site_id: site, user_id: "nobody" })).data.deleted_sessions).toBe(0);
    expect((await tool(key, "update_replay_site", { site_id: site, sample_rate: 0.5 })).data.site.sample_rate).toBe(0.5);
    expect((await tool(key, "get_install_snippet", { site_id: site, framework: "nextjs" })).data.code).toContain("next/script");
    expect((await tool(key, "get_replay_site", { site_id: site })).data.site.id).toBe(site);
    expect((await tool(key, "list_replay_sites", {})).data.sites).toHaveLength(1);
    expect((await tool(key, "delete_replay_site", { site_id: site })).data.deleted).toBe(site);
  });
});

async function mcpTools(key: string) {
  const r = await call("POST", "/mcp", {
    key,
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    headers: { accept: "application/json, text/event-stream" },
  });
  return r.json.result.tools as { name: string; description: string }[];
}
async function mcpList(key: string) {
  return (await mcpTools(key)).map((t) => t.name);
}

describe("llms.txt and discovery", () => {
  it("documents every MCP tool and REST route, and the service root points at it", async () => {
    const { key } = await signup();
    const llms = await call("GET", "/llms.txt");
    expect(llms.headers.get("content-type")).toContain("text/markdown");
    for (const name of await mcpList(key)) expect(llms.text).toContain(name);
    for (const route of [
      "POST /v1/sites",
      "PATCH /v1/sites/:id",
      "DELETE /v1/sites/:id",
      "/v1/sites/:id/install",
      "/v1/sites/:id/verify",
      "/v1/sites/:id/sessions",
      "/v1/sites/:id/sessions/:sid/transcript",
      "/v1/sites/:id/summary",
      "/v1/sites/:id/heatmap",
      "/v1/sites/:id/errors",
      "/v1/sites/:id/funnel",
      "/v1/sites/:id/delete-visitor-data",
      "/v1/sites/:id/links",
      "/play/<token>",
      "POST ",
      "/i?s=",
      "/r/<site>.js",
      "loads_with_analytics",
      "homepage_analytics",
      "suggested_analytics_site_id",
    ])
      expect(llms.text).toContain(route);
    const root = await call("GET", "/");
    expect(root.json).toMatchObject({ app: "replay", docs: "http://replay.test/llms.txt", mcp: "http://replay.test/mcp" });
    const prm = await call("GET", "/.well-known/oauth-protected-resource/mcp");
    expect(prm.json.resource).toBe("http://replay.test/mcp");
    const unauth = await call("POST", "/mcp", { body: {} });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain("resource_metadata");
  });
});
