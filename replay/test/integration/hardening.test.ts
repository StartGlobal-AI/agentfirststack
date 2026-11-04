/**
 * The security, abuse and cost hardening end to end (workerd, D1 + DO + R2): ownership and
 * domain verification, Origin and page-host checks, trial quotas, forced and per-network quotas,
 * account and deployment budgets, suspension, edge rate limits, retention on the DO alarm, the cron's
 * isolation, share links (verified only, per-site CSP, byte budget), verify's fetch rules, deletion
 * tombstones, and a measurement of the DO's rows written.
 */
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { createApiKey, forgetStanding } from "@afs/shared";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { SCHEMA_VERSION } from "../../src/do/engine";
import { runPurge } from "../../src/service/purge";
import { click, error, hide, meta, mousemove, page, snapshot } from "../fixtures/rrweb";
import { call, E, hosted, markVerified, newSid, newSite, sendChunk, signup, tool } from "./helpers";

const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A new session's first chunk: its page on `host`. */
const first = (site: string, host: string, opts: Parameters<typeof sendChunk>[4] = {}) =>
  sendChunk(site, newSid(), 0, [page(Date.now() - 5_000, 1, "/", { h: host })], { origin: `https://${host}`, ...opts });
const stubFetch = (handler: (url: string) => Response | null) => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = String(input instanceof Request ? input.url : input);
    return handler(u) ?? new Response("nope", { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
};

describe("C1: who may record into a site", () => {
  it("refuses domains nobody owns and wildcards over public suffixes, with hints", async () => {
    const { key } = await signup();
    for (const [domain, hint] of [
      ["1.2.3.4", "IP"],
      ["com", "TLD"],
      ["co.uk", "public suffix"],
      ["github.io", "public suffix"],
    ] as const) {
      const r = await call("POST", "/v1/sites", { key, body: { domain } });
      expect(r.status, domain).toBe(400);
      expect(r.json.error.hint).toContain(hint);
    }
    const wild = await call("POST", "/v1/sites", { key, body: { domain: "ok.test", allowed_hostnames: ["*.com"] } });
    expect(wild.status).toBe(400);
    expect(wild.json.error.message).toContain("*.com");
  });

  it("needs an Origin header on the site's hosts, and a new session's page with its hostname", async () => {
    const { site } = await newSite("own.test");
    const T = Date.now() - 5_000;
    const ev = [page(T, 1, "/", { h: "own.test" })];
    const none = await sendChunk(site, newSid(), 0, ev, { origin: null });
    expect(none.status).toBe(403);
    expect(none.json).toMatchObject({ error: "origin_required", stop: true });
    expect((await sendChunk(site, newSid(), 0, ev, { origin: "null" })).json.error).toBe("origin_required");
    const noPage = await sendChunk(site, newSid(), 0, [snapshot(T), click(T + 10, 1, "#a")], { origin: "https://own.test" });
    expect(noPage.status).toBe(400);
    expect(noPage.json).toMatchObject({ error: "page_host_required" });
    expect(noPage.json.stop).toBeUndefined();
    const emptyHost = await sendChunk(site, newSid(), 0, [page(T, 1, "/", { h: "" })], { origin: "https://own.test" });
    expect(emptyHost.json.error).toBe("page_host_required");
    const foreignMeta = await sendChunk(site, newSid(), 0, [meta(T, "https://victim.test/"), ...ev], { origin: "https://own.test" });
    expect(foreignMeta.json.error).toBe("hostname_not_allowed");
    expect((await sendChunk(site, newSid(), 0, ev, { origin: "https://own.test" })).status).toBe(202);
  });

  it("until verified: trial quota, strict loader, no share links, one unverified site per account; verify lifts it", async () => {
    const env = hosted({ MAX_UNVERIFIED_SESSIONS_PER_SITE_PER_DAY: "2" });
    const { key, site } = await newSite("trial.test", { mask_mode: "relaxed", unmask_selectors: ["*"] }, env, { verified: false });
    const cfg = async () => JSON.parse(/var __AFSR__=(\{.*?\});\n/.exec((await call("GET", `/r/${site}.js`)).text)![1]!);
    expect(await cfg()).toMatchObject({ mask: "strict", unmask: "" });
    const g = await call("GET", `/v1/sites/${site}`, { key });
    expect(g.json.site.verification).toMatchObject({ verified: false, dns_record: { name: "_afs-verify.trial.test" } });
    expect(g.json.limits.sessions_per_day).toBe(20);
    expect((await first(site, "trial.test", { env })).status).toBe(202);
    expect((await first(site, "trial.test", { env })).status).toBe(202);
    const third = await first(site, "trial.test", { env });
    expect(third.status).toBe(429);
    expect(third.json).toMatchObject({ error: "unverified_daily_limit", stop: true });
    expect(third.json.hint).toContain("verify");
    const sid = (await call("GET", `/v1/sites/${site}/sessions`, { key })).json.sessions[0].id;
    const link = await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: sid } });
    expect(link.status).toBe(403);
    expect(link.json.error.code).toBe("domain_not_verified");
    const second = await call("POST", "/v1/sites", { key, body: { domain: "second.test" } });
    expect(second.status).toBe(403);
    expect(second.json.error.code).toBe("verification_required");

    const restore = stubFetch((u) =>
      u === "https://trial.test/" ? new Response(`<script defer src="http://replay.test/r/${site}.js"></script>`) : null,
    );
    try {
      const v = await call("POST", `/v1/sites/${site}/verify`, { key, body: {} });
      expect(v.json).toMatchObject({ domain_verified: true, verification: { verified: true, method: "homepage" } });
    } finally {
      restore();
    }
    expect(await cfg()).toMatchObject({ mask: "relaxed", unmask: "*" });
    expect((await first(site, "trial.test", { env })).status).toBe(202);
    expect((await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: sid } })).status).toBe(201);
    expect((await call("POST", "/v1/sites", { key, body: { domain: "second.test" } })).status).toBe(201);
  });

  it("a DNS TXT record verifies too; a loader on another page or subdomain doesn't", async () => {
    const { key, site } = await newSite("dns.test", {}, undefined, { verified: false });
    let txt = false;
    const restore = stubFetch((u) => {
      if (u === "https://www.dns.test/pricing") return new Response(`<script src="http://replay.test/r/${site}.js"></script>`);
      if (u.startsWith("https://cloudflare-dns.com/dns-query") && u.includes("_afs-verify.dns.test"))
        return Response.json({
          Status: 0,
          Answer: txt ? [{ name: "_afs-verify.dns.test", type: 16, data: `"afs-replay-site=${site}"` }] : [],
        });
      return null;
    });
    try {
      const a = await call("POST", `/v1/sites/${site}/verify`, { key, body: { url: "https://www.dns.test/pricing" } });
      expect(a.json.domain_verified).toBe(false);
      expect(a.json.checks.find((c: { id: string }) => c.id === "domain_verified").fix).toContain(`afs-replay-site=${site}`);
      txt = true;
      const b = await call("POST", `/v1/sites/${site}/verify`, { key, body: {} });
      expect(b.json).toMatchObject({ domain_verified: true, verification: { method: "dns_txt" } });
    } finally {
      restore();
    }
  });

  it("a url with a query string never proves the domain, even when the page repeats the loader (the ?s= exploit)", async () => {
    const { key, site } = await newSite("victim.test", {}, undefined, { verified: false });
    const tag = `<script defer src="http://replay.test/r/${site}.js"></script>`;
    let raw = false;
    const seen: string[] = [];
    const restore = stubFetch((u) => {
      seen.push(u);
      const url = new URL(u);
      if (url.hostname === "cloudflare-dns.com") return Response.json({ Status: 0, Answer: [] });
      if (url.hostname !== "victim.test") return null;
      const q = url.searchParams.get("s") ?? "";
      const esc = q.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
      // a WordPress-style search page: the query in the search box, an inline script and a comment,
      // or (worst case) as raw HTML
      return new Response(
        `<html><head><script>var search = ${JSON.stringify(q)};</script></head><body><input name="s" value="${esc}">` +
          `<!-- results for ${q.replace(/-->/g, "")} -->${raw ? q : ""}</body></html>`,
      );
    });
    try {
      const a = await call("POST", `/v1/sites/${site}/verify`, { key, body: { url: `https://victim.test/?s=/r/${site}.js` } });
      expect(a.json.domain_verified).toBe(false);
      expect(a.json.checks.find((c: { id: string }) => c.id === "snippet_present")).toMatchObject({
        ok: false,
        detail: expect.stringContaining("not in a <script src> tag"),
      });
      expect(a.json.untrusted.found_scripts).toEqual([expect.objectContaining({ site, inline: true })]);
      expect(a.json.checks.find((c: { id: string }) => c.id === "domain_verified").detail).toContain("only that exact URL counts");
      // the homepage itself was fetched to decide, without the query
      expect(seen).toContain("https://victim.test/");
      // the query echoed as raw HTML is a real tag on that page, but that page isn't the homepage
      raw = true;
      for (const url of [`https://victim.test/?s=${encodeURIComponent(tag)}`, `https://victim.test/?s=${encodeURIComponent(tag)}#top`]) {
        const b = await call("POST", `/v1/sites/${site}/verify`, { key, body: { url } });
        expect(b.json.checks.find((c: { id: string }) => c.id === "snippet_present").ok, url).toBe(true);
        expect(b.json.domain_verified, url).toBe(false);
      }
    } finally {
      restore();
    }
    // so none of what the exploit was for: no share link, and the loader keeps masking strictly
    const link = await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: newSid() } });
    expect(link.json.error.code).toBe("domain_not_verified");
    expect((await call("GET", `/v1/sites/${site}`, { key })).json.site.verification.verified).toBe(false);
  });

  it("on the homepage only a real <script src> tag counts: not inline loader code, a comment or an attribute", async () => {
    const { key, site } = await newSite("inline.test", {}, undefined, { verified: false });
    const A = "site_0123456789abcdef";
    let body = "";
    const restore = stubFetch((u) => {
      if (u.startsWith("https://cloudflare-dns.com/")) return Response.json({ Status: 0, Answer: [] });
      return u === "https://inline.test/" ? new Response(`<html><head>${body}</head></html>`) : null;
    });
    try {
      for (const b of [
        // a GTM-style loader names the URL only in code
        `<script>(function(d){var s=d.createElement("script");s.src="http://replay.test/r/${site}.js";d.head.appendChild(s)})(document)</script>`,
        `<!-- <script src="http://replay.test/r/${site}.js"></script> -->`,
        `<meta name="x" content='<script src="http://replay.test/r/${site}.js"></script>'>`,
        `<noscript><script src="http://replay.test/r/${site}.js"></script></noscript>`,
      ]) {
        body = b;
        const r = await call("POST", `/v1/sites/${site}/verify`, { key, body: {} });
        expect(r.json.domain_verified, b).toBe(false);
      }
      body = `<script async src="http://replay.test/r/${site}.js"></script>`;
      const ok = await call("POST", `/v1/sites/${site}/verify`, { key, body: {} });
      expect(ok.json.verification).toMatchObject({ verified: true, method: "homepage" });
    } finally {
      restore();
    }
    // the linked analytics tracker follows the same rule
    const t = await newSite("inline-a.test", {}, undefined, { verified: false });
    await E.DB.prepare("UPDATE sites SET analytics_site_id = ? WHERE id = ?").bind(A, t.site).run();
    const tracker = `<script src="/_a/s.js" data-site="${A}"></script>`;
    body = `<!-- ${tracker} --><script>var t = '${tracker.replace("</script>", "")}';</script>`;
    const restore2 = stubFetch((u) => {
      if (u.startsWith("https://cloudflare-dns.com/")) return Response.json({ Status: 0, Answer: [] });
      return u === "https://inline-a.test/" ? new Response(`<html><head>${body}</head></html>`) : null;
    });
    try {
      expect((await call("POST", `/v1/sites/${t.site}/verify`, { key: t.key, body: {} })).json.domain_verified).toBe(false);
      body = tracker;
      const ok = await call("POST", `/v1/sites/${t.site}/verify`, { key: t.key, body: {} });
      expect(ok.json.verification).toMatchObject({ verified: true, method: "homepage_analytics" });
    } finally {
      restore2();
    }
  });

  it("?afsr=1 skips the bot filter but counts against its own daily quota", async () => {
    const { site } = await newSite("forced.test");
    const env = hosted({ MAX_FORCED_SESSIONS_PER_SITE_PER_DAY: "1" });
    const o = { env, ua: "curl/8.0", extra: { f: 1 } };
    expect((await first(site, "forced.test", o)).status).toBe(202);
    const again = await first(site, "forced.test", o);
    expect(again.status).toBe(429);
    expect(again.json.error).toBe("forced_daily_limit");
    expect((await first(site, "forced.test", { env, ua: "curl/8.0" })).json.dropped).toBe("bot");
    expect((await first(site, "forced.test", { env })).status).toBe(202);
  });

  it("a suspended account's ingest, loader and share links are refused", async () => {
    const { key, account, site } = await newSite("susp.test");
    const T = Date.now() - 5_000;
    const sid = newSid();
    await sendChunk(site, sid, 0, [snapshot(T), page(T, 1, "/", { h: "susp.test" })], { origin: "https://susp.test" });
    const link = await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: sid } });
    expect(link.status).toBe(201);
    await (E.AUTH_DB ?? E.DB).prepare("UPDATE accounts SET suspended_at = ? WHERE id = ?").bind(Date.now(), account).run();
    forgetStanding(account);
    const r = await first(site, "susp.test");
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: "account_suspended", stop: true });
    expect((await call("GET", `/r/${site}.js`)).status).toBe(403);
    expect((await call("GET", new URL(link.json.link.url).pathname)).status).toBe(404);
  });
});

