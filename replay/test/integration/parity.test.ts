import { describe, expect, it } from "vitest";
import { hashUserId } from "../../src/lib/hash";
import { click, error, event, hide, meta, mutation, net, page, snapshot, tag } from "../fixtures/rrweb";
import { call, hosted, newSid, newSite, sendChunk, tool } from "./helpers";

/** One session with tags, a click and an error; returns its id. */
export async function tagged(
  site: string,
  tags: [string, string][],
  opts: { uid?: string; path?: string; origin?: string; country?: string; ua?: string } = {},
) {
  const sid = newSid();
  const T = Date.now() - 60_000;
  const p = opts.path ?? "/checkout";
  const host = opts.origin ? new URL(opts.origin).hostname : "shop.test";
  await sendChunk(site, sid, 0, [meta(T, `https://${host}${p}`), snapshot(T + 1), page(T + 5, 1, p, { h: host })], {
    extra: opts.uid ? { uid: opts.uid } : {},
    origin: opts.origin,
    headers: opts.country ? { "x-dev-geo-country": opts.country } : {},
    ua: opts.ua,
  });
  await sendChunk(
    site,
    sid,
    1,
    [
      ...tags.map(([k, v], i) => tag(T + 100 + i, 1, k, v)),
      click(T + 2000, 1, "#pay", { l: "Pay" }),
      mutation(T + 2100),
      error(T + 2200, 1, "TypeError: boom"),
      event(T + 2300, 1, "paid"),
      hide(T + 3000, 1),
    ],
    { extra: { end: 1, ...(opts.uid ? { uid: opts.uid } : {}) }, origin: opts.origin, ua: opts.ua },
  );
  return sid;
}

describe("1. custom tags, identify attributes, hashed user ids", () => {
  it("tag= filters sessions, summary, heatmap, errors and funnels; get_session and transcripts show tags", async () => {
    const { key, site } = await newSite("shop.test");
    const pro = await tagged(site, [
      ["plan", "pro"],
      ["exp", "B"],
    ]);
    const free = await tagged(site, [["plan", "free"]]);
    const q = async (qs: string) => (await call("GET", `/v1/sites/${site}/sessions?${qs}`, { key })).json;
    expect((await q("tag=plan:pro")).sessions.map((s: { id: string }) => s.id)).toEqual([pro]);
    expect((await q("tag=!exp:B")).sessions.map((s: { id: string }) => s.id)).toEqual([free]);
    expect((await q("tag=plan")).total).toBe(2);
    expect((await call("GET", `/v1/sites/${site}/sessions?tag=bad%20key`, { key })).json.error.hint).toContain("tag=plan:pro");
    const one = (await call("GET", `/v1/sites/${site}/sessions/${pro}`, { key })).json;
    expect(one.session.untrusted.tags).toEqual({ exp: ["B"], plan: ["pro"] });
    const tr = (await call("GET", `/v1/sites/${site}/sessions/${pro}/transcript`, { key })).json.transcript;
    expect(tr).toContain('tag "plan" = "pro"');
    const sum = (await call("GET", `/v1/sites/${site}/summary?tag=plan`, { key })).json;
    expect(sum.untrusted.top_tags.length).toBeGreaterThan(0);
    const heat = (await call("GET", `/v1/sites/${site}/heatmap?page=/checkout&tag=plan:pro`, { key })).json;
    expect(heat.clicks).toBe(1);
    expect((await call("GET", `/v1/sites/${site}/heatmap?page=/checkout`, { key })).json.clicks).toBe(2);
    expect((await call("GET", `/v1/sites/${site}/errors?tag=plan:free`, { key })).json.sessions_with_errors).toBe(1);
    const fun = (await call("GET", `/v1/sites/${site}/funnel?steps=/checkout,event:paid&tag=plan:pro`, { key })).json;
    expect(fun.sessions_considered).toBe(1);
    const viaMcp = await tool(key, "search_sessions", { site_id: site, tag: ["plan:pro"] });
    expect(viaMcp.data.total).toBe(1);
  });

  it("hash_user_ids: the loader hashes, the user_id filter and delete_visitor_data take the raw id", async () => {
    const { key, site } = await newSite("hash.test", { hash_user_ids: true });
    const loader = await call("GET", `/r/${site}.js`);
    expect(loader.text).toContain('"hu":1');
    const h = await hashUserId(site, "u_7");
    const sid = await tagged(site, [], { uid: h, origin: "https://hash.test" });
    const found = (await call("GET", `/v1/sites/${site}/sessions?user_id=u_7`, { key })).json;
    expect(found.sessions.map((s: { id: string }) => s.id)).toEqual([sid]);
    const del = (await call("POST", `/v1/sites/${site}/delete-visitor-data`, { key, body: { user_id: "u_7" } })).json;
    expect(del.session_ids).toEqual([sid]);
    const s = (await call("GET", `/v1/sites/${site}`, { key })).json.site;
    expect(s.hash_user_ids).toBe(true);
  });
});

