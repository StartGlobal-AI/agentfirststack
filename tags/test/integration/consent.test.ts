import { createAccount } from "@afs/shared";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ContainerDO } from "../../src/do/container-do";
import type { Bindings } from "../../src/env";
import type { ConsentRecordPayload } from "../../src/service/ingest-schema";

/**
 * The consent banner end to end in workerd: config through the draft, the script served by
 * country (cache headers), the banner UI script, consent records through /collect (anonymous,
 * capped, test traffic left out) and the read endpoints over REST and MCP.
 */
const B = "https://tags.test";
const E = env as unknown as Bindings;

async function json(res: Response) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

/** A fresh account (createAccount: signup is rate limited even in tests) with one published container. */
async function setup(domain: string, draft: object) {
  const { accountId, apiKey } = await createAccount(E.AUTH_DB!, { keyPrefix: "afs" });
  const key = apiKey.key;
  const H = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  // biome-ignore lint/suspicious/noExplicitAny: test responses
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any; headers: Headers }> => {
    const res = await SELF.fetch(`${B}${path}`, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, headers: res.headers, body: await json(res) };
  };
  const C = (await api("POST", "/v1/containers", { domain })).body.container.id as string;
  const put = await api("PUT", `/v1/containers/${C}/draft`, draft);
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  return { api, C, key, accountId };
}

const metaDraft = {
  triggers: [{ id: "all_pages", type: "page_view" }],
  tags: [{ id: "meta", type: "meta_pixel", params: { pixel_id: "1234567890123456" }, triggers: ["all_pages"] }],
};

const script = (C: string, country?: string) => SELF.fetch(`${B}/c/${C}.js`, { headers: country ? { "x-dev-geo-country": country } : {} });

const record = (over: object = {}): ConsentRecordPayload => ({
  id: "k3j4h5g6f7d8s9a0q1w2",
  version: 1,
  analytics: true,
  ads: false,
  personalization: false,
  method: "custom",
  language: "de",
  ...over,
});
const consentHit = (domain: string, C: string, body: object, headers: Record<string, string> = {}) =>
  SELF.fetch(`${B}/collect`, {
    method: "POST",
    headers: { origin: `https://${domain}`, "user-agent": "Mozilla/5.0 Chrome/130", ...headers },
    body: JSON.stringify({ container_id: C, type: "consent", version: 1, page_url: `https://${domain}/`, ...body }),
  });

