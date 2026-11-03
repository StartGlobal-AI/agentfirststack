import { SELF, createExecutionContext, env, runDurableObjectAlarm, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { stripeSignatureHeader } from "../../src/lib/stripe";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const B = "http://analytics.test";
const DAY = 86_400_000;
const SECRET = "whsec_integration_test_secret_0123";

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
  return { status: res.status, body };
}

const call = async (path: string, init: Init = {}) => parsed(await SELF.fetch(request(path, init)));

/** The same Worker with some bindings changed (fair-use caps on, ENCRYPTION_KEY missing). */
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

/** Call an MCP tool; returns the parsed JSON it returned (and whether it was an error). */
async function tool(key: string, name: string, args: Record<string, unknown>) {
  const r = await mcp(key, "tools/call", { name, arguments: args });
  return { isError: !!r.body.result.isError, data: JSON.parse(r.body.result.content[0].text) };
}

// One account for the whole file: signups are rate limited (SIGNUP_LIMITER, 5 a minute), sites are not.
let accountKey: string | null = null;
async function newSite(domain: string, json: Record<string, unknown> = {}) {
  accountKey ??= (await call("/v1/signup", { method: "POST" })).body.api_key as string;
  const key = accountKey;
  const created = await call("/v1/sites", { method: "POST", key, json: { domain, ...json } });
  return { key, site: created.body.site.id as string, proxyKey: created.body.install.first_party_proxy.proxy_key as string, created };
}

/** A browser beacon through the first-party proxy (so X-Forwarded-For, i.e. the visitor IP, counts). */
const beacon = (proxyKey: string, payload: Record<string, unknown>, ip: string, geo: Record<string, string> = {}) =>
  call("/_a/e", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      "user-agent": UA,
      "content-type": "text/plain",
      "x-forwarded-for": ip,
      "x-afs-proxy-key": proxyKey,
      ...Object.fromEntries(Object.entries(geo).map(([k, v]) => [`x-dev-geo-${k}`, v])),
    },
  });