describe("2. more filters, negation, saved segments", () => {
  it("negates text filters and filters by referrer, region, page count and scroll", async () => {
    const { key, site } = await newSite("shop.test");
    const us = await tagged(site, [["plan", "pro"]], { country: "US" });
    const de = await tagged(site, [["plan", "free"]], { country: "DE", path: "/pricing" });
    const ids = async (qs: string) =>
      ((await call("GET", `/v1/sites/${site}/sessions?${qs}`, { key })).json.sessions as { id: string }[]).map((s) => s.id).sort();
    expect(await ids("country=!US")).toEqual([de]);
    expect(await ids("country=us")).toEqual([us]);
    expect(await ids("page=!/pricing*")).toEqual([us]);
    expect(await ids("entry_page=!/checkout")).toEqual([de]);
    expect(await ids("min_pageviews=2")).toEqual([]);
    expect(await ids("min_pageviews=1")).toEqual([us, de].sort());
    expect(await ids("device=!desktop")).toEqual([]);
    expect(await ids("referrer=google.com")).toEqual([]);
    expect((await call("GET", `/v1/sites/${site}/sessions?country=USA`, { key })).status).toBe(400);
    expect((await call("GET", `/v1/sites/${site}/sessions?page=!checkout`, { key })).json.error.hint).toContain("!/admin*");
  });

  it("segments: idempotent by name, capped, accepted by every read, MCP tools", async () => {
    const { key, site } = await newSite("shop.test");
    const pro = await tagged(site, [["plan", "pro"]], { country: "US" });
    await tagged(site, [["plan", "free"]], { country: "DE" });
    const c = await call("POST", `/v1/sites/${site}/segments`, { key, body: { name: "Pro", filters: { tag: ["plan:pro"] } } });
    expect(c.status).toBe(201);
    expect(c.json.matching_now).toMatchObject({ sessions: 1, example_session_ids: [pro] });
    const seg = c.json.segment.id as string;
    const again = await call("POST", `/v1/sites/${site}/segments`, { key, body: { name: "Pro", filters: { country: "DE" } } });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ existing: true, segment: { id: seg, filters: { tag: ["plan:pro"] } } });
    const get = async (path: string) => (await call("GET", `/v1/sites/${site}/${path}`, { key })).json;
    expect((await get(`sessions?segment_id=${seg}`)).sessions.map((s: { id: string }) => s.id)).toEqual([pro]);
    expect((await get(`sessions?segment_id=${seg}`)).segment).toEqual({ id: seg, name: "Pro" });
    // explicit filters override the segment's own
    expect((await get(`sessions?segment_id=${seg}&tag=plan:free`)).total).toBe(1);
    expect((await get(`summary?segment_id=${seg}`)).sessions_considered).toBe(1);
    expect((await get(`heatmap?page=/checkout&segment_id=${seg}`)).clicks).toBe(1);
    expect((await get(`errors?segment_id=${seg}`)).sessions_with_errors).toBe(1);
    expect((await get(`funnel?steps=/checkout,event:paid&segment_id=${seg}`)).sessions_considered).toBe(1);
    expect((await call("GET", `/v1/sites/${site}/sessions?segment_id=seg_0000000000000000`, { key })).status).toBe(404);
    const bad = await call("POST", `/v1/sites/${site}/segments`, { key, body: { name: "x", filters: { from: "2026-01-01" } } });
    expect(bad.json.error.hint).toContain("relative period");
    expect((await call("POST", `/v1/sites/${site}/segments`, { key, body: { name: "y", filters: { nope: 1 } } })).status).toBe(400);
    const env = hosted({ MAX_SEGMENTS_PER_SITE: "1" });
    const capped = await call("POST", `/v1/sites/${site}/segments`, { key, body: { name: "Other", filters: {} }, env });
    expect(capped.json.error.code).toBe("quota_exceeded");
    const up = await tool(key, "update_segment", { site_id: site, segment_id: seg, filters: { country: "DE" } });
    expect(up.data.matching_now.sessions).toBe(1);
    expect((await tool(key, "list_segments", { site_id: site })).data.segments).toHaveLength(1);
    expect((await tool(key, "delete_segment", { site_id: site, segment_id: seg })).data.deleted).toBe(seg);
    expect((await tool(key, "create_segment", { site_id: site, name: "M", filters: { device: "mobile" } })).data.existing).toBe(false);
  });
});

