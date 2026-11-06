/**
 * Hardening round (abuse guardrails) end to end in workerd: a site's own daily budget, the network
 * byte share, attack mode for data-centre networks, share links (short default expiry, Report abuse,
 * the replay.share_links capability pause), and replay behind a path proxy (/_r/*).
 */
import { describe, expect, it } from "vitest";
import { ATTACK_MIN_SESSIONS } from "../../src/do/engine";
import { visitorAsn } from "../../src/service/ingest";
import { click, page, snapshot } from "../fixtures/rrweb";
import { call, E, hosted, markVerified, newSid, newSite, sendChunk, setPause } from "./helpers";

const DC_ASN = "16509"; // Amazon AWS: in @afs/shared DATACENTER_ASNS
const HOME_ASN = "7922"; // a residential ISP
let ipSeq = 0;
const nextIp = () => `192.0.2.${(ipSeq++ % 250) + 1}`;
/** A new session's first chunk from its own network. */
const first = (site: string, host: string, opts: Parameters<typeof sendChunk>[4] = {}) =>
  sendChunk(site, newSid(), 0, [page(Date.now() - 5_000, 1, "/", { h: host })], { origin: `https://${host}`, ip: nextIp(), ...opts });

describe("a site's own daily budget", () => {
  it("a flooded site stops alone (half the account's budget by default); the account's other sites keep recording", async () => {
    const env = hosted({ MAX_CHUNKS_PER_ACCOUNT_PER_DAY: "4" });
    const { key, site: a } = await newSite("flood-a.test");
    const b = (await call("POST", "/v1/sites", { key, body: { domain: "flood-b.test" } })).json.site.id as string;
    await markVerified(b);
    const sid = newSid();
    const T = Date.now() - 5_000;
    expect((await sendChunk(a, sid, 0, [page(T, 1, "/", { h: "flood-a.test" })], { origin: "https://flood-a.test", env })).status).toBe(
      202,
    );
    expect((await sendChunk(a, sid, 1, [click(T + 100, 1, "#a")], { origin: "https://flood-a.test", env })).status).toBe(202);
    const over = await sendChunk(a, sid, 2, [click(T + 200, 1, "#b")], { origin: "https://flood-a.test", env });
    expect(over.status).toBe(429);
    expect(over.json).toMatchObject({ ok: false, error: "site_daily_limit", stop: true });
    expect(over.json.hint).toContain("other sites keep recording");
    // remembered per isolate for a minute (no DO call), for this site only
    expect((await first(a, "flood-a.test", { env })).json.error).toBe("site_daily_limit");
    expect((await first(b, "flood-b.test", { env })).status).toBe(202);
    const got = await call("GET", `/v1/sites/${a}`, { key, env });
    expect(got.json.limits.site_per_day).toEqual({ sessions: null, chunks: 2, bytes: null, derived: null });
    expect(got.json.data.dropped_last_7d.site_daily_limit.count).toBeGreaterThan(0);
    const u = (await call("GET", "/v1/usage", { key, env })).json;
    expect(u.limits.chunks_per_site_per_day).toMatchObject({ limit: 2, used: 2, drops_data: true });
    expect(u.limits.chunks_per_site_per_day.per.map((p: { id: string }) => p.id)).toEqual([a, b]);
  });

  it("MAX_BYTES_PER_IP_PER_SITE_PER_DAY bounds the bytes one network sends a site; other networks continue", async () => {
    const { key, site } = await newSite("netbytes.test");
    const sid = newSid();
    const T = Date.now() - 5_000;
    const opts = { origin: "https://netbytes.test", ip: "198.18.0.7" };
    expect((await sendChunk(site, sid, 0, [page(T, 1, "/", { h: "netbytes.test" })], opts)).status).toBe(202);
    const used = (await call("GET", `/v1/sites/${site}`, { key })).json.data.usage_today.bytes as number;
    const env = hosted({ MAX_BYTES_PER_IP_PER_SITE_PER_DAY: String(used + 10) });
    const over = await sendChunk(site, sid, 1, [click(T + 100, 1, "#a")], { ...opts, env });
    expect(over.status).toBe(429);
    expect(over.json).toMatchObject({ error: "ip_bytes_limit", stop: true });
    expect((await first(site, "netbytes.test", { env, ip: "198.18.0.8" })).status).toBe(202);
    expect((await call("GET", `/v1/sites/${site}`, { key, env })).json.limits.bytes_per_network_per_day).toBe(used + 10);
  });
});

