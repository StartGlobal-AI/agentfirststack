/**
 * The shared dashboard (routes/share.ts, service/share.ts shareReport): on the user-content host a
 * share link's page is the dashboard itself (dashboard-app.js in shared mode), reading one report
 * at a time from <base>/<token>/data/<report>. Aggregates only, standard dimensions only, the
 * link's segment always, nothing of one person.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const B = "http://analytics.test";
const UC = "https://usercontent.test";
const over = { USER_CONTENT_BASE_URL: UC, ABUSE_REPORT_URL: "https://platform.test/report-abuse" };

async function fetchAt(url: string, init: RequestInit & { key?: string; json?: unknown; vars?: Record<string, unknown> } = {}) {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(url, { ...init, headers, redirect: "manual", body: init.json !== undefined ? JSON.stringify(init.json) : init.body }),
    { ...env, ...(init.vars ?? over) } as typeof env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, headers: res.headers, body, text };
}

const api = (path: string, init: Parameters<typeof fetchAt>[1] = {}) => fetchAt(`${B}${path}`, init);

/** A verified site with three visitors today: two from Germany (/ and /pricing), one from France (/blog/a). */
async function sharedSite(domain: string) {
  const key = (await api("/v1/signup", { method: "POST", vars: { ...over, SIGNUP_LIMITER: undefined } })).body.api_key as string;
  const created = (await api("/v1/sites", { method: "POST", key, json: { domain } })).body;
  const site = created.site.id as string;
  const proxyKey = created.install.first_party_proxy.proxy_key as string;
  await env.DB.prepare("UPDATE sites SET verified_at = ?, verify_method = 'dns_txt' WHERE id = ?").bind(Date.now(), site).run();
  const visit = (path: string, ip: string, country: string) =>
    api("/_a/e", {
      method: "POST",
      body: JSON.stringify({ s: site, u: `https://${domain}${path}` }),
      headers: {
        "user-agent": UA,
        "content-type": "text/plain",
        "x-forwarded-for": ip,
        "x-afs-proxy-key": proxyKey,
        "x-afs-geo-country": country,
      },
    });
  await visit("/", "10.61.0.1", "DE");
  await visit("/pricing", "10.61.0.2", "DE");
  await visit("/blog/a", "10.61.0.3", "FR");
  return { key, site };
}

async function shareLink(key: string, site: string, json: Record<string, unknown> = {}) {
  const made = (await api(`/v1/sites/${site}/share`, { method: "POST", key, json })).body;
  return { url: made.url as string, token: made.token as string };
}