describe("C2: cost is bounded per session, site, account and deployment", () => {
  it("measures what one chunk costs the site's Durable Object in rows written (and what the old indexes cost)", async () => {
    const workload = async (domain: string, oldIndexes: boolean) => {
      const { key, site } = await newSite(domain);
      const sid = newSid();
      const T = Date.now() - 600_000;
      const o = { origin: `https://${domain}` };
      await sendChunk(site, sid, 0, [snapshot(T), page(T, 1, "/", { h: domain })], o);
      const stub = E.SITE.get(E.SITE.idFromName(site));
      if (oldIndexes)
        await runInDurableObject(stub, (_i, state: DurableObjectState) => {
          state.storage.sql.exec("CREATE INDEX events_kind_ts ON events(kind, ts)");
          state.storage.sql.exec("CREATE INDEX events_click_path ON events(path, ts) WHERE kind = 'click'");
        });
      const before = await stub.usageStats();
      for (let c = 1; c <= 10; c++) {
        // 50 clicks per chunk at 10 per second, the most a real visitor produces
        const ev = Array.from({ length: 50 }, (_, i) => click(T + c * 10_000 + i * 100, 1, `#b${i % 7}`, { l: `B${i}`, x: i * 40 }));
        expect((await sendChunk(site, sid, c, ev, o)).status).toBe(202);
      }
      const after = await stub.usageStats();
      return { key, site, sid, T, o, written: after.rows_written - before.rows_written, schema: after.schema_version };
    };
    const now = await workload("cost.test", false);
    const old = await workload("cost-old.test", true);
    const m = { per_click: now.written / 500, per_chunk: now.written / 10, old_per_click: old.written / 500 };
    console.log(JSON.stringify({ event: "measure.do_rows_written", ...m }));
    expect(now.schema).toBe(SCHEMA_VERSION);
    // a click is a table row + 2 index entries (events_session, events_ce) instead of 4
    expect(m.per_click).toBeLessThan(m.old_per_click);
    expect(m.per_click).toBeLessThan(4);
    // the hosted-safe default caps derived rows at 500 per chunk (and 1,500 per session)
    const big = Array.from({ length: 600 }, (_, i) => click(now.T + 200_000 + i * 60, 1, `#c${i}`));
    await sendChunk(now.site, now.sid, 20, big, now.o);
    const one = (await call("GET", `/v1/sites/${now.site}/sessions/${now.sid}`, { key: now.key })).json.session;
    expect(one).toMatchObject({ clicks: 500 + 500, limited: "events" });
  });

  it("deleting sessions doesn't free the site's daily quota", async () => {
    const { key, site } = await newSite("quota.test");
    const env = hosted({ MAX_SESSIONS_PER_SITE_PER_DAY: "1" });
    expect((await first(site, "quota.test", { env })).status).toBe(202);
    const sid = (await call("GET", `/v1/sites/${site}/sessions`, { key })).json.sessions[0].id;
    await call("DELETE", `/v1/sites/${site}/sessions/${sid}`, { key });
    const again = await first(site, "quota.test", { env });
    expect(again.status).toBe(429);
    expect(again.json.error).toBe("daily_session_limit");
    expect((await call("GET", `/v1/sites/${site}`, { key })).json.data.usage_today.sessions).toBe(1);
  });

  it("an account's daily budget holds across its sites", async () => {
    const env = hosted({ MAX_SESSIONS_PER_ACCOUNT_PER_DAY: "2" });
    const { key, account, site: a } = await newSite("acct-a.test");
    const b = (await call("POST", "/v1/sites", { key, body: { domain: "acct-b.test" } })).json.site.id as string;
    await markVerified(b);
    expect((await first(a, "acct-a.test", { env })).status).toBe(202);
    await sleep(2_100); // site A reports its counters at most every 2 s when near a cap
    expect((await first(a, "acct-a.test", { env })).status).toBe(202);
    const r = await first(b, "acct-b.test", { env });
    expect(r.status).toBe(429);
    expect(r.json).toMatchObject({ error: "account_daily_limit", stop: true });
    const row = await E.DB.prepare("SELECT sessions FROM account_usage WHERE account_id = ? AND day = ?")
      .bind(account, new Date().toISOString().slice(0, 10))
      .first<{ sessions: number }>();
    expect(row?.sessions).toBe(2);
  });

  it("past the deployment's daily budget, ingest answers 429 for everyone", async () => {
    const env = hosted({ MAX_PLATFORM_BYTES_PER_DAY: "1" });
    for (const domain of ["plat-a.test", "plat-b.test"]) {
      const { site } = await newSite(domain);
      const r = await first(site, domain, { env });
      expect(r.status).toBe(429);
      expect(r.json).toMatchObject({ error: "platform_budget", stop: true });
      // without the budget configured, the same site records (the refusal isn't remembered across configurations)
      expect((await first(site, domain)).status).toBe(202);
    }
  });
});