describe("3. metrics over time and active time", () => {
  it("GET /metrics and get_replay_metrics: series, breakdowns, filters, bucket limit", async () => {
    const { key, site } = await newSite("shop.test");
    await tagged(site, [["plan", "pro"]], { country: "US" });
    await tagged(site, [["plan", "free"]], { country: "DE" });
    const m = (await call("GET", `/v1/sites/${site}/metrics?period=7d`, { key })).json;
    expect(m.interval).toBe("day");
    expect(m.totals.sessions).toBe(2);
    expect(m.series.at(-1).sessions).toBe(2);
    expect(m.totals.share_with.js_error).toBe(1);
    const by = (await call("GET", `/v1/sites/${site}/metrics?period=24h&by=tag:plan&tag=plan:pro`, { key })).json;
    expect(by.interval).toBe("hour");
    expect(by.untrusted.breakdown.map((r: { value: string }) => r.value)).toEqual(["pro"]);
    expect((await call("GET", `/v1/sites/${site}/metrics?period=365d&interval=hour`, { key })).json.error.hint).toContain("coarser");
    expect((await call("GET", `/v1/sites/${site}/metrics?by=nope`, { key })).status).toBe(400);
    const viaMcp = await tool(key, "get_replay_metrics", { site_id: site, by: "country" });
    expect(viaMcp.data.untrusted.breakdown).toHaveLength(2);
  });
});

describe("4. failed network requests", () => {
  it("capture_network_errors reaches the loader; failures are listed by kind, filterable and in transcripts", async () => {
    const { key, site } = await newSite("shop.test");
    expect((await call("GET", `/r/${site}.js`)).text).not.toContain('"net":1');
    const up = await call("PATCH", `/v1/sites/${site}`, { key, body: { capture_network_errors: true, capture_console_warnings: true } });
    expect(up.json.site).toMatchObject({ capture_network_errors: true, capture_console_warnings: true });
    const loader = (await call("GET", `/r/${site}.js`)).text;
    expect(loader).toContain('"net":1');
    expect(loader).toContain('"cw":1');
    const sid = newSid();
    const T = Date.now() - 60_000;
    await sendChunk(site, sid, 0, [meta(T), snapshot(T + 1), page(T + 5, 1, "/checkout")]);
    await sendChunk(site, sid, 1, [
      click(T + 1000, 1, "#pay", { l: "Pay" }),
      mutation(T + 1050),
      net(T + 1200, 1, "POST", "/api/pay?x=1", 500),
    ]);
    const n = (await call("GET", `/v1/sites/${site}/errors?kind=network`, { key })).json;
    expect(n.untrusted.errors[0]).toMatchObject({ kind: "network", request: { method: "POST", url: "/api/pay", status: 500 } });
    expect((await call("GET", `/v1/sites/${site}/errors`, { key })).json.groups).toBe(0);
    expect((await call("GET", `/v1/sites/${site}/errors?kind=all`, { key })).json.groups).toBe(1);
    expect((await call("GET", `/v1/sites/${site}/sessions?signal=api_error`, { key })).json.total).toBe(1);
    const fp = n.untrusted.errors[0].fingerprint;
    expect((await call("GET", `/v1/sites/${site}/sessions?error_fingerprint=${fp}`, { key })).json.total).toBe(1);
    const tr = (await call("GET", `/v1/sites/${site}/sessions/${sid}/transcript`, { key })).json.transcript;
    expect(tr).toContain('request failed POST "/api/pay" -> 500');
    expect((await tool(key, "list_errors", { site_id: site, kind: "network" })).data.groups).toBe(1);
    const fresh = await newSite("off.test");
    expect((await call("GET", `/v1/sites/${fresh.site}/errors?kind=network`, { key: fresh.key })).json.next_steps[0]).toContain(
      "capture_network_errors",
    );
  });
});