describe("the shared dashboard on the user-content host", () => {
  it("is the dashboard: its files from this host, its facts in data attributes, no inline code", async () => {
    const { key, site } = await sharedSite("sd-page.test");
    const { url, token } = await shareLink(key, site);
    const page = await fetchAt(url);
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy")!;
    for (const rule of ["script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'none'"])
      expect(csp).toContain(rule);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("nonce-");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("x-robots-tag")).toContain("noindex");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.text).toContain('<script src="/dashboard-app.js" defer></script>');
    expect(page.text).toContain('<link rel="stylesheet" href="/dashboard-app.css">');
    expect(page.text).toContain(`data-share="/a/${token}"`);
    expect(page.text).toContain('data-view="site"');
    // Every script is a file: no inline code for the CSP to allow.
    expect(page.text).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(page.text).not.toMatch(/\sstyle=/);
    const attr = /data-site="([^"]*)"/.exec(page.text)![1]!.replace(/&quot;/g, '"');
    expect(JSON.parse(attr)).toMatchObject({ id: "shared", domain: "sd-page.test" });
    // The site's id stays private; the owner's API key is never on the page.
    expect(page.text).not.toContain(site);
    expect(page.text).not.toContain(key);
    expect(page.text).toContain(`https://platform.test/report-abuse?url=${encodeURIComponent(url)}`);
    expect(page.text).toContain('href="https://platform.test/">Made with AgentFirstStack</a>');

    // The service host (no user-content host there) keeps the standalone page.
    const standalone = await api(`/share/${token}`, { vars: {} });
    expect(standalone.status).toBe(200);
    expect(standalone.text).toContain('BASE="/share"');
    expect(standalone.text).not.toContain("dashboard-app.js");
  });

  it("answers the dashboard's reports, aggregates only, cached publicly for a minute", async () => {
    const { key, site } = await sharedSite("sd-reports.test");
    await api(`/v1/sites/${site}/goals`, { method: "POST", key, json: { name: "Pricing", type: "pageview", match: "/pricing" } });
    const funnel = (await api(`/v1/sites/${site}/funnels`, { method: "POST", key, json: { name: "Buy", steps: ["/", "/pricing"] } })).body
      .funnel;
    const { url } = await shareLink(key, site);
    // AI search reads the site's robots.txt (cached an hour): an empty one, so the test stays offline.
    await caches.default.put(
      new Request("https://robots-cache.internal/sd-reports.test"),
      new Response("", { headers: { "cache-control": "max-age=3600" } }),
    );

    const stats = await fetchAt(`${url}/data/stats?period=7d&compare=previous`);
    expect(stats.status).toBe(200);
    expect(stats.body.metrics.visitors).toBe(3);
    expect(stats.headers.get("cache-control")).toBe("public, max-age=60");
    expect(stats.headers.get("x-robots-tag")).toContain("noindex");

    const pages = await fetchAt(`${url}/data/breakdown?period=7d&breakdown=page&limit=10`);
    expect(pages.body.results.map((r: { value: string }) => r.value).sort()).toEqual(["/", "/blog/a", "/pricing"]);
    const de = await fetchAt(`${url}/data/stats?period=7d&filters_json=${encodeURIComponent('["and",[["==","country",["DE"]]]]')}`);
    expect(de.body.metrics.visitors).toBe(2);

    for (const path of [
      "timeseries?period=7d",
      "goals",
      "funnels",
      `funnels/${funnel.id}?period=7d`,
      "insights?period=7d",
      "crawlers?period=7d&by=category",
      "ai-search?period=7d",
      "web-vitals?period=7d",
    ]) {
      const r = await fetchAt(`${url}/data/${path}`);
      expect(r.status, path).toBe(200);
    }
    expect((await fetchAt(`${url}/data/goals`)).body.goals[0]).toMatchObject({ name: "Pricing" });
    expect((await fetchAt(`${url}/data/funnels/${funnel.id}?period=7d`)).body.steps[0].visitors).toBe(1);

    // Realtime: the counts, never its list of events (one visitor at a time).
    const live = await fetchAt(`${url}/data/realtime`);
    expect(live.status).toBe(200);
    expect(Object.keys(live.body).sort()).toEqual(["online", "pageviews_last_30m", "visitors_last_30m", "visitors_last_5m"]);
    expect(live.body.visitors_last_30m).toBe(3);
    expect(live.text).not.toContain("visitor_id");
    expect(live.headers.get("cache-control")).toBe("public, max-age=15");
  });

  it("refuses what isn't aggregate, and anything but the standard dimensions", async () => {
    const { key, site } = await sharedSite("sd-refuse.test");
    const { url } = await shareLink(key, site);
    for (const path of [
      "visitors",
      "journeys",
      "sessions",
      "web-vitals/lab",
      "sql",
      "export",
      "people",
      "funnels/nope",
      "realtime/stream",
    ]) {
      const r = await fetchAt(`${url}/data/${path}`);
      expect(r.status, path).toBe(404);
    }
    for (const q of [
      "breakdown?breakdown=prop:plan",
      "breakdown?breakdown=country,user:email",
      "stats?filters=prop:plan==pro",
      "stats?filters=did==signup",
      `stats?filters_json=${encodeURIComponent('["or",[["==","country",["DE"]],["==","user:email",["a@b.test"]]]]')}`,
    ]) {
      const r = await fetchAt(`${url}/data/${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error.code, q).toBe("not_shared");
    }
    // Rows are capped rather than refused (web-vitals alone takes at most 100); no paging past them.
    expect((await fetchAt(`${url}/data/web-vitals?period=7d&breakdown=page&limit=500`)).status).toBe(200);
    const first = await fetchAt(`${url}/data/breakdown?period=7d&breakdown=page&sort=value`);
    const skipped = await fetchAt(`${url}/data/breakdown?period=7d&breakdown=page&sort=value&offset=2`);
    expect(skipped.body.results).toEqual(first.body.results);
    // A revoked link's reports stop.
    await api(`/v1/sites/${site}/share`, { method: "DELETE", key });
    expect((await fetchAt(`${url}/data/stats?period=30d`)).status).toBe(404);
  });

  it("a segment link shows only that segment, whatever the viewer asks, and no AI search", async () => {
    const { key, site } = await sharedSite("sd-segment.test");
    const seg = (await api(`/v1/sites/${site}/segments`, { method: "POST", key, json: { name: "Germany", filters: "country==DE" } })).body
      .segment;
    await api(`/v1/sites/${site}/segments`, { method: "POST", key, json: { name: "France", filters: "country==FR" } });
    const { url } = await shareLink(key, site, { segment: "Germany" });
    const page = await fetchAt(url);
    expect(page.text).toContain('data-share-segment="Germany"');
    expect(page.text).toContain("Only the Germany segment&#39;s traffic.");

    expect((await fetchAt(`${url}/data/stats?period=7d`)).body.metrics.visitors).toBe(2);
    expect((await fetchAt(`${url}/data/stats?period=7d&segment=France`)).body.metrics.visitors).toBe(2);
    const countries = await fetchAt(`${url}/data/breakdown?period=7d&breakdown=country`);
    expect(countries.body.results.map((r: { value: string }) => r.value)).toEqual(["DE"]);
    expect((await fetchAt(`${url}/data/realtime`)).body.visitors_last_30m).toBe(2);
    for (const path of ["crawlers?period=7d", "ai-search?period=7d"]) {
      const r = await fetchAt(`${url}/data/${path}`);
      expect(r.status, path).toBe(403);
      expect(r.body.error.code, path).toBe("not_in_segment");
    }
    await api(`/v1/sites/${site}/segments/${seg.id}`, { method: "DELETE", key });
    const gone = await fetchAt(`${url}/data/stats?period=30d`);
    expect(gone.status).toBe(404);
    expect(gone.body.error.hint).toContain("segment");
  });

  it("a password link's reports need the cookie or the header, and are never cached publicly", async () => {
    const { key, site } = await sharedSite("sd-password.test");
    const { url } = await shareLink(key, site, { password: "correct horse battery", label: "board" });
    const locked = await fetchAt(`${url}/data/stats?period=7d`);
    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe("share_password_required");
    const open = await fetchAt(`${url}/data/stats?period=7d`, { headers: { "x-share-password": "correct horse battery" } });
    expect(open.status).toBe(200);
    expect(open.body.metrics.visitors).toBe(3);
    expect(open.headers.get("cache-control")).toBe("private, max-age=60");
    // Still locked for the next viewer: nothing was cached for them.
    expect((await fetchAt(`${url}/data/stats?period=7d`)).status).toBe(401);
  });
});