describe("H2: retention runs on each site's own alarm; the cron isolates sites", () => {
  it("ingest schedules the alarm; maintenance purges by retention and deletes the R2 chunks", async () => {
    const { site } = await newSite("ret.test", { retention_days: 1 });
    const sid = newSid();
    const T = Date.now() - 60_000;
    await sendChunk(site, sid, 0, [snapshot(T), page(T, 1, "/", { h: "ret.test" })], { origin: "https://ret.test" });
    await sendChunk(site, sid, 1, [click(T + 1000, 1, "#a"), hide(T + 2000, 1)], { origin: "https://ret.test" });
    const stub = E.SITE.get(E.SITE.idFromName(site));
    expect(await runInDurableObject(stub, (_i, state: DurableObjectState) => state.storage.getAlarm())).not.toBeNull();
    expect((await E.CHUNKS.list({ prefix: `${site}/${sid}/` })).objects).toHaveLength(2);
    const r = await stub.maintain(undefined, { now: Date.now() + 2 * DAY });
    expect(r).toMatchObject({ sessions_deleted: 1, chunks_deleted: 2, more: false });
    expect((await E.CHUNKS.list({ prefix: `${site}/${sid}/` })).objects).toHaveLength(0);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  });

  it("one failing site doesn't stop the cron: it is marked and retried a day later", async () => {
    const bad = await newSite("bad.test");
    const good = await newSite("good.test", { retention_days: 1 });
    await first(good.site, "good.test");
    const badId = E.SITE.idFromName(bad.site);
    const env: Bindings = {
      ...E,
      SITE: {
        idFromName: (n: string) => E.SITE.idFromName(n),
        get: (id: DurableObjectId) =>
          id.equals(badId)
            ? ({
                kick: async () => {
                  throw new Error("boom");
                },
              } as never)
            : E.SITE.get(id),
      } as unknown as Bindings["SITE"],
    };
    const r = await runPurge(env, Date.now() + 2 * DAY);
    expect(r.site_errors).toBeGreaterThanOrEqual(1);
    expect(r.sessions_deleted).toBeGreaterThanOrEqual(1);
    const row = await E.DB.prepare("SELECT maintained_at FROM sites WHERE id = ?").bind(bad.site).first<{ maintained_at: number }>();
    expect(row?.maintained_at).not.toBeNull();
  });

  it("heatmap_retention_days is capped by MAX_HEATMAP_RETENTION_DAYS", async () => {
    const { key, site } = await newSite("heat.test");
    const r = await call("PATCH", `/v1/sites/${site}`, {
      key,
      body: { heatmap_retention_days: 365 },
      env: hosted({ MAX_HEATMAP_RETENTION_DAYS: "90" }),
    });
    expect(r.json.site.heatmap_retention_days).toBe(90);
    expect(r.json.notes.join(" ")).toContain("MAX_HEATMAP_RETENTION_DAYS");
  });
});

