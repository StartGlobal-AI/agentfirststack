import { createApiKey } from "@afs/shared";
import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { stripeSignatureHeader } from "../../src/lib/stripe";
import { runCron } from "../../src/service/cron";
import { expireStatusThrottle } from "../../src/service/payments";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const B = "http://analytics.test";
/** Obviously fake test credentials (not real key formats' entropy). */
const FAKE_RK = "rk_test_fakekeyfortests";
const FAKE_WHSEC = "whsec_test";

type Init = RequestInit & { key?: string; json?: unknown };
function request(path: string, init: Init = {}) {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return new Request(`${B}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}
async function parsed(res: Response) {
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}
const call = async (path: string, init: Init = {}) => parsed(await SELF.fetch(request(path, init)));
async function callWith(over: Record<string, unknown>, path: string, init: Init = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request(path, init), { ...env, ...over } as typeof env, ctx);
  await waitOnExecutionContext(ctx);
  return parsed(res);
}
const mcp = (key: string, method: string, params: unknown = {}) =>
  call("/mcp", {
    method: "POST",
    key,
    headers: { accept: "application/json, text/event-stream" },
    json: { jsonrpc: "2.0", id: 1, method, params },
  });
async function tool(key: string, name: string, args: Record<string, unknown>) {
  const r = await mcp(key, "tools/call", { name, arguments: args });
  return { isError: !!r.body.result.isError, data: JSON.parse(r.body.result.content[0].text) };
}
let accountKey: string | null = null;
async function newSite(domain: string, json: Record<string, unknown> = {}) {
  accountKey ??= (await call("/v1/signup", { method: "POST" })).body.api_key as string;
  const key = accountKey;
  const created = await call("/v1/sites", { method: "POST", key, json: { domain, ...json } });
  return { key, site: created.body.site.id as string, proxyKey: created.body.install.first_party_proxy.proxy_key as string, created };
}
const beacon = (proxyKey: string, payload: Record<string, unknown>, ip: string, headers: Record<string, string> = {}) =>
  call("/_a/e", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "user-agent": UA, "content-type": "text/plain", "x-forwarded-for": ip, "x-afs-proxy-key": proxyKey, ...headers },
  });
/** A service context for calling service functions directly (with an injected fetcher). */
async function ctxFor(key: string, over: Record<string, unknown> = {}) {
  const me = (await call("/v1/me", { key })).body;
  return {
    env: { ...env, ...over } as typeof env,
    accountId: me.account.id,
    auth: { accountId: me.account.id, keyId: "k", scopes: ["*"] } as any,
    baseUrl: B,
  };
}

/** A fake Stripe API: routes by method + path, records calls. */
function fakeStripe(routes: Record<string, (url: URL, body: URLSearchParams) => { status?: number; body: unknown }>) {
  const calls: {
    method: string;
    path: string;
    query: URLSearchParams;
    body: URLSearchParams;
    auth: string | null;
    version: string | null;
  }[] = [];
  const fetcher = async (u: string, init?: RequestInit) => {
    const url = new URL(u);
    const method = init?.method ?? "GET";
    const body = new URLSearchParams(String(init?.body ?? ""));
    const h = new Headers(init?.headers);
    calls.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      body,
      auth: h.get("authorization"),
      version: h.get("stripe-version"),
    });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ error: { message: `no route ${method} ${url.pathname}` } }), { status: 404 });
    const r = route(url, body);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { calls, fetcher };
}

const now = () => Math.floor(Date.now() / 1000);

describe("Stripe in one call", () => {
  it("creates the endpoint, seals key and secret, backfills (resumable, idempotent), webhook verifies, disconnect deletes the endpoint", async () => {
    const { key, site, proxyKey } = await newSite("stripe1.test");
    const vid = (await beacon(proxyKey, { s: site, u: "https://stripe1.test/pricing", r: "https://www.google.com/" }, "10.20.0.1")).body
      .v as string;
    const invoices = [
      {
        id: "in_3",
        object: "invoice",
        customer: "cus_a",
        currency: "usd",
        amount_paid: 3000,
        billing_reason: "subscription_cycle",
        livemode: false,
        created: now() - 86400,
        status_transitions: { paid_at: now() - 86400 },
      },
      {
        id: "in_2",
        object: "invoice",
        customer: "cus_a",
        currency: "usd",
        amount_paid: 3000,
        billing_reason: "subscription_create",
        livemode: false,
        created: now() - 3 * 86400,
        status_transitions: { paid_at: now() - 3 * 86400 },
      },
      {
        id: "in_1",
        object: "invoice",
        customer: "cus_b",
        currency: "usd",
        amount_paid: 0,
        billing_reason: "subscription_create",
        livemode: false,
        created: now() - 4 * 86400,
      },
    ];
    const stripe = fakeStripe({
      "POST /v1/webhook_endpoints": () => ({ body: { id: "we_test_1", secret: FAKE_WHSEC, url: `${B}/webhooks/stripe/${site}` } }),
      "GET /v1/webhook_endpoints/we_test_1": () => ({ body: { id: "we_test_1", url: `${B}/webhooks/stripe/${site}`, status: "enabled" } }),
      "DELETE /v1/webhook_endpoints/we_test_1": () => ({ body: { id: "we_test_1", deleted: true } }),
      "GET /v1/checkout/sessions": () => ({
        body: {
          has_more: false,
          data: [
            {
              id: "cs_1",
              object: "checkout.session",
              mode: "subscription",
              customer: "cus_a",
              metadata: { afs_visitor_id: vid },
              livemode: false,
              created: now() - 3 * 86400,
            },
          ],
        },
      }),
      "GET /v1/invoices": (url) => ({
        body: url.searchParams.get("starting_after")
          ? { has_more: false, data: invoices.slice(2) }
          : { has_more: true, data: invoices.slice(0, 2) },
      }),
      "GET /v1/charges": () => ({
        body: {
          has_more: false,
          data: [
            {
              id: "ch_1",
              object: "charge",
              invoice: "in_3",
              currency: "usd",
              amount_refunded: 1000,
              livemode: false,
              created: now() - 86400,
              refunds: { data: [{ created: now() - 3600 }] },
            },
          ],
        },
      }),
      "GET /v1/subscriptions": () => ({ body: { has_more: false, data: [] } }),
    });
    const { connectStripeWithKey } = await import("../../src/service/stripe-connect");
    const ctx = await ctxFor(key);
    // validation and permanent keys
    expect(
      (await call(`/v1/sites/${site}/integrations/stripe/connect`, { method: "POST", key, json: { restricted_key: "sk_test_nope" } }))
        .status,
    ).toBe(400);
    const me = (await call("/v1/me", { key })).body;
    const token = (await createApiKey(env.AUTH_DB ?? env.DB, me.account.id, { keyPrefix: "afs", expiresAt: Date.now() + 3_600_000 })).key;
    expect(
      (await call(`/v1/sites/${site}/integrations/stripe/connect`, { method: "POST", key: token, json: { restricted_key: FAKE_RK } })).body
        .error.code,
    ).toBe("temporary_credential");

    const res = await connectStripeWithKey(ctx, site, { restricted_key: FAKE_RK }, { fetcher: stripe.fetcher });
    expect(res).toMatchObject({
      connected: true,
      existing: false,
      webhook: { endpoint_id: "we_test_1", created: true, api_version: "2024-06-20" },
    });
    const create = stripe.calls.find((c) => c.method === "POST")!;
    expect(create.auth).toBe(`Bearer ${FAKE_RK}`);
    expect(create.version).toBe("2024-06-20");
    expect(create.body.get("url")).toBe(`${B}/webhooks/stripe/${site}`);
    expect(create.body.getAll("enabled_events[]")).toEqual(
      expect.arrayContaining(["invoice.paid", "charge.refunded", "customer.subscription.updated"]),
    );
    // two pages ran in the call: checkout sessions, then the first invoices page
    expect(res.backfill).toMatchObject({ status: "running", stage: "invoices", cursor: "in_2", linked: 1, imported: 2 });
    const sealed = await env.DB.prepare("SELECT api_key_sealed, secret_sealed FROM integrations WHERE site_id = ?").bind(site).first<any>();
    expect(sealed.api_key_sealed.startsWith("v1.")).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain(FAKE_RK);
    // the cron finishes it
    await env.DB.prepare("UPDATE integrations SET backfill = json_set(backfill, '$.paused_until', 0) WHERE site_id != ?").bind(site).run();
    await runCron(env, Date.now(), { fetcher: stripe.fetcher });
    const status = (await call(`/v1/sites/${site}/integrations/stripe`, { key })).body.integration;
    expect(status).toMatchObject({ connect_mode: "restricted_key", endpoint_id: "we_test_1", backfill: { status: "done", skipped: 1 } });
    const pays = (await call(`/v1/sites/${site}/payments?period=7d`, { key })).body.payments;
    expect(pays.map((p: any) => [p.type, p.amount]).sort()).toEqual([
      ["new", 30],
      ["refund", -10],
      ["renewal", 30],
    ]);
    const rev = (await call(`/v1/sites/${site}/breakdown?breakdown=channel&period=7d&metrics=revenue`, { key })).body.results;
    expect(rev).toEqual([{ value: "Organic Search", revenue: 50 }]); // linked through the checkout's visitor
    // again with the same key: nothing new, the endpoint is reused, no double counting
    const again = await connectStripeWithKey(ctx, site, { restricted_key: FAKE_RK }, { fetcher: stripe.fetcher });
    expect(again).toMatchObject({ existing: true, webhook: { created: false } });
    expect(stripe.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const { restartBackfill } = await import("../../src/service/stripe-connect");
    const re = await restartBackfill(ctx, site, { days: 30 }, { fetcher: stripe.fetcher });
    expect(re.backfill).toMatchObject({ existing: 2 });
    expect((await call(`/v1/sites/${site}/payments?period=7d`, { key })).body.payments).toHaveLength(3);
    // the endpoint's signing secret verifies webhooks
    expireStatusThrottle();
    const evt = JSON.stringify({
      id: "evt_t1",
      type: "invoice.paid",
      created: now(),
      livemode: false,
      data: { object: { id: "in_9", customer: "cus_a", currency: "usd", amount_paid: 3000, billing_reason: "subscription_cycle" } },
    });
    const hook = await call(`/webhooks/stripe/${site}`, {
      method: "POST",
      body: evt,
      headers: { "stripe-signature": await stripeSignatureHeader(evt, FAKE_WHSEC, now()) },
    });
    expect(hook.body.result).toMatchObject({ ok: true, linked_by: "customer" });
    // disconnect removes the endpoint we created
    const { disconnectStripe } = await import("../../src/service/payments");
    expect(await disconnectStripe(ctx, site, { fetcher: stripe.fetcher })).toMatchObject({
      disconnected: true,
      webhook_endpoint_deleted: true,
    });
  });

  it("a missing permission names it; the daily budget pauses the backfill until tomorrow", async () => {
    const { key, site } = await newSite("stripe2.test");
    const ctx = await ctxFor(key);
    const { connectStripeWithKey } = await import("../../src/service/stripe-connect");
    const denied = fakeStripe({
      "POST /v1/webhook_endpoints": () => ({
        status: 403,
        body: {
          error: {
            type: "invalid_request_error",
            message: "The provided key does not have the required permissions for this endpoint: rak_webhook_write.",
          },
        },
      }),
    });
    await expect(connectStripeWithKey(ctx, site, { restricted_key: FAKE_RK }, { fetcher: denied.fetcher })).rejects.toMatchObject({
      code: "stripe_permission_missing",
    });
    const inv = (id: string) => ({
      id,
      customer: "cus_x",
      currency: "usd",
      amount_paid: 500,
      billing_reason: "manual",
      livemode: false,
      created: now() - 60,
      status_transitions: { paid_at: now() - 60 },
    });
    const ok = fakeStripe({
      "POST /v1/webhook_endpoints": () => ({ body: { id: "we_test_2", secret: FAKE_WHSEC } }),
      "GET /v1/checkout/sessions": () => ({ body: { has_more: false, data: [] } }),
      "GET /v1/invoices": () => ({ body: { has_more: false, data: [inv("in_a"), inv("in_b"), inv("in_c")] } }),
    });
    const tight = await ctxFor(key, { MAX_EVENTS_PER_SITE_PER_DAY: "2" });
    const r = await connectStripeWithKey(tight, site, { restricted_key: FAKE_RK, record_test_events: true }, { fetcher: ok.fetcher });
    expect(r.backfill).toMatchObject({ status: "paused", imported: 2, stage: "invoices", cursor: "in_b" });
    expect(r.backfill!.paused_until).toBeGreaterThan(Date.now());
  });

  it("MCP lists the one-call tools", async () => {
    const { key } = await newSite("stripe3.test");
    const names = ((await mcp(key, "tools/list")).body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["connect_stripe_key", "backfill_stripe"]));
    expect((await tool(key, "backfill_stripe", { site_id: (await newSite("stripe4.test")).site })).isError).toBe(true);
  });
});

describe("subscriptions and MRR", () => {
  const D = 86400;
  const stripeSub = (over: Record<string, unknown> = {}) => ({
    id: "sub_1",
    object: "subscription",
    status: "active",
    currency: "usd",
    customer: "cus_s",
    livemode: false,
    start_date: now() - 200 * D,
    created: now() - 200 * D,
    items: {
      data: [
        {
          quantity: 1,
          price: {
            id: "price_m",
            nickname: "Pro",
            unit_amount: 4000,
            currency: "usd",
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
    metadata: {},
    ...over,
  });

  it("backfills every live subscription, then webhooks move MRR (stale deliveries ignored)", async () => {
    const { key, site, proxyKey } = await newSite("subs1.test");
    const vid = (await beacon(proxyKey, { s: site, u: "https://subs1.test/", r: "https://www.google.com/" }, "10.21.0.1")).body.v as string;
    const stripe = fakeStripe({
      "POST /v1/webhook_endpoints": () => ({ body: { id: "we_test_s", secret: FAKE_WHSEC } }),
      "GET /v1/checkout/sessions": () => ({ body: { has_more: false, data: [] } }),
      "GET /v1/invoices": () => ({ body: { has_more: false, data: [] } }),
      "GET /v1/charges": () => ({ body: { has_more: false, data: [] } }),
      "GET /v1/subscriptions": () => ({
        body: {
          has_more: false,
          data: [
            stripeSub({ id: "sub_new", start_date: now() - 2 * D, created: now() - 2 * D, metadata: { afs_visitor_id: vid } }),
            stripeSub({
              id: "sub_trial",
              status: "trialing",
              trial_start: now() - D,
              trial_end: now() + 13 * D,
              start_date: now() - D,
              created: now() - D,
            }),
            stripeSub({ id: "sub_old" }),
            stripeSub({ id: "sub_gone", status: "canceled", canceled_at: now() - 150 * D, ended_at: now() - 150 * D }),
          ],
        },
      }),
    });
    const { connectStripeWithKey } = await import("../../src/service/stripe-connect");
    const ctx = await ctxFor(key);
    await connectStripeWithKey(ctx, site, { restricted_key: FAKE_RK }, { fetcher: stripe.fetcher });
    await env.DB.prepare("UPDATE integrations SET backfill = json_set(backfill, '$.paused_until', 0) WHERE site_id != ?").bind(site).run();
    await runCron(env, Date.now() - 600_000, { fetcher: stripe.fetcher }); // the snapshot: 10 minutes ago
    const subsCall = stripe.calls.find((c) => c.path === "/v1/subscriptions")!;
    expect(subsCall.query.get("created[gte]")).toBeNull(); // an old active subscription is MRR today
    const status = (await call(`/v1/sites/${site}/integrations/stripe`, { key })).body.integration;
    expect(status.backfill).toMatchObject({ status: "done" });
    expect(status.subscription_events).toContain("customer.subscription.updated");
    const list = (await call(`/v1/sites/${site}/subscriptions`, { key })).body;
    expect(list.subscriptions.map((s: any) => s.external_id).sort()).toEqual(["sub_new", "sub_old", "sub_trial"]);
    const m = (await call(`/v1/sites/${site}/mrr?include_test=true&period=30d&breakdown=channel`, { key })).body;
    expect(m.current).toMatchObject({ mrr: 80, arr: 960, active_subscriptions: 2, trialing: 1, currency: "USD" });
    expect(m.totals).toMatchObject({ mrr_at_start: 40, new_mrr: 40, trials_started: 1 });
    expect(m.breakdown.results.find((r: any) => r.value === "Organic Search")).toMatchObject({ mrr: 40, new_mrr: 40 });
    // test-mode subscriptions stay out of MRR by default
    expect((await call(`/v1/sites/${site}/mrr`, { key })).body.current.mrr).toBe(0);

    // Webhooks after the backfill: an upgrade, then a late retry of an older state, then a
    // cancellation. An event older than the backfill's snapshot is stale too.
    expireStatusThrottle();
    const send = async (type: string, created: number, object: unknown) => {
      const body = JSON.stringify({ id: `evt_${type}_${created}`, type, created, livemode: false, data: { object } });
      return call(`/webhooks/stripe/${site}`, {
        method: "POST",
        body,
        headers: { "stripe-signature": await stripeSignatureHeader(body, FAKE_WHSEC, now()) },
      });
    };
    const before = await send("customer.subscription.updated", now() - 3600, stripeSub({ id: "sub_old", items: { data: [] } }));
    expect(before.body.result).toMatchObject({ stale: true });
    const seats = (q: number) => ({
      data: [{ quantity: q, price: { unit_amount: 4000, currency: "usd", recurring: { interval: "month" } } }],
    });
    const up = await send("customer.subscription.updated", now() - 60, stripeSub({ id: "sub_old", items: seats(3) }));
    expect(up.body.result).toMatchObject({ ok: true, changed: true, changes: ["expansion"] });
    const late = await send("customer.subscription.updated", now() - 120, stripeSub({ id: "sub_old", items: seats(1) }));
    expect(late.body.result).toMatchObject({ stale: true, changed: false });
    const gone = await send(
      "customer.subscription.deleted",
      now() - 30,
      stripeSub({ id: "sub_new", status: "canceled", canceled_at: now() - 30, ended_at: now() - 30 }),
    );
    expect(gone.body.result.changes).toEqual(["churn"]);
    const after = (await call(`/v1/sites/${site}/mrr?include_test=true&period=7d`, { key })).body;
    expect(after.current.mrr).toBe(120);
    expect(after.totals).toMatchObject({ expansion_mrr: 80, churned_mrr: 40 });
  });

  it("records states from any provider, validates them, and MCP exposes the tools", async () => {
    const { key, site } = await newSite("subs2.test");
    const bad = await call(`/v1/sites/${site}/subscriptions`, {
      method: "POST",
      key,
      json: { id: "s1", status: "active", currency: "USD" },
    });
    expect(bad.status).toBe(202);
    expect(bad.body.results[0]).toMatchObject({ ok: false, reason: "give amount (per interval) or mrr" });
    const t0 = Date.now() - 20 * 86_400_000;
    const ok = await call(`/v1/sites/${site}/subscriptions`, {
      method: "POST",
      key,
      json: {
        subscriptions: [
          {
            id: "s1",
            provider: "chargebee",
            status: "active",
            amount: 120,
            interval: "year",
            currency: "usd",
            started_at: t0,
            timestamp: t0,
            customer_id: "c1",
          },
          {
            id: "s2",
            provider: "chargebee",
            status: "active",
            amount: 10,
            quantity: 3,
            currency: "usd",
            started_at: new Date(t0).toISOString(),
            timestamp: t0,
          },
        ],
      },
    });
    expect(ok.body).toMatchObject({ accepted: 2, rejected: 0 });
    expect(ok.body.next_steps[0]).toContain("/mrr");
    const m = (await call(`/v1/sites/${site}/mrr?period=30d`, { key })).body;
    expect(m.current).toMatchObject({ mrr: 40, arr: 480, active_subscriptions: 2, paying_customers: 1 });
    // A pause is churn; resuming is reactivation.
    await call(`/v1/sites/${site}/subscriptions`, {
      method: "POST",
      key,
      json: {
        id: "s2",
        provider: "chargebee",
        status: "paused",
        amount: 10,
        quantity: 3,
        currency: "usd",
        timestamp: Date.now() - 86_400_000,
      },
    });
    const back = await call(`/v1/sites/${site}/subscriptions`, {
      method: "POST",
      key,
      json: { id: "s2", provider: "chargebee", status: "active", amount: 10, quantity: 3, currency: "usd" },
    });
    expect(back.body.results[0].changes).toEqual(["reactivation"]);
    const names = ((await mcp(key, "tools/list")).body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_mrr", "list_subscriptions", "record_subscriptions"]));
    const viaMcp = await tool(key, "get_mrr", { site_id: site, period: "30d" });
    expect(viaMcp.data.totals).toMatchObject({ new_mrr: 40, churned_mrr: 30, reactivation_mrr: 30 });
    // Each changing state counts against the daily budget.
    const tight = await callWith({ MAX_EVENTS_PER_SITE_PER_DAY: "0" }, `/v1/sites/${site}/subscriptions`, {
      method: "POST",
      key,
      json: { id: "s3", status: "active", mrr: 5, currency: "usd" },
    });
    expect(tight.status).toBe(429);
  });
});

describe("Polar, Paddle and LemonSqueezy webhooks", () => {
  /** Obviously fake secrets (32 bytes of 0x01 in base64; plain words). */
  const SECRETS = {
    polar: ["whsec", "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="].join("_"), // fake, built from parts for secret scanners
    paddle: "pdl_ntfset_test",
    lemonsqueezy: "lstest-lstest-lstest-1",
  } as const;
  const iso = (s: number) => new Date(s * 1000).toISOString();
  async function deliver(
    provider: keyof typeof SECRETS,
    site: string,
    payload: unknown,
    id = `msg_${Math.random().toString(36).slice(2)}`,
    extra: Record<string, string> = {},
  ) {
    const { billingSignatureHeaders } = await import("../../src/lib/billing");
    const body = JSON.stringify(payload);
    const headers = await billingSignatureHeaders(provider, body, SECRETS[provider], now(), id);
    return call(`/webhooks/${provider}/${site}`, {
      method: "POST",
      body,
      headers: { ...headers, ...extra, "content-type": "application/json" },
    });
  }

  it("connects each provider (sealed, idempotent, permanent keys only) and rejects bad signatures alike", async () => {
    const { key, site } = await newSite("billing1.test");
    const before = (await call(`/v1/sites/${site}/integrations/paddle`, { key })).body;
    expect(before.integration).toMatchObject({ connected: false, webhook_url: `${B}/webhooks/paddle/${site}` });
    expect(before.integration.events).toContain("transaction.completed");
    expect(
      (await call(`/v1/sites/${site}/integrations/polar`, { method: "POST", key, json: { webhook_secret: "nope_secret" } })).body.error
        .code,
    ).toBe("invalid_secret");
    for (const p of ["polar", "paddle", "lemonsqueezy"] as const) {
      const c = await call(`/v1/sites/${site}/integrations/${p}`, { method: "POST", key, json: { webhook_secret: SECRETS[p] } });
      expect(c.status).toBe(201);
      expect(JSON.stringify(c.body)).not.toContain(SECRETS[p]);
      const again = await call(`/v1/sites/${site}/integrations/${p}`, { method: "POST", key, json: { webhook_secret: SECRETS[p] } });
      expect([again.status, again.body.existing]).toEqual([200, true]);
    }
    const me = (await call("/v1/me", { key })).body;
    const token = (await createApiKey(env.AUTH_DB ?? env.DB, me.account.id, { keyPrefix: "afs", expiresAt: Date.now() + 3_600_000 })).key;
    expect(
      (await call(`/v1/sites/${site}/integrations/polar`, { method: "POST", key: token, json: { webhook_secret: SECRETS.polar } })).body
        .error.code,
    ).toBe("temporary_credential");
    expect((await call(`/v1/sites/${site}/integrations/chargebee`, { key })).status).toBe(400);
    // Wrong secret, unknown provider, unknown site: the same 400.
    const body = JSON.stringify({ type: "order.paid", data: { id: "o" } });
    const bad = await call(`/webhooks/polar/${site}`, {
      method: "POST",
      body,
      headers: { "webhook-id": "m", "webhook-timestamp": String(now()), "webhook-signature": "v1,AAAA" },
    });
    const other = await call(`/webhooks/chargebee/${site}`, { method: "POST", body });
    expect([bad.status, bad.body.error.code, other.status, other.body.error.code]).toEqual([
      400,
      "webhook_rejected",
      400,
      "webhook_rejected",
    ]);
    // Disconnect
    expect((await call(`/v1/sites/${site}/integrations/lemonsqueezy`, { method: "DELETE", key })).body.disconnected).toBe(true);
    expect((await deliver("lemonsqueezy", site, { meta: { event_name: "order_created" }, data: { id: "1", attributes: {} } })).status).toBe(
      400,
    );
  });

  it("feeds payments, refunds and MRR; dedupes event ids; LemonSqueezy replays change nothing", async () => {
    const { key, site, proxyKey } = await newSite("billing2.test");
    const vid = (await beacon(proxyKey, { s: site, u: "https://billing2.test/", r: "https://www.google.com/" }, "10.22.0.1")).body
      .v as string;
    for (const p of ["polar", "paddle", "lemonsqueezy"] as const)
      await call(`/v1/sites/${site}/integrations/${p}`, { method: "POST", key, json: { webhook_secret: SECRETS[p] } });
    expireStatusThrottle();
    // Polar: an order (twice with the same webhook-id), its refund, its subscription.
    const order = {
      id: "ord_1",
      paid: true,
      net_amount: 2000,
      tax_amount: 400,
      total_amount: 2400,
      currency: "usd",
      billing_reason: "subscription_create",
      customer_id: "cus_p",
      customer: {},
      metadata: { afs_visitor_id: vid },
    };
    const paid = await deliver("polar", site, { type: "order.paid", timestamp: iso(now() - 60), data: order }, "msg_order_1");
    expect(paid.body.payments[0]).toMatchObject({ ok: true, linked_by: "visitor" });
    expect(
      (await deliver("polar", site, { type: "order.paid", timestamp: iso(now() - 60), data: order }, "msg_order_1")).body.payments[0]
        .duplicate_event,
    ).toBe(true);
    await deliver("polar", site, { type: "order.refunded", timestamp: iso(now() - 30), data: { ...order, refunded_amount: 500 } });
    await deliver("polar", site, {
      type: "subscription.active",
      timestamp: iso(now() - 60),
      data: {
        id: "ps_1",
        status: "active",
        amount: 2000,
        currency: "usd",
        recurring_interval: "month",
        recurring_interval_count: 1,
        customer_id: "cus_p",
        started_at: iso(now() - 60),
        metadata: { afs_visitor_id: vid },
      },
    });
    // Paddle: a yearly subscription (sandbox off: live).
    const psub = {
      id: "sub_pd",
      status: "active",
      currency_code: "USD",
      customer_id: "ctm_1",
      started_at: iso(now() - 120),
      billing_cycle: { interval: "year", frequency: 1 },
      items: [
        {
          status: "active",
          quantity: 1,
          price: { name: "Annual", unit_price: { amount: "12000" }, billing_cycle: { interval: "year", frequency: 1 } },
        },
      ],
    };
    expect(
      (
        await deliver("paddle", site, {
          event_id: "evt_pd1",
          event_type: "subscription.activated",
          occurred_at: iso(now() - 120),
          data: psub,
        })
      ).body.subscriptions[0].changes,
    ).toEqual(["new"]);
    // LemonSqueezy: an order, replayed (no event ids: the order id keeps it once).
    const lsOrder = {
      meta: { event_name: "order_created", custom_data: { afs_visitor_id: vid } },
      data: {
        type: "orders",
        id: "900",
        attributes: {
          status: "paid",
          currency: "USD",
          subtotal: 3000,
          discount_total: 0,
          tax: 0,
          total: 3000,
          customer_id: 5,
          created_at: iso(now() - 50),
        },
      },
    };
    expect((await deliver("lemonsqueezy", site, lsOrder)).body.payments[0]).toMatchObject({ ok: true, existing: false });
    expect((await deliver("lemonsqueezy", site, lsOrder)).body.payments[0]).toMatchObject({ ok: true, existing: true });
    const pays = (await call(`/v1/sites/${site}/payments?period=7d`, { key })).body.payments;
    expect(pays.map((p: any) => [p.provider ?? p.source, p.type, p.amount]).length).toBe(3);
    const rev = (await call(`/v1/sites/${site}/breakdown?breakdown=channel&period=7d&metrics=revenue`, { key })).body.results;
    expect(rev).toEqual([{ value: "Organic Search", revenue: 45 }]); // 20 - 5 refunded + 30
    const m = (await call(`/v1/sites/${site}/mrr?period=7d&breakdown=channel`, { key })).body;
    expect(m.current).toMatchObject({ mrr: 30, active_subscriptions: 2 });
    expect(m.breakdown.results.find((r: any) => r.value === "Organic Search")).toMatchObject({ mrr: 20 });
    const status = (await call(`/v1/sites/${site}/integrations/polar`, { key })).body.integration;
    expect(status.events_received).toBeGreaterThan(0);
    const names = ((await mcp(key, "tools/list")).body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_billing_integration", "connect_billing_provider", "disconnect_billing_provider"]));
    expect((await tool(key, "get_billing_integration", { site_id: site, provider: "lemonsqueezy" })).data.integration.connected).toBe(true);
  });
});

describe("site currency", () => {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const ecb = (days: [string, Record<string, number>][]) =>
    `<gesmes:Envelope><Cube>${days
      .map(
        ([d, r]) =>
          `<Cube time='${d}'>${Object.entries(r)
            .map(([c, v]) => `<Cube currency='${c}' rate='${v}'/>`)
            .join("")}</Cube>`,
      )
      .join("")}</Cube></gesmes:Envelope>`;

  it("the cron fetches ECB rates only when a site uses a currency; money converts at ingest with originals kept", async () => {
    const { refreshFxRates } = await import("../../src/service/fx");
    await env.DB.prepare("DELETE FROM fx_rates").run();
    await env.DB.prepare("DELETE FROM fx_meta").run();
    let fetched: string[] = [];
    const xml = ecb([
      [day(Date.now()), { USD: 1.25, GBP: 0.8 }],
      [day(Date.now() - 86_400_000), { USD: 1.2, GBP: 0.8 }],
    ]);
    const fxFetcher = async (u: string) => {
      fetched.push(u);
      return new Response(xml, { headers: { "content-type": "application/xml" } });
    };
    await env.DB.prepare("UPDATE sites SET currency = NULL").run();
    expect(await refreshFxRates(env, Date.now(), fxFetcher)).toEqual({});
    expect(fetched).toEqual([]);
    const { key, site } = await newSite("fx1.test", { currency: "eur" });
    expect((await call(`/v1/sites/${site}`, { key })).body.site.currency).toBe("EUR");
    const r = await runCron(env, Date.now(), { fxFetcher });
    expect(r.fx_days_fetched).toBe(2);
    expect(fetched[0]).toContain("eurofxref-hist-90d.xml");
    // Fresh (or just tried): no second fetch.
    await runCron(env, Date.now(), { fxFetcher });
    expect(fetched).toHaveLength(1);
    const rates = (await call(`/v1/fx/rates?base=USD`, { key })).body;
    expect(rates).toMatchObject({ day: day(Date.now()), base: "USD", rates: { USD: 1, EUR: 0.8 } });

    const rec = await call(`/v1/sites/${site}/payments`, {
      method: "POST",
      key,
      json: {
        payments: [
          { id: "fx1", amount: 125, currency: "usd", timestamp: Date.now() - 60_000 },
          { id: "fx2", amount: 120, currency: "USD", timestamp: Date.now() - 86_400_000 },
          { id: "fx3", amount: 10, currency: "EUR" },
          { id: "fx4", amount: 10, currency: "XYZ" },
          { id: "fx5", amount: 12, currency: "USD", timestamp: Date.now() - 30 * 86_400_000 },
        ],
      },
    });
    expect(rec.body.accepted).toBe(5);
    const list = (await call(`/v1/sites/${site}/payments?period=90d`, { key })).body.payments;
    const by = Object.fromEntries(list.map((p: any) => [p.external_id, p]));
    expect(by.fx1).toMatchObject({ amount: 100, currency: "EUR", original: { amount: 125, currency: "USD", fx_fallback: false } });
    expect(by.fx2).toMatchObject({ amount: 100, original: { amount: 120, fx_day: day(Date.now() - 86_400_000) } });
    expect(by.fx3.original).toBeUndefined();
    expect(by.fx4).toMatchObject({ amount: 10, currency: "XYZ" }); // not an ECB currency: kept as it is
    expect(by.fx5.original).toMatchObject({ fx_fallback: true }); // older than any stored rate
    // Subscriptions convert too, and MRR reports in the site currency.
    await call(`/v1/sites/${site}/subscriptions`, {
      method: "POST",
      key,
      json: { id: "s_fx", status: "active", amount: 50, currency: "USD", started_at: Date.now() - 60_000 },
    });
    const m = (await call(`/v1/sites/${site}/mrr?period=7d`, { key })).body;
    expect(m.current).toMatchObject({ mrr: 40, currency: "EUR" });
    const subs = (await call(`/v1/sites/${site}/subscriptions`, { key })).body.subscriptions;
    expect(subs[0]).toMatchObject({ currency: "EUR", original: { mrr: 50, currency: "USD" } });
    expect(((await mcp(key, "tools/list")).body.result.tools as { name: string }[]).map((t) => t.name)).toContain("get_fx_rates");
  });
});

describe("ad spend", () => {
  it("records JSON and CSV costs idempotently (converted), reports ROAS / CPA / CAC, caps rows, MCP tools", async () => {
    const { key, site, proxyKey } = await newSite("costs1.test", { currency: "EUR" });
    await env.DB.prepare("INSERT OR REPLACE INTO fx_rates (day, currency, per_eur) VALUES (?, 'USD', 1.25)")
      .bind(new Date().toISOString().slice(0, 10))
      .run();
    const vid = (
      await beacon(proxyKey, { s: site, u: "https://costs1.test/?utm_source=google&utm_medium=cpc&utm_campaign=brand" }, "10.23.0.1")
    ).body.v as string;
    await call(`/v1/sites/${site}/payments`, { method: "POST", key, json: { id: "c_p1", amount: 80, currency: "EUR", visitor_id: vid } });
    const today = new Date().toISOString().slice(0, 10);
    const j = await call(`/v1/sites/${site}/costs`, {
      method: "POST",
      key,
      json: {
        costs: [
          { date: today, source: "Google", campaign: "Brand", cost: 25, currency: "USD", clicks: 9 },
          { date: "2001-01-01", source: "x", cost: 1 },
        ],
      },
    });
    expect(j.status).toBe(202);
    expect(j.body).toMatchObject({ accepted: 1, rejected: 1, created: 1 });
    expect(j.body.results[1].reason).toContain("retention");
    const csv = `date,source,campaign,cost\n${today},google,brand,25\n${today},meta,"spring, sale","1,200.00"\n`;
    const c = await call(`/v1/sites/${site}/costs?currency=EUR`, {
      method: "POST",
      key,
      body: csv,
      headers: { "content-type": "text/csv" },
    });
    expect(c.body).toMatchObject({ accepted: 2, created: 1, updated: 1 }); // google/brand: 25 USD (20 EUR) -> 25 EUR
    const list = (await call(`/v1/sites/${site}/costs`, { key })).body;
    expect(list.costs.find((r: any) => r.source === "meta")).toMatchObject({ campaign: "spring, sale", cost: 1200, currency: "EUR" });
    const again = await call(`/v1/sites/${site}/costs`, {
      method: "POST",
      key,
      json: { costs: [{ date: today, source: "google", campaign: "brand", cost: 25, currency: "USD", clicks: 9 }] },
    });
    expect(again.body.results[0]).toMatchObject({ ok: true, existing: true });
    const google = list.costs.find((r: any) => r.source === "google");
    expect(google).toMatchObject({ cost: 25 });
    const b = (await call(`/v1/sites/${site}/breakdown?breakdown=utm_campaign&period=today&metrics=visits,revenue,cost,roas,cac`, { key }))
      .body;
    expect(b.results.find((r: any) => r.value === "brand")).toMatchObject({ visits: 1, revenue: 80, cost: 20, roas: 4, cac: 20 });
    const t = (await call(`/v1/sites/${site}/timeseries?period=7d&metrics=cost`, { key })).body;
    expect(t.results.at(-1).cost).toBe(1220);
    // Cap (unclaimed accounts have the same default here): one more row past it is refused.
    const capped = await callWith({ MAX_COST_ROWS_PER_SITE: "2" }, `/v1/sites/${site}/costs`, {
      method: "POST",
      key,
      json: { costs: [{ date: today, source: "bing", cost: 3 }] },
    });
    expect(capped.body.results[0]).toMatchObject({ ok: false, reason: "cost_rows_limit" });
    expect(capped.body.next_steps.join(" ")).toContain("MAX_COST_ROWS_PER_SITE");
    const names = ((await mcp(key, "tools/list")).body.result.tools as { name: string }[]).map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["record_costs", "list_costs", "delete_costs"]));
    expect((await tool(key, "delete_costs", { site_id: site, from: today, to: today, source: "meta" })).data.deleted).toBe(1);
  });
});

describe("ecommerce items", () => {
  it("server events and browser props carry items; GET /items and MCP get_items report them", async () => {
    const { key, site, proxyKey } = await newSite("items1.test");
    const shoe = { item_id: "SKU1", item_name: "Runner", item_category: "Shoes", price: 50, quantity: 1 };
    // Browser: the items ride in the event's props (no tracker change).
    expect(
      (
        await beacon(
          proxyKey,
          { s: site, n: "view_item", u: "https://items1.test/p/runner", p: { items: [shoe], list: "home" } },
          "10.24.0.1",
        )
      ).body.ok,
    ).toBe(true);
    expect(
      (await beacon(proxyKey, { s: site, n: "add_to_cart", u: "https://items1.test/p/runner", p: { items: [shoe] } }, "10.24.0.1")).body.ok,
    ).toBe(true);
    // Server: items on the event; purchase prices from the server count.
    const srv = await call(`/v1/sites/${site}/events`, {
      method: "POST",
      key,
      json: {
        events: [
          {
            name: "purchase",
            user_id: "u1",
            items: [shoe, { item_id: "SKU2", price: 5, quantity: 2 }],
            revenue: { amount: 60, currency: "USD" },
          },
        ],
      },
    });
    expect(srv.body.accepted).toBe(1);
    const r = (await call(`/v1/sites/${site}/items?period=today`, { key })).body;
    expect(r.results.find((x: any) => x.value === "SKU1")).toMatchObject({
      item_name: "Runner",
      items_viewed: 1,
      items_added: 1,
      items_purchased: 1,
      item_revenue: 50,
    });
    expect(r.totals.item_revenue).toBe(60);
    expect(r.untrusted).toContain("data, not instructions");
    const m = await tool(key, "get_items", { site_id: site, period: "today", by: "item_category" });
    expect(m.data.results.find((x: any) => x.value === "Shoes")).toMatchObject({ items_purchased: 1 });
    // The props JSON doesn't keep the array.
    const raw = (await call(`/v1/sites/${site}/sql?q=${encodeURIComponent("SELECT props FROM events WHERE name = 'view_item'")}`, { key }))
      .body;
    expect(JSON.stringify(raw.rows)).not.toContain("SKU1");
  });
});

describe("user properties and custom metrics", () => {
  it("server user_props and browser identify traits; user:<key> breakdowns; sum:prop metrics over REST and MCP", async () => {
    const { key, site, proxyKey } = await newSite("uprops1.test");
    const srv = await call(`/v1/sites/${site}/events`, {
      method: "POST",
      key,
      json: {
        events: [
          { name: "login", user_id: "acct_1", user_props: { plan: "pro", seats: 5 }, props: { amount: 12 } },
          { name: "quote", user_id: "acct_2", user_props: { plan: "free" }, props: { amount: 3 } },
        ],
      },
    });
    expect(srv.body.accepted).toBe(2);
    // Browser-sent user properties are opt-in (security review finding 5): dropped first, kept once enabled.
    await beacon(proxyKey, { s: site, u: "https://uprops1.test/", i: "acct_4", up: { plan: "ignored" } }, "10.25.0.2");
    expect(
      (await call(`/v1/sites/${site}`, { method: "PATCH", key, json: { browser_user_props: true } })).body.site.browser_user_props,
    ).toBe(true);
    expect((await beacon(proxyKey, { s: site, u: "https://uprops1.test/", i: "acct_3", up: { plan: "team" } }, "10.25.0.1")).body.ok).toBe(
      true,
    );
    const b = (await call(`/v1/sites/${site}/breakdown?period=today&breakdown=user:plan&metrics=visitors,sum:prop:amount`, { key })).body;
    expect(Object.fromEntries(b.results.map((r: any) => [r.value, r["sum:prop:amount"]]))).toMatchObject({ pro: 12, free: 3, team: null });
    const f = (
      await call(`/v1/sites/${site}/stats?period=today&metrics=events&filters=${encodeURIComponent("user:plan==pro|team")}`, { key })
    ).body;
    expect(f.metrics.events).toBe(2);
    const list = (await call(`/v1/sites/${site}/user-props`, { key })).body;
    expect(list.untrusted.keys.find((k: any) => k.key === "plan")).toMatchObject({ users: 3 });
    const v = (await call(`/v1/sites/${site}/visitors/user:acct_1`, { key })).body;
    expect(v.user_props).toEqual({ plan: "pro", seats: "5" });
    expect((await call(`/v1/sites/${site}/stats?metrics=median:prop:x`, { key })).status).toBe(400);
    const m = await tool(key, "get_stats", { site_id: site, period: "today", metrics: ["max:prop:amount"] });
    expect(m.data.metrics).toEqual({ "max:prop:amount": 12 });
    expect((await tool(key, "list_user_props", { site_id: site })).data.untrusted.keys.length).toBeGreaterThan(0);
  });
});

describe("reads: sessions, realtime map, roll-up", () => {
  it("lists sessions and the realtime map over REST and MCP; rolls up every site of the account", async () => {
    // A fresh account so the roll-up sees only these sites.
    const key = (await call("/v1/signup", { method: "POST" })).body.api_key as string;
    const a = (await call("/v1/sites", { method: "POST", key, json: { domain: "rollup-a.test", currency: "EUR" } })).body;
    const b = (await call("/v1/sites", { method: "POST", key, json: { domain: "rollup-b.test" } })).body;
    const send = (site: any, u: string, ip: string, extra: Record<string, unknown> = {}) =>
      beacon(site.install.first_party_proxy.proxy_key, { s: site.site.id, u, ...extra }, ip, { "x-afs-geo-country": "DE" });
    await send(a, "https://rollup-a.test/", "10.26.0.1");
    await send(a, "https://rollup-a.test/pricing", "10.26.0.2", { n: "signup", p: { replay_session_id: "rs_test123456" } });
    await send(b, "https://rollup-b.test/", "10.26.0.3");
    const list = (await call(`/v1/sites/${a.site.id}/sessions?period=today&filters=${encodeURIComponent("did==signup")}`, { key })).body;
    expect(list.total).toBe(1);
    expect(list.sessions[0].replay).toEqual({ session_id: "rs_test123456" }); // no replay site linked
    const viaMcp = await tool(key, "list_sessions", { site_id: a.site.id, period: "today" });
    expect(viaMcp.data.total).toBe(2);
    const map = (await call(`/v1/sites/${a.site.id}/realtime/map`, { key })).body;
    expect(map).toMatchObject({ minutes: 30, visitors: 2 });
    expect((await tool(key, "get_realtime_map", { site_id: a.site.id, minutes: 5 })).data.minutes).toBe(5);
    const roll = (await call("/v1/rollup?period=today", { key })).body;
    expect(roll.totals).toMatchObject({ sites: 2, visitors: 3, revenue: null });
    expect(roll.sites.map((s: any) => s.domain)).toEqual(["rollup-a.test", "rollup-b.test"]);
    expect((await tool(key, "get_account_rollup", { period: "today", compare: "previous" })).data.sites[0].change_percent).toBeDefined();
    const vt = (await call(`/v1/sites/${a.site.id}/breakdown?period=today&breakdown=visitor_type`, { key })).body;
    expect(vt.results[0]).toMatchObject({ value: "new" });
  });
});

describe("AI crawlers", () => {
  it("records bot hits from the site's server, reports them, refuses past the daily budget; the list is public", async () => {
    const { key, site } = await newSite("crawl1.test");
    const list = (await call("/v1/crawlers")).body;
    expect(list.crawlers.find((c: any) => c.name === "GPTBot")).toMatchObject({ operator: "OpenAI", category: "ai_training" });
    expect(new RegExp(list.prefilter, list.prefilter_flags).test("Mozilla/5.0 (compatible; PerplexityBot/1.0)")).toBe(true);
    const r = await call(`/v1/sites/${site}/crawls`, {
      method: "POST",
      key,
      json: {
        hits: [
          { user_agent: "Mozilla/5.0 (compatible; GPTBot/1.2)", path: "/docs?x=1", status: 200 },
          { user_agent: "Mozilla/5.0 (compatible; PerplexityBot/1.0)", url: "https://crawl1.test/pricing" },
          { user_agent: UA },
        ],
      },
    });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ accepted: 2, ignored: 1 });
    expect(r.body.results[2].reason).toBe("not_a_known_bot");
    const rep = (await call(`/v1/sites/${site}/crawlers?by=page`, { key })).body;
    expect(rep.results.map((x: any) => x.value).sort()).toEqual(["/docs", "/pricing"]);
    const stats = (await call(`/v1/sites/${site}/stats?period=today&metrics=visitors,events`, { key })).body;
    expect(stats.metrics).toEqual({ visitors: 0, events: 0 });
    const tight = await callWith({ MAX_CRAWL_HITS_PER_SITE_PER_DAY: "2" }, `/v1/sites/${site}/crawls`, {
      method: "POST",
      key,
      json: { user_agent: "GPTBot/1.2", path: "/" },
    });
    expect([tight.status, tight.body.error?.code]).toEqual([429, "daily_limit"]);
    const t = await tool(key, "get_crawlers", { site_id: site, category: "ai_search" });
    expect(t.data.results[0]).toMatchObject({ value: "PerplexityBot", hits: 1 });
    expect((await tool(key, "record_crawls", { site_id: site, hits: [{ user_agent: "ClaudeBot/1.0", path: "/a" }] })).data.accepted).toBe(
      1,
    );
  });
});

describe("imports", () => {
  it("imports Plausible and GA4 CSVs over REST (text/csv) and MCP, idempotently, and reports them with imported=true", async () => {
    const { key, site } = await newSite("import1.test");
    const csv = "date,visitors,pageviews,bounces,visits,visit_duration\n2026-01-01,10,30,4,12,600\n2026-01-02,20,50,10,25,1250\n";
    const r = await call(`/v1/sites/${site}/imports?source=plausible&file_name=imported_visitors.csv`, {
      method: "POST",
      key,
      body: csv,
      headers: { "content-type": "text/csv" },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ existing: false, import: { kind: "visitors", from: "2026-01-01", to: "2026-01-02", rows: 2 } });
    const again = await call(`/v1/sites/${site}/imports?source=plausible`, {
      method: "POST",
      key,
      body: csv,
      headers: { "content-type": "text/csv" },
    });
    expect([again.status, again.body.existing]).toEqual([200, true]);
    const bad = await call(`/v1/sites/${site}/imports`, { method: "POST", key, json: { source: "ga4", csv: "Views\n1\n" } });
    expect(bad.body.error.code).toBe("invalid_import");
    const ga4 = await tool(key, "import_csv", {
      site_id: site,
      source: "ga4",
      csv: "Date,Country,Active users,Sessions,Views\n20260101,Germany,5,6,9\n",
    });
    expect(ga4.data.import).toMatchObject({ kind: "countries", rows: 1 });
    const stats = (
      await call(`/v1/sites/${site}/stats?from=2026-01-01&to=2026-01-31&metrics=visitors,visits,pageviews&imported=true`, { key })
    ).body;
    expect(stats.metrics).toEqual({ visitors: 30, visits: 37, pageviews: 80 });
    const countries = (
      await call(`/v1/sites/${site}/breakdown?from=2026-01-01&to=2026-01-31&breakdown=country&metrics=visitors&imported=true`, { key })
    ).body;
    expect(countries.results).toEqual([{ value: "DE", visitors: 5 }]); // GA4 exports names; reports use ISO codes
    const list = (await call(`/v1/sites/${site}/imports`, { key })).body;
    expect(list.imports).toHaveLength(2);
    const del = await call(`/v1/sites/${site}/imports/${list.imports[0].id}`, { method: "DELETE", key });
    expect(del.body.deleted).toBe(true);
    const capped = await callWith({ MAX_IMPORTS_PER_SITE: "1" }, `/v1/sites/${site}/imports?source=plausible`, {
      method: "POST",
      key,
      body: csv.replace(/2026-01-0/g, "2026-02-0"),
      headers: { "content-type": "text/csv" },
    });
    expect(capped.body.error.code).toBe("quota_exceeded");
  });
});

describe("raw export", () => {
  it("NDJSON and CSV pages with a cursor header; MCP returns JSON pages", async () => {
    const { key, site, proxyKey } = await newSite("export1.test");
    for (let i = 0; i < 3; i++) await beacon(proxyKey, { s: site, u: `https://export1.test/p${i}`, p: { i } }, `10.27.0.${i + 1}`);
    const today = new Date().toISOString().slice(0, 10);
    const res = await SELF.fetch(request(`/v1/sites/${site}/export?from=${today}&limit=2`, { key }));
    expect(res.headers.get("content-type")).toContain("ndjson");
    const cursor = res.headers.get("x-afs-next-cursor");
    expect(cursor).toMatch(/^e[0-9a-z]+$/);
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.pathname)).toEqual(["/p0", "/p1"]);
    const rest = await SELF.fetch(request(`/v1/sites/${site}/export?from=${today}&cursor=${cursor}&format=csv`, { key }));
    const csv = await rest.text();
    expect(csv.split("\n")[0]).toContain("pathname");
    expect(csv).toContain("/p2");
    expect(rest.headers.get("x-afs-next-cursor")).toBeNull();
    const m = await tool(key, "export_events", { site_id: site, from: today, limit: 2 });
    expect(m.data.rows).toHaveLength(2);
    expect(m.data.next_cursor).toBe(cursor);
    const capped = await callWith({ MAX_EXPORT_ROWS_PER_SITE_PER_DAY: "5" }, `/v1/sites/${site}/export?from=${today}`, { key });
    expect(capped.status).toBe(429);
  });
});