describe("6. heatmap bundle", () => {
  it("findings, compare (period, device, segment), CSV over REST and MCP", async () => {
    const { key, site } = await newSite("shop.test");
    await tagged(site, [["plan", "pro"]]);
    await tagged(site, [["plan", "free"]], { ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1" });
    const h = (await call("GET", `/v1/sites/${site}/heatmap?page=/checkout&converted_event=paid`, { key })).json;
    expect(h.untrusted.findings[0]).toMatch(/The most clicked element is "Pay" \{#pay\}: 100% of 2 clicks/);
    expect(h.untrusted.elements[0]).toMatchObject({ conversion_share: 1, converted_sessions: 2 });
    const prev = (await call("GET", `/v1/sites/${site}/heatmap?page=/checkout&period=24h&compare=previous`, { key })).json;
    expect(prev.compared_with).toMatchObject({ clicks: 0 });
    expect(prev.untrusted.elements[0].compare).toMatchObject({ click_share: 0, click_share_delta: 1 });
    expect(prev.scroll.reach[0]).toHaveProperty("delta");
    const dev = (await call("GET", `/v1/sites/${site}/heatmap?page=/checkout&device=desktop&compare_device=mobile`, { key })).json;
    expect(dev.compared_with).toMatchObject({ device: "mobile", clicks: 1 });
    const seg = (await call("POST", `/v1/sites/${site}/segments`, { key, body: { name: "Free", filters: { tag: ["plan:free"] } } })).json
      .segment.id;
    const bySeg = (await call("GET", `/v1/sites/${site}/heatmap?page=/checkout&tag=plan:pro&compare_segment_id=${seg}`, { key })).json;
    expect(bySeg.compared_with).toMatchObject({ segment_id: seg, clicks: 1 });
    expect((await call("GET", `/v1/sites/${site}/heatmap?page=/checkout&compare=bad`, { key })).status).toBe(400);
    const csv = await call("GET", `/v1/sites/${site}/heatmap?page=/checkout&format=csv`, { key });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.text.split("\r\n")[1]).toMatch(/^#pay,Pay,button,true,2,1,2/);
    const m = await tool(key, "get_heatmap", { site_id: site, page: "/checkout", format: "csv" });
    expect(m.data.untrusted.csv).toContain("#pay");
    expect((await tool(key, "get_heatmap", { site_id: site, page: "/checkout", click: "first", sort: "dead" })).data.click).toBe("first");
  });
});

describe("7. notes, labels, stars, clips", () => {
  it("label_session, notes in transcripts and the player, clips serve their window only", async () => {
    const { key, site } = await newSite("shop.test");
    const sid = await tagged(site, []);
    const star = await call("PATCH", `/v1/sites/${site}/sessions/${sid}`, { key, body: { starred: true, labels: ["checkout bug"] } });
    expect(star.json).toMatchObject({ starred: true, labels: ["checkout bug"] });
    expect(star.json.note).toContain("90 days");
    expect((await call("PATCH", `/v1/sites/${site}/sessions/${sid}`, { key, body: { labels: ["<b>"] } })).status).toBe(400);
    expect((await call("PATCH", `/v1/sites/${site}/sessions/${sid}`, { key, body: {} })).status).toBe(400);
    const list = (await call("GET", `/v1/sites/${site}/sessions?starred=true&label=checkout%20bug`, { key })).json;
    expect(list.sessions.map((x: { id: string; labels: string[] }) => [x.id, x.labels])).toEqual([[sid, ["checkout bug"]]]);
    expect((await call("GET", `/v1/sites/${site}/labels`, { key })).json.labels).toEqual([{ label: "checkout bug", sessions: 1 }]);
    const n = await call("POST", `/v1/sites/${site}/sessions/${sid}/notes`, { key, body: { t_ms: 2000, text: "Pay throws here" } });
    expect(n.status).toBe(201);
    expect(n.json.next_steps[1]).toContain("start_ms");
    const one = (await call("GET", `/v1/sites/${site}/sessions/${sid}`, { key })).json.session;
    expect(one).toMatchObject({ starred: true, labels: ["checkout bug"], untrusted: { notes: [{ t_ms: 2000, text: "Pay throws here" }] } });
    expect((await call("GET", `/v1/sites/${site}/sessions/${sid}/transcript`, { key })).json.transcript).toContain(
      'note "Pay throws here"',
    );
    const notes = (await tool(key, "list_session_notes", { site_id: site, session_id: sid })).data.notes;
    expect(notes[0].untrusted.text).toBe("Pay throws here");
    const clip = await call("POST", `/v1/sites/${site}/links`, {
      key,
      body: { session_id: sid, start_ms: 1500, end_ms: 2600, note: "Watch the Pay button" },
    });
    expect(clip.status).toBe(201);
    expect(clip.json.link.clip).toEqual({ start_ms: 1500, end_ms: 2600 });
    const token = clip.json.link.url.split("/play/")[1];
    const data = (await call("GET", `/play/${token}/data`)).json;
    expect(data).toMatchObject({ clip: { start_ms: 1500, end_ms: 2600 }, note: "Watch the Pay button" });
    expect(data.timeline.every((e: { t: number }) => e.t >= 1500 && e.t <= 2600)).toBe(true);
    expect(data.timeline.some((e: { kind: string }) => e.kind === "note")).toBe(true);
    expect(data.chunks.length).toBeGreaterThan(0);
    expect((await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: sid, start_ms: 5000, end_ms: 4000 } })).status).toBe(
      400,
    );
    expect((await tool(key, "label_session", { site_id: site, session_id: sid, starred: false })).data.starred).toBe(false);
    expect((await tool(key, "list_labels", { site_id: site })).data.labels).toHaveLength(1);
    const added = await tool(key, "add_session_note", { site_id: site, session_id: sid, text: "second" });
    expect((await tool(key, "delete_session_note", { site_id: site, session_id: sid, note_id: added.data.note.id })).data.deleted).toBe(
      added.data.note.id,
    );
    const env = hosted({ MAX_NOTES_PER_SESSION: "1" });
    expect((await call("POST", `/v1/sites/${site}/sessions/${sid}/notes`, { key, body: { text: "x" }, env })).json.error.code).toBe(
      "quota_exceeded",
    );
  });
});

describe("8. consent and exclusion", () => {
  it("require_consent eea per country, Google Consent Mode, exclude_ip_ranges at ingest, upgraded sessions", async () => {
    const { key, site } = await newSite("shop.test", { require_consent: "eea", consent_source: "gcm" });
    const s = (await call("GET", `/v1/sites/${site}`, { key })).json.site;
    expect(s).toMatchObject({ require_consent: "eea", consent_source: "gcm", exclude_ip_ranges: [] });
    const de = await call("GET", `/r/${site}.js`, { headers: { "x-dev-geo-country": "DE" } });
    expect(de.text).toContain('"consent":true');
    expect(de.text).toContain('"gcm":1');
    expect(de.headers.get("cache-control")).toBe("private, max-age=300");
    const us = await call("GET", `/r/${site}.js`, { headers: { "x-dev-geo-country": "US" } });
    expect(us.text).toContain('"consent":false');
    expect(us.headers.get("etag")).not.toBe(de.headers.get("etag"));
    expect((await call("GET", `/r/${site}.js`)).text).toContain('"consent":true'); // unknown country: ask
    expect((await call("PATCH", `/v1/sites/${site}`, { key, body: { exclude_ip_ranges: ["10.0.0.0/33"] } })).json.error.message).toContain(
      "CIDR",
    );
    const up = await call("PATCH", `/v1/sites/${site}`, {
      key,
      body: { require_consent: true, exclude_ip_ranges: ["203.0.113.0/24", "2001:db8::/32"] },
    });
    expect(up.json.site).toMatchObject({ require_consent: true, exclude_ip_ranges: ["203.0.113.0/24", "2001:db8::/32"] });
    const T = Date.now() - 10_000;
    const refused = await sendChunk(site, newSid(), 0, [meta(T), page(T + 5, 1, "/")], { ip: "203.0.113.77" });
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ error: "ip_excluded", stop: true });
    const v6 = await sendChunk(site, newSid(), 0, [meta(T), page(T + 5, 1, "/")], { ip: "2001:db8::5" });
    expect(v6.json.error).toBe("ip_excluded");
    expect((await sendChunk(site, newSid(), 0, [meta(T), page(T + 5, 1, "/")], { ip: "198.51.100.4" })).status).toBe(202);
    expect((await call("GET", `/v1/sites/${site}`, { key })).json.data.dropped_last_7d.ip_excluded.count).toBeGreaterThan(0); // sampled
    // afsr('upgrade', reason): the envelope carries it, the session is filterable, the reason is page text
    const sid = newSid();
    expect(
      (await sendChunk(site, sid, 0, [meta(T), page(T + 5, 1, "/")], { ip: "198.51.100.5", extra: { up: "checkout_error" } })).status,
    ).toBe(202);
    const found = (await call("GET", `/v1/sites/${site}/sessions?upgraded=true`, { key })).json.sessions;
    expect(found.map((x: { id: string }) => x.id)).toEqual([sid]);
    expect(found[0]).toMatchObject({ upgraded: true, untrusted: { upgraded_reason: "checkout_error" } });
    const capped = await sendChunk(site, newSid(), 0, [meta(T), page(T + 5, 1, "/")], {
      ip: "198.51.100.6",
      extra: { up: "x" },
      env: hosted({ MAX_UPGRADED_SESSIONS_PER_SITE_PER_DAY: "1" }),
    });
    expect(capped.json.error).toBe("upgraded_daily_limit");
  });
});

