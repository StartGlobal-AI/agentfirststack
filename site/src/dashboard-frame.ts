import { ApiError } from "@afs/shared";
import type { Context } from "hono";
import type { SiteEnv } from "./env";
import { type PageOptions, type SafeHtml, html, page } from "./html";
import { type Project, listProjects } from "./identity";

/**
 * The frame every dashboard page shares: the top bar's project switcher, and a project's header
 * with its tabs (Overview, Analytics, Tags, Replay, Mail, Settings).
 */

export const PROJECT_ID = /^acct_[0-9a-z]{1,64}$/;

export const projectId = (c: Context<SiteEnv>) => {
  const id = c.req.param("id") ?? "";
  if (!PROJECT_ID.test(id)) throw new ApiError(404, "not_found", "Project not found.");
  return id;
};

export const projectName = (p: { name: string | null }) => p.name || "Untitled project";

export type ProjectTab = "overview" | "analytics" | "tags" | "replay" | "mail" | "settings";
export type SettingsTab = "general" | "keys" | "members";

/** Where the switcher takes you in another project: the same tab. */
const SWITCH_TO: Record<ProjectTab, string> = {
  overview: "",
  analytics: "analytics",
  tags: "tags",
  replay: "replay",
  mail: "mail",
  settings: "settings",
};

/** page() with the project switcher filled in (one D1 query for the person's projects). */
export async function dashPage(
  c: Context<SiteEnv>,
  opts: PageOptions & { project?: Project; tab?: ProjectTab; settingsTab?: SettingsTab },
): Promise<Response> {
  const s = c.var.session;
  const projects = await listProjects(c.env.DB, s.user.id);
  const tab = opts.tab ? SWITCH_TO[opts.tab] : undefined;
  return page({
    ...opts,
    // Every dashboard page loads the app: its views, and moving between pages without reloading.
    scripts: [...new Set([...(opts.scripts ?? []), "/dashboard-app.js"])],
    styles: [...new Set([...(opts.styles ?? []), "/dashboard-app.css"])],
    session: s,
    switcher: {
      projects: projects.map((p) => ({ id: p.id, name: projectName(p) })),
      current: opts.project ? { id: opts.project.id, name: projectName(opts.project) } : undefined,
      tab: opts.tab === "settings" && opts.settingsTab && opts.settingsTab !== "general" ? opts.settingsTab : tab || undefined,
    },
  });
}

/**
 * What to ask the project's agent from each tab: the dashboard shows the numbers, the agent can
 * explain them and act. The project's facts (id, role, dates) are under Settings, General.
 */
function askFor(p: Project, tab: ProjectTab): string {
  const name = `our AgentFirstStack project ${projectName(p)}`;
  switch (tab) {
    case "analytics":
      return `How did ${name} do this week compared with last week? Visitors, top sources and pages, goal completions, and anything unusual.`;
    case "tags":
      return `Check the tags of ${name}: is every tag firing, did any conversion fail to reach an ad platform this week, and what should we fix?`;
    case "replay":
      return `Look at the most frustrated replay sessions of ${name} this week, and tell me what confused visitors and what we should change.`;
    case "mail":
      return `What came into the inbox of ${name} this week? Summarise anything that needs me.`;
    case "settings":
      return `Who can see ${name}, which API keys are active, and is anything there we should clean up?`;
    default:
      return `Give me an update on ${name}: this week's visitors and goals, failing tags or conversions, frustrated sessions, new emails, and anything the setup check says to fix.`;
  }
}

/** A project's name, what to ask its agent, and its tabs. */
export function projectHeader(p: Project, active: ProjectTab, settingsTab?: SettingsTab): SafeHtml {
  const tab = (key: ProjectTab, href: string, label: string) =>
    html`<a href="${href}" class="ptab ptab-${key}"${key === active ? html` aria-current="page"` : ""}>${label}</a>`;
  const base = `/dashboard/projects/${p.id}`;
  const sub = (key: SettingsTab, href: string, label: string) =>
    html`<a href="${href}"${key === settingsTab ? html` aria-current="page"` : ""}>${label}</a>`;
  // The switcher in the top bar already names the project, so the page starts with its tabs. The
  // name stays for screen readers (and in the browser's title).
  return html`<div class="page-head project-head">
  <h1 class="sr-only">${projectName(p)}</h1>
  <div class="ptabs-row">
    <nav class="tabs ptabs" aria-label="Project">
      ${tab("overview", base, "Overview")}
      ${tab("analytics", `${base}/analytics`, "Analytics")}
      ${tab("tags", `${base}/tags`, "Tags")}
      ${tab("replay", `${base}/replay`, "Replay")}
      ${tab("mail", `${base}/mail`, "Mail")}
      ${tab("settings", `${base}/settings`, "Settings")}
    </nav>
    <details class="pick project-ask">
      <summary><span class="project-ask-dot" aria-hidden="true"></span>Ask your agent${html`<span class="pick-caret" aria-hidden="true"></span>`}</summary>
      <div class="pick-menu pick-menu-end project-ask-panel">
        <p class="pick-head">Paste this into your agent</p>
        <p class="ask-line"><span class="ask-q select">${askFor(p, active)}</span></p>
      </div>
    </details>
  </div>
</div>
${
  active === "settings"
    ? html`<nav class="subtabs" aria-label="Settings">
  ${sub("general", `${base}/settings`, "General")}
  ${sub("keys", `${base}/keys`, "API keys")}
  ${sub("members", `${base}/members`, "Members")}
</nav>`
    : ""
}`;
}
