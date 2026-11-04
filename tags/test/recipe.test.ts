import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate";
import { buildRecipe, deliveryGaps, recipeInput, withGaps } from "../src/service/recipe";

describe("setup_conversion_tracking recipe", () => {
  const input = recipeInput.parse({
    platforms: {
      ga4: { measurement_id: "G-ABC123XYZ", api_secret: "secret123" },
      meta: { pixel_id: "1234567890123456" },
      tiktok: { pixel_id: "C1A2B3C4D5E6F7G8H9I0", access_token: "x".repeat(32) },
      google_ads: { conversion_id: "AW-123456789", labels: { purchase: "AbCdEfGh" } },
    },
    conversions: [
      {
        name: "purchase",
        when: { data_layer_event: "purchase" },
        value: { data_layer: "ecommerce.value" },
        currency: "USD",
        transaction_id: { data_layer: "ecommerce.transaction_id" },
        email: { data_layer: "user.email" },
      },
      { name: "lead", when: { form_selector: "form#contact" }, email: { selector: "input[type=email]" } },
    ],
    phone_country_code: "1",
  });
  const r = buildRecipe(input, {});

  it("builds base tags, triggers, variables and conversions with standard event names", () => {
    expect(r.config.tags!.map((t) => t.id)).toEqual(["ga4", "google_ads", "meta", "tiktok"]);
    const purchase = r.config.conversions!.find((c) => c.name === "purchase")!;
    expect(purchase.send_to).toEqual({
      ga4: { event_name: "purchase" },
      meta: { event_name: "Purchase" },
      tiktok: { event_name: "CompletePayment" },
      google_ads: { send_to: "AW-123456789/AbCdEfGh" },
    });
    expect(purchase).toMatchObject({
      value: "purchase_value",
      currency: "USD",
      transaction_id: "purchase_order_id",
      user_data: { email: "purchase_email" },
      server: true,
    });
    const lead = r.config.conversions!.find((c) => c.name === "lead")!;
    expect(lead.send_to.meta).toEqual({ event_name: "Lead" });
    expect(lead.send_to.tiktok).toEqual({ event_name: "SubmitForm" });
    expect(r.config.triggers!.find((t) => t.id === "lead_trigger")).toEqual({
      id: "lead_trigger",
      type: "form_submit",
      selector: "form#contact",
    });
    expect(r.config.consent?.regions?.EEA?.ad_storage).toBe("denied");
    expect(r.config.settings?.phone_country_code).toBe("1");
  });
  it("plans destinations for platforms with credentials and lists what's missing", () => {
    expect(r.destinations.map((d) => d.type).sort()).toEqual(["ga4", "tiktok"]);
    const missing = r.missing.map((m) => `${m.platform}.${m.field}`);
    expect(missing).toEqual(expect.arrayContaining(["meta.access_token", "google_ads.server", "google_ads.labels"]));
    expect(r.missing.every((m) => m.where.length > 0)).toBe(true);
  });
  it("produces a config without errors", () => {
    const v = validateConfig(r.config, { destinations: r.destinations.map((d, i) => ({ id: `d${i}`, type: d.type, enabled: true })) });
    expect(v.errors).toEqual([]);
  });
  it("merges into an existing draft by id", () => {
    const again = buildRecipe(
      recipeInput.parse({
        platforms: { meta: { pixel_id: "9999999999999999" } },
        conversions: [{ name: "lead", when: { thank_you_path: "/thanks" } }],
      }),
      r.config,
    );
    expect(again.config.tags!.find((t) => t.id === "meta")!.params).toEqual({ pixel_id: "9999999999999999" });
    expect(again.config.tags!.some((t) => t.id === "ga4")).toBe(true);
    expect(again.config.conversions!.filter((c) => c.name === "lead")).toHaveLength(1);
    expect(again.config.triggers!.find((t) => t.id === "lead_trigger")!.type).toBe("page_view");
  });
});