describe("attack mode", () => {
  it("while a site is under attack, data-centre networks start no session and don't count; residential visitors record", async () => {
    const { key, site } = await newSite("attack.test");
    const dc = { headers: { "x-afs-dev-asn": DC_ASN } };
    expect((await first(site, "attack.test", dc)).status).toBe(202); // no attack yet: recorded
    for (let i = 1; i < ATTACK_MIN_SESSIONS; i++)
      expect((await first(site, "attack.test", { headers: { "x-afs-dev-asn": HOME_ASN } })).status).toBe(202);
    const sessions = (await call("GET", `/v1/sites/${site}`, { key })).json.data.usage_today.sessions;
    const refused = await first(site, "attack.test", dc);
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ ok: false, error: "datacenter_under_attack", stop: true });
    expect(refused.json.hint).toContain("data-centre");
    expect((await first(site, "attack.test", { headers: { "x-afs-dev-asn": HOME_ASN } })).status).toBe(202);
    // ?afsr=1 test recordings (installs are verified from cloud browsers) still record
    const forced = await sendChunk(site, newSid(), 0, [page(Date.now() - 5_000, 1, "/", { h: "attack.test" })], {
      origin: "https://attack.test",
      ip: nextIp(),
      extra: { f: 1 },
      ...dc,
    });
    expect(forced.status).toBe(202);
    const got = (await call("GET", `/v1/sites/${site}`, { key })).json.data;
    expect(got.protection).toMatchObject({ state: "under_attack", window_minutes: 15 });
    expect(got.protection.ends_at).toBeGreaterThan(Date.now());
    expect(got.usage_today.sessions).toBe(sessions + 2); // the residential and the forced one, not the refused one
    expect(got.dropped_last_7d.datacenter_under_attack.count).toBe(1);
    // verify explains the refusals (its page fetch answered here, not from the network)
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response("<html></html>", { headers: { "content-type": "text/html" } })) as typeof fetch;
    try {
      const v = (await call("POST", `/v1/sites/${site}/verify`, { key })).json;
      expect(v.checks.find((c: { id: string }) => c.id === "datacenter_under_attack")?.fix).toContain("data-centre");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("the visitor's network operator: request.cf, the edge's x-afs-geo-asn only behind the edge, x-afs-dev-asn only in dev", () => {
    const TOKEN = "replay-edge-token";
    const geo = { "x-afs-geo-asn": DC_ASN, "x-afs-edge-host": "edge.shop.test" };
    const edge = new Request("https://replay.internal/_r/i", { headers: { ...geo, "x-afs-internal": TOKEN } });
    expect(visitorAsn(edge, { INTERNAL_TOKEN: TOKEN })).toBe(16509);
    // anyone else's x-afs-geo-asn is ignored (cf has none in tests)
    expect(visitorAsn(new Request("https://replay.example.com/_r/i", { headers: geo }), { INTERNAL_TOKEN: TOKEN })).toBeNull();
    const dev = new Request("https://replay.test/i", { headers: { "x-afs-dev-asn": HOME_ASN } });
    expect(visitorAsn(dev, {}, true)).toBe(7922);
    expect(visitorAsn(dev, {}, false)).toBeNull();
  });
});