async function stripePost(site: string, event: Record<string, unknown>, opts: { secret?: string; t?: number } = {}) {
  const body = JSON.stringify(event);
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  return call(`/webhooks/stripe/${site}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "stripe-signature": await stripeSignatureHeader(body, opts.secret ?? SECRET, t) },
  });
}

let evtN = 0;
const stripeEvent = (type: string, object: Record<string, unknown>, livemode = true) => ({
  id: `evt_${++evtN}_${Math.random().toString(36).slice(2, 8)}`,
  type,
  created: Math.floor(Date.now() / 1000),
  livemode,
  data: { object },
});

describe("revenue attribution: Stripe webhook + payments API", () => {
  it("connect, signed webhooks (dedupe, refunds, renewals, test mode), status, revenue metrics, disconnect", async () => {
    const { key, site, proxyKey } = await newSite("stripe.test");
    // before connecting: the URL and events to enable
    const before = await call(`/v1/sites/${site}/integrations/stripe`, { key });
    expect(before.body.integration).toMatchObject({
      connected: false,
      webhook_url: `${B}/webhooks/stripe/${site}`,
      signing_secret: { configured: false },
    });
    expect(before.body.integration.events).toContain("invoice.paid");
    // without ENCRYPTION_KEY the connect call explains what the operator must do
    const nokey = await callWith({ ENCRYPTION_KEY: undefined }, `/v1/sites/${site}/integrations/stripe`, {
      method: "POST",
      key,
      json: { webhook_secret: SECRET },
    });
    expect(nokey.status).toBe(503);
    expect(nokey.body.error).toMatchObject({ code: "not_configured", hint: expect.stringContaining("ENCRYPTION_KEY") });
    expect(
      (await call(`/v1/sites/${site}/integrations/stripe`, { method: "POST", key, json: { webhook_secret: "sk_live_nope" } })).status,
    ).toBe(400);
    const con = await call(`/v1/sites/${site}/integrations/stripe`, { method: "POST", key, json: { webhook_secret: SECRET } });
    expect(con.status).toBe(201);
    expect(JSON.stringify(con.body)).not.toContain(SECRET);
    expect(con.body.integration).toMatchObject({ connected: true, signing_secret: { configured: true } });
    expect(con.body.next_steps.length).toBeGreaterThan(0);
    const again = await call(`/v1/sites/${site}/integrations/stripe`, { method: "POST", key, json: { webhook_secret: SECRET } });
    expect(again.status).toBe(200);
    expect(again.body.existing).toBe(true);
    const sealed = await env.DB.prepare("SELECT secret_sealed FROM integrations WHERE site_id = ?")
      .bind(site)
      .first<{ secret_sealed: string }>();
    expect(sealed!.secret_sealed.startsWith("v1.")).toBe(true);

    // a visitor from Google, then a paid checkout carrying afsa.visitorId()
    const pv = await beacon(proxyKey, { s: site, u: "https://stripe.test/pricing", r: "https://www.google.com/" }, "10.1.0.1", {
      country: "DE",
    });
    const vid = pv.body.v as string;
    const checkout = stripeEvent("checkout.session.completed", {
      id: "cs_1",
      mode: "payment",
      payment_status: "paid",
      amount_total: 4900,
      currency: "usd",
      payment_intent: "pi_1",
      customer: "cus_1",
      metadata: { afs_visitor_id: vid },
    });
    const w1 = await stripePost(site, checkout);
    expect(w1.status).toBe(200);
    expect(w1.body.result).toMatchObject({ ok: true, linked_by: "visitor", existing: false });
    expect((await stripePost(site, checkout)).body.result).toMatchObject({ duplicate_event: true });
    // bad signature, stale timestamp, unknown site, a site without Stripe: one identical answer, and
    // nothing written (an unauthenticated request can't plant a last_error or reveal which sites use Stripe)
    const bad = await stripePost(site, stripeEvent("invoice.paid", {}), { secret: "whsec_someone_else_000" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("webhook_rejected");
    expect((await call(`/v1/sites/${site}/integrations/stripe`, { key })).body.integration.last_error).toBeNull();
    const stale = await stripePost(site, stripeEvent("invoice.paid", {}), { t: Math.floor(Date.now() / 1000) - 600 });
    const unknown = await stripePost("site_0000000000000000", checkout);
    const noStripe = await stripePost((await newSite("nostripe.test")).site, checkout);
    const unsigned = await call(`/webhooks/stripe/${site}`, { method: "POST", body: JSON.stringify(checkout) });
    for (const r of [stale, unknown, noStripe, unsigned]) expect(r).toEqual(bad);
    // test mode is acknowledged but not counted by default
    const test = await stripePost(
      site,
      stripeEvent(
        "checkout.session.completed",
        { id: "cs_t", mode: "payment", payment_status: "paid", amount_total: 100, currency: "usd" },
        false,
      ),
    );
    expect(test.body).toMatchObject({ received: true, ignored: "test_mode" });
    // a subscription: checkout links the customer, invoices carry the money, the renewal keeps the source
    await stripePost(
      site,
      stripeEvent("checkout.session.completed", { id: "cs_2", mode: "subscription", customer: "cus_2", client_reference_id: vid }),
    );
    expect(
      (
        await stripePost(
          site,
          stripeEvent("invoice.paid", {
            id: "in_1",
            amount_paid: 2000,
            currency: "usd",
            billing_reason: "subscription_create",
            customer: "cus_2",
          }),
        )
      ).body.result,
    ).toMatchObject({ linked_by: "customer" });
    await stripePost(
      site,
      stripeEvent("invoice.paid", {
        id: "in_2",
        amount_paid: 2000,
        currency: "usd",
        billing_reason: "subscription_cycle",
        customer: "cus_2",
      }),
    );
    // a partial refund of the checkout
    await stripePost(
      site,
      stripeEvent("charge.refunded", { id: "ch_1", amount_refunded: 900, currency: "usd", payment_intent: "pi_1", customer: "cus_1" }),
    );
    // ignored types are fine
    expect((await stripePost(site, stripeEvent("customer.created", { id: "cus_3" }))).body.ignored).toBeTruthy();

    const status = (await call(`/v1/sites/${site}/integrations/stripe`, { key })).body.integration;
    expect(status).toMatchObject({ last_error: null, last_event_type: "customer.created" });
    expect(status.events_received).toBeGreaterThanOrEqual(7);
    expect(status.payments).toMatchObject({ payments_30d: 4, unlinked_30d: 0 });

    const stats = await call(
      `/v1/sites/${site}/stats?period=24h&metrics=visitors,revenue,revenue_per_visitor,new_revenue,renewal_revenue,refunds,purchases,purchase_rate`,
      { key },
    );
    expect(stats.body.metrics).toEqual({
      visitors: 1,
      revenue: 80, // 49 + 20 + 20 - 9
      revenue_per_visitor: 80,
      new_revenue: 69,
      renewal_revenue: 20,
      refunds: 9,
      purchases: 2,
      purchase_rate: 100,
    });
    const ch = await call(`/v1/sites/${site}/breakdown?period=24h&breakdown=channel&metrics=visitors,revenue&sort=revenue`, { key });
    expect(ch.body.results).toEqual([{ value: "Organic Search", visitors: 1, revenue: 80 }]);
    expect(ch.body.sort).toBe("revenue");
    expect((await call(`/v1/sites/${site}/breakdown?period=24h&breakdown=channel&sort=bounce_rate`, { key })).status).toBe(400);

    // MCP: status and disconnect
    expect((await tool(key, "get_stripe_integration", { site_id: site })).data.integration.connected).toBe(true);
    expect((await tool(key, "connect_stripe", { site_id: site, webhook_secret: SECRET })).data.existing).toBe(true);
    expect((await tool(key, "disconnect_stripe", { site_id: site })).data.disconnected).toBe(true);
    expect((await stripePost(site, checkout)).body.error.code).toBe("webhook_rejected");
    expect((await call(`/v1/sites/${site}/integrations/stripe`, { method: "DELETE", key })).status).toBe(404);
  });

  it("payments API: idempotent batch, list, delete (REST + MCP)", async () => {
    const { key, site, proxyKey } = await newSite("payapi.test");
    const vid = (await beacon(proxyKey, { s: site, u: "https://payapi.test/", r: "https://chatgpt.com/" }, "10.2.0.1")).body.v;
    const post = await call(`/v1/sites/${site}/payments`, {
      method: "POST",
      key,
      json: {
        payments: [
          { id: "txn_1", provider: "paddle", amount: 30, currency: "eur", visitor_id: vid, customer_id: "ctm_1" },
          { id: "txn_2", provider: "paddle", amount: 30, currency: "EUR", type: "renewal", customer_id: "ctm_1" },
          { id: "txn_3", provider: "paddle", amount: -5, currency: "EUR", refunded_payment_id: "txn_1" },
          { id: "txn_4", provider: "paddle", amount: 10, currency: "EUR" },
          { id: "txn_5", provider: "paddle", amount: 10, currency: "EUR", timestamp: Date.now() + DAY },
        ],
      },
    });
    expect(post.status).toBe(202);
    expect(post.body).toMatchObject({ accepted: 4, rejected: 1 });
    expect(post.body.results.map((r: any) => r.linked_by ?? r.reason)).toEqual([
      "visitor",
      "customer",
      "original_payment",
      undefined,
      "timestamp is in the future",
    ]);
    expect(post.body.next_steps.join(" ")).toContain("Unattributed");
    // retry: nothing doubles
    const retry = await call(`/v1/sites/${site}/payments`, {
      method: "POST",
      key,
      json: { id: "txn_1", provider: "paddle", amount: 30, currency: "EUR", visitor_id: vid },
    });
    expect(retry.body.results[0]).toMatchObject({ ok: true, existing: true });
    const list = await call(`/v1/sites/${site}/payments?period=7d`, { key });
    expect(list.body).toMatchObject({ total: 4, revenue: 65, unlinked: 1 });
    expect(list.body.payments.find((p: any) => p.external_id === "txn_1")).toMatchObject({
      channel: "AI Assistants",
      source: "ChatGPT",
      linked: true,
    });
    const unl = list.body.payments.find((p: any) => p.external_id === "txn_4");
    expect(unl).toMatchObject({ linked: false, channel: "Unattributed", visitor_id: null });
    expect((await call(`/v1/sites/${site}/payments/${unl.id}`, { method: "DELETE", key })).body.deleted).toBe(unl.id);
    expect((await call(`/v1/sites/${site}/payments/${unl.id}`, { method: "DELETE", key })).status).toBe(404);
    // MCP
    const rec = await tool(key, "record_payments", {
      site_id: site,
      payments: [{ id: "m_1", amount: 5, currency: "USD", visitor_id: vid }],
    });
    expect(rec.data.accepted).toBe(1);
    const ml = await tool(key, "list_payments", { site_id: site, period: "7d" });
    expect(ml.data.total).toBe(4);
    const del = await tool(key, "delete_payment", { site_id: site, payment_id: ml.data.payments[0].id });
    expect(del.data.deleted).toBe(ml.data.payments[0].id);
  });
});

describe("visitors, sessions, journeys, insights", () => {
  it("REST and MCP over one visitor's sign-up and purchase", async () => {
    // trust_browser_user_id: the payment below carries only a user id that afsa('identify') sent
    const { key, site, proxyKey } = await newSite("people.test", { visitor_id_mode: "persistent", trust_browser_user_id: true });
    await call(`/v1/sites/${site}/goals`, { method: "POST", key, json: { name: "Signup", type: "event", match: "signup" } });
    const first = await beacon(proxyKey, { s: site, u: "https://people.test/", r: "https://www.google.com/" }, "10.3.0.1", {
      country: "FR",
    });
    const vid = first.body.v as string;
    await beacon(
      proxyKey,
      { s: site, n: "signup", u: "https://people.test/pricing", id: vid, i: "user_42", p: { plan: "pro" } },
      "10.3.0.1",
      { country: "FR" },
    );
    await call(`/v1/sites/${site}/payments`, { method: "POST", key, json: { id: "p1", amount: 99, currency: "USD", user_id: "user_42" } });
    await beacon(proxyKey, { s: site, u: "https://people.test/" }, "10.3.0.2", { country: "US" });

    const list = await call(`/v1/sites/${site}/visitors?period=24h&sort=revenue`, { key });
    expect(list.body.total).toBe(2);
    expect(list.body.visitors[0]).toMatchObject({
      id: "user:user_42",
      identified: true,
      revenue: 99,
      country: "FR",
      source: "Google",
      customer: true,
    });
    expect(list.body.identity.mode).toBe("persistent");
    const filtered = await call(`/v1/sites/${site}/visitors?period=24h&filters=country==US`, { key });
    expect(filtered.body.visitors.map((v: any) => v.identified)).toEqual([false]);

    const one = await call(`/v1/sites/${site}/visitors/${encodeURIComponent("user:user_42")}`, { key });
    expect(one.body.visitor).toMatchObject({ user_id: "user_42", visits: 1, revenue: 99 });
    expect(one.body.timeline.map((e: any) => e.name)).toEqual(["pageview", "signup", "payment"]);
    expect(one.body.untrusted).toBeTruthy();
    expect((await call(`/v1/sites/${site}/visitors/nobody_at_all`, { key })).status).toBe(404);
    const sid = one.body.sessions[0].id;
    const sess = await call(`/v1/sites/${site}/sessions/${sid}`, { key });
    expect(sess.body.events).toHaveLength(3);
    expect((await call(`/v1/sites/${site}/sessions/nope`, { key })).status).toBe(400);

    const j = await call(`/v1/sites/${site}/journeys?period=24h&goal=Signup`, { key });
    expect(j.body.summary).toMatchObject({ converters: 1, first_visit_rate: 100 });
    expect(j.body.journeys[0]).toMatchObject({ id: "user:user_42", source: "Google", visits: 1, revenue: 99 });
    expect((await call(`/v1/sites/${site}/journeys?goal=Nope`, { key })).body.error.code).toBe("unknown_goal");

    const ins = await call(`/v1/sites/${site}/insights?period=24h`, { key });
    expect(ins.body.kpis).toMatchObject({ visitors: 2, revenue: 99, converters: 1, conversion_rate: 50, revenue_per_visitor: 49.5 });
    expect(ins.body.revenue_share.device[0]).toMatchObject({ share: 100 });
    expect(ins.body.heatmap.values).toHaveLength(7);

    // MCP mirrors
    expect((await tool(key, "list_visitors", { site_id: site, period: "24h" })).data.total).toBe(2);
    expect((await tool(key, "get_visitor", { site_id: site, visitor: "user:user_42" })).data.visitor.revenue).toBe(99);
    expect((await tool(key, "get_session", { site_id: site, session_id: sid })).data.session.id).toBe(sid);
    expect((await tool(key, "get_journeys", { site_id: site, period: "24h" })).data.summary.converters).toBe(1);
    expect((await tool(key, "get_insights", { site_id: site, period: "24h", goal: "Signup" })).data.target).toEqual({
      type: "goal",
      goal: "Signup",
    });
  });
});

describe("comparisons and top movers", () => {
  it("compare=previous|year|custom with match_weekday, rows, buckets, sort=change, movers (REST + MCP)", async () => {
    const { key, site } = await newSite("compare.test");
    const now = Date.now();
    const evs = [
      ...["a", "b", "c"].map((u) => ({
        name: "pageview",
        url: "https://compare.test/",
        user_id: u,
        referrer: "https://www.google.com/",
        timestamp: now - 8 * DAY,
      })),
      ...["d", "e", "f", "g"].map((u) => ({
        name: "pageview",
        url: "https://compare.test/",
        user_id: u,
        referrer: "https://l.facebook.com/",
        timestamp: now - 2 * DAY,
      })),
    ];
    expect((await call(`/v1/sites/${site}/events`, { method: "POST", key, json: { events: evs } })).body.accepted).toBe(7);
    const s = await call(`/v1/sites/${site}/stats?period=7d&metrics=visitors&breakdown=source&compare=previous`, { key });
    expect(s.body.metrics.visitors).toBe(4);
    expect(s.body.comparison.metrics.visitors).toBe(3);
    expect(s.body.breakdown.results.map((r: any) => [r.value, r.visitors, r.comparison.metrics.visitors])).toEqual([["Facebook", 4, 0]]);
    const ch = await call(`/v1/sites/${site}/breakdown?period=7d&breakdown=source&metrics=visitors&sort=change`, { key });
    expect(ch.body.results.map((r: any) => [r.value, r.change])).toEqual([
      ["Facebook", 4],
      ["Google", -3],
    ]);
    const y = await call(`/v1/sites/${site}/stats?period=7d&metrics=visitors&compare=year&match_weekday=true`, { key });
    expect(y.body.comparison.period).toMatchObject({ mode: "year", match_weekday: true });
    const custom = await call(
      `/v1/sites/${site}/stats?period=7d&metrics=visitors&compare=custom&compare_from=2026-01-01&compare_to=2026-01-07`,
      { key },
    );
    expect(custom.body.comparison.period).toMatchObject({ from: "2026-01-01", to: "2026-01-07", mode: "custom" });
    expect((await call(`/v1/sites/${site}/stats?compare=custom&compare_from=2026-01-01`, { key })).status).toBe(400);
    const ts = await call(`/v1/sites/${site}/timeseries?period=7d&metrics=visitors&compare=previous`, { key });
    expect(ts.body.results[0].comparison).toMatchObject({ metrics: { visitors: expect.any(Number) } });
    expect(ts.body.results.reduce((a: number, r: any) => a + r.comparison.metrics.visitors, 0)).toBe(3);
    const mv = await call(`/v1/sites/${site}/movers?period=7d&breakdown=source`, { key });
    expect(mv.body.gainers.map((r: any) => r.value)).toEqual(["Facebook"]);
    expect(mv.body.losers.map((r: any) => r.value)).toEqual(["Google"]);
    expect((await tool(key, "get_top_movers", { site_id: site, period: "7d", breakdown: "channel" })).data.gainers[0].value).toBe(
      "Organic Social",
    );
    expect((await call(`/v1/sites/${site}/movers?breakdown=goal`, { key })).status).toBe(400);
  });
});

describe("annotations and automatic traffic spikes", () => {
  it("CRUD (REST + MCP), returned with timeseries, capped by MAX_ANNOTATIONS_PER_SITE, spikes written by the alarm", async () => {
    const { key, site } = await newSite("notes.test");
    const today = new Date().toISOString().slice(0, 10);
    const c = await call(`/v1/sites/${site}/annotations`, {
      method: "POST",
      key,
      json: { date: today, title: "Launched v2", description: "pricing page" },
    });
    expect(c.status).toBe(201);
    expect(c.body.annotation).toMatchObject({ date: today, title: "Launched v2", kind: "note" });
    const again = await call(`/v1/sites/${site}/annotations`, { method: "POST", key, json: { date: today, title: "Launched v2" } });
    expect(again.status).toBe(200);
    expect(again.body.existing).toBe(true);
    expect((await call(`/v1/sites/${site}/annotations`, { method: "POST", key, json: { date: "03/11/2026", title: "x" } })).status).toBe(
      400,
    );
    const capped = await callWith({ MAX_ANNOTATIONS_PER_SITE: "1" }, `/v1/sites/${site}/annotations`, {
      method: "POST",
      key,
      json: { title: "Another" },
    });
    expect(capped.status).toBe(403);
    expect(capped.body.error.code).toBe("quota_exceeded");
    const id = c.body.annotation.id as string;
    expect(
      (await call(`/v1/sites/${site}/annotations/${id}`, { method: "PATCH", key, json: { title: "Launched pricing v2" } })).body.annotation
        .title,
    ).toBe("Launched pricing v2");
    const ts = await call(`/v1/sites/${site}/timeseries?period=7d`, { key });
    expect(ts.body.annotations.map((a: any) => a.title)).toEqual(["Launched pricing v2"]);
    expect((await call(`/v1/sites/${site}/annotations?period=7d`, { key })).body.annotations).toHaveLength(1);
    expect((await call(`/v1/sites/${site}/annotations/${id}`, { method: "DELETE", key })).body.deleted).toBe(id);
    expect((await call(`/v1/sites/${site}/annotations/${id}`, { method: "DELETE", key })).status).toBe(404);
    // MCP
    const m = await tool(key, "create_annotation", { site_id: site, title: "Campaign", date: today, end_date: today });
    expect(m.data.annotation.end_date).toBe(today);
    expect(
      (await tool(key, "update_annotation", { site_id: site, annotation_id: m.data.annotation.id, description: "spring" })).data.annotation
        .description,
    ).toBe("spring");
    expect((await tool(key, "list_annotations", { site_id: site })).data.annotations).toHaveLength(1);
    expect((await tool(key, "delete_annotation", { site_id: site, annotation_id: m.data.annotation.id })).data.deleted).toBeTruthy();

    // spike: two visitors a day for two weeks, then 30 from Facebook yesterday; the daily alarm notices
    const today0 = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    const evs: Record<string, unknown>[] = [];
    for (let d = 15; d >= 2; d--)
      for (const i of [1, 2])
        evs.push({
          name: "pageview",
          url: "https://notes.test/",
          user_id: `b${d}_${i}`,
          referrer: "https://www.google.com/",
          timestamp: today0 - d * DAY + 3_600_000,
        });
    for (let i = 0; i < 30; i++)
      evs.push({
        name: "pageview",
        url: "https://notes.test/",
        user_id: `s${i}`,
        referrer: "https://l.facebook.com/",
        timestamp: today0 - DAY + 7_200_000,
      });
    expect((await call(`/v1/sites/${site}/events`, { method: "POST", key, json: { events: evs } })).body.accepted).toBe(58);
    const stub = env.SITE.get(env.SITE.idFromName(site));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const spikes = await call(`/v1/sites/${site}/annotations?kind=traffic_spike`, { key });
    expect(spikes.body.annotations).toHaveLength(1);
    expect(spikes.body.annotations[0]).toMatchObject({
      title: "Traffic spike from Facebook",
      source: "auto",
      details: { visitors: 30, source: "Facebook" },
    });
  });
});

describe("exclusions at ingest", () => {
  it("IP/CIDR (v4+v6), paths, hostnames, countries; counted drops; dry run; verify mentions them", async () => {
    const { key, site, proxyKey } = await newSite("excl.test");
    const bad = await call(`/v1/sites/${site}`, { method: "PATCH", key, json: { exclusions: { ips: ["999.1.1.1"], paths: ["admin"] } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toHaveLength(2);
    const ok = await call(`/v1/sites/${site}`, {
      method: "PATCH",
      key,
      json: {
        exclusions: { ips: ["10.9.0.0/16", "2001:db8::/32"], paths: ["/admin/*"], hostnames: ["staging.excl.test"], countries: ["ru"] },
      },
    });
    expect(ok.body.site.exclusions).toEqual({
      ips: ["10.9.0.0/16", "2001:db8::/32"],
      paths: ["/admin/*"],
      hostnames: ["staging.excl.test"],
      countries: ["RU"],
    });
    const r = await Promise.all([
      beacon(proxyKey, { s: site, u: "https://excl.test/" }, "10.9.3.4"),
      beacon(proxyKey, { s: site, u: "https://excl.test/" }, "2001:db8:1::9"),
      beacon(proxyKey, { s: site, u: "https://excl.test/admin/x" }, "10.8.0.1"),
      beacon(proxyKey, { s: site, u: "https://staging.excl.test/" }, "10.8.0.2"),
      beacon(proxyKey, { s: site, u: "https://excl.test/" }, "10.8.0.3", { country: "RU" }),
      beacon(proxyKey, { s: site, u: "https://excl.test/" }, "10.8.0.4", { country: "DE" }),
    ]);
    expect(r.map((x) => x.body.dropped ?? "kept")).toEqual([
      "excluded_ip",
      "excluded_ip",
      "excluded_path",
      "excluded_hostname",
      "excluded_country",
      "kept",
    ]);
    const ex = await call(`/v1/sites/${site}/exclusions?ip=10.9.200.1`, { key, headers: { "cf-connecting-ip": "198.51.100.77" } });
    expect(ex.body.dropped_last_7d).toEqual({ excluded_ip: 2, excluded_path: 1, excluded_hostname: 1, excluded_country: 1 });
    expect(ex.body.test).toMatchObject({ excluded: true, reason: "excluded_ip", rule: "10.9.0.0/16" });
    expect(ex.body.your_ip).toBe("198.51.100.77");
    const info = await call(`/v1/sites/${site}`, { key });
    expect(info.body.data.dropped_last_7d.excluded_ip.rule).toBe("2001:db8::/32");
    expect(JSON.stringify(info.body)).not.toContain("10.9.3.4");
    const m = await tool(key, "get_exclusions", { site_id: site, url: "https://excl.test/admin/login" });
    expect(m.data.test).toMatchObject({ excluded: true, reason: "excluded_path" });
    const v = await call(`/v1/sites/${site}/verify`, { method: "POST", key, json: { url: "https://excl.test/" } });
    expect(v.body.checks.find((c: any) => c.id === "exclusions").detail).toContain("excluded_ip: 2");
    // clearing
    expect((await call(`/v1/sites/${site}`, { method: "PATCH", key, json: { exclusions: null } })).body.site.exclusions).toBeNull();
  });
});

describe("saved funnels", () => {
  it("CRUD with drop-off, idempotent by name, unknown goals refused, capped by MAX_FUNNELS_PER_SITE (REST + MCP)", async () => {
    const { key, site, proxyKey } = await newSite("funnel.test");
    await call(`/v1/sites/${site}/goals`, { method: "POST", key, json: { name: "Signup", type: "event", match: "signup" } });
    for (const [ip, steps] of [
      ["10.4.0.1", ["/", "/pricing", "signup"]],
      ["10.4.0.2", ["/", "/pricing"]],
      ["10.4.0.3", ["/"]],
    ] as const) {
      for (const s of steps)
        await beacon(
          proxyKey,
          s.startsWith("/") ? { s: site, u: `https://funnel.test${s}` } : { s: site, n: s, u: "https://funnel.test/pricing" },
          ip,
        );
    }
    expect(
      (await call(`/v1/sites/${site}/funnels`, { method: "POST", key, json: { name: "x", steps: ["/", "goal:Nope"] } })).body.error.message,
    ).toContain("Nope");
    const c = await call(`/v1/sites/${site}/funnels`, {
      method: "POST",
      key,
      json: { name: "Signup flow", steps: "/, /pricing, goal:Signup" },
    });
    expect(c.status).toBe(201);
    expect(c.body.funnel.steps).toEqual(["/", "/pricing", "goal:Signup"]);
    expect(
      (
        await call(`/v1/sites/${site}/funnels`, {
          method: "POST",
          key,
          json: { name: "Signup flow", steps: ["/", "/pricing", "goal:Signup"] },
        })
      ).status,
    ).toBe(200);
    const capped = await callWith({ MAX_FUNNELS_PER_SITE: "1" }, `/v1/sites/${site}/funnels`, {
      method: "POST",
      key,
      json: { name: "Second", steps: ["/", "/pricing"] },
    });
    expect(capped.status).toBe(403);
    const id = c.body.funnel.id as string;
    const res = await call(`/v1/sites/${site}/funnels/${id}?period=24h`, { key });
    expect(res.body.funnel.name).toBe("Signup flow");
    expect(res.body.steps.map((s: any) => [s.visitors, s.dropoff])).toEqual([
      [3, 0],
      [2, 1],
      [1, 1],
    ]);
    expect((await call(`/v1/sites/${site}/funnels`, { key })).body.funnels).toHaveLength(1);
    expect(
      (await call(`/v1/sites/${site}/funnels/${id}`, { method: "PATCH", key, json: { steps: ["/", "/pricing"] } })).body.funnel.steps,
    ).toEqual(["/", "/pricing"]);
    expect((await call(`/v1/sites/${site}/funnels/fnl_0000000000000000`, { key })).status).toBe(404);
    // MCP
    const m = await tool(key, "create_funnel", { site_id: site, name: "Pricing", steps: ["/pricing", "event:signup"] });
    expect(m.data.existing).toBe(false);
    expect(
      (await tool(key, "get_funnel", { site_id: site, funnel_id: m.data.funnel.id, period: "24h" })).data.steps.map((s: any) => s.visitors),
    ).toEqual([2, 1]);
    expect((await tool(key, "list_funnels", { site_id: site })).data.funnels).toHaveLength(2);
    expect(
      (await tool(key, "update_funnel", { site_id: site, funnel_id: m.data.funnel.id, name: "Pricing to signup" })).data.funnel.name,
    ).toBe("Pricing to signup");
    expect((await tool(key, "delete_funnel", { site_id: site, funnel_id: m.data.funnel.id })).data.deleted).toBe(m.data.funnel.id);
    expect((await call(`/v1/sites/${site}/funnels/${id}`, { method: "DELETE", key })).body.deleted).toBe(id);
  });
});