describe("10. event definitions", () => {
  it("define_event works over recorded sessions, in filters and funnels; idempotent, capped, built-ins listed", async () => {
    const { key, site } = await newSite("shop.test");
    const sid = await tagged(site, []);
    const d = await call("POST", `/v1/sites/${site}/event-definitions`, {
      key,
      body: { name: "pay_click", match: { click: { selector_contains: "#pay" }, page: "/checkout*" } },
    });
    expect(d.status).toBe(201);
    expect(d.json.matching_now).toMatchObject({ sessions: 1, example_session_ids: [sid] });
    expect(
      (await call("POST", `/v1/sites/${site}/event-definitions`, { key, body: { name: "pay_click", match: { page: "/x" } } })).json
        .existing,
    ).toBe(true);
    expect(
      (await call("POST", `/v1/sites/${site}/event-definitions`, { key, body: { name: "download", match: { page: "/x" } } })).status,
    ).toBe(400);
    expect(
      (await call("POST", `/v1/sites/${site}/event-definitions`, { key, body: { name: "nothing", match: {} } })).json.error.hint,
    ).toContain("click");
    expect((await call("GET", `/v1/sites/${site}/sessions?event=pay_click`, { key })).json.total).toBe(1);
    expect((await call("GET", `/v1/sites/${site}/sessions?event=!pay_click`, { key })).json.total).toBe(0);
    const f = (await call("GET", `/v1/sites/${site}/funnel?steps=/checkout,event:pay_click,event:paid`, { key })).json;
    expect(f.untrusted.steps.map((x: { sessions: number }) => x.sessions)).toEqual([1, 1, 1]);
    expect(f.untrusted.steps[2].median_ms_from_previous).toBe(300);
    const capped = await call("POST", `/v1/sites/${site}/event-definitions`, {
      key,
      body: { name: "two", match: { page: "/" } },
      env: hosted({ MAX_EVENT_DEFINITIONS_PER_SITE: "1" }),
    });
    expect(capped.json.error.code).toBe("quota_exceeded");
    const list = (await tool(key, "list_event_definitions", { site_id: site })).data;
    expect(list.event_definitions.map((x: { name: string }) => x.name)).toEqual(["pay_click"]);
    expect(list.built_in.map((x: { name: string }) => x.name)).toEqual(["outbound_click", "download", "form_submit"]);
    expect(
      (await tool(key, "define_event", { site_id: site, name: "thanks", match: { page: "/thanks" } })).data.matching_now.sessions,
    ).toBe(0);
    expect(
      (await tool(key, "delete_event_definition", { site_id: site, event_definition_id: d.json.event_definition.id })).data.deleted,
    ).toBe(d.json.event_definition.id);
    expect((await call("GET", `/r/${site}.js`)).text).toContain('"ae":1');
  });
});

