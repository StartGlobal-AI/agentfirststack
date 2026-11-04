import { describe, expect, it } from "vitest";
import type { DispatchEvent } from "../src/destinations/types";
import { signWebhook, webhook } from "../src/destinations/webhook";
import { destinationSettings } from "../src/service/destinations";
import { planDispatch } from "../src/service/dispatch-plan";
import { applyParamRules, renderTemplate, routingProblem } from "../src/service/transform";

const e = (over: Partial<DispatchEvent> = {}): DispatchEvent => ({
  event_id: "evt.1",
  name: "purchase",
  ts: 1,
  source: "browser",
  value: 50,
  currency: "USD",
  params: { sku: "S1", coupon: "SAVE", internal: "x" },
  items: [{ item_id: "S1", quantity: 2 }, { item_id: "S2" }, { item_id: "S9", quantity: 5 }],
  page_url: "https://shop.test/thanks?email=a@b.com#x",
  referrer: "https://google.com/search?q=secret",
  ip: "203.0.113.7",
  user_agent: "UA",
  geo: { country: "US", region_code: "CA" },
  click_ids: { gclid: "G" },
  user: { em: "abc" },
  consent: { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" },
  send_to: { meta: { event_name: "Purchase" } },
  ...over,
});

describe("routing conditions", () => {
  it("every condition must match; the reason names the field and value", () => {
    expect(
      routingProblem(e(), [
        { var: "country", op: "equals", value: "US" },
        { var: "value", op: "gte", value: 10 },
      ]),
    ).toBeNull();
    expect(routingProblem(e(), [{ var: "value", op: "gt", value: 100 }])).toBe('routing condition: value "50" fails gt 100');
    expect(routingProblem(e(), [{ var: "params.coupon", op: "not_equals", value: "SAVE" }])).toContain("params.coupon");
    const planned = planDispatch(e(), [
      { id: "d1", type: "meta", enabled: true, settings: { conditions: [{ var: "country", op: "equals", value: "GB" }] } },
    ]);
    expect(planned).toEqual([
      { destination_id: "d1", type: "meta", status: "skipped", reason: 'routing condition: country "US" fails equals "GB"' },
    ]);
  });
});

describe("parameter rules", () => {
  it("allow, exclude (custom and standard fields), set (literal, field, lookup) and redact_query", () => {
    const lookups = new Map([["margin", { S1: 10, S2: 3, X: "n/a" }]]);
    const out = applyParamRules(
      e(),
      {
        allow: ["sku", "coupon"],
        exclude: ["coupon", "ip", "user"],
        set: {
          value: { lookup: "margin", key: "items[].item_id" },
          channel: "web",
          order_country: { var: "country" },
          one: { lookup: "margin", key: "params.sku" },
          missing: { lookup: "nope", key: "params.sku", default: 0 },
        },
        redact_query: true,
      },
      lookups,
    );
    expect(out.params).toEqual({ sku: "S1", channel: "web", order_country: "US", one: 10, missing: 0 });
    expect(out.value).toBe(23); // 10 * 2 + 3 * 1; S9 isn't in the table
    expect(out.ip).toBeUndefined();
    expect(out.user).toEqual({});
    expect(out.page_url).toBe("https://shop.test/thanks");
    expect(out.referrer).toBe("https://google.com/search");
    expect(e().params).toEqual({ sku: "S1", coupon: "SAVE", internal: "x" }); // the input isn't changed
  });

  it("settings validation: fields, ops and webhook template headers", () => {
    expect(destinationSettings.safeParse({ conditions: [{ var: "country", op: "equals", value: "US" }] }).success).toBe(true);
    expect(destinationSettings.safeParse({ conditions: [{ var: "page_title", op: "equals", value: "x" }] }).success).toBe(false);
    expect(destinationSettings.safeParse({ conditions: [{ var: "value", op: "matches_css_selector", value: "x" }] }).success).toBe(false);
    expect(destinationSettings.safeParse({ template: { headers: { "x-shop": "1" } } }).success).toBe(true);
    for (const h of ["Authorization", "cookie", "Host", "x-signature", "x-forwarded-for", "content-type"])
      expect(destinationSettings.safeParse({ template: { headers: { [h]: "v" } } }).success, h).toBe(false);
    expect(destinationSettings.safeParse({ template: { headers: { "x-a": "a\r\nb" } } }).success).toBe(false);
  });
});

describe("webhook body templates", () => {
  it("renders {{event.*}} keeping types, sends method and static headers, and signs the rendered body", async () => {
    const body = {
      order: "{{event.transaction_id}}",
      amount: "{{event.value}}",
      label: "Order {{event.transaction_id}} for {{event.currency}}",
      items: "{{event.items}}",
      test: "{{test}}",
    };
    expect(renderTemplate(body, { event: e({ transaction_id: "T1" }), container_id: "c", destination_id: "d", test: false })).toEqual({
      order: "T1",
      amount: 50,
      label: "Order T1 for USD",
      items: e().items,
      test: false,
    });
    const calls: { url: string; init: RequestInit }[] = [];
    const r = await webhook.send(
      e({ transaction_id: "T1" }),
      { url: "https://hooks.example.net/x", secret: "s".repeat(20) },
      {
        test: false,
        env: {},
        destinationId: "dst_1",
        containerId: "ctr_1",
        settings: { template: { method: "PUT", headers: { "x-shop": "main" }, body: { order: "{{event.transaction_id}}" } } },
        fetch: (async (url: string, init: RequestInit) => {
          calls.push({ url, init });
          return new Response("{}", { status: 200 });
        }) as never,
      },
    );
    expect(r.ok).toBe(true);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.init.method).toBe("PUT");
    expect(calls[0]!.init.body).toBe('{"order":"T1"}');
    expect(h["x-shop"]).toBe("main");
    expect(h["x-signature"]).toBe(await signWebhook("s".repeat(20), Number(h["x-signature-timestamp"]), '{"order":"T1"}'));
  });
});
