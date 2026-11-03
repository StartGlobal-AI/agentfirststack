import { describe, expect, it } from "vitest";
import { autoConfigure, cfRequests, toFetchArgs, zoneCandidates } from "../../src/lib/cloudflare-api";
import { CF_SPF, buildDomainRecords, checkDomainDns, evaluateRecord, mergeCloudflareRecords, parseDohData } from "../../src/lib/dns";
import { newWebhookSecret, parseSignatureHeader, signPayload, verifySignature } from "../../src/lib/signing";
import { buildDeliveryRequest, validateWebhookUrl } from "../../src/service/webhooks";

describe("webhook signing", () => {
  it("signs t=<ts>,v1=<hmac(secret, ts.body)> and verifies", async () => {
    const secret = newWebhookSecret();
    expect(secret).toMatch(/^whsec_[0-9a-z]{40}$/);
    const body = JSON.stringify({ id: "evt_1", type: "message.received" });
    const sig = await signPayload(secret, body, 1_800_000_000);
    expect(sig).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(await verifySignature(secret, body, sig, { nowSec: 1_800_000_100 })).toBe(true);
  });
  it("matches openssl (printf '1.{}' | openssl dgst -sha256 -hmac k)", async () => {
    expect(await signPayload("k", "{}", 1)).toBe("t=1,v1=3dd49b2593d0f9a349e9e71c4bde3e2b862c2be4003fe9b4ba81332029310158");
  });
  it("rejects tampered bodies, wrong secrets and stale timestamps", async () => {
    const sig = await signPayload("s1", "body", 1000);
    expect(await verifySignature("s1", "body!", sig, { nowSec: 1000 })).toBe(false);
    expect(await verifySignature("s2", "body", sig, { nowSec: 1000 })).toBe(false);
    expect(await verifySignature("s1", "body", sig, { nowSec: 1000 + 301 })).toBe(false);
    expect(await verifySignature("s1", "body", "garbage", { nowSec: 1000 })).toBe(false);
    expect(parseSignatureHeader("t=5, v1=" + "a".repeat(64))).toEqual({ t: 5, v1: ["a".repeat(64)] });
  });
  it("delivery request carries signature and ids", async () => {
    const job = {
      delivery_id: "whd_1",
      webhook_id: "wh_1",
      event: { id: "evt_1", type: "message.received" as const, created_at: 1, data: { a: 1 } },
    };
    const r = await buildDeliveryRequest("sec", job, 2, 1234);
    expect(r.body).toBe(JSON.stringify(job.event));
    expect(r.headers["x-event-type"]).toBe("message.received");
    expect(r.headers["x-delivery-attempt"]).toBe("2");
    expect(await verifySignature("sec", r.body, r.headers["x-signature"], { nowSec: 1234 })).toBe(true);
  });
  it("webhook URLs must be https (http only for localhost)", () => {
    expect(validateWebhookUrl("https://hooks.example.com/x")).toBe("https://hooks.example.com/x");
    expect(validateWebhookUrl("http://127.0.0.1:9999/h")).toBe("http://127.0.0.1:9999/h");
    expect(() => validateWebhookUrl("http://hooks.example.com/x")).toThrow(/https/);
    expect(() => validateWebhookUrl("https://user:pw@x.com/")).toThrow(/Credentials/);
    expect(() => validateWebhookUrl("nope")).toThrow();
  });
});