describe("11. attention map and zones", () => {
  it("zones reach the loader; heatmap type=attention and group_by=zone", async () => {
    const { key, site } = await newSite("shop.test");
    expect((await call("PATCH", `/v1/sites/${site}`, { key, body: { zones: ["#hero", "a{"] } })).status).toBe(400);
    const up = await call("PATCH", `/v1/sites/${site}`, { key, body: { zones: ["#hero", ".pricing"] } });
    expect(up.json.site.zones).toEqual(["#hero", ".pricing"]);
    expect((await call("GET", `/r/${site}.js`)).text).toContain('"zn":["#hero",".pricing"]');
    const sid = newSid();
    const T = Date.now() - 60_000;
    await sendChunk(site, sid, 0, [meta(T), snapshot(T + 1), page(T + 5, 1, "/p"), click(T + 500, 1, "#cta", { z: "#hero", y: 100 })]);
    await sendChunk(site, sid, 1, [
      click(T + 3000, 1, "#plan", { z: ".pricing", y: 1400 }),
      click(T + 3500, 1, "#plan2", { z: ".pricing", y: 1300 }),
    ]);
    const z = (await call("GET", `/v1/sites/${site}/heatmap?page=/p&group_by=zone`, { key })).json;
    expect(z.untrusted.zones.map((x: { zone: string; clicks: number }) => [x.zone, x.clicks])).toEqual([
      [".pricing", 2],
      ["#hero", 1],
    ]);
    const a = (await call("GET", `/v1/sites/${site}/heatmap?page=/p&type=attention`, { key })).json;
    expect(a.attention).toHaveLength(10);
    expect(a.attention[0].avg_visible_ms).toBeGreaterThan(0);
    expect(a.findings[0]).toMatch(/holds \d+% of the viewing time/);
    expect((await tool(key, "get_heatmap", { site_id: site, page: "/p", type: "attention" })).data.attention[4].clicks).toBe(2);
  });
});

