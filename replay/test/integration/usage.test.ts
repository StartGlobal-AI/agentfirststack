import { forgetStanding } from "@afs/shared";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { app } from "../../src/index";
import { meta, page, snapshot } from "../fixtures/rrweb";
import { call, E, hosted, markVerified, newSid, newSite, sendChunk, signup, tool } from "./helpers";

const TOKEN = "test-internal-0123456789";
const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);

/** One recorded session (one chunk) on a site of `domain`; `forced` = an ?afsr=1 test recording. */
async function record(site: string, domain: string, opts: { forced?: boolean; env?: Bindings } = {}) {
  const T = Date.now() - 60_000;
  const r = await sendChunk(site, newSid(), 0, [meta(T, `https://${domain}/`), snapshot(T + 1), page(T + 5, 1, "/", { h: domain })], {
    origin: `https://${domain}`,
    extra: opts.forced ? { f: 1 } : {},
    env: opts.env,
  });
  expect(r.status).toBe(202);
}

async function addSite(key: string, domain: string, verified = true) {
  const r = await call("POST", "/v1/sites", { key, body: { domain } });
  expect(r.status).toBe(201);
  if (verified) await markVerified(r.json.site.id);
  return r.json.site.id as string;
}

const usage = async (key: string, env?: Bindings) => {
  const r = await call("GET", "/v1/usage", { key, env });
  expect(r.status).toBe(200);
  return r.json;
};

/** GET /v1/usage as the platform site sends it: a service binding with internal auth. */
async function internalUsage(account: string, env: Bindings) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request("https://replay.internal/v1/usage", { headers: { "x-afs-internal": TOKEN, "x-afs-account": account } }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: (await res.json()) as any };
}

const DROPS = [
  "sessions_per_day",
  "chunks_per_day",
  "daily_recorded_bytes",
  "derived_per_day",
  "sessions_per_site_per_day",
  "unverified_sessions_per_site_per_day",
  "upgraded_sessions_per_site_per_day",
  "forwarded_events_per_site_per_day",
  "tags_events_per_site_per_day",
  "survey_responses_per_site_per_day",
  "webhook_deliveries_per_day",
].sort();

