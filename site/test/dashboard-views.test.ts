import { describe, expect, it } from "vitest";
import { Browser, call, csrfOf, E, fixtures, serviceCalls, signup, uniqueEmail } from "./helpers";

/** A project with one of everything, claimed by a signed-in owner. */
async function ownedProject(label: string) {
  const agent = await signup(`${label}.test`);
  const tag = label.replace(/[^a-z0-9]/g, "");
  const now = Date.now();
  const ids = {
    site: `site_dash${tag}`,
    container: `ctr_dash${tag}`,
    replay: `rsite_dash${tag}`,
    inbox: `inb_dash${tag}`,
  };
  fixtures.set(agent.accountId, {
    sites: [{ id: ids.site, domain: `${label}.test`, name: null, created_at: now }],
    containers: [{ id: ids.container, domain: `${label}.test`, name: null, live_version: 2, created_at: now }],
    replaySites: [{ id: ids.replay, domain: `${label}.test`, name: null, enabled: true, created_at: now }],
    inboxes: [{ id: ids.inbox, address: `${tag}@afs.test`, display_name: null, last_message_at: null, created_at: now }],
  });
  const link = (await call("POST", "/v1/claim-link", { key: agent.key })).json.url as string;
  const owner = new Browser();
  const path = new URL(link).pathname;
  await owner.signIn(uniqueEmail(label), path);
  const claim = await owner.get(path);
  expect((await owner.post(path, { csrf: csrfOf(claim.text) })).status).toBe(303);
  return { agent, ids, owner, base: `/dashboard/projects/${agent.accountId}` };
}

const lastCall = () => serviceCalls[serviceCalls.length - 1]!;