describe("12. exports and small reads", () => {
  it("sessions as CSV / NDJSON, raw rrweb events with paging and a daily byte budget, sorts, in-progress", async () => {
    const { key, site } = await newSite("shop.test");
    const a = await tagged(site, [["plan", "pro"]]);
    const b = await tagged(site, [["plan", "free"]], { path: "/pricing" });
    const csv = await call("GET", `/v1/sites/${site}/sessions?format=csv&tag=plan:pro`, { key });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("x-afs-rows")).toBe("1");
    const lines = csv.text.trim().split("\r\n");
    expect(lines[0]!.startsWith("id,started_at,duration_ms,active_ms,pageviews,clicks")).toBe(true);
    expect(lines[1]!.startsWith(`${a},`)).toBe(true);
    const nd = await call("GET", `/v1/sites/${site}/sessions?format=ndjson`, { key });
    expect(
      nd.text
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).id)
        .sort(),
    ).toEqual([a, b].sort());
    expect((await tool(key, "export_sessions", { site_id: site, sort: "clicks" })).data.untrusted.csv).toContain(a);
    expect((await call("GET", `/v1/sites/${site}/sessions?sort=pageviews`, { key })).json.sort).toBe("pageviews");
    expect((await call("GET", `/v1/sites/${site}/sessions?sort=active&limit=1`, { key })).json.next_cursor).toBeTruthy();
    expect((await call("GET", `/v1/sites/${site}/sessions?active=true`, { key })).json.total).toBe(2);
    const ev = await call("GET", `/v1/sites/${site}/sessions/${a}/events`, { key });
    expect(ev.headers.get("content-type")).toBe("application/x-ndjson");
    const events = ev.text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events[0]).toMatchObject({ type: 4 });
    expect(events.some((e) => e.type === 5 && e.data.tag === "afs.click")).toBe(true);
    const paged = await call("GET", `/v1/sites/${site}/sessions/${a}/events?to_seq=0`, { key });
    expect(paged.text.trim().split("\n")).toHaveLength(3);
    const m = await tool(key, "get_session_events", { site_id: site, session_id: a, from_seq: 1 });
    expect(m.data.untrusted.events[0]).toMatchObject({ type: 5 });
    const over = await call("GET", `/v1/sites/${site}/sessions/${b}/events`, { key, env: hosted({ MAX_EXPORT_BYTES_PER_DAY: "1" }) });
    expect(over.status).toBe(429);
  });

  it("get_visitor answers a data-access request; get_manual by section", async () => {
    const { key, site } = await newSite("shop.test");
    const sid = await tagged(site, [["plan", "pro"]], { uid: "u_55" });
    const v = (await call("GET", `/v1/sites/${site}/visitors?user_id=u_55`, { key })).json;
    expect(v).toMatchObject({ sessions_total: 1, untrusted: { tags: { plan: ["pro"] } } });
    expect(v.sessions[0].id).toBe(sid);
    expect(v.next_steps[0]).toContain("delete-visitor-data");
    expect((await call("GET", `/v1/sites/${site}/visitors`, { key })).status).toBe(400);
    expect((await tool(key, "get_visitor", { site_id: site, user_id: "nobody" })).data.sessions_total).toBe(0);
    const list = (await tool(key, "get_manual", {})).data;
    expect(list.sections).toContain("## Surveys and feedback (on the site's own pages)");
    expect((await tool(key, "get_manual", { section: "webhooks" })).data.text).toContain("x-signature");
    expect((await call("GET", "/v1/manual?section=nope", { key })).status).toBe(404);
  });
});