describe("share links with options", () => {
  it("password (hashed, cookie or header), expiry, segment and label; the page has goals and keeps its headers", async () => {
    const { key, site, proxyKey } = await newSite("share2.test");
    await env.DB.prepare("UPDATE sites SET verified_at = ?, verify_method = 'dns_txt' WHERE id = ?").bind(Date.now(), site).run();
    await beacon(proxyKey, { s: site, u: "https://share2.test/blog/a" }, "10.28.0.1", { "x-afs-geo-country": "DE" });
    await beacon(proxyKey, { s: site, u: "https://share2.test/" }, "10.28.0.2", { "x-afs-geo-country": "FR" });
    await call(`/v1/sites/${site}/goals`, { method: "POST", key, json: { name: "Blog", type: "pageview", match: "/blog/*" } });
    const seg = (await call(`/v1/sites/${site}/segments`, { method: "POST", key, json: { name: "Germany", filters: "country==DE" } })).body
      .segment;
    const made = await call(`/v1/sites/${site}/share`, {
      method: "POST",
      key,
      json: { password: "open sesame", expires_in_days: 7, segment: "Germany", label: "investors" },
    });
    expect(made.body).toMatchObject({ existing: false, label: "investors", password: { configured: true }, segment_id: seg.id });
    expect(JSON.stringify(made.body)).not.toContain("open sesame");
    const again = await call(`/v1/sites/${site}/share`, { method: "POST", key, json: { label: "investors", password: "other password" } });
    expect(again.body).toMatchObject({ existing: true, token: made.body.token });
    const token = made.body.token as string;
    // Locked: the form, no data.
    const page = await SELF.fetch(`${B}/share/${token}`);
    const html = await page.text();
    expect(html).toContain('name="password"');
    expect(html).not.toContain("Top pages");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(page.headers.get("x-robots-tag")).toContain("noindex");
    expect((await call(`/share/${token}/data`)).body.error.code).toBe("share_password_required");
    const wrong = await SELF.fetch(`${B}/share/${token}/unlock`, {
      method: "POST",
      body: new URLSearchParams({ password: "nope nope" }),
      redirect: "manual",
    });
    expect(wrong.status).toBe(401);
    const right = await SELF.fetch(`${B}/share/${token}/unlock`, {
      method: "POST",
      body: new URLSearchParams({ password: "open sesame" }),
      redirect: "manual",
    });
    expect(right.status).toBe(303);
    const cookie = right.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toContain(`Path=/share/${token}`);
    const unlocked = await SELF.fetch(`${B}/share/${token}`, { headers: { cookie: cookie.split(";")[0]! } });
    expect(await unlocked.text()).toContain("Goals");
    expect(unlocked.headers.get("content-security-policy")).toContain("form-action 'none'");
    // Data: the segment's traffic only (Germany), with goals.
    const data = (await call(`/share/${token}/data?period=today`, { headers: { "x-share-password": "open sesame" } })).body;
    expect(data.metrics.visitors).toBe(1);
    expect(data.goals).toEqual([{ value: "Blog", visitors: 1, conversions: 1, conversion_rate: 100 }]);
    expect(data.share).toMatchObject({ segment: "Germany" });
    // Expiry, listing and revoking one link.
    const short = await call(`/v1/sites/${site}/share`, { method: "POST", key, json: { expires_in_days: 1, label: "temp" } });
    await env.DB.prepare("UPDATE share_links SET expires_at = ? WHERE token = ?")
      .bind(Date.now() - 1000, short.body.token)
      .run();
    expect((await call(`/share/${short.body.token}/data`)).body.error.code).toBe("share_link_expired");
    const list = (await call(`/v1/sites/${site}/share`, { key })).body.share_links;
    expect(list.find((l: any) => l.label === "temp")).toMatchObject({ expired: true });
    expect((await call(`/v1/sites/${site}/share?token=${short.body.token}`, { method: "DELETE", key })).body.revoked).toBe(1);
    expect((await tool(key, "list_share_links", { site_id: site })).data.share_links).toHaveLength(1);
  });
});