describe("dashboard: projects, tabs and the views' data", () => {
  it("lists projects as cards and shows the switcher and the menu under your name", async () => {
    const { agent, ids, owner } = await ownedProject("home");
    const r = await owner.get("/dashboard");
    expect(r.status).toBe(200);
    expect(r.text).toContain('data-view="home"');
    expect(r.text).toContain(`data-pcard="${agent.accountId}"`);
    expect(r.text).toContain(`data-sites="[&quot;${ids.site}&quot;]"`);
    expect(r.text).toContain('<script src="/dashboard-app.js" defer></script>');
    expect(r.text).toContain('<link rel="stylesheet" href="/dashboard-app.css">');
    // The switcher lists the project; the menu under your name has Account and Connected apps.
    expect(r.text).toContain('<span class="pick-label">All projects</span>');
    expect(r.text).toContain(`href="/dashboard/projects/${agent.accountId}"`);
    expect(r.text).toContain('href="/dashboard/account">Account</a>');
    expect(r.text).toContain('href="/dashboard/apps">Connected apps</a>');
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    // The old all-sites page now lives on the projects page.
    const old = await owner.get("/dashboard/analytics");
    expect(old.status).toBe(301);
    expect(old.headers.get("location")).toBe("/dashboard");
  });

  it("opens each tab for members, keeps the tab when switching, and 404s for anyone else", async () => {
    const { ids, owner, base } = await ownedProject("tabs");
    const pages: [string, string][] = [
      [`${base}/analytics/${ids.site}`, 'data-view="site"'],
      [`${base}/tags`, 'data-view="tags"'],
      [`${base}/tags/${ids.container}`, `&quot;id&quot;:&quot;${ids.container}&quot;`],
      [`${base}/replay`, 'data-view="replay"'],
      [`${base}/mail/${ids.inbox}`, 'data-view="mail"'],
      [`${base}/settings`, "Project name"],
      [`${base}/keys`, "API keys"],
      [`${base}/members`, "Invite someone"],
    ];
    for (const [path, marker] of pages) {
      const r = await owner.get(path);
      expect(r.status, path).toBe(200);
      expect(r.text, path).toContain(marker);
    }
    // Under the project's name: what to ask its agent from this tab (the facts are under Settings).
    expect((await owner.get(base)).text).toContain('<details class="pick project-ask">');
    expect((await owner.get(base)).text).toContain("Give me an update on our AgentFirstStack project");
    expect((await owner.get(`${base}/tags`)).text).toContain("Check the tags of our AgentFirstStack project");
    expect((await owner.get(`${base}/settings`)).text).toContain("Project id");
    // The switcher on the Tags tab sends you to the other project's Tags tab.
    expect((await owner.get(`${base}/tags`)).text).toMatch(/href="\/dashboard\/projects\/acct_[0-9a-z]+\/tags" aria-current="page"/);
    // Settings has General, API keys and Members.
    const settings = (await owner.get(`${base}/keys`)).text;
    expect(settings).toContain(`<a href="${base}/keys" aria-current="page">API keys</a>`);
    // The Analytics tab opens the first site.
    const go = await owner.get(`${base}/analytics`);
    expect(go.status).toBe(302);
    expect(go.headers.get("location")).toBe(`${base}/analytics/${ids.site}`);
    // Not the project's, or not anyone's: 404.
    expect((await owner.get(`${base}/tags/ctr_someoneelses`)).status).toBe(404);
    expect((await owner.get(`${base}/analytics/site_nosuchsite`)).status).toBe(404);
    const stranger = new Browser();
    await stranger.signIn(uniqueEmail("stranger"));
    for (const path of [`${base}/tags`, `${base}/replay`, `${base}/mail`, `${base}/settings`])
      expect((await stranger.get(path)).status, path).toBe(404);
  });

  it("reads every service's reports as the project, GET and listed paths only", async () => {
    const { agent, ids, owner, base } = await ownedProject("data");
    const filters = JSON.stringify(["and", [["==", "page", ["/pricing"]]]]);
    const stats = await owner.get(
      `${base}/data/analytics/sites/${ids.site}/stats?period=7d&format=csv&filters_json=${encodeURIComponent(filters)}`,
    );
    expect(stats.status).toBe(200);
    expect(stats.headers.get("content-type")).toContain("application/json");
    expect(stats.json.report).toBe(`/v1/sites/${ids.site}/stats`);
    expect(stats.json.query).toEqual({ period: "7d", filters_json: filters }); // format=csv dropped
    expect(lastCall()).toMatchObject({ service: "analytics", account: agent.accountId, internal: E.INTERNAL_TOKEN, authorization: null });

    const ok = [
      `analytics/rollup`,
      `tags/containers/${ids.container}/tag-stats?since=7d`,
      `tags/containers/${ids.container}/events?status=failed`,
      `replay/sites/${ids.replay}/sessions?sort=frustration`,
      `replay/sites/${ids.replay}/metrics`,
      `mail/inboxes/${ids.inbox}/messages`,
      `mail/messages/msg_dash1`,
    ];
    for (const path of ok) {
      const r = await owner.get(`${base}/data/${path}`);
      expect(r.status, path).toBe(200);
      expect(lastCall().service, path).toBe(path.split("/")[0]);
    }
    // Mail is read as text: the HTML body is never fetched.
    expect((await owner.get(`${base}/data/mail/messages/msg_dash1`)).json.query).toEqual({ html: "false" });

    const before = serviceCalls.length;
    const refused = [
      `analytics/sites/${ids.site}/sql`,
      `analytics/sites/${ids.site}/export`,
      `analytics/keys`,
      `tags/containers/${ids.container}/install`,
      `tags/containers/${ids.container}/visitors/v1`,
      `tags/containers/${ids.container}/draft`,
      `replay/sites/${ids.replay}/sessions/rs_1/events`,
      `replay/sites/${ids.replay}/links`,
      `mail/messages/msg_dash1/raw`,
      `mail/messages/msg_dash1/attachments/a1`,
      `mail/domains`,
      `billing/anything`,
    ];
    for (const path of refused) {
      const r = await owner.get(`${base}/data/${path}`);
      expect(r.status, path).toBe(404);
      expect(r.json.error.code, path).toBe("not_found");
    }
    expect((await owner.post(`${base}/data/analytics/sites/${ids.site}/stats`, { csrf: "x" })).status).not.toBe(200);
    expect(serviceCalls.length).toBe(before);

    // Another project's data: a JSON 404, not sent.
    const stranger = new Browser();
    await stranger.signIn(uniqueEmail("stranger2"));
    const r = await stranger.get(`${base}/data/analytics/sites/${ids.site}/stats`);
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("not_found");
    expect(serviceCalls.length).toBe(before);
  });

  it("makes a one-hour player link to watch a session, with the page's CSRF token", async () => {
    const { ids, owner, base } = await ownedProject("watch");
    const page = await owner.get(`${base}/replay`);
    const csrf = /data-csrf="([^"]+)"/.exec(page.text)?.[1] ?? "";
    expect(csrf).not.toBe("");
    const path = `${base}/replay/${ids.replay}/sessions/rs_abc123/watch`;
    const watch = (headers: Record<string, string>) =>
      call("POST", path, { cookie: owner.cookie, headers: { ...headers, accept: "application/json" } });
    expect((await watch({})).status).toBe(403);
    expect((await watch({ "x-csrf": "wrong" })).status).toBe(403);
    const r = await watch({ "x-csrf": csrf });
    expect(r.status).toBe(201);
    expect(r.json.url).toBe("https://replay.afs.test/play/rpt_rs_abc123");
    const sent = serviceCalls[serviceCalls.length - 1]!;
    expect(sent).toMatchObject({ service: "replay", path: `/v1/sites/${ids.replay}/links` });
    expect(JSON.parse(sent.body ?? "{}")).toEqual({ session_id: "rs_abc123", expires_in: 3600 });
  });

  it("sends people who aren't signed in to sign in", async () => {
    const r = await call("GET", "/dashboard");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("/signin");
  });
});