describe("13. install targets", () => {
  it("shopify, webflow, wix, squarespace and framer instructions; Segment / Mixpanel / Amplitude snippets", async () => {
    const { key, site } = await newSite("shop.test");
    for (const [f, where] of [
      ["shopify", "theme.liquid"],
      ["webflow", "Custom code"],
      ["wix", "Custom code"],
      ["squarespace", "Code injection"],
      ["framer", "Custom code"],
    ]) {
      const i = (await call("GET", `/v1/sites/${site}/install?framework=${f}`, { key })).json;
      expect(i.file).toContain(where);
      expect(i.code).toContain(`/r/${site}.js`);
    }
    const i = (await tool(key, "get_install_snippet", { site_id: site, framework: "webflow" })).data;
    expect(Object.keys(i.with_tools)).toEqual(["segment", "mixpanel", "amplitude"]);
    expect(i.with_tools.segment.code).toContain("replay_session_id");
    expect(i.other_frameworks).toContain("shopify");
  });
});

describe("MCP and llms.txt cover every parity tool and route", () => {
  const READ = [
    "export_sessions",
    "get_funnel_dropoffs",
    "get_heatmap",
    "get_heatmap_image",
    "get_install_snippet",
    "get_manual",
    "get_replay_metrics",
    "get_replay_site",
    "get_session",
    "get_session_events",
    "get_session_transcript",
    "get_survey",
    "get_survey_results",
    "get_usage",
    "get_visitor",
    "get_webhook",
    "list_errors",
    "list_event_definitions",
    "list_labels",
    "list_replay_links",
    "list_replay_sites",
    "list_segments",
    "list_session_notes",
    "list_survey_responses",
    "list_surveys",
    "list_webhooks",
    "search_sessions",
    "summarize_sessions",
  ];
  const WRITE = [
    "add_session_note",
    "create_replay_link",
    "create_replay_site",
    "create_segment",
    "create_survey",
    "create_webhook",
    "define_event",
    "delete_event_definition",
    "delete_replay_site",
    "delete_segment",
    "delete_session",
    "delete_session_note",
    "delete_survey",
    "delete_survey_response",
    "delete_visitor_data",
    "delete_webhook",
    "label_session",
    "revoke_replay_link",
    "test_survey",
    "test_webhook",
    "update_replay_site",
    "update_segment",
    "update_survey",
    "verify_install",
  ];
  const names = async (key: string) =>
    (
      await call("POST", "/mcp", {
        key,
        body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        headers: { accept: "application/json, text/event-stream" },
      })
    ).json.result.tools as { name: string; description: string }[];

  it("a full key sees every tool, a read key only the read ones; tools returning recorded or typed content say it is untrusted", async () => {
    const { key } = await newSite("shop.test");
    const all = await names(key);
    expect(all.map((t) => t.name).sort()).toEqual([...READ, ...WRITE].sort());
    const ro = (await call("POST", "/v1/keys", { key, body: { scope: "read" } })).json.api_key;
    expect((await names(ro)).map((t) => t.name).sort()).toEqual([...READ].sort());
    for (const n of [
      "export_sessions",
      "get_session_events",
      "get_visitor",
      "list_survey_responses",
      "get_survey_results",
      "list_session_notes",
      "get_replay_metrics",
    ])
      expect(all.find((t) => t.name === n)!.description).toMatch(/untrusted/i);
  });

  it("llms.txt documents every tool and the new routes", async () => {
    const llms = (await call("GET", "/llms.txt")).text;
    for (const n of [...READ, ...WRITE]) expect(llms).toContain(n);
    for (const route of [
      "/v1/sites/:id/segments",
      "/v1/sites/:id/metrics",
      "/v1/sites/:id/surveys",
      "/v1/sites/:id/surveys/:sv/test",
      "/v1/sites/:id/surveys/:sv/responses",
      "/v1/sites/:id/surveys/:sv/results",
      "/v1/webhooks",
      "/v1/webhooks/:id/test",
      "/v1/sites/:id/event-definitions",
      "/v1/sites/:id/sessions/:sid/notes",
      "PATCH /v1/sites/:id/sessions/:sid",
      "/v1/sites/:id/labels",
      "/v1/sites/:id/sessions/:sid/events",
      "/v1/sites/:id/visitors",
      "/v1/manual",
      "/sv/<site>.<rev>.js",
      "POST ${base}/f".replace("${base}", "http://replay.test"),
      "afsr('set'",
      "afsr('upgrade'",
      "afsr('survey'",
      "exclude_ip_ranges",
      "consent_source",
      "capture_network_errors",
      "hash_user_ids",
      "zones",
      "auto_events",
    ])
      expect(llms).toContain(route);
  });
});