describe("smaller items", () => {
  it("site settings for session timeout and channel groups; /s.js?linker=1 serves the linker build", async () => {
    const { key, site, proxyKey } = await newSite("small1.test");
    const p = await call(`/v1/sites/${site}`, {
      method: "PATCH",
      key,
      json: { session_timeout_minutes: 15, channel_groups: [{ name: "Partners", source: ["partner-*"] }] },
    });
    expect(p.body.site).toMatchObject({ session_timeout_minutes: 15, channel_groups: [{ name: "Partners", source: ["partner-*"] }] });
    expect((await call(`/v1/sites/${site}`, { method: "PATCH", key, json: { session_timeout_minutes: 2 } })).status).toBe(400);
    await beacon(proxyKey, { s: site, u: "https://small1.test/?utm_source=partner-acme" }, "10.29.0.1");
    const b = (await call(`/v1/sites/${site}/breakdown?period=today&breakdown=channel_group`, { key })).body;
    expect(b.results[0]).toMatchObject({ value: "Partners", visitors: 1 });
    const plain = await (await SELF.fetch(`${B}/s.js`)).text();
    const linker = await SELF.fetch(`${B}/s.js?linker=1`);
    const text = await linker.text();
    expect(text.startsWith("/*! afs-analytics */")).toBe(true);
    expect(text).toContain("_afsa");
    expect(plain).not.toContain("_afsa");
    expect(linker.headers.get("etag")).not.toBe((await SELF.fetch(`${B}/s.js`)).headers.get("etag"));
  });
});