describe("share links: short default expiry, Report abuse, the replay.share_links pause", () => {
  const recorded = async (domain: string) => {
    const s = await newSite(domain);
    const sid = newSid();
    const T = Date.now() - 60_000;
    await sendChunk(s.site, sid, 0, [snapshot(T), page(T, 1, "/", { h: domain })], { origin: `https://${domain}` });
    await sendChunk(s.site, sid, 1, [click(T + 500, 1, "#a")], { origin: `https://${domain}` });
    return { ...s, sid };
  };

  it("expire after a day by default; the player has a Report abuse link to the platform (none without one)", async () => {
    const { key, site, sid } = await recorded("abuse-link.test");
    const made = await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: sid } });
    expect(made.status).toBe(201);
    expect(made.json.link.expires_at - made.json.link.created_at).toBe(86_400_000);
    const path = new URL(made.json.link.url).pathname;
    const env = hosted({ AUTH_ISSUER: "https://platform.test" });
    const page = await call("GET", path, { env });
    expect(page.headers.get("x-robots-tag")).toContain("noindex");
    expect(page.text).toContain(`href="https://platform.test/report-abuse?url=${encodeURIComponent(`http://replay.test${path}`)}"`);
    expect(page.text).toContain("Report abuse");
    expect((await call("GET", path)).text).not.toContain("Report abuse");
  });

  it("while paused: no new link (403 capability_paused with the reason), existing links show a paused page and serve nothing", async () => {
    const { key, account, site, sid } = await recorded("paused-link.test");
    const link = await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: sid } });
    const path = new URL(link.json.link.url).pathname;
    expect((await call("GET", `${path}/chunks/0`)).status).toBe(200);
    await setPause(account, "replay.share_links", "a phishing report about a share link");
    const refused = await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: sid } });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("capability_paused");
    expect(refused.json.error.hint).toContain("a phishing report about a share link");
    const shown = await call("GET", path, { env: hosted({ AUTH_ISSUER: "https://platform.test" }) });
    expect(shown.status).toBe(403);
    expect(shown.text).toContain("paused");
    expect(shown.text).toContain("Report abuse");
    expect(shown.headers.get("x-robots-tag")).toContain("noindex");
    expect((await call("GET", `${path}/data`)).json.error.code).toBe("capability_paused");
    expect((await call("GET", `${path}/chunks/0`)).status).toBe(403);
    // other capabilities don't matter; lifting it brings the link back
    await setPause(account, "replay.share_links", "", true);
    await setPause(account, "mail.send", "bounces");
    expect((await call("GET", `${path}/data`)).status).toBe(200);
    expect((await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: sid } })).status).toBe(201);
  });
});

describe("replay behind a path proxy (/_r/*, forwarded unchanged)", () => {
  it("serves the loader, the recorder and takes chunks under the prefix", async () => {
    const { key, site } = await newSite("proxy.test");
    const loader = await call("GET", `/_r/r/${site}.js`);
    expect(loader.status).toBe(200);
    expect(loader.headers.get("content-type")).toContain("javascript");
    // the loader derives its base from its own src (test/unit/bundles.test.ts): the recorder comes from /_r too
    const rec = JSON.parse(/var __AFSR__=(\{.*?\});\n/.exec(loader.text)![1]!).rec as string;
    expect(rec).toMatch(/^\/rec\/[0-9a-f]{12}\.js$/);
    const recorder = await call("GET", `/_r${rec}`);
    expect(recorder.status).toBe(200);
    expect(recorder.text.startsWith("/*! afs-replay recorder")).toBe(true);
    const pre = await call("OPTIONS", "/_r/i");
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    const sid = newSid();
    const r = await sendChunk(site, sid, 0, [snapshot(Date.now() - 5_000), page(Date.now() - 5_000, 1, "/", { h: "proxy.test" })], {
      origin: "https://proxy.test",
      path: "/_r/i",
    });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ ok: true, session_id: sid, new_session: true });
    expect((await call("GET", `/v1/sites/${site}/sessions/${sid}`, { key })).status).toBe(200);
    // the API isn't reachable under the prefix
    expect((await call("GET", "/_r/v1/sites", { key })).status).toBe(404);
  });
});