describe("tracker data: scroll depth, vitals, scroll goals, 404s", () => {
  it("engagement beacons feed page metrics and scroll goals", async () => {
    const { key, site, proxyKey } = await newSite("vitals.test");
    const g = await call(`/v1/sites/${site}/goals`, {
      method: "POST",
      key,
      json: { name: "Read", type: "scroll", match: "/blog/*", threshold: 75 },
    });
    expect(g.body.goal).toMatchObject({ type: "scroll", threshold: 75 });
    expect(
      (await call(`/v1/sites/${site}/goals`, { method: "POST", key, json: { name: "Bad", type: "event", match: "x", threshold: 5 } }))
        .status,
    ).toBe(400);
    for (const [ip, sd, lcp] of [
      ["10.5.0.1", 90, 1800],
      ["10.5.0.2", 30, 4200],
    ] as const) {
      await beacon(proxyKey, { s: site, u: "https://vitals.test/blog/post" }, ip);
      const e = await beacon(
        proxyKey,
        { s: site, n: "engagement", u: "https://vitals.test/blog/post", e: 12_000, sd, v: [lcp, 120, 50] },
        ip,
      );
      expect(e.body.ok).toBe(true);
    }
    await beacon(
      proxyKey,
      { s: site, n: "404", u: "https://vitals.test/old-link", p: { from: "https://vitals.test/blog/post" } },
      "10.5.0.1",
    );
    const b = await call(
      `/v1/sites/${site}/breakdown?period=24h&breakdown=page&metrics=pageviews,scroll_depth,time_on_page,lcp_p75,inp_p75,cls_p75,conversions`,
      { key },
    );
    expect(b.body.results.find((r: any) => r.value === "/blog/post")).toMatchObject({
      pageviews: 2,
      scroll_depth: 60,
      time_on_page: 12,
      lcp_p75: 4200,
      inp_p75: 120,
      cls_p75: 0.05,
      conversions: 1,
    });
    const broken = await call(`/v1/sites/${site}/breakdown?period=24h&breakdown=prop:from&filters=event_name==404&metrics=events`, { key });
    expect(broken.body.results).toEqual([{ value: "https://vitals.test/blog/post", events: 1 }]);
    const inst = await call(`/v1/sites/${site}/install`, { key });
    expect(inst.body.tracker.not_found_pages).toContain('data-404="true"');
    expect(inst.body.revenue.stripe.webhook_url).toBe(`${B}/webhooks/stripe/${site}`);
  });
});