describe("setup sets server: true only when a destination receives the conversion", () => {
  const conversions = [
    { name: "purchase", when: { data_layer_event: "purchase" }, value: 5, currency: "USD" },
    { name: "sign_up", when: { data_layer_event: "sign_up" } },
  ];
  const analyticsOnly = recipeInput.parse({ platforms: { analytics: { site_id: "site_abc123" } }, conversions, consent: "none" });
  const validate = (r: ReturnType<typeof buildRecipe>, types: string[]) =>
    validateConfig(r.config, { destinations: types.map((type, i) => ({ id: `d${i}`, type, enabled: true })) });

  it("analytics site_id with the ANALYTICS binding: a keyless destination and server: true, no delivery gaps", () => {
    const r = buildRecipe(analyticsOnly, {}, { analyticsBinding: true });
    expect(r.destinations).toEqual([
      { type: "analytics", name: "analytics app (service binding)", credentials: { site_id: "site_abc123" } },
    ]);
    expect(r.config.conversions!.map((c) => c.server)).toEqual([true, true]);
    expect(r.missing).toEqual([]);
    expect(deliveryGaps(validate(r, ["analytics"]), r.config)).toEqual([]);
  });
  it("without the binding or a key: server: false, the reason in notes, api_key in missing, no server_without_destination", () => {
    const r = buildRecipe(analyticsOnly, {}, { analyticsBinding: false });
    expect(r.destinations).toEqual([]);
    expect(r.config.conversions!.map((c) => c.server)).toEqual([false, false]);
    expect(r.notes.join(" ")).toMatch(/server: false on "purchase", "sign_up".*no ANALYTICS service binding/);
    expect(r.missing.map((m) => `${m.platform}.${m.field}`)).toEqual(["analytics.api_key"]);
    const v = validate(r, []);
    expect(v.warnings.map((w) => w.code)).not.toContain("server_without_destination");
    expect(deliveryGaps(v, r.config)).toEqual([]);
  });
  it("an api_key still plans a keyed destination; existing destinations count as receivers", () => {
    const keyed = buildRecipe(
      recipeInput.parse({ platforms: { analytics: { site_id: "site_abc123", api_key: "afs_xxxxxxxx" } }, conversions }),
      {},
    );
    expect(keyed.destinations[0]!.credentials).toEqual({ site_id: "site_abc123", api_key: "afs_xxxxxxxx" });
    const viaHook = buildRecipe(analyticsOnly, {}, { existingDestinations: ["webhook"] });
    expect(viaHook.config.conversions!.every((c) => c.server)).toBe(true);
    // A destination that couldn't be created doesn't count, and the note says so.
    const failed = buildRecipe(analyticsOnly, {}, { analyticsBinding: true, available: [], failed: ["analytics"] });
    expect(failed.config.conversions!.every((c) => c.server === false)).toBe(true);
    expect(failed.notes.join(" ")).toMatch(/analytics destination couldn't be created/);
  });
  it("an explicit server: true is kept and its gap is listed (setup then isn't ready)", () => {
    const r = buildRecipe(
      recipeInput.parse({
        platforms: { ga4: { measurement_id: "G-ABC123XYZ" }, meta: { pixel_id: "1234567890123456" } },
        conversions: [{ name: "purchase", when: { data_layer_event: "purchase" }, value: 5, currency: "USD", server: true }],
      }),
      {},
    );
    expect(r.config.conversions![0]!.server).toBe(true);
    const gaps = deliveryGaps(validate(r, []), r.config);
    expect(gaps.map((g) => `${g.platform}.${g.field}`).sort()).toEqual(["ga4.destination", "meta.destination", "server.destination"]);
    expect(gaps.every((g) => g.impact.includes('"purchase"') && g.where.length > 0)).toBe(true);
    // In missing[], a gap that a missing server credential already explains is said once.
    expect(withGaps(r.missing, gaps).map((m) => `${m.platform}.${m.field}`)).toEqual([
      "ga4.api_secret",
      "meta.access_token",
      "server.destination",
    ]);
  });
});