describe("H4: public site ids can't be used to sabotage a site", () => {
  it("edge rate limits answer 429 before any other work", async () => {
    const { site } = await newSite("rl.test");
    const no = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const ip = await first(site, "rl.test", { env: hosted({ INGEST_IP_LIMITER: no }) });
    expect(ip.status).toBe(429);
    expect(ip.json).toMatchObject({ error: "rate_limited" });
    expect(ip.json.stop).toBeUndefined();
    expect((await call("GET", `/r/${site}.js`, { env: hosted({ INGEST_IP_LIMITER: no }) })).status).toBe(429);
    expect((await first(site, "rl.test", { env: hosted({ INGEST_SITE_LIMITER: no }) })).status).toBe(429);
    expect((await first(site, "rl.test", { env: hosted({ INGEST_SITE_IP_LIMITER: no }) })).status).toBe(429);
    // random site ids are refused before a D1 read, too
    expect((await sendChunk("rsite_zzzzzzzzzzzzzzzz", newSid(), 0, [], { env: hosted({ INGEST_IP_LIMITER: no }) })).status).toBe(429);
  });

  it("one network starts only a few sessions per site and day", async () => {
    const { site } = await newSite("net.test");
    const env = hosted({ MAX_SESSIONS_PER_IP_PER_SITE_PER_DAY: "1" });
    expect((await first(site, "net.test", { env, ip: "192.0.2.10" })).status).toBe(202);
    const r = await first(site, "net.test", { env, ip: "192.0.2.10" });
    expect(r.status).toBe(429);
    expect(r.json.error).toBe("ip_daily_limit");
    expect((await first(site, "net.test", { env, ip: "192.0.2.11" })).status).toBe(202);
  });

  it("refusals are counted with sampled writes", async () => {
    const { key, site } = await newSite("drops.test");
    for (let i = 0; i < 5; i++) await first(site, "drops.test", { origin: "https://evil.test" });
    const d = (await call("GET", `/v1/sites/${site}`, { key })).json;
    // the first refusal is written at once; the rest ride along with the next write (a minute later)
    expect(d.data.dropped_last_7d.origin_not_allowed.count).toBe(1);
    expect(d.untrusted.drop_samples.origin_not_allowed).toBe("evil.test");
  });

  it("analytics forwarding: verified sites only, at most MAX_FORWARDED_EVENTS_PER_SITE_PER_DAY", async () => {
    const received: { name: string }[] = [];
    const ANALYTICS = {
      fetch: async (req: Request) => {
        const u = new URL(req.url);
        if (req.method === "GET") return Response.json({ site: { id: "site_0123456789abcdef", domain: "fw.test" } });
        if (u.pathname.endsWith("/events")) received.push(...((await req.json()) as { events: { name: string }[] }).events);
        return Response.json({ ok: true }, { status: 202 });
      },
    } as unknown as Fetcher;
    const env = hosted({ ANALYTICS, INTERNAL_TOKEN: "test-internal-0123456789", MAX_FORWARDED_EVENTS_PER_SITE_PER_DAY: "1" });
    const run = async (site: string, host: string) => {
      const sid = newSid();
      const T = Date.now() - 60_000;
      await sendChunk(site, sid, 0, [page(T, 1, "/", { h: host })], { origin: `https://${host}`, env });
      await sendChunk(
        site,
        sid,
        1,
        [click(T + 1000, 1, "#a"), click(T + 1200, 1, "#a"), click(T + 1400, 1, "#a"), error(T + 1500, 1, "Error: x"), hide(T + 4000, 1)],
        { origin: `https://${host}`, env, extra: { end: 1 } },
      );
    };
    const unverified = await newSite("fw-u.test", {}, undefined, { verified: false });
    await call("PATCH", `/v1/sites/${unverified.site}`, { key: unverified.key, body: { analytics_site_id: "site_0123456789abcdef" }, env });
    expect((await call("GET", `/v1/sites/${unverified.site}`, { key: unverified.key, env })).json.site.analytics_forwarding).toBe(
      "waiting_for_domain_verification",
    );
    await run(unverified.site, "fw-u.test");
    expect(received).toHaveLength(0);
    const verified = await newSite("fw.test");
    await call("PATCH", `/v1/sites/${verified.site}`, { key: verified.key, body: { analytics_site_id: "site_0123456789abcdef" }, env });
    await run(verified.site, "fw.test");
    expect(received.map((e) => e.name)).toEqual(["rage_click"]);
  });
});