describe("security review: Stripe backfill robustness (finding 1)", () => {
  const D = 86400;
  const invoice = (id: string) => ({
    id,
    object: "invoice",
    customer: "cus_r",
    currency: "usd",
    amount_paid: 1000,
    billing_reason: "manual",
    livemode: false,
    created: now() - D,
    status_transitions: { paid_at: now() - D },
  });
  const routes = (pages: Record<string, (url: URL) => unknown>) =>
    fakeStripe({
      "POST /v1/webhook_endpoints": () => ({ body: { id: `we_${Math.random().toString(36).slice(2, 10)}`, secret: FAKE_WHSEC } }),
      "GET /v1/checkout/sessions": () => ({ body: { has_more: false, data: [] } }),
      "GET /v1/invoices": (u) => ({ body: pages.invoices ? pages.invoices(u) : { has_more: false, data: [] } }),
      "GET /v1/charges": () => ({ body: { has_more: false, data: [] } }),
      "GET /v1/subscriptions": (u) => ({ body: pages.subscriptions ? pages.subscriptions(u) : { has_more: false, data: [] } }),
    });
  async function connected(domain: string, stripe: ReturnType<typeof fakeStripe>) {
    const { key, site } = await newSite(domain);
    const { connectStripeWithKey } = await import("../../src/service/stripe-connect");
    // Connect without running pages in the call: the cron does the work.
    await connectStripeWithKey(
      await ctxFor(key),
      site,
      { restricted_key: FAKE_RK },
      { fetcher: async () => new Response("{}", { status: 503 }) },
    ).catch(() => {});
    await connectStripeWithKey(await ctxFor(key), site, { restricted_key: FAKE_RK }, { fetcher: stripe.fetcher });
    return { key, site };
  }
  const state = async (site: string) =>
    JSON.parse(
      (await env.DB.prepare("SELECT backfill FROM integrations WHERE site_id = ? AND provider = 'stripe'")
        .bind(site)
        .first<{ backfill: string }>())!.backfill,
    );

  it("a full site pauses with the reason, an unexpected error fails with its message, and the queue keeps moving in turn", async () => {
    const { runStripeBackfills } = await import("../../src/service/stripe-connect");
    await env.DB.prepare("UPDATE integrations SET backfill = json_set(backfill, '$.status', 'done') WHERE provider = 'stripe'").run();
    const full = routes({ invoices: () => ({ has_more: true, data: [invoice("in_f1")] }) });
    const a = await connected("bf-full.test", full);
    await env.DB.prepare(
      "UPDATE integrations SET backfill = json_set(backfill, '$.status', 'running', '$.stage', 'invoices', '$.cursor', NULL, '$.updated_at', 1) WHERE site_id = ?",
    )
      .bind(a.site)
      .run();
    const broken = routes({ invoices: () => ({ has_more: false, data: "not a list" }) });
    const b = await connected("bf-broken.test", broken);
    await env.DB.prepare(
      "UPDATE integrations SET backfill = json_set(backfill, '$.status', 'running', '$.stage', 'invoices', '$.cursor', NULL, '$.updated_at', 2) WHERE site_id = ?",
    )
      .bind(b.site)
      .run();
    // One site per run: the least recently worked on goes first.
    const tiny = { ...env, MAX_SITE_STORAGE_MB: "0.01" } as typeof env;
    await runStripeBackfills(tiny, Date.now(), Date.now() + 30_000, full.fetcher, 1);
    const sa = await state(a.site);
    expect(sa).toMatchObject({ status: "paused" });
    expect(sa.error).toContain("storage_full");
    expect(sa.paused_until).toBeGreaterThan(Date.now());
    expect((await state(b.site)).status).toBe("running"); // not reached yet: one slot
    const out = await runStripeBackfills(env, Date.now(), Date.now() + 30_000, broken.fetcher, 1);
    const sb = await state(b.site);
    expect(sb.status).toBe("failed");
    expect(sb.error).toMatch(/forEach|not a function|iterable/);
    expect(out.stripe_backfill_failed).toBe(1);
    // The integration shows it.
    expect((await call(`/v1/sites/${b.site}/integrations/stripe`, { key: b.key })).body.integration.backfill).toMatchObject({
      status: "failed",
    });
  });

  it("the subscriptions stage is bounded: past MAX_SUBSCRIPTION_PAGES the backfill is done, truncated", async () => {
    const { runBackfill, MAX_SUBSCRIPTION_PAGES } = await import("../../src/service/stripe-connect");
    let n = 0;
    const many = routes({
      subscriptions: () => ({
        has_more: true,
        data: [
          {
            id: `sub_m${n++}`,
            object: "subscription",
            status: "canceled",
            customer: "cus_m",
            livemode: false,
            created: now() - 400 * D,
            start_date: now() - 400 * D,
            ended_at: now() - 300 * D,
            items: { data: [] },
          },
        ],
      }),
    });
    const { site } = await connected("bf-many.test", many);
    await env.DB.prepare(
      "UPDATE integrations SET backfill = json_set(backfill, '$.status', 'running', '$.stage', 'subscriptions', '$.cursor', NULL) WHERE site_id = ?",
    )
      .bind(site)
      .run();
    const row = (await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(site).first())!;
    const s = await runBackfill(env, row as never, MAX_SUBSCRIPTION_PAGES + 20, many.fetcher);
    expect(s).toMatchObject({ status: "done", subscription_pages: MAX_SUBSCRIPTION_PAGES });
    expect(s!.truncated).toContain("stopped after");
    expect(many.calls.filter((c) => c.path === "/v1/subscriptions")).toHaveLength(MAX_SUBSCRIPTION_PAGES);
  });
});