describe("DNS record builder", () => {
  const recs = buildDomainRecords("Acme.com");
  it("lists receiving and sending records with relative hosts", () => {
    expect(recs.map((r) => `${r.purpose} ${r.type} ${r.host} ${r.match}`)).toEqual([
      "receiving MX @ mx_host",
      "receiving MX @ mx_host",
      "receiving MX @ mx_host",
      "receiving TXT @ spf_include",
      "receiving TXT cf2024-1._domainkey dkim_present",
      "sending MX cf-bounce mx_host",
      "sending MX cf-bounce mx_host",
      "sending MX cf-bounce mx_host",
      "sending TXT cf-bounce spf_include",
      "sending TXT cf-bounce._domainkey dkim_present",
      "sending TXT _dmarc dmarc_present",
    ]);
    expect(recs.filter((r) => r.type === "MX").map((r) => r.value)).toEqual(
      Array(2).fill(["route1.mx.cloudflare.net", "route2.mx.cloudflare.net", "route3.mx.cloudflare.net"]).flat(),
    );
    expect(recs.find((r) => r.id === "receiving_spf")!.value).toBe("v=spf1 include:_spf.mx.cloudflare.net ~all");
    expect(recs.find((r) => r.id === "sending_dkim")!.name).toBe("cf-bounce._domainkey.acme.com");
  });
  it("parses DoH answers", () => {
    expect(parseDohData("MX", "13 route1.mx.cloudflare.net.")).toEqual({ value: "route1.mx.cloudflare.net", priority: 13 });
    expect(parseDohData("TXT", '"v=DKIM1; k=rsa; " "p=MIIB"')).toEqual({ value: "v=DKIM1; k=rsa; p=MIIB", priority: null });
  });
  it("evaluates each record with a concrete fix", () => {
    const mx = recs[0]!;
    expect(evaluateRecord(mx, ["route2.mx.cloudflare.net", "route1.mx.cloudflare.net"]).status).toBe("pass");
    expect(evaluateRecord(mx, ["aspmx.l.google.com"]).fix).toMatch(/Remove the MX records pointing to aspmx.l.google.com/);
    const spf = recs.find((r) => r.id === "receiving_spf")!;
    expect(evaluateRecord(spf, ["v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net ~all"]).status).toBe("pass");
    expect(evaluateRecord(spf, ["v=spf1 include:_spf.google.com ~all"]).fix).toMatch(
      /Add include:_spf.mx.cloudflare.net to the existing SPF/,
    );
    expect(evaluateRecord(spf, [CF_SPF, "v=spf1 -all"]).fix).toMatch(/2 SPF records/);
    const dkim = recs.find((r) => r.id === "receiving_dkim")!;
    expect(evaluateRecord(dkim, ["v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA"]).status).toBe("pass");
    expect(evaluateRecord(dkim, []).fix).toMatch(/Enable Email Routing/);
    const dmarc = recs.find((r) => r.id === "sending_dmarc")!;
    expect(evaluateRecord(dmarc, ["v=DMARC1; p=quarantine; rua=mailto:x@acme.com"]).status).toBe("pass");
    expect(evaluateRecord(dmarc, ["v=DMARC1"]).status).toBe("fail");
  });
  it("checks live DNS through an injected DoH fetcher", async () => {
    const zone: Record<string, string[]> = {
      "MX acme.com": ["10 route1.mx.cloudflare.net.", "20 route2.mx.cloudflare.net.", "30 route3.mx.cloudflare.net."],
      "TXT acme.com": ['"v=spf1 include:_spf.mx.cloudflare.net ~all"'],
      "TXT cf2024-1._domainkey.acme.com": ['"v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC"'],
    };
    const seen: string[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      seen.push(url);
      expect(new Headers(init?.headers).get("accept")).toBe("application/dns-json");
      const u = new URL(url);
      const key = `${u.searchParams.get("type")} ${u.searchParams.get("name")}`;
      const data = zone[key];
      const type = u.searchParams.get("type") === "MX" ? 15 : 16;
      return Response.json(
        data ? { Status: 0, Answer: data.map((d) => ({ name: u.searchParams.get("name"), type, TTL: 300, data: d })) } : { Status: 3 },
      );
    };
    const res = await checkDomainDns("acme.com", recs, fetcher, 1);
    expect(seen.every((u) => u.startsWith("https://cloudflare-dns.com/dns-query?"))).toBe(true);
    expect(res.receiving).toBe("pass");
    expect(res.sending).toBe("fail");
    expect(res.records.filter((r) => r.status === "fail").map((r) => r.id)).toEqual([
      "sending_mx_1",
      "sending_mx_2",
      "sending_mx_3",
      "sending_spf",
      "sending_dkim",
      "sending_dmarc",
    ]);
    expect(res.next_steps.some((s) => /catch-all/.test(s))).toBe(true);
  });
  it("merges exact values Cloudflare returns (priority, DKIM key)", () => {
    const merged = mergeCloudflareRecords(recs, [
      { type: "MX", name: "acme.com", content: "route1.mx.cloudflare.net", priority: 61 },
      { type: "TXT", name: "cf2024-1._domainkey.acme.com", content: "v=DKIM1; h=sha256; k=rsa; p=REALKEY" },
    ]);
    expect(merged[0]!.priority).toBe(61);
    expect(merged.find((r) => r.id === "receiving_dkim")!.value).toBe("v=DKIM1; h=sha256; k=rsa; p=REALKEY");
  });
});