describe("scopes, schema and docs", () => {
  it("read keys see the new read tools and none of the write tools; REST writes are refused", async () => {
    const { key, site } = await newSite("scope1.test");
    const ro = (await call("/v1/keys", { method: "POST", key, json: { name: "ro", scope: "read" } })).body.api_key as string;
    const names = async (k: string) => ((await mcp(k, "tools/list")).body.result.tools as { name: string }[]).map((t) => t.name);
    const read = [
      "get_top_movers",
      "get_insights",
      "list_visitors",
      "get_visitor",
      "get_session",
      "get_journeys",
      "get_stripe_integration",
      "list_payments",
      "list_annotations",
      "get_exclusions",
      "list_funnels",
    ];
    const write = [
      "connect_stripe",
      "disconnect_stripe",
      "record_payments",
      "delete_payment",
      "create_annotation",
      "update_annotation",
      "delete_annotation",
      "create_funnel",
      "update_funnel",
      "delete_funnel",
    ];
    const roNames = await names(ro);
    const fullNames = await names(key);
    for (const t of read) {
      expect(roNames).toContain(t);
      expect(fullNames).toContain(t);
    }
    for (const t of write) {
      expect(roNames).not.toContain(t);
      expect(fullNames).toContain(t);
    }
    expect(
      (await call(`/v1/sites/${site}/payments`, { method: "POST", key: ro, json: { id: "x", amount: 1, currency: "USD" } })).status,
    ).toBe(403);
    expect(
      (await call(`/v1/sites/${site}/integrations/stripe`, { method: "POST", key: ro, json: { webhook_secret: SECRET } })).status,
    ).toBe(403);
  });

  it("the site's Durable Object is on the current schema; llms.txt documents the new routes and tools", async () => {
    const { site } = await newSite("schema.test");
    const stub = env.SITE.get(env.SITE.idFromName(site));
    expect(await stub.schemaVersion()).toBe(3);
    const llms = (await call("/llms.txt")).body as string;
    for (const s of [
      "/webhooks/stripe/:site_id",
      "/v1/sites/:id/payments",
      "/v1/sites/:id/visitors",
      "/v1/sites/:id/journeys",
      "/v1/sites/:id/insights",
      "/v1/sites/:id/movers",
      "/v1/sites/:id/annotations",
      "/v1/sites/:id/exclusions",
      "/v1/sites/:id/funnels",
      "connect_stripe",
      "get_top_movers",
      "ENCRYPTION_KEY",
      "MAX_ANNOTATIONS_PER_SITE",
      "MAX_FUNNELS_PER_SITE",
      "MAX_EVENTS_PER_SITE_PER_DAY",
      "UNCLAIMED_",
      "browser_revenue",
      "trust_browser_user_id",
      "MAX_SITE_STORAGE_MB",
      "SQL_TIME_BUDGET_MS",
      "match_weekday",
      "data-404",
      "replay_site_id",
      "REPLAY_BASE_URL",
    ])
      expect(llms).toContain(s);
  });
});