describe("security review: share links and credentials (finding 2)", () => {
  it("temporary tokens and read-only keys list share links without url or token", async () => {
    const { key, site } = await newSite("share-cred.test");
    await env.DB.prepare("UPDATE sites SET verified_at = ?, verify_method = 'dns_txt' WHERE id = ?").bind(Date.now(), site).run();
    const made = (await call(`/v1/sites/${site}/share`, { method: "POST", key, json: { label: "board" } })).body;
    const me = (await call("/v1/me", { key })).body;
    const db = env.AUTH_DB ?? env.DB;
    const temp = (await createApiKey(db, me.account.id, { keyPrefix: "afs", expiresAt: Date.now() + 3_600_000 })).key;
    const read = (await createApiKey(db, me.account.id, { keyPrefix: "afs", scope: "read" })).key;
    const full = (await call(`/v1/sites/${site}/share`, { key })).body;
    expect(full.share_links[0]).toMatchObject({ token: made.token, url: made.url });
    for (const k of [temp, read]) {
      const r = (await call(`/v1/sites/${site}/share`, { key: k })).body;
      expect(r.share_links[0]).toMatchObject({ label: "board", password: { configured: false } });
      expect(r.share_links[0].url).toBeUndefined();
      expect(r.share_links[0].token).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain(made.token);
      expect(r.hint).toContain("never expire");
    }
    const viaMcp = await tool(read, "list_share_links", { site_id: site });
    expect(JSON.stringify(viaMcp.data)).not.toContain(made.token);
  });
});