describe("Cloudflare API request builders (never called for real in tests)", () => {
  it("builds the documented endpoints", () => {
    expect(cfRequests.findZone("acme.com", "acc1")).toEqual({
      method: "GET",
      path: "/zones",
      query: { name: "acme.com", "account.id": "acc1", per_page: "5" },
    });
    expect(cfRequests.enableRouting("z1", "acme.com")).toEqual({
      method: "POST",
      path: "/zones/z1/email/routing/dns",
      body: { name: "acme.com" },
    });
    expect(cfRequests.routingDns("z1")).toEqual({ method: "GET", path: "/zones/z1/email/routing/dns" });
    expect(cfRequests.getCatchAll("z1")).toEqual({ method: "GET", path: "/zones/z1/email/routing/rules/catch_all" });
    expect(cfRequests.setCatchAllToWorker("z1", "sg-mail")).toEqual({
      method: "PUT",
      path: "/zones/z1/email/routing/rules/catch_all",
      body: {
        name: "Catch-all to sg-mail (mail)",
        enabled: true,
        matchers: [{ type: "all" }],
        actions: [{ type: "worker", value: ["sg-mail"] }],
      },
    });
    expect(cfRequests.createSendingSubdomain("z1", "acme.com")).toEqual({
      method: "POST",
      path: "/zones/z1/email/sending/subdomains",
      body: { name: "acme.com" },
    });
    expect(cfRequests.fixSendingDns("z1", "t1")).toEqual({ method: "POST", path: "/zones/z1/email/sending/subdomains/t1/dns" });
    expect(cfRequests.sendingDns("z1", "t1")).toEqual({ method: "GET", path: "/zones/z1/email/sending/subdomains/t1/dns" });
  });
  it("turns requests into fetch arguments with a bearer token", () => {
    const { url, init } = toFetchArgs(cfRequests.setCatchAllToWorker("z1", "w"), "TOKEN");
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones/z1/email/routing/rules/catch_all");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer TOKEN");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string).actions[0]).toEqual({ type: "worker", value: ["w"] });
    expect(toFetchArgs(cfRequests.findZone("a.com"), "T").url).toBe("https://api.cloudflare.com/client/v4/zones?name=a.com&per_page=5");
  });
  it("zone candidates walk up from the most specific name", () => {
    expect(zoneCandidates("mail.acme.co.uk")).toEqual(["mail.acme.co.uk", "acme.co.uk", "co.uk"]);
  });

  type Call = { method: string; path: string; body?: unknown };
  function fakeApi(state: { catchAll?: unknown; routingEnabled?: boolean; sending?: unknown[] }) {
    const calls: Call[] = [];
    const ok = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });
    const fetcher = async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      expect(u.origin).toBe("https://api.cloudflare.com");
      const path = u.pathname.replace("/client/v4", "");
      const method = init?.method ?? "GET";
      calls.push({ method, path, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (path === "/zones") return ok(u.searchParams.get("name") === "acme.com" ? [{ id: "z1", name: "acme.com" }] : []);
      if (path === "/zones/z1/email/routing" && method === "GET") return ok({ enabled: !!state.routingEnabled, status: "ready" });
      if (path === "/zones/z1/email/routing/dns" && method === "POST") return ok({ enabled: true });
      if (path === "/zones/z1/email/routing/dns")
        return ok([{ type: "MX", name: "acme.com", content: "route1.mx.cloudflare.net", priority: 7 }]);
      if (path === "/zones/z1/email/routing/rules/catch_all" && method === "GET")
        return ok(state.catchAll ?? { enabled: false, actions: [{ type: "drop" }] });
      if (path === "/zones/z1/email/routing/rules/catch_all") return ok({ enabled: true });
      if (path === "/zones/z1/email/sending/subdomains" && method === "GET") return ok(state.sending ?? []);
      if (path === "/zones/z1/email/sending/subdomains") return ok({ tag: "t1", name: "acme.com", enabled: true });
      if (path === "/zones/z1/email/sending/subdomains/t1/dns" && method === "POST") return ok({ errors: [] });
      if (path === "/zones/z1/email/sending/subdomains/t1/dns")
        return ok([{ type: "TXT", name: "cf-bounce._domainkey.acme.com", content: "v=DKIM1; p=SENDKEY" }]);
      return Response.json({ success: false, errors: [{ code: 7000, message: "No route" }] }, { status: 404 });
    };
    return { calls, fetcher };
  }

  it("auto_configure: zone lookup, routing on, catch-all -> worker, sending onboarded", async () => {
    const { calls, fetcher } = fakeApi({});
    const r = await autoConfigure(
      "mail.acme.com",
      buildDomainRecords("mail.acme.com"),
      { token: "T", accountId: "acc", workerName: "sg-mail" },
      fetcher,
    );
    expect(r.ok).toBe(true);
    expect(r.zone_id).toBe("z1");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /zones",
      "GET /zones",
      "POST /zones/z1/email/routing/dns",
      "GET /zones/z1/email/routing/dns",
      "GET /zones/z1/email/routing/rules/catch_all",
      "PUT /zones/z1/email/routing/rules/catch_all",
      "GET /zones/z1/email/sending/subdomains",
      "POST /zones/z1/email/sending/subdomains",
      "POST /zones/z1/email/sending/subdomains/t1/dns",
      "GET /zones/z1/email/sending/subdomains/t1/dns",
    ]);
    expect(calls[2]!.body).toEqual({ name: "mail.acme.com" }); // subdomain is always added to Email Routing
    expect(r.next_steps.some((s) => /catch-all rules exist only on the zone apex/.test(s))).toBe(true);
  });

  it("apex with routing already on: no enable call", async () => {
    const { calls, fetcher } = fakeApi({ routingEnabled: true });
    const r = await autoConfigure("acme.com", buildDomainRecords("acme.com"), { token: "T", workerName: "sg-mail" }, fetcher);
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.path === "/zones/z1/email/routing/dns")).toBe(false);
    expect(r.records.find((x) => x.id === "receiving_mx_1")!.priority).toBe(7); // exact value from Cloudflare
  });

  it("never overwrites a catch-all that routes elsewhere unless force", async () => {
    const elsewhere = { enabled: true, actions: [{ type: "forward", value: ["boss@acme.com"] }] };
    const a = fakeApi({ catchAll: elsewhere, routingEnabled: true, sending: [{ tag: "t1", name: "acme.com", enabled: true }] });
    const r = await autoConfigure("acme.com", buildDomainRecords("acme.com"), { token: "T", workerName: "sg-mail" }, a.fetcher);
    expect(r.ok).toBe(false);
    expect(a.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(r.steps.find((s) => s.step === "catch_all_to_worker")!.detail).toMatch(/forward -> boss@acme.com; not changed/);
    const b = fakeApi({ catchAll: elsewhere, routingEnabled: true, sending: [{ tag: "t1", name: "acme.com", enabled: true }] });
    const forced = await autoConfigure(
      "acme.com",
      buildDomainRecords("acme.com"),
      { token: "T", workerName: "sg-mail", force: true },
      b.fetcher,
    );
    expect(forced.ok).toBe(true);
    expect(b.calls.some((c) => c.method === "PUT")).toBe(true);
    expect(b.calls.some((c) => c.method === "POST" && c.path === "/zones/z1/email/sending/subdomains")).toBe(false); // already onboarded
    expect(forced.records.find((x) => x.id === "sending_dkim")!.value).toBe("v=DKIM1; p=SENDKEY");
  });

  it("reports a missing zone without further calls", async () => {
    const { calls, fetcher } = fakeApi({});
    const r = await autoConfigure("other.org", buildDomainRecords("other.org"), { token: "T", workerName: "w" }, fetcher);
    expect(r.ok).toBe(false);
    expect(calls.every((c) => c.path === "/zones")).toBe(true);
  });
});