describe("consent banner", () => {
  it("validates the config with paths and hints, and warns about what makes a banner unlawful or ineffective", async () => {
    const t = await setup("consent-validate.test", metaDraft);
    const bad = await t.api("PATCH", `/v1/containers/${t.C}/draft`, {
      consent_banner: { enabled: true, regions: "eu", expiry_days: 400, colors: { accent: "blue" }, privacy_url: "http://x.test" },
    });
    expect(bad.status).toBe(400);
    const paths = (bad.body.error.details as { path: string; hint: string }[]).map((d) => d.path).sort();
    expect(paths).toEqual([
      "consent_banner.colors.accent",
      "consent_banner.expiry_days",
      "consent_banner.privacy_url",
      "consent_banner.regions",
    ]);
    expect(bad.body.error.details[0].hint).toContain("catalog.consent_banner");

    const ok = await t.api("PATCH", `/v1/containers/${t.C}/draft`, {
      consent_banner: { enabled: true, categories: ["analytics"], colors: { text: "#999999" } },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.validation.valid).toBe(true);
    const codes = (ok.body.validation.warnings as { code: string }[]).map((w) => w.code);
    expect(codes).toEqual(
      expect.arrayContaining(["consent_banner_no_privacy_url", "consent_banner_no_ads_category", "consent_banner_contrast"]),
    );
    // With a banner, "no consent configured" no longer applies.
    expect(codes).not.toContain("consent_not_configured");
    // The diff shows the new section.
    const diff = await t.api("GET", `/v1/containers/${t.C}/diff`);
    expect(diff.body.summary).toContain("consent_banner added");
  });

  it("serves the script by country: private cache only when it depends on the country; the UI script is separate and immutable", async () => {
    const t = await setup("consent-serve.test", metaDraft);
    expect((await t.api("POST", `/v1/containers/${t.C}/publish`, {})).status).toBe(201);
    // No banner, no consent regions: the same for everyone.
    let res = await script(t.C, "DE");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("x-afs-consent-banner")).toBeNull();
    expect(await res.text()).not.toContain('"ui":');

    expect(
      (await t.api("PATCH", `/v1/containers/${t.C}/draft`, { consent_banner: { enabled: true, privacy_url: "/privacy" } })).status,
    ).toBe(200);
    expect((await t.api("POST", `/v1/containers/${t.C}/publish`, {})).status).toBe(201);
    const de = await script(t.C, "DE");
    expect(de.headers.get("cache-control")).toBe("private, max-age=300");
    expect(de.headers.get("x-afs-consent-banner")).toBe("ask");
    const deText = await de.text();
    expect(deText).toContain('"country":"DE"');
    const ui = /"ui":"([a-z0-9]+)"/.exec(deText)?.[1];
    expect(ui).toMatch(/^[a-f0-9]{10}$/);
    const us = await script(t.C, "US");
    expect(us.headers.get("x-afs-consent-banner")).toBe("default");
    expect(us.headers.get("etag")).not.toBe(de.headers.get("etag"));
    expect((await script(t.C, "CH")).headers.get("x-afs-consent-banner")).toBe("ask");
    expect((await script(t.C, "XX")).headers.get("x-afs-consent-banner")).toBe("ask"); // unknown country: ask

    // The banner UI: immutable at its version, short-lived at any other.
    const cb = await SELF.fetch(`${B}/cb/${ui}.js`);
    expect(cb.status).toBe(200);
    expect(cb.headers.get("content-type")).toContain("javascript");
    expect(cb.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const uiText = await cb.text();
    expect(uiText).toContain("We value your privacy");
    expect(uiText).toContain("Reject all");
    expect((await SELF.fetch(`${B}/_t/cb/0.js`)).headers.get("cache-control")).toBe("public, max-age=300"); // first-party prefix too
    // The core script doesn't carry the UI.
    expect(deText).not.toContain("We value your privacy");

    // regions "all": the same answer everywhere, so shared caches may keep it again.
    expect((await t.api("PATCH", `/v1/containers/${t.C}/draft`, { consent_banner: { regions: "all" } })).status).toBe(200);
    expect((await t.api("POST", `/v1/containers/${t.C}/publish`, {})).status).toBe(201);
    res = await script(t.C, "US");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("x-afs-consent-banner")).toBe("ask");

    // Consent regions (without a banner) depend on the country too.
    expect(
      (
        await t.api("PATCH", `/v1/containers/${t.C}/draft`, {
          consent_banner: { enabled: false },
          consent: { mode: "none", regions: { EEA: { ad_storage: "denied" }, GB: { ad_storage: "denied" } } },
        })
      ).status,
    ).toBe(200);
    expect((await t.api("POST", `/v1/containers/${t.C}/publish`, {})).status).toBe(201);
    res = await script(t.C, "US");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(res.headers.get("x-afs-consent-banner")).toBeNull();
  });

  it("records each choice anonymously, leaves test traffic out, caps records per day, and reports rates and one visitor's history", async () => {
    const domain = "consent-records.test";
    const t = await setup(domain, { ...metaDraft, consent_banner: { enabled: true, privacy_url: "https://consent-records.test/privacy" } });
    let status = await t.api("GET", `/v1/containers/${t.C}/consent`);
    expect(status.body.status).toBe("draft_only");
    expect(status.body.next_steps[0]).toContain(`/v1/containers/${t.C}/publish`);
    expect((await t.api("POST", `/v1/containers/${t.C}/publish`, {})).status).toBe(201);

    // A choice from a real visitor in Germany.
    let res = await consentHit(
      domain,
      t.C,
      { consent_record: record(), visitor_id: "vis_should_not_be_kept" },
      { "x-dev-geo-country": "DE" },
    );
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, stored: true, consent_id: "k3j4h5g6f7d8s9a0q1w2" });
    // Two more: accept all, reject all (another visitor).
    expect(
      (
        await consentHit(domain, t.C, {
          consent_record: record({ analytics: true, ads: true, personalization: true, method: "accept_all" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await consentHit(domain, t.C, {
          consent_record: record({ id: "zzzzyyyyxxxxwwwwvvvv", analytics: false, method: "reject_all", language: undefined }),
        })
      ).status,
    ).toBe(200);

    // Test traffic (preview, ?afsa_debug=1, afst('test', true)) isn't recorded.
    res = await consentHit(domain, t.C, { consent_record: record({ id: "testtesttesttesttest" }), test: 1 });
    expect(await json(res)).toMatchObject({ ok: true, test: true, stored: false });
    res = await consentHit(domain, t.C, {
      consent_record: record({ id: "testtesttesttesttes2" }),
      page_url: `https://${domain}/?afsa_debug=1`,
    });
    expect(await json(res)).toMatchObject({ stored: false });
    // Another site can't write records; a malformed record is refused with a hint.
    res = await consentHit("evil.test", t.C, { consent_record: record({ id: "evilevilevilevilevil" }), page_url: "https://evil.test/" });
    expect(res.status).toBe(403);
    res = await consentHit(domain, t.C, { consent_record: { ...record(), method: "maybe" } });
    expect(res.status).toBe(400);
    res = await consentHit(domain, t.C, {});
    expect(res.status).toBe(400);
    expect((await json(res)).error.hint).toContain("consent banner");

    status = await t.api("GET", `/v1/containers/${t.C}/consent`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      status: "on",
      banner: { enabled: true, regions: "eea", categories: ["analytics", "ads", "personalization"], version: 1, expiry_days: 180 },
      totals: { records: 3, accept_all: 1, reject_all: 1, custom: 1 },
      rates: { accept_all: 0.333, reject_all: 0.333, custom: 0.333 },
      categories: { analytics: { granted: 2, rate: 0.667 }, ads: { granted: 1 }, personalization: { granted: 1 } },
      today: { records: 3, limit: null },
      retention_days: 365,
    });
    expect(status.body.by_day).toHaveLength(1);

    // One visitor's history, newest first, with nothing that identifies them.
    const one = await t.api("GET", `/v1/containers/${t.C}/consent/records?consent_id=k3j4h5g6f7d8s9a0q1w2`);
    expect(one.status).toBe(200);
    expect(one.body.records.map((r: { method: string }) => r.method)).toEqual(["accept_all", "custom"]);
    expect(one.body.records[1]).toEqual({
      consent_id: "k3j4h5g6f7d8s9a0q1w2",
      at: expect.any(Number),
      at_iso: expect.any(String),
      version: 1,
      method: "custom",
      choice: { necessary: true, analytics: true, ads: false, personalization: false },
      country: "DE",
      language: "de",
      container_version: 1,
    });
    expect(JSON.stringify(one.body)).not.toMatch(/vis_should_not_be_kept|Mozilla|203\.0\./);
    const none = await t.api("GET", `/v1/containers/${t.C}/consent/records?consent_id=nonexistentconsent01`);
    expect(none.body.records).toEqual([]);
    expect(none.body.next_steps[0]).toContain("No record for this consent id");
    expect((await t.api("GET", `/v1/containers/${t.C}/consent/records?consent_id=NOT-AN-ID`)).status).toBe(400);
    // Paging.
    const page = await t.api("GET", `/v1/containers/${t.C}/consent/records?limit=2`);
    expect(page.body.records).toHaveLength(2);
    const rest = await t.api("GET", `/v1/containers/${t.C}/consent/records?limit=2&before=${page.body.next_before}`);
    expect(rest.body.records).toHaveLength(1);
    expect(rest.body.next_before).toBeNull();

    // MAX_CONSENT_RECORDS_PER_CONTAINER_PER_DAY (UNCLAIMED_ for this agent-only account): past it, nothing more is kept.
    const capped = await runInDurableObject(E.CONTAINER.getByName(t.C), async (instance) => {
      const i = instance as unknown as { env: Bindings } & ContainerDO;
      const saved = i.env;
      i.env = {
        ...saved,
        MAX_CONSENT_RECORDS_PER_CONTAINER_PER_DAY: "100",
        UNCLAIMED_MAX_CONSENT_RECORDS_PER_CONTAINER_PER_DAY: "4",
      } as Bindings;
      try {
        const input = (id: string) => ({ record: record({ id }), host: domain, country: "FR", container_version: 1, at: Date.now() });
        return [await i.recordConsent(input("capcapcapcapcapcap01")), await i.recordConsent(input("capcapcapcapcapcap02"))];
      } finally {
        i.env = saved;
      }
    });
    expect(capped).toEqual([{ ok: true }, { ok: false, error: "consent_quota", limit: 4 }]);

    // MCP read tools return the same, with a read key.
    const read = await t.api("POST", "/v1/keys", { scope: "read" });
    expect(read.status).toBe(201);
    const mcp = async (method: string, params?: Record<string, unknown>) =>
      (
        await json(
          await SELF.fetch(`${B}/mcp`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${read.body.api_key}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
          }),
        )
      ).result;
    const tools = ((await mcp("tools/list")).tools as { name: string }[]).map((x) => x.name);
    expect(tools).toEqual(expect.arrayContaining(["get_consent", "list_consent_records"]));
    const got = JSON.parse((await mcp("tools/call", { name: "get_consent", arguments: { container_id: t.C } })).content[0].text);
    expect(got.totals.records).toBe(4);
    const hist = JSON.parse(
      (await mcp("tools/call", { name: "list_consent_records", arguments: { container_id: t.C, consent_id: "capcapcapcapcapcap01" } }))
        .content[0].text,
    );
    expect(hist.records).toHaveLength(1);
    expect(hist.records[0].country).toBe("FR");
  });

  it("an off banner says how to turn it on; the setup recipe can turn it on", async () => {
    const t = await setup("consent-off.test", metaDraft);
    const off = await t.api("GET", `/v1/containers/${t.C}/consent`);
    expect(off.body.status).toBe("off");
    expect(off.body.rates).toEqual({ accept_all: null, reject_all: null, custom: null });
    expect(off.body.next_steps[0]).toContain(
      `PATCH ${B}/v1/containers/${t.C}/draft {"consent_banner":{"enabled":true,"privacy_url":"https://consent-off.test/privacy"}}`,
    );
    const r = await t.api("POST", `/v1/containers/${t.C}/setup`, {
      platforms: { meta: { pixel_id: "1234567890123456" } },
      conversions: [{ name: "lead", when: { thank_you_path: "/thanks" } }],
      consent: "banner",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const draft = (await t.api("GET", `/v1/containers/${t.C}/draft`)).body.config;
    expect(draft.consent_banner).toEqual({ enabled: true });
    expect(draft.consent).toEqual({ mode: "none" });
  });
});