describe("security review: storage and crawler budgets (finding 3)", () => {
  it("imports, cost rows and crawler hits are refused on a full site, like events", async () => {
    const { key, site } = await newSite("full3.test");
    const full = { MAX_SITE_STORAGE_MB: "0.01" };
    const today = new Date().toISOString().slice(0, 10);
    const cost = await callWith(full, `/v1/sites/${site}/costs`, {
      method: "POST",
      key,
      json: { costs: [{ date: today, source: "google", cost: 1 }] },
    });
    const imp = await callWith(full, `/v1/sites/${site}/imports`, {
      method: "POST",
      key,
      json: { source: "plausible", csv: "date,visitors,pageviews,bounces,visits,visit_duration\n2026-01-01,1,1,0,1,0\n" },
    });
    const crawl = await callWith(full, `/v1/sites/${site}/crawls`, { method: "POST", key, json: { user_agent: "GPTBot/1.2", path: "/" } });
    for (const r of [cost, imp, crawl]) {
      expect(r.status).toBe(507);
      expect(r.body.error.code).toBe("storage_full");
      expect(r.body.error.hint).toContain("retention_days");
    }
  });

  it("crawler hits hold to the account's and the deployment's daily budgets", async () => {
    await env.DB.prepare("DELETE FROM crawl_usage_daily").run();
    await env.DB.prepare("DELETE FROM crawl_usage_global").run();
    const key = (await call("/v1/signup", { method: "POST" })).body.api_key as string;
    const a = (await call("/v1/sites", { method: "POST", key, json: { domain: "crawl-a.test" } })).body.site.id;
    const b = (await call("/v1/sites", { method: "POST", key, json: { domain: "crawl-b.test" } })).body.site.id;
    const acct = { MAX_CRAWL_HITS_PER_ACCOUNT_PER_DAY: "3" };
    const hit = (site: string, vars: Record<string, string>, n = 1) =>
      callWith(vars, `/v1/sites/${site}/crawls`, {
        method: "POST",
        key,
        json: { hits: Array.from({ length: n }, () => ({ user_agent: "GPTBot/1.2", path: "/x" })) },
      });
    expect((await hit(a, acct, 2)).body.accepted).toBe(2);
    const second = await hit(b, acct, 2);
    expect(second.body).toMatchObject({ accepted: 1, refused: 1 });
    const third = await hit(b, acct);
    expect([third.status, third.body.error.code]).toEqual([429, "daily_limit"]);
    expect(third.body.error.hint).toContain("MAX_CRAWL_HITS_PER_ACCOUNT_PER_DAY");
    const glob = await hit(a, { MAX_CRAWL_HITS_PER_DAY: "3" });
    expect([glob.status, glob.body.error.code]).toEqual([429, "over_capacity"]);
  });
});

