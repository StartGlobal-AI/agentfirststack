import { runInDurableObject } from "cloudflare:test";
import { createApiKey, hmacSha256Hex } from "@afs/shared";
import { describe, expect, it } from "vitest";
import type { ReplaySiteDO } from "../../src/do/site-do";
import { webhookUrlProblem } from "../../src/lib/webhook-url";
import { forgetHooks } from "../../src/service/webhooks";
import { click, error, hide, meta, mutation, page, snapshot } from "../fixtures/rrweb";
import { call, E, hosted, newSid, newSite, postF, sendChunk, tool } from "./helpers";

/** Outbound fetches to the receiver are captured; `answer` decides the status. */
function receiver(answer: (n: number) => number = () => 200) {
  const got: { url: string; headers: Record<string, string>; body: string }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://hooks.example.test/")) return orig(input, init);
    got.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body ?? "") });
    return new Response("ok", { status: answer(got.length) });
  }) as typeof fetch;
  return { got, restore: () => void (globalThis.fetch = orig) };
}

describe("9. signed webhooks", () => {
  it("URL rules: https, no credentials, no IP literals, never the deployment itself", () => {
    const env = { PUBLIC_BASE_URL: "https://replay.agentfirststack.com", AUTH_ISSUER: "https://agentfirststack.com" };
    expect(webhookUrlProblem("https://hooks.example.test/x", env)).toBeNull();
    expect(webhookUrlProblem("http://hooks.example.test/x", env)).toMatch(/https/);
    expect(webhookUrlProblem("https://u:p@hooks.example.test/x", env)).toMatch(/credentials/);
    expect(webhookUrlProblem("https://10.0.0.1/x", env)).toMatch(/IP/);
    expect(webhookUrlProblem("https://[::1]/x", env)).toMatch(/localhost/);
    expect(webhookUrlProblem("https://mail.agentfirststack.com/x", env)).toMatch(/this deployment/);
    expect(webhookUrlProblem("http://localhost:9000/x", { DEV_MODE: "true" })).toBeNull();
    expect(webhookUrlProblem("https://hooks.example.test:8443/x", env)).toMatch(/443/);
  });

  it("create (secret once, idempotent, capped, permanent keys only), test, survey.response delivered and signed", async () => {
    const { key, account, site } = await newSite("shop.test");
    const bad = await call("POST", "/v1/webhooks", { key, body: { url: "https://10.1.2.3/h", events: ["error.new"] } });
    expect(bad.json.error.hint).toContain("hostname");
    const token = (await createApiKey(E.AUTH_DB ?? E.DB, account, { keyPrefix: "afs", expiresAt: Date.now() + 3_600_000 })).key;
    expect(
      (await call("POST", "/v1/webhooks", { key: token, body: { url: "https://hooks.example.test/a", events: ["error.new"] } })).json.error
        .code,
    ).toBe("temporary_credential");
    const c = await call("POST", "/v1/webhooks", {
      key,
      body: { url: "https://hooks.example.test/a", events: ["survey.response", "error.new"], site_id: site },
    });
    expect(c.status).toBe(201);
    const secret = c.json.secret as string;
    expect(secret).toMatch(/^whsec_/);
    const id = c.json.webhook.id as string;
    const again = await call("POST", "/v1/webhooks", {
      key,
      body: { url: "https://hooks.example.test/a", events: ["error.new"], site_id: site },
    });
    expect(again.status).toBe(200);
    expect(again.json.secret).toBeUndefined();
    expect(again.json.webhook.events).toEqual(["error.new"]);
    await call("POST", "/v1/webhooks", {
      key,
      body: { url: "https://hooks.example.test/a", events: ["survey.response", "error.new"], site_id: site },
    });
    const capped = await call("POST", "/v1/webhooks", {
      key,
      body: { url: "https://hooks.example.test/b", events: ["error.new"] },
      env: hosted({ MAX_WEBHOOKS_PER_ACCOUNT: "1" }),
    });
    expect(capped.json.error.code).toBe("quota_exceeded");
    const r = receiver();
    try {
      const t = (await call("POST", `/v1/webhooks/${id}/test`, { key })).json;
      expect(t).toMatchObject({ delivered: true, response_status: 200 });
      const sig = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(r.got[0]!.headers["x-signature"]!)!;
      expect(sig[2]).toBe(await hmacSha256Hex(secret, `${sig[1]}.${r.got[0]!.body}`));
      expect(r.got[0]!.headers["x-event-type"]).toBe("webhook.test");
      // a completed survey response is delivered right after the response
      forgetHooks(account);
      const sv = (
        await call("POST", `/v1/sites/${site}/surveys`, {
          key,
          body: { name: "S", kind: "popover", template: "free_text", status: "active" },
        })
      ).json.survey.id;
      expect((await postF({ s: site, sv, r: "w000000000000001", a: { q1: "the pay button is broken" }, d: 1 })).status).toBe(202);
      const ev = r.got.map((g) => JSON.parse(g.body)).find((b) => b.type === "survey.response");
      expect(ev).toMatchObject({ site_id: site, data: { survey_id: sv, untrusted: { answers: { q1: "the pay button is broken" } } } });
      const log = (await call("GET", `/v1/webhooks/${id}`, { key })).json.webhook.deliveries;
      expect(log.map((d: { event_type: string; status: string }) => [d.event_type, d.status])).toContainEqual([
        "survey.response",
        "delivered",
      ]);
    } finally {
      r.restore();
    }
    expect((await tool(key, "list_webhooks", {})).data.webhooks).toHaveLength(1);
    expect((await tool(key, "delete_webhook", { webhook_id: id })).data.deleted).toBe(id);
  });

  it("error.new once per group, retries on the site's alarm with backoff, 410 disables, segment.session once", async () => {
    const { key, account, site } = await newSite("shop.test");
    const seg = (await call("POST", `/v1/sites/${site}/segments`, { key, body: { name: "Errors", filters: { has_error: true } } })).json
      .segment.id;
    await call("POST", "/v1/webhooks", { key, body: { url: "https://hooks.example.test/e", events: ["error.new"], site_id: site } });
    const s = await call("POST", "/v1/webhooks", {
      key,
      body: { url: "https://hooks.example.test/s", events: ["segment.session"], site_id: site, segment_id: seg },
    });
    expect(s.status).toBe(201);
    expect(
      (await call("POST", "/v1/webhooks", { key, body: { url: "https://hooks.example.test/x", events: ["segment.session"] } })).status,
    ).toBe(400);
    forgetHooks(account);
    const r = receiver((n) => (n === 1 ? 500 : 200));
    try {
      const sid = newSid();
      const T = Date.now() - 30_000;
      await sendChunk(site, sid, 0, [meta(T), snapshot(T + 1), page(T + 5, 1, "/checkout")]);
      await sendChunk(
        site,
        sid,
        1,
        [click(T + 1000, 1, "#pay"), mutation(T + 1050), error(T + 1100, 1, "TypeError: boom"), hide(T + 2000, 1)],
        { extra: { end: 1 } },
      );
      // the same error again in another session: not new
      const sid2 = newSid();
      await sendChunk(site, sid2, 0, [meta(T), snapshot(T + 1), page(T + 5, 1, "/"), error(T + 100, 1, "TypeError: boom")], {
        extra: { end: 1 },
      });
      const types = () => r.got.map((g) => JSON.parse(g.body).type as string);
      expect(types().filter((t) => t === "error.new")).toHaveLength(1);
      expect(types().filter((t) => t === "segment.session")).toHaveLength(2); // two sessions entered the segment
      const first = JSON.parse(r.got[0]!.body);
      expect(r.got[0]!.headers["x-delivery-attempt"]).toBe("1");
      // the first attempt got a 500: retrying, and the site's alarm sends it again when due
      const row = await E.DB.prepare("SELECT * FROM webhook_deliveries WHERE event_id = ?")
        .bind(first.id)
        .first<{ status: string; next_at: number; id: string }>();
      expect(row!.status).toBe("retrying");
      await E.DB.prepare("UPDATE webhook_deliveries SET next_at = ? WHERE id = ?")
        .bind(Date.now() - 1, row!.id)
        .run();
      // the site's alarm when the retry is due (run here directly, so the test doesn't race a real alarm)
      const stub = E.SITE.get(E.SITE.idFromName(site));
      await runInDurableObject(stub, async (instance: ReplaySiteDO, st: DurableObjectState) => {
        st.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('webhook_at', ?)", String(Date.now() - 1));
        await instance.alarm();
      });
      const after = await E.DB.prepare("SELECT status, attempts FROM webhook_deliveries WHERE id = ?").bind(row!.id).first();
      expect(after).toMatchObject({ status: "delivered", attempts: 2 });
      expect(r.got.at(-1)!.headers["x-delivery-attempt"]).toBe("2");
      // the same session ending again (next page) doesn't enter the segment twice
      await sendChunk(site, sid, 2, [page(T + 3000, 2, "/x"), hide(T + 4000, 2)], { extra: { end: 1 } });
      expect(types().filter((t) => t === "segment.session")).toHaveLength(2);
    } finally {
      r.restore();
    }
    const gone = receiver(() => 410);
    try {
      const id = s.json.webhook.id;
      await call("POST", `/v1/webhooks/${id}/test`, { key });
      expect((await call("GET", `/v1/webhooks/${id}`, { key })).json.webhook.enabled).toBe(false);
    } finally {
      gone.restore();
    }
  });

  it("unverified sites can't have webhooks; deliveries stop at the daily cap; MCP test_webhook", async () => {
    const un = await newSite("trial.test", {}, undefined, { verified: false });
    expect(
      (
        await call("POST", "/v1/webhooks", {
          key: un.key,
          body: { url: "https://hooks.example.test/u", events: ["error.new"], site_id: un.site },
        })
      ).json.error.code,
    ).toBe("domain_not_verified");
    const { key, account, site } = await newSite("shop.test");
    const id = (await call("POST", "/v1/webhooks", { key, body: { url: "https://hooks.example.test/c", events: ["error.new"] } })).json
      .webhook.id;
    forgetHooks(account);
    const r = receiver();
    try {
      const env = hosted({ MAX_WEBHOOK_DELIVERIES_PER_ACCOUNT_PER_DAY: "1" });
      const T = Date.now() - 30_000;
      await sendChunk(site, newSid(), 0, [meta(T), page(T + 5, 1, "/"), error(T + 10, 1, "A is broken")], { env });
      await sendChunk(site, newSid(), 0, [meta(T), page(T + 5, 1, "/"), error(T + 10, 1, "B is broken")], { env });
      // (other tests' sites may retry their own deliveries meanwhile: count this webhook's only)
      expect(r.got.filter((g) => g.headers["x-webhook-id"] === id)).toHaveLength(1);
      const log = (await call("GET", `/v1/webhooks/${id}`, { key })).json.webhook.deliveries;
      expect(log.map((d: { status: string }) => d.status).sort()).toEqual(["delivered", "dropped"]);
      expect((await tool(key, "test_webhook", { webhook_id: id })).data.delivered).toBe(true);
      expect((await tool(key, "get_webhook", { webhook_id: id })).data.webhook.deliveries.length).toBe(3);
    } finally {
      r.restore();
    }
  });
});