describe("replay link: the tracker loads a linked replay site's recorder", () => {
  const RSITE = "rsite_0123456789abcdef";
  const REPLAY = { REPLAY_BASE_URL: "https://replay.example.net/" };
  const loader = `https://replay.example.net/r/${RSITE}.js`;
  /** A beacon through the proxy with some vars changed (REPLAY_BASE_URL, caps). */
  const beaconWith = (over: Record<string, unknown>, proxyKey: string, payload: Record<string, unknown>, ua = UA) =>
    callWith(over, "/_a/e", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "user-agent": ua, "content-type": "text/plain", "x-forwarded-for": "198.51.100.7", "x-afs-proxy-key": proxyKey },
    });

  it("PATCH replay_site_id: validated with a hint, returned by every site response, null (or empty) clears it", async () => {
    const { key, site, created } = await newSite("replaylink.test");
    expect(created.body.site.replay_site_id).toBeNull();
    for (const bad of ["site_0123456789abcdef", "rsite_SHORT", `${RSITE}x`]) {
      const r = await call(`/v1/sites/${site}`, { method: "PATCH", key, json: { replay_site_id: bad } });
      expect(r.status).toBe(400);
      expect(r.body.error.hint).toContain("rsite_");
    }
    const linked = await callWith(REPLAY, `/v1/sites/${site}`, { method: "PATCH", key, json: { replay_site_id: RSITE } });
    expect(linked.status).toBe(200);
    expect(linked.body.site.replay_site_id).toBe(RSITE);
    expect(linked.body.note).toContain("replay.example.net");
    expect((await call(`/v1/sites/${site}`, { key })).body.site.replay_site_id).toBe(RSITE);
    expect((await call("/v1/sites", { key })).body.sites.find((s: { id: string }) => s.id === site).replay_site_id).toBe(RSITE);
    // another setting leaves it alone
    expect((await call(`/v1/sites/${site}`, { method: "PATCH", key, json: { name: "x" } })).body.site.replay_site_id).toBe(RSITE);
    expect((await call(`/v1/sites/${site}`, { method: "PATCH", key, json: { replay_site_id: null } })).body.site.replay_site_id).toBeNull();
    const mcpLinked = await tool(key, "update_site", { site_id: site, replay_site_id: RSITE });
    expect(mcpLinked.data.site.replay_site_id).toBe(RSITE);
    expect((await tool(key, "update_site", { site_id: site, replay_site_id: "nope" })).isError).toBe(true);
    expect((await call(`/v1/sites/${site}`, { method: "PATCH", key, json: { replay_site_id: "" } })).body.site.replay_site_id).toBeNull();
  });

  it("POST /e answers carry r only for a linked site with REPLAY_BASE_URL set, dropped and refused events included", async () => {
    const { key, site, proxyKey } = await newSite("replayload.test", { exclusions: { paths: ["/admin/*"] } });
    const u = "https://replayload.test/";
    // not linked: nothing, with or without REPLAY_BASE_URL
    expect((await beaconWith(REPLAY, proxyKey, { s: site, u })).body).not.toHaveProperty("r");
    await call(`/v1/sites/${site}`, { method: "PATCH", key, json: { replay_site_id: RSITE } });
    // linked, but the deployment has no REPLAY_BASE_URL: the feature is off
    const off = await beaconWith({}, proxyKey, { s: site, u });
    expect(off.body.ok).toBe(true);
    expect(off.body).not.toHaveProperty("r");
    // linked + REPLAY_BASE_URL (a trailing slash is fine)
    const on = await beaconWith(REPLAY, proxyKey, { s: site, u });
    expect(on.status).toBe(202);
    expect(on.body).toMatchObject({ ok: true, r: loader });
    expect(typeof on.body.v).toBe("string");
    // dropped events still carry it: the loader makes its own decisions
    expect((await beaconWith(REPLAY, proxyKey, { s: site, u: "https://replayload.test/admin/x" })).body).toMatchObject({
      ok: false,
      dropped: "excluded_path",
      r: loader,
    });
    expect((await beaconWith(REPLAY, proxyKey, { s: site, u: "https://elsewhere.test/" })).body).toMatchObject({
      dropped: "hostname_not_allowed",
      r: loader,
    });
    expect((await beaconWith(REPLAY, proxyKey, { s: site, u }, "Googlebot/2.1 (+http://www.google.com/bot.html)")).body).toMatchObject({
      dropped: "bot",
      r: loader,
    });
    expect((await beaconWith({}, proxyKey, { s: site, u }, "Googlebot/2.1 (+http://www.google.com/bot.html)")).body).not.toHaveProperty(
      "r",
    );
    // a daily budget refusal too
    const capped = await beaconWith({ ...REPLAY, MAX_EVENTS_PER_SITE_PER_DAY: "1" }, proxyKey, { s: site, u });
    expect(capped.status).toBe(429);
    expect(capped.body).toMatchObject({ ok: false, error: "daily_limit", r: loader });
    // unknown site: no link
    const unknown = await beaconWith(REPLAY, proxyKey, { s: "site_zzzzzzzzzzzzzzzz", u });
    expect(unknown.status).toBe(404);
    expect(unknown.body).not.toHaveProperty("r");
    // unlinked again: gone from the next answer
    await call(`/v1/sites/${site}`, { method: "PATCH", key, json: { replay_site_id: null } });
    expect((await beaconWith(REPLAY, proxyKey, { s: site, u })).body).not.toHaveProperty("r");
  });
});