describe("security review: LemonSqueezy secrets and signature lockout (finding 4)", () => {
  it("generates a LemonSqueezy secret shown once, refuses short ones, and answers 429 to bad signatures past 20 while good ones still pass", async () => {
    const { key, site } = await newSite("ls-secret.test");
    const short = await call(`/v1/sites/${site}/integrations/lemonsqueezy`, {
      method: "POST",
      key,
      json: { webhook_secret: "tooshort123" },
    });
    expect([short.status, short.body.error.code]).toEqual([400, "weak_secret"]);
    expect((await call(`/v1/sites/${site}/integrations/polar`, { method: "POST", key, json: {} })).body.error.code).toBe("missing_secret");
    const made = await call(`/v1/sites/${site}/integrations/lemonsqueezy`, { method: "POST", key, json: {} });
    expect(made.status).toBe(201);
    const secret = made.body.webhook_secret as string;
    expect(secret).toMatch(/^[0-9a-z]{40}$/);
    expect(made.body.next_steps[0]).toContain("Signing secret");
    const status = (await call(`/v1/sites/${site}/integrations/lemonsqueezy`, { key })).body;
    expect(JSON.stringify(status)).not.toContain(secret);
    const again = await call(`/v1/sites/${site}/integrations/lemonsqueezy`, { method: "POST", key, json: {} });
    expect(again.body).toMatchObject({ existing: true });
    expect(again.body.webhook_secret).toBeUndefined();
    // The generated secret verifies deliveries.
    const { billingSignatureHeaders } = await import("../../src/lib/billing");
    const body = JSON.stringify({
      meta: { event_name: "order_created" },
      data: { id: "1", attributes: { status: "paid", currency: "USD", subtotal: 100, total: 100, created_at: new Date().toISOString() } },
    });
    const ok = await call(`/webhooks/lemonsqueezy/${site}`, {
      method: "POST",
      body,
      headers: await billingSignatureHeaders("lemonsqueezy", body, secret, now()),
    });
    expect(ok.status).toBe(200);
    // 20 bad signatures get 400, the next ones 429; a correctly signed delivery still goes through.
    for (let i = 0; i < 20; i++) {
      const bad = await call(`/webhooks/lemonsqueezy/${site}`, { method: "POST", body, headers: { "x-signature": "00" } });
      expect(bad.status).toBe(400);
    }
    const noisy = await call(`/webhooks/lemonsqueezy/${site}`, { method: "POST", body, headers: { "x-signature": "00" } });
    expect([noisy.status, noisy.body.error.code]).toEqual([429, "rate_limited"]);
    expect(noisy.body.retry_after).toBeGreaterThan(0);
    const good = await call(`/webhooks/lemonsqueezy/${site}`, {
      method: "POST",
      body,
      headers: await billingSignatureHeaders("lemonsqueezy", body, secret, now()),
    });
    expect(good.status).toBe(200);
  });
});