describe("GET /v1/usage", () => {
  it("lists every cap with label, unit, var, resets and drops_data; no deployment-wide budgets", async () => {
    const { key, site } = await newSite("usage-shape.test");
    const u = await usage(key);
    const now = Date.now();
    expect(u.day).toBe(today());
    expect(u.resets_at).toBe(Date.parse(`${today()}T00:00:00Z`) + DAY);
    expect(u.resets_at).toBeGreaterThan(now);
    expect(u.resets_at_iso).toBe(new Date(u.resets_at).toISOString());
    expect(u.claimed).toBe(false);
    expect(u.next_steps.join(" ")).toContain("claim");
    expect(u.not_listed).toContain("MAX_CHUNKS_PER_SESSION");
    const names = Object.keys(u.limits);
    for (const n of ["sites", "unverified_sites", "sessions_per_site_per_day", "share_links_per_site", "webhooks", "daily_export_bytes"])
      expect(names).toContain(n);
    for (const [name, it] of Object.entries<any>(u.limits)) {
      expect(typeof it.label).toBe("string");
      expect(it.label[0]).toBe(it.label[0].toUpperCase());
      expect(typeof it.unit).toBe("string");
      expect(it.var).toMatch(/^MAX_[A-Z_]+$/);
      expect(it.var).not.toMatch(/^MAX_PLATFORM_/);
      expect(it.used === null || typeof it.used === "number").toBe(true);
      expect(it.limit === null || typeof it.limit === "number").toBe(true);
      if (it.limit !== null && it.used !== null) expect(it.remaining).toBe(Math.max(0, it.limit - it.used));
      else expect(it.remaining).toBeNull();
      // daily budgets reset at the next 00:00 UTC; counts and the rolling hour don't
      if (/_per_day$|^daily_/.test(name)) expect(it.resets_at).toBe(u.resets_at);
      else expect(it.resets_at).toBeNull();
      if (it.drops_data !== undefined) expect(it.drops_data).toBe(true);
      if (it.per) for (const p of it.per) expect(Object.keys(p).sort()).toEqual(["id", "label", "remaining", "used"]);
    }
    expect(JSON.stringify(u)).not.toMatch(/PLATFORM/);
    expect(
      names.filter((n) => u.limits[n].drops_data),
      "drops_data only where reaching the cap silently loses incoming data",
    ).toEqual(expect.arrayContaining(DROPS));
    expect(names.filter((n) => u.limits[n].drops_data).sort()).toEqual(DROPS);
    // the built-in defaults where a var is unset; no cap where there is none
    expect(u.limits.sites).toMatchObject({ used: 1, limit: null, remaining: null, var: "MAX_SITES_PER_ACCOUNT" });
    expect(u.limits.unverified_sites).toMatchObject({ used: 0, limit: 1 });
    expect(u.limits.webhooks).toMatchObject({ used: 0, limit: 10 });
    expect(u.limits.unverified_sessions_per_site_per_day).toMatchObject({ used: 0, limit: 20, per: [] });
    expect(u.limits.starred_copy_bytes).toMatchObject({ used: null, remaining: null, limit: 200 * 1_048_576 });
    expect(u.limits.sessions_per_site_per_day.per).toEqual([{ id: site, label: "usage-shape.test", used: 0, remaining: null }]);
  });

  it("counts move after creating sites and recording sessions; per-site caps list every site busiest first", async () => {
    const { key, site: a } = await newSite("usage-a.test");
    const b = await addSite(key, "usage-b.test");
    const c = await addSite(key, "usage-c.test");
    const before = await usage(key);
    expect(before.limits.sites.used).toBe(3);
    expect(before.limits.sessions_per_day.used).toBe(0);
    expect(before.limits.sessions_per_site_per_day.per.map((p: any) => p.id)).toEqual([a, b, c]);

    await record(b, "usage-b.test");
    await record(b, "usage-b.test");
    await record(a, "usage-a.test");
    await record(c, "usage-c.test", { forced: true });
    const env = hosted({ MAX_SESSIONS_PER_SITE_PER_DAY: "5" });
    const u = await usage(key, env);
    const s = u.limits.sessions_per_site_per_day;
    // used = the busiest site's; forced (?afsr=1) sessions have their own quota
    expect(s).toMatchObject({ used: 2, limit: 5, remaining: 3, drops_data: true });
    expect(s.per).toEqual([
      { id: b, label: "usage-b.test", used: 2, remaining: 3 },
      { id: a, label: "usage-a.test", used: 1, remaining: 4 },
      { id: c, label: "usage-c.test", used: 0, remaining: 5 },
    ]);
    expect(u.limits.forced_sessions_per_site_per_day).toMatchObject({ used: 1, limit: 20, remaining: 19 });
    expect(u.limits.forced_sessions_per_site_per_day.drops_data).toBeUndefined();
    expect(u.limits.forced_sessions_per_site_per_day.per[0]).toMatchObject({ id: c, used: 1 });
    // the account's daily totals: every session, chunk and byte across sites (no cap set here)
    expect(u.limits.sessions_per_day).toMatchObject({ used: 4, limit: null, remaining: null, drops_data: true });
    expect(u.limits.chunks_per_day.used).toBe(4);
    expect(u.limits.daily_recorded_bytes.used).toBeGreaterThan(0);
    expect(u.limits.derived_per_day.used).toBeGreaterThanOrEqual(0);

    // a share link is counted on its site
    const sid = newSid();
    const T = Date.now() - 30_000;
    await sendChunk(a, sid, 0, [meta(T, "https://usage-a.test/"), snapshot(T + 1), page(T + 5, 1, "/", { h: "usage-a.test" })], {
      origin: "https://usage-a.test",
    });
    expect((await call("POST", `/v1/sites/${a}/links`, { key, body: { session_id: sid } })).status).toBe(201);
    const after = await usage(key);
    expect(after.limits.share_links_per_site).toMatchObject({ used: 1, limit: null });
    expect(after.limits.share_links_per_site.per[0]).toEqual({ id: a, label: "usage-a.test", used: 1, remaining: null });
    expect(after.limits.sessions_per_site_per_day.per.map((p: any) => [p.id, p.used])).toEqual([
      [a, 2],
      [b, 2],
      [c, 0],
    ]);
  });

  it("unverified sites are under the trial quota; verified ones under the site cap", async () => {
    const { key, site: v } = await newSite("usage-v.test");
    const t = await addSite(key, "usage-trial.test", false);
    await record(t, "usage-trial.test");
    const u = await usage(key);
    expect(u.limits.unverified_sites).toMatchObject({ used: 1, limit: 1, remaining: 0 });
    expect(u.limits.unverified_sessions_per_site_per_day).toMatchObject({ used: 1, limit: 20, remaining: 19, drops_data: true });
    expect(u.limits.unverified_sessions_per_site_per_day.per).toEqual([{ id: t, label: "usage-trial.test", used: 1, remaining: 19 }]);
    expect(u.limits.sessions_per_site_per_day.per.map((p: any) => p.id)).toEqual([v]);
    expect(u.next_steps.join(" ")).toContain(`${t}`);
  });

  it("the account's daily budgets add what D1 holds (deleted sites included) to what sites haven't reported", async () => {
    const { key, account, site } = await newSite("usage-budget.test");
    // as if another site (since deleted) had reported 7 sessions today
    await E.DB.prepare(
      "INSERT INTO account_usage (account_id, day, sessions, chunks, bytes, derived, updated_at) VALUES (?, ?, 7, 9, 1000, 3, ?)",
    )
      .bind(account, today(), Date.now())
      .run();
    await record(site, "usage-budget.test");
    const env = hosted({ MAX_SESSIONS_PER_ACCOUNT_PER_DAY: "10", MAX_BYTES_PER_ACCOUNT_PER_DAY: "1000000" });
    const u = await usage(key, env);
    expect(u.limits.sessions_per_day).toMatchObject({ used: 8, limit: 10, remaining: 2, drops_data: true });
    expect(u.limits.chunks_per_day.used).toBe(10);
    expect(u.limits.daily_recorded_bytes.used).toBeGreaterThan(1000);
    expect(u.limits.daily_recorded_bytes.limit).toBe(1_000_000);
    // the site's own counter alone is what's listed per site
    expect(u.limits.sessions_per_site_per_day.per[0]).toMatchObject({ id: site, used: 1 });
  });

  it("UNCLAIMED_ values apply until a person claims the account; per-site D1 counters and heatmap images", async () => {
    const { key, account, site } = await newSite("usage-claim.test");
    const env = hosted({
      MAX_SITES_PER_ACCOUNT: "10",
      UNCLAIMED_MAX_SITES_PER_ACCOUNT: "3",
      UNCLAIMED_MAX_SEGMENTS_PER_SITE: "4",
    } as Partial<Bindings>);
    let u = await usage(key, env);
    expect(u.claimed).toBe(false);
    expect(u.limits.sites).toMatchObject({ used: 1, limit: 3, remaining: 2 });
    expect(u.limits.segments_per_site.limit).toBe(4);
    expect(
      (await call("POST", `/v1/sites/${site}/segments`, { key, body: { name: "Mobile", filters: { device: "mobile" } } })).status,
    ).toBe(201);
    await E.DB.prepare("INSERT INTO heatmap_image_usage (scope, day, images, browser_ms) VALUES (?, ?, 2, 0), (?, ?, 2, 0)")
      .bind(site, today(), account, today())
      .run();
    u = await usage(key, hosted({ ...env, BROWSER: {} as BrowserRun }));
    expect(u.limits.segments_per_site).toMatchObject({ used: 1, limit: 4, remaining: 3 });
    expect(u.limits.segments_per_site.per).toEqual([{ id: site, label: "usage-claim.test", used: 1, remaining: 3 }]);
    expect(u.limits.heatmap_images_per_day).toMatchObject({ used: 2, limit: 30 });
    expect(u.limits.heatmap_images_per_site_per_day).toMatchObject({ used: 2, limit: 10 });
    expect(u.limits.heatmap_images_per_site_per_day.drops_data).toBeUndefined();
    // without Browser Rendering the feature is off here: limit 0 and a note
    const off = await usage(key, hosted({ ...env, BROWSER: undefined }));
    expect(off.limits.heatmap_images_per_day).toMatchObject({ limit: 0 });
    expect(off.limits.heatmap_images_per_day.note).toContain("Browser Rendering");

    // a person claims the project: the claimed values apply
    const users = E.AUTH_DB!;
    const user = `usr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await users.batch([
      users
        .prepare("INSERT INTO users (id, google_sub, email, created_at) VALUES (?, ?, ?, ?)")
        .bind(user, `google-${user}`, "owner@usage-claim.test", Date.now()),
      users
        .prepare("INSERT INTO memberships (user_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)")
        .bind(user, account, Date.now()),
    ]);
    forgetStanding(account);
    u = await usage(key, env);
    expect(u.claimed).toBe(true);
    expect(u.limits.sites).toMatchObject({ used: 1, limit: 10 });
    expect(u.limits.segments_per_site.limit).toBe(50);
    expect(u.next_steps.join(" ")).not.toContain("claim");
  });

  it("works with a read key, over MCP get_usage, and for the platform site's internal calls", async () => {
    const { key, account, site } = await newSite("usage-read.test");
    await record(site, "usage-read.test");
    const ro = (await call("POST", "/v1/keys", { key, body: { scope: "read" } })).json.api_key;
    const r = await usage(ro);
    expect(r.limits.sessions_per_site_per_day.per[0]).toMatchObject({ id: site, used: 1 });
    const t = await tool(ro, "get_usage", {});
    expect(t.isError).toBe(false);
    expect(t.data.limits.sessions_per_day.used).toBe(1);
    expect(t.data.limits.sessions_per_site_per_day).toMatchObject({ label: "Recorded sessions a day on one site", drops_data: true });
    const i = await internalUsage(account, hosted({ INTERNAL_TOKEN: TOKEN }));
    expect(i.status).toBe(200);
    expect(i.json.limits.sessions_per_site_per_day.per[0]).toMatchObject({ id: site, label: "usage-read.test", used: 1 });
    // other accounts see their own numbers only
    const other = await signup();
    const o = await usage(other.key);
    expect(o.limits.sites.used).toBe(0);
    expect(o.limits.sessions_per_day.used).toBe(0);
    expect(o.limits.sessions_per_site_per_day.per).toEqual([]);
  });
});