describe("share links, verify, deletion and storage details (H1, M3, M4, LOW)", () => {
  it("the player's CSP names only the site's hosts; a site no longer verified gets a banner and no chunks", async () => {
    const { key, site } = await newSite("play.test", { allowed_hostnames: ["*.cdn-play.test"] });
    const sid = newSid();
    const T = Date.now() - 60_000;
    await sendChunk(site, sid, 0, [snapshot(T), page(T, 1, "/", { h: "play.test" })], { origin: "https://play.test" });
    await sendChunk(site, sid, 1, [click(T + 500, 1, "#a")], { origin: "https://play.test" });
    // a chunk without rrweb events isn't written to R2 and isn't offered to the player
    await sendChunk(site, sid, 2, [], { origin: "https://play.test" });
    expect(await E.CHUNKS.get(`${site}/${sid}/000002`)).toBeNull();
    const link = await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: sid } });
    const path = new URL(link.json.link.url).pathname;
    const csp = (await call("GET", path)).headers.get("content-security-policy")!;
    expect(csp).toContain("img-src 'self' data: blob: https://play.test https://*.play.test https://*.cdn-play.test");
    expect(csp).not.toMatch(/https:(;|\s|$)/);
    const data = await call("GET", `${path}/data`);
    expect(data.json.session).toMatchObject({ site_domain: "play.test", site_verified: true });
    expect(data.json.chunks).toEqual([0, 1]);
    // the link's daily byte budget
    const tight = hosted({ MAX_LINK_BYTES_PER_DAY: "1" });
    expect((await call("GET", `${path}/chunks/0`, { env: tight })).status).toBe(429);
    expect((await call("GET", `${path}/chunks/0`)).status).toBe(200);
    expect((await call("GET", `${path}/chunks/2`)).status).toBe(404);
    // the domain changes: unverified until proven again
    await call("PATCH", `/v1/sites/${site}`, { key, body: { domain: "other-play.test" } });
    const after = await call("GET", `${path}/data`);
    expect(after.json.session).toMatchObject({ site_domain: null, site_verified: false });
    expect(after.json.chunks).toEqual([]);
    expect((await call("GET", `${path}/chunks/0`)).status).toBe(404);
  });

  it("a connected app's OAuth access token can't create share links (REST and MCP); the project's key can", async () => {
    const { key, account, site } = await newSite("oauth-play.test");
    const sid = newSid();
    const T = Date.now() - 60_000;
    await sendChunk(site, sid, 0, [snapshot(T), page(T, 1, "/", { h: "oauth-play.test" })], { origin: "https://oauth-play.test" });
    // what the platform's OAuth server issues: an API key that expires
    const token = (await createApiKey(E.AUTH_DB ?? E.DB, account, { keyPrefix: "afs", expiresAt: Date.now() + 3_600_000 })).key;
    expect((await call("GET", `/v1/sites/${site}/sessions`, { key: token })).status).toBe(200);
    const r = await call("POST", `/v1/sites/${site}/links`, { key: token, body: { session_id: sid } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("temporary_credential");
    const m = await tool(token, "create_replay_link", { site_id: site, session_id: sid });
    expect(m).toMatchObject({ isError: true, data: { error: { code: "temporary_credential" } } });
    const made = await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: sid } });
    expect(made.status).toBe(201);
    // revoking is fine with a token
    expect((await call("DELETE", `/v1/sites/${site}/links/${made.json.link.id}`, { key: token })).json.revoked).toBe(made.json.link.id);
  });

  it("verify fetches only https pages on the site's own domain, and is rate-limited per account", async () => {
    const { key, site } = await newSite("vf.test", { allowed_hostnames: ["partner.example.net"] });
    for (const url of [
      "http://vf.test/",
      "https://1.2.3.4/",
      "https://vf.test:8443/",
      "https://partner.example.net/",
      "https://evil.test/",
    ]) {
      const r = await call("POST", `/v1/sites/${site}/verify`, { key, body: { url } });
      expect(r.status, url).toBe(400);
    }
    const env = hosted({ MAX_VERIFY_PER_ACCOUNT_PER_HOUR: "1" });
    const restore = stubFetch(() => null);
    try {
      expect((await call("POST", `/v1/sites/${site}/verify`, { key, body: {}, env })).status).toBe(200);
      const r = await call("POST", `/v1/sites/${site}/verify`, { key, body: {}, env });
      expect(r.status).toBe(429);
      expect(r.json.error.hint).toContain("Retry after");
    } finally {
      restore();
    }
  });

  it("a deleted session can't be recorded again by a tab that is still open", async () => {
    const { key, site } = await newSite("del.test");
    const sid = newSid();
    const T = Date.now() - 60_000;
    await sendChunk(site, sid, 0, [snapshot(T), page(T, 1, "/", { h: "del.test" })], { origin: "https://del.test" });
    const del = await call("DELETE", `/v1/sites/${site}/sessions/${sid}`, { key });
    expect(del.json).toMatchObject({ deleted: sid, chunks_deleted: 1 });
    expect(await E.CHUNKS.get(`${site}/${sid}/000000`)).toBeNull();
    const late = await sendChunk(site, sid, 1, [mousemove(T + 1000)], { origin: "https://del.test" });
    expect(late.status).toBe(403);
    expect(late.json).toMatchObject({ error: "session_deleted", stop: true });
  });

  it("an envelope with extra fields, or mostly junk events, is refused (nothing to host)", async () => {
    const { site } = await newSite("junk.test");
    const T = Date.now() - 5_000;
    const ev = [page(T, 1, "/", { h: "junk.test" })];
    const extra = await sendChunk(site, newSid(), 0, ev, { origin: "https://junk.test", extra: { file: "x".repeat(5000) } });
    expect(extra.json.error).toBe("invalid_body");
    const junk = await sendChunk(site, newSid(), 0, [...ev, ...Array.from({ length: 40 }, () => "x".repeat(100))], {
      origin: "https://junk.test",
    });
    expect(junk.json.error).toBe("invalid_events");
  });
});