describe("security review: share passwords (findings 6, 7, 10)", () => {
  async function protectedLink(domain: string) {
    const { key, site } = await newSite(domain);
    await env.DB.prepare("UPDATE sites SET verified_at = ?, verify_method = 'dns_txt' WHERE id = ?").bind(Date.now(), site).run();
    const made = (await call(`/v1/sites/${site}/share`, { method: "POST", key, json: { password: "open sesame please", label: "x" } }))
      .body;
    return made.token as string;
  }
  const unlock = (token: string, password: string, ip: string, extra: RequestInit = {}) =>
    SELF.fetch(`${B}/share/${token}/unlock`, {
      method: "POST",
      body: new URLSearchParams({ password }),
      redirect: "manual",
      headers: { "cf-connecting-ip": ip },
      ...extra,
    });

  it("10 wrong passwords per IP, then 429 with retry_after; other IPs and unlocked viewers carry on; the IP is never stored", async () => {
    const token = await protectedLink("pw-limit.test");
    const good = await unlock(token, "open sesame please", "198.51.100.9");
    const cookie = good.headers.get("set-cookie")!;
    expect(cookie).toMatch(/SameSite=Lax/i); // finding 10
    for (let i = 0; i < 10; i++) expect((await unlock(token, `wrong ${i}`, "198.51.100.1")).status).toBe(401);
    const blocked = await unlock(token, "open sesame please", "198.51.100.1");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await blocked.text()).toContain("Too many wrong passwords");
    // The header path counts too, and answers JSON with retry_after.
    const hdr = await call(`/share/${token}/data`, {
      headers: { "x-share-password": "open sesame please", "cf-connecting-ip": "198.51.100.1" },
    });
    expect([hdr.status, hdr.body.error.code]).toEqual([429, "too_many_attempts"]);
    expect(hdr.body.error.details.retry_after).toBeGreaterThan(0);
    expect((await unlock(token, "open sesame please", "198.51.100.2")).status).toBe(303);
    const viewer = await SELF.fetch(`${B}/share/${token}/data`, {
      headers: { cookie: cookie.split(";")[0]!, "cf-connecting-ip": "198.51.100.1" },
    });
    expect(viewer.status).toBe(200);
    const stored = JSON.stringify((await env.DB.prepare("SELECT * FROM share_attempts").all()).results);
    expect(stored).not.toContain("198.51.100");
  });

  it("a per-link ceiling locks password attempts only, never viewers with a cookie", async () => {
    const token = await protectedLink("pw-ceiling.test");
    const cookie = (await unlock(token, "open sesame please", "203.0.113.5")).headers.get("set-cookie")!.split(";")[0]!;
    await unlock(token, "wrong", "203.0.113.6"); // creates the link counter
    await env.DB.prepare("UPDATE share_attempts SET count = 200 WHERE key LIKE 'link:%'").run();
    const r = await unlock(token, "open sesame please", "203.0.113.7");
    expect(r.status).toBe(429);
    expect((await SELF.fetch(`${B}/share/${token}/data`, { headers: { cookie } })).status).toBe(200);
  });

  it("the unlock form body is capped (finding 7)", async () => {
    const token = await protectedLink("pw-body.test");
    const big = await SELF.fetch(`${B}/share/${token}/unlock`, {
      method: "POST",
      body: `password=${"a".repeat(5000)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(big.status).toBe(413);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`password=${"b".repeat(6000)}`));
        c.close();
      },
    });
    const chunked = await SELF.fetch(`${B}/share/${token}/unlock`, { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(chunked.status).toBe(413);
  });
});

describe("security review: Stripe endpoint hygiene (finding 11)", () => {
  it("reconnecting with another key deletes the old endpoint, deleting the site deletes ours, and restarting the backfill needs a permanent key", async () => {
    const { key, site } = await newSite("hygiene.test");
    const ctx = await ctxFor(key);
    const { connectStripeWithKey } = await import("../../src/service/stripe-connect");
    const { deleteSite } = await import("../../src/service/sites");
    let n = 0;
    const stripe = fakeStripe({
      "POST /v1/webhook_endpoints": () => ({ body: { id: `we_hyg${++n}`, secret: FAKE_WHSEC } }),
      "GET /v1/checkout/sessions": () => ({ body: { has_more: false, data: [] } }),
      "GET /v1/invoices": () => ({ body: { has_more: false, data: [] } }),
      "GET /v1/charges": () => ({ body: { has_more: false, data: [] } }),
      "GET /v1/subscriptions": () => ({ body: { has_more: false, data: [] } }),
      "DELETE /v1/webhook_endpoints/we_hyg1": () => ({ body: { id: "we_hyg1", deleted: true } }),
      "DELETE /v1/webhook_endpoints/we_hyg2": () => ({ body: { id: "we_hyg2", deleted: true } }),
    });
    await connectStripeWithKey(ctx, site, { restricted_key: FAKE_RK, backfill_days: 0 }, { fetcher: stripe.fetcher });
    const second = "rk_test_fakekeyfortests2";
    const again = await connectStripeWithKey(ctx, site, { restricted_key: second, backfill_days: 0 }, { fetcher: stripe.fetcher });
    expect(again.webhook).toMatchObject({ endpoint_id: "we_hyg2", created: true, previous_endpoint_deleted: true });
    const del1 = stripe.calls.find((c) => c.method === "DELETE" && c.path.endsWith("we_hyg1"))!;
    expect(del1.auth).toBe(`Bearer ${FAKE_RK}`); // the key that made it
    // Restarting the backfill: the project's own key only.
    const me = (await call("/v1/me", { key })).body;
    const temp = (await createApiKey(env.AUTH_DB ?? env.DB, me.account.id, { keyPrefix: "afs", expiresAt: Date.now() + 3_600_000 })).key;
    const r = await call(`/v1/sites/${site}/integrations/stripe/backfill`, { method: "POST", key: temp, json: {} });
    expect(r.body.error.code).toBe("temporary_credential");
    // Deleting the site deletes our endpoint in Stripe.
    const gone = await deleteSite(ctx, site, { fetcher: stripe.fetcher });
    expect(gone).toMatchObject({ deleted: site, stripe_webhook_endpoint_deleted: true });
    expect(stripe.calls.some((c) => c.method === "DELETE" && c.path.endsWith("we_hyg2") && c.auth === `Bearer ${second}`)).toBe(true);
  });
});
