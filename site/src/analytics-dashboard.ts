import { ApiError, type AttackItem } from "@afs/shared";
import { type Context, Hono } from "hono";
import { dashPage, projectHeader, projectId, projectName } from "./dashboard-frame";
import { attackPrompt } from "./email-messages";
import type { SiteEnv } from "./env";
import { siteBase } from "./google";
import { type SafeHtml, html } from "./html";
import { type Project, requireProject } from "./identity";
import { type AttackService, serviceAttacks } from "./project-health";
import { callService, type SiteItem } from "./services";
import { askLine, attacksView } from "./views";

/**
 * A project's Analytics tab: one site's traffic, sources, pages, locations, devices, goals,
 * funnels, crawlers, live visitors and insights (/dashboard/projects/:id/analytics/:site).
 *
 * The page is a shell; /dashboard-app.js draws it from the analytics API's own answers, read
 * through the dashboard's read-only data route (src/service-views.ts). So the dashboard shows
 * exactly what the project's agent gets from GET /v1/sites/:id/stats, breakdown, timeseries and
 * the rest, and anything it can show, an agent can fetch too.
 */

export const analyticsDashboard = new Hono<SiteEnv>();

const SITE_ID = /^site_[0-9a-z]{1,64}$/;

const param = (c: Context<SiteEnv>, name: string, re: RegExp, what: string) => {
  const v = c.req.param(name) ?? "";
  if (!re.test(v)) throw new ApiError(404, "not_found", `${what} not found.`);
  return v;
};

/** JSON for a data-* attribute (html`` escapes it). */
const data = (v: unknown) => JSON.stringify(v);

/**
 * The Analytics and Tags tabs' banner when one of the project's sites or containers is getting
 * suspicious traffic (or did in the last 24 hours), from that service's own usage answer: one call
 * made alongside the page's own (tabAttacks), nothing when it fails.
 */
export const tabAttacks = (c: Context<SiteEnv>, p: Project, service: AttackService): Promise<AttackItem[]> =>
  serviceAttacks(c.env, p.id, service).catch(() => []);

export function attackBanner(c: Context<SiteEnv>, p: Project, attacks: AttackItem[], current?: string): SafeHtml | "" {
  if (!attacks.length) return "";
  return html`<div class="bento attack-bento">${attacksView(attacks, {
    name: projectName(p),
    prompt: attackPrompt(siteBase(c), projectName(p), attacks),
    projectId: p.id,
    current,
  })}</div>`;
}

export const NOSCRIPT = html`<noscript><p class="notice notice-error">This view needs JavaScript. Your agent can read the same numbers from the API.</p></noscript>`;

// The old all-sites page: every project now shows its numbers on the projects page.
analyticsDashboard.get("/analytics", (c) => c.redirect("/dashboard", 301));

// The Analytics tab: straight to the first site, or how to add one.
analyticsDashboard.get("/projects/:id/analytics", async (c) => {
  const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
  const sites = await callService<{ sites?: SiteItem[] }>(c.env, "analytics", p.id, "/v1/sites");
  const site = sites.json?.sites?.[0];
  if (site) return c.redirect(`/dashboard/projects/${p.id}/analytics/${site.id}${new URL(c.req.url).search}`, 302);
  return dashPage(c, {
    title: "Analytics",
    project: p,
    tab: "analytics",
    body: html`${projectHeader(p, "analytics")}
<section class="tile empty">
  <h3>${sites.ok ? "No analytics on this project yet" : "Analytics didn't answer"}</h3>
  <p>${sites.ok ? "When your agent adds analytics to a site, its visitors, sources and conversions show up here." : "Try again in a minute."}</p>
  ${sites.ok ? askLine("Add AgentFirstStack analytics to my website.", "Ask your agent") : ""}
</section>`,
  });
});

// One site.
analyticsDashboard.get("/projects/:id/analytics/:site", async (c) => {
  const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
  const siteId = param(c, "site", SITE_ID, "Site");
  const [one, all, attacks] = await Promise.all([
    callService<{ site?: { id: string; domain: string; name: string | null; currency: string | null; timezone: string } }>(
      c.env,
      "analytics",
      p.id,
      `/v1/sites/${siteId}`,
    ),
    callService<{ sites?: SiteItem[] }>(c.env, "analytics", p.id, "/v1/sites"),
    tabAttacks(c, p, "analytics"),
  ]);
  if (one.status === 404) throw new ApiError(404, "not_found", "Site not found.");
  const site = one.json?.site;
  if (!one.ok || !site) throw new ApiError(502, "analytics_unavailable", "Analytics didn't answer. Try again in a minute.");
  return dashPage(c, {
    title: `${site.domain} analytics`,
    project: p,
    tab: "analytics",
    scripts: ["/dashboard-app.js"],
    styles: ["/dashboard-app.css"],
    body: html`${projectHeader(p, "analytics")}
${attackBanner(c, p, attacks, site.id)}
<div class="afa" id="afa" data-view="site" data-project="${p.id}" data-site="${data({
      id: site.id,
      domain: site.domain,
      name: site.name,
      currency: site.currency,
      timezone: site.timezone,
    })}" data-sites="${data((all.json?.sites ?? []).map((x) => ({ id: x.id, domain: x.domain })))}">${NOSCRIPT}</div>`,
  });
});
