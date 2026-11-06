import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GTM_EXPORT } from "../fixtures/gtm-export";

const B = "https://tags.test";

async function json(res: Response) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

/** One account for the whole file (signup is rate limited). */
let shared: Promise<{ api: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }> }> | null = null;
function account() {
  shared ??= (async () => {
    const s = await json(await SELF.fetch(`${B}/v1/signup`, { method: "POST" }));
    const H = { authorization: `Bearer ${s.api_key}`, "content-type": "application/json" };
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await SELF.fetch(`${B}${path}`, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: await json(res) };
    };
    return { api };
  })();
  return shared;
}

async function container(domain: string) {
  const a = await account();
  const C = (await a.api("POST", "/v1/containers", { domain })).body.container.id as string;
  return { ...a, C };
}

const base = {
  triggers: [{ id: "all_pages", type: "page_view" }],
  tags: [{ id: "ga4", type: "ga4", params: { measurement_id: "G-ABC123XYZ" }, triggers: ["all_pages"] }],
};

describe("item-level draft edits", () => {
  it("upserts, reads, removes and reverts one item; identical upserts and repeated removes are no-ops", async () => {
    const { api, C } = await container("items.test");
    expect((await api("PUT", `/v1/containers/${C}/draft`, base)).status).toBe(200);
    expect((await api("POST", `/v1/containers/${C}/publish`, {})).status).toBe(201);

    const meta = { type: "meta_pixel", params: { pixel_id: "1234567890123456" }, triggers: ["all_pages"] };
    const up = await api("PUT", `/v1/containers/${C}/draft/tags/meta`, meta);
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ kind: "tags", key: "meta", created: true, unchanged: false, item: { id: "meta", ...meta } });
    expect(up.body.changes_vs_live).toMatchObject({ identical: false, counts: { added: 1, removed: 0, changed: 0 } });
    const rev = up.body.revision as number;

    const again = await api("PUT", `/v1/containers/${C}/draft/tags/meta`, meta);
    expect(again.body).toMatchObject({ created: false, unchanged: true, revision: rev });

    const got = await api("GET", `/v1/containers/${C}/draft/tags/meta`);
    expect(got.body).toMatchObject({ item: { id: "meta" }, in_live: false });

    // Validation errors point at the item.
    const bad = await api("PUT", `/v1/containers/${C}/draft/tags/meta`, { ...meta, params: { pixel_id: "abc" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe("tags.meta.params.pixel_id");
    const mismatch = await api("PUT", `/v1/containers/${C}/draft/tags/meta`, { ...meta, id: "other" });
    expect(mismatch.status).toBe(400);
    expect((await api("PUT", `/v1/containers/${C}/draft/widgets/x`, {})).body.error.hint).toContain("tags, triggers");

    // Changing ga4 in the draft, then reverting it to live.
    const changed = await api("PUT", `/v1/containers/${C}/draft/tags/ga4`, { ...base.tags[0], params: { measurement_id: "G-NEW123XYZ" } });
    expect(changed.body.created).toBe(false);
    const diff = await api("GET", `/v1/containers/${C}/diff`);
    expect(diff.body.summary).toBe("1 tag added (meta), 1 tag changed (ga4).");
    expect(diff.body.changes.find((c: { key: string }) => c.key === "ga4").paths).toEqual([
      { path: "params.measurement_id", from: "G-ABC123XYZ", to: "G-NEW123XYZ" },
    ]);
    const reverted = await api("POST", `/v1/containers/${C}/draft/tags/ga4/revert`);
    expect(reverted.body).toMatchObject({ reverted: "restored", item: { params: { measurement_id: "G-ABC123XYZ" } } });
    expect((await api("POST", `/v1/containers/${C}/draft/tags/meta/revert`)).body.reverted).toBe("removed");
    expect((await api("POST", `/v1/containers/${C}/draft/tags/meta/revert`)).body.reverted).toBe("unchanged");

    const draft = await api("GET", `/v1/containers/${C}/draft`);
    expect(draft.body.changes_vs_live).toMatchObject({ identical: true, summary: "No changes." });

    // Remove: dangling references show in validation; removing again is safe.
    const rm = await api("DELETE", `/v1/containers/${C}/draft/triggers/all_pages`);
    expect(rm.body.removed).toBe(true);
    expect(rm.body.validation.errors.map((e: { code: string }) => e.code)).toContain("undefined_trigger");
    const rm2 = await api("DELETE", `/v1/containers/${C}/draft/triggers/all_pages`);
    expect(rm2.body).toMatchObject({ removed: false, revision: rm.body.revision });
  });

  it("a stale revision is a 409; without one, concurrent edits to different items both land", async () => {
    const { api, C } = await container("race.test");
    const put = await api("PUT", `/v1/containers/${C}/draft`, base);
    const stale = put.body.revision as number;
    await api("PUT", `/v1/containers/${C}/draft/triggers/t1`, { type: "dom_ready" });
    const conflict = await api("PUT", `/v1/containers/${C}/draft/triggers/t2?revision=${stale}`, { type: "dom_ready" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("revision_conflict");

    const puts = await Promise.all(
      ["a", "b", "c", "d"].map((k) => api("PUT", `/v1/containers/${C}/draft/triggers/${k}`, { type: "timer", interval_ms: 1000 })),
    );
    for (const r of puts) expect(r.status).toBeLessThan(300);
    const ids = (await api("GET", `/v1/containers/${C}/draft`)).body.config.triggers.map((t: { id: string }) => t.id);
    expect(ids).toEqual(expect.arrayContaining(["all_pages", "t1", "a", "b", "c", "d"]));
  });

  it("diff between versions and the draft", async () => {
    const { api, C } = await container("diff.test");
    await api("PUT", `/v1/containers/${C}/draft`, base);
    await api("POST", `/v1/containers/${C}/publish`, {});
    await api("PUT", `/v1/containers/${C}/draft/triggers/thanks`, { type: "page_view" });
    await api("PUT", `/v1/containers/${C}/draft/tags/ga4`, { ...base.tags[0], triggers: ["thanks"] });
    await api("POST", `/v1/containers/${C}/publish`, {});
    const d = await api("GET", `/v1/containers/${C}/diff?from=1&to=2`);
    expect(d.body.from).toEqual({ ref: 1, version: 1 });
    expect(d.body.summary).toBe("1 tag changed (ga4), 1 trigger added (thanks).");
    expect((await api("GET", `/v1/containers/${C}/diff?from=2&to=draft`)).body.identical).toBe(true);
    expect((await api("GET", `/v1/containers/${C}/diff?from=9`)).status).toBe(404);
    expect((await api("GET", `/v1/containers/${C}/diff?to=latest`)).status).toBe(400);
  });
});

describe("import", () => {
  it("GTM export: dry run, then save; re-running is a no-op; reports mapped/adapted/unmapped", async () => {
    const { api, C } = await container("import.test");
    await api("PUT", `/v1/containers/${C}/draft`, base);
    const dry = await api("POST", `/v1/containers/${C}/draft/import`, { format: "gtm", data: GTM_EXPORT, dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dry_run: true, written: false, format: "gtm", mode: "merge" });
    expect(dry.body.report.totals.unmapped).toBeGreaterThan(0);
    expect(dry.body.config.tags.length).toBeGreaterThan(5);
    expect((await api("GET", `/v1/containers/${C}/draft`)).body.config.tags).toHaveLength(1); // nothing saved

    const saved = await api("POST", `/v1/containers/${C}/draft/import`, { data: GTM_EXPORT });
    expect(saved.body).toMatchObject({ written: true, format: "gtm" });
    expect(saved.body.counts.tags.added).toEqual(expect.arrayContaining(["google_tag", "ga4_purchase"]));
    expect(saved.body.summary).toMatch(/tags added/);
    // The custom HTML tag is kept and gated at publish (unclaimed account here), not dropped.
    expect(saved.body.validation.errors.map((e: { code: string }) => e.code)).toContain("custom_code_not_allowed");
    const again = await api("POST", `/v1/containers/${C}/draft/import`, { data: GTM_EXPORT });
    expect(again.body).toMatchObject({ written: false, revision: saved.body.revision });
  });

  it("own JSON merge with rename; invalid and oversized imports are refused", async () => {
    const { api, C } = await container("import2.test");
    await api("PUT", `/v1/containers/${C}/draft`, base);
    const r = await api("POST", `/v1/containers/${C}/draft/import`, {
      config: { tags: [{ id: "ga4", type: "ga4", params: { measurement_id: "G-OTHER123" }, triggers: ["all_pages"] }] },
      on_conflict: "rename",
    });
    expect(r.body.counts.tags.renamed).toEqual([{ from: "ga4", to: "ga4_2" }]);
    expect((await api("POST", `/v1/containers/${C}/draft/import`, { config: { tags: [{ id: "x" }] } })).body.error.code).toBe(
      "invalid_config",
    );
    expect((await api("POST", `/v1/containers/${C}/draft/import`, { format: "gtm", data: { tag: 5 } })).body.error.code).toBe(
      "invalid_import",
    );
    const big = await api("POST", `/v1/containers/${C}/draft/import`, { format: "gtm", data: { pad: "x".repeat(2_200_000) } });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("import_too_large");
  });
});

const granted = { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" };
const hit = (C: string, domain: string, body: object) =>
  SELF.fetch(`${B}/collect`, {
    method: "POST",
    headers: { origin: `https://${domain}`, "user-agent": "Mozilla/5.0 Chrome/130" },
    body: JSON.stringify({ container_id: C, consent: granted, page_url: `https://${domain}/pricing?x=1`, ...body }),
  });

describe("preview log", () => {
  it("a preview build's debug entries are stored per token and read back as untrusted data", async () => {
    const { api, C } = await container("plog.test");
    await api("PUT", `/v1/containers/${C}/draft`, base);
    const p = await api("POST", `/v1/containers/${C}/preview`, {});
    expect(p.body.log_url).toContain(`/preview/${p.body.token}/log`);
    const entry = {
      ts: 1,
      event: "page_view",
      page: "/pricing",
      triggers: [{ id: "all_pages", matched: true }],
      tags: [{ id: "ga4", type: "ga4", status: "fired" }],
      conversions: [],
    };
    expect((await hit(C, "plog.test", { type: "debug", preview: p.body.token, entries: [entry, entry] })).status).toBe(200);
    // Without a valid preview token, debug entries are refused.
    expect((await hit(C, "plog.test", { type: "debug", entries: [entry] })).status).toBe(403);
    expect((await hit(C, "plog.test", { type: "debug", preview: "prv_aaaaaaaaaaaaaaaaaaaaaaaa", entries: [entry] })).status).toBe(403);
    const log = await api("GET", `/v1/containers/${C}/preview/${p.body.token}/log`);
    expect(log.body.count).toBe(2);
    expect(log.body.untrusted.events[0]).toMatchObject({ event: "page_view", tags: [{ id: "ga4", status: "fired" }] });
    expect((await api("GET", `/v1/containers/${C}/preview/prv_bbbbbbbbbbbbbbbbbbbbbbbb/log`)).status).toBe(404);
  });

  it("an expired or invalid preview link loads the live container and keeps the tab test traffic", async () => {
    const { api, C } = await container("plog-expired.test");
    await api("PUT", `/v1/containers/${C}/draft`, base);
    await api("POST", `/v1/containers/${C}/publish`, {});
    const js = await (await SELF.fetch(`${B}/c/${C}.js?preview=prv_cccccccccccccccccccccccc`)).text();
    expect(js).toContain(`sessionStorage.removeItem("_afst_preview_${C}")`);
    expect(js).toContain(`sessionStorage.setItem("afsa_debug","1")`);
    expect(js).toContain("loading the live container as test traffic");
    // Its hits, which still carry the dead token, are test traffic: logged as test, never stored as a visitor.
    const r = await json(
      await hit(C, "plog-expired.test", { type: "visit", preview: "prv_cccccccccccccccccccccccc", visitor_id: "vis_expired_1" }),
    );
    expect(r).toMatchObject({ ok: true, test: true });
    expect((await api("GET", `/v1/containers/${C}/visitors/vis_expired_1`)).status).toBe(404);
  });
});

describe("versions, environments and previews of a version", () => {
  it("saves a version without publishing, publishes it later, pins an environment, previews a version", async () => {
    const { api, C } = await container("envs.test");
    await api("PUT", `/v1/containers/${C}/draft`, base);
    const v1 = await api("POST", `/v1/containers/${C}/versions`, { note: "first" });
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({ version: 1, existing: false, live: false });
    expect((await api("POST", `/v1/containers/${C}/versions`, {})).body).toMatchObject({ version: 1, existing: true });
    expect((await api("GET", `/v1/containers/${C}`)).body.container.live_version).toBeNull();

    const env = await api("POST", `/v1/containers/${C}/environments`, { name: "staging", version: 1 });
    expect(env.status).toBe(201);
    const e = env.body.environment;
    expect(e).toMatchObject({ name: "staging", version: 1 });
    expect((await api("POST", `/v1/containers/${C}/environments`, { name: "staging", version: 1 })).body.existing).toBe(true);
    expect((await api("POST", `/v1/containers/${C}/environments`, { name: "live", version: 1 })).status).toBe(400);
    expect((await api("POST", `/v1/containers/${C}/environments`, { name: "qa", version: 99 })).status).toBe(404);

    // The environment snippet serves version 1 while nothing is live.
    const js = await SELF.fetch(e.script_url.replace(/^https?:\/\/[^/]+/, B));
    const text = await js.text();
    expect(js.headers.get("x-afs-version")).toBe("1");
    expect(text).toContain("G-ABC123XYZ");
    expect(text).toContain('"env":{"name":"staging"');
    // A changed draft, published to the environment via a new version.
    await api("PUT", `/v1/containers/${C}/draft/tags/ga4`, { ...base.tags[0], params: { measurement_id: "G-STAGE1234" } });
    const v2 = await api("POST", `/v1/containers/${C}/versions`, {});
    expect((await api("PATCH", `/v1/containers/${C}/environments/${e.id}`, { version: v2.body.version })).body.environment.version).toBe(2);
    expect(await (await SELF.fetch(e.script_url.replace(/^https?:\/\/[^/]+/, B))).text()).toContain("G-STAGE1234");
    // Reauthorize: the old snippet falls back to live.
    const re = await api("POST", `/v1/containers/${C}/environments/${e.id}/reauthorize`);
    expect(re.body.environment.script_url).not.toBe(e.script_url);
    expect(await (await SELF.fetch(e.script_url.replace(/^https?:\/\/[^/]+/, B))).text()).toContain("token is invalid");

    // Publish the saved version 1; versions list shows which environment pins what.
    const pub = await api("POST", `/v1/containers/${C}/publish`, { version: 1 });
    expect(pub.body.version).toBe(1);
    const list = await api("GET", `/v1/containers/${C}/versions`);
    expect(list.body.versions.find((v: { version: number }) => v.version === 2).environments).toEqual(["staging"]);
    expect(list.body.live_version).toBe(1);

    // Preview an older version.
    const pv = await api("POST", `/v1/containers/${C}/preview`, { version: 2 });
    expect(pv.body.shows).toBe("version 2");
    const pjs = await (await SELF.fetch(`${B}/c/${C}.js?preview=${pv.body.token}`)).text();
    expect(pjs).toContain("G-STAGE1234");
    expect(pjs).toContain("v2 (preview)");
    expect((await api("DELETE", `/v1/containers/${C}/environments/${e.id}`)).body.deleted).toBe(e.id);
  });
});

describe("tag telemetry and coverage", () => {
  it("counts tag fires for the live config's tags only, and pages that sent hits", async () => {
    const { api, C } = await container("stats.test");
    await api("PUT", `/v1/containers/${C}/draft`, { ...base, settings: { report_tag_fires: true } });
    await api("POST", `/v1/containers/${C}/publish`, {});
    const fires = [
      { tag_id: "ga4", status: "fired", n: 3 },
      { tag_id: "ga4", status: "blocked", n: 1 },
      { tag_id: "made_up", status: "fired", n: 100 },
    ];
    expect((await hit(C, "stats.test", { type: "tags", fires })).status).toBe(200);
    expect((await hit(C, "stats.test", { type: "visit", visitor_id: "vis_stats_1" })).status).toBe(200);
    const st = await api("GET", `/v1/containers/${C}/tag-stats?since=1d`);
    expect(st.body.reporting).toBe(true);
    expect(st.body.tags).toEqual([expect.objectContaining({ tag_id: "ga4", fired: 3, blocked: 1 })]);
    expect(JSON.stringify(st.body)).not.toContain("made_up");
    const cov = await api("GET", `/v1/containers/${C}/coverage`);
    expect(cov.body.untrusted.pages).toEqual([expect.objectContaining({ host: "stats.test", path: "/pricing", hits: 2 })]);
  });

  it("a pixel that would have fired on test traffic counts as test_skipped and isn't listed in never_fired", async () => {
    const { api, C } = await container("stats-test.test");
    await api("PUT", `/v1/containers/${C}/draft`, {
      triggers: base.triggers,
      tags: [
        ...base.tags,
        { id: "meta", type: "meta_pixel", params: { pixel_id: "1234567890123456" }, triggers: ["all_pages"] },
        { id: "quiet", type: "tiktok_pixel", params: { pixel_id: "C1A2B3C4D5E6F7G8H9I0" }, triggers: ["all_pages"] },
      ],
      settings: { report_tag_fires: true },
    });
    expect((await api("POST", `/v1/containers/${C}/publish`, {})).status).toBe(201);
    // What a tab with ?afsa_debug=1 sends: the pixels as test_skipped, test: 1.
    const fires = [
      { tag_id: "ga4", status: "test_skipped", n: 2 },
      { tag_id: "meta", status: "test_skipped", n: 2 },
    ];
    const r = await hit(C, "stats-test.test", { type: "tags", fires, test: 1, page_url: "https://stats-test.test/?afsa_debug=1" });
    expect(r.status).toBe(200);
    expect((await json(r)).test).toBe(true);
    const st = await api("GET", `/v1/containers/${C}/tag-stats?since=1d`);
    const by = Object.fromEntries((st.body.tags as { tag_id: string }[]).map((t) => [t.tag_id, t]));
    expect(by.meta).toMatchObject({ fired: 0, test_skipped: 2 });
    expect(by.ga4).toMatchObject({ fired: 0, test_skipped: 2 });
    expect(st.body.never_fired).toEqual(["quiet"]);
    expect(st.body.note).toContain("test_skipped");
  });
});

describe("lookups and destination transformations", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lookup CRUD with caps; a webhook test applies settings.params (lookup) and the body template", async () => {
    const { api, C } = await container("lookups.test");
    const put = await api("PUT", `/v1/containers/${C}/lookups/sku_margin`, { rows: { "SKU-1": 12.5, "SKU-2": 4 } });
    expect(put.status).toBe(201);
    expect((await api("PUT", `/v1/containers/${C}/lookups/sku_margin`, { rows: { "SKU-1": 12.5, "SKU-2": 4 } })).body.lookup).toMatchObject(
      { existing: true, updated: false },
    );
    expect((await api("GET", `/v1/containers/${C}/lookups`)).body.lookups).toEqual([
      expect.objectContaining({ name: "sku_margin", rows: 2 }),
    ]);
    expect((await api("GET", `/v1/containers/${C}/lookups/sku_margin`)).body.rows).toEqual({ "SKU-1": 12.5, "SKU-2": 4 });
    expect((await api("PUT", `/v1/containers/${C}/lookups/bad name`, { rows: {} })).status).toBe(400);

    const sent: { body: string; method?: string }[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://hooks.test/")) {
        sent.push({ body: String(init?.body), method: init?.method });
        return new Response("{}", { status: 200 });
      }
      return realFetch(input, init);
    });
    const d = await api("POST", `/v1/containers/${C}/destinations`, {
      type: "webhook",
      credentials: { url: "https://hooks.test/lookups", secret: "integration-secret-123" },
      settings: {
        params: { set: { margin: { lookup: "sku_margin", key: "params.sku", default: 0 } }, redact_query: true },
        template: { method: "PUT", body: { id: "{{event.event_id}}", margin: "{{event.params.margin}}", page: "{{event.page_url}}" } },
      },
    });
    expect(d.status).toBe(201);
    // Templates are webhook-only.
    const bad = await api("POST", `/v1/containers/${C}/destinations`, {
      type: "ga4",
      credentials: { measurement_id: "G-ABC123XYZ", api_secret: "secretsecret" },
      settings: { template: { body: {} } },
    });
    expect(bad.status).toBe(400);
    const t = await api("POST", `/v1/containers/${C}/destinations/${d.body.destination.id}/test`, {});
    expect(t.body.result.ok).toBe(true);
    expect(sent[0]!.method).toBe("PUT");
    const body = JSON.parse(sent[0]!.body);
    expect(body.margin).toBe(0); // the sample event has no sku: the lookup's default
    expect(body.page).toBe("https://lookups.test/");
    expect((await api("DELETE", `/v1/containers/${C}/lookups/sku_margin`)).body).toMatchObject({ existed: true });
    expect((await api("DELETE", `/v1/containers/${C}/lookups/sku_margin`)).body).toMatchObject({ existed: false });
  });
});
