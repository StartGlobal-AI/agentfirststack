import type { Resources } from "./services";

/**
 * The prompt a person pastes into their agent to get a dashboard built for them. This dashboard
 * deliberately shows no numbers: charts and reports belong in a page the agent builds from the
 * API, in the project's own app, where the owner can shape them.
 */
export function dashboardPrompt(project: { id: string; name: string }, r: Resources, base: string): string {
  const svc = (sub: string) => base.replace("://", `://${sub}.`);
  const list = <T>(items: T[] | null, line: (x: T) => string, none: string) =>
    items === null
      ? "  (couldn't load the list: call the API)"
      : items.length
        ? items.map((x) => `  - ${line(x)}`).join("\n")
        : `  ${none}`;

  return `Build me a dashboard for my AgentFirstStack project "${project.name}" (${project.id}).

Data comes only from the AgentFirstStack APIs. Read the manuals first:
${base}/llms.txt (platform), ${svc("analytics")}/llms.txt, ${svc("tags")}/llms.txt and ${svc("mail")}/llms.txt.

Key: create a read-only key for the dashboard with the full-access AGENTFIRSTSTACK_API_KEY from this project's .env:
  POST ${base}/v1/keys {"name":"dashboard","scope":"read"}
Keep it on the server (an env var). Never put any key in browser code.

What the project has:
Sites (analytics):
${list(r.sites, (s) => `${s.domain} (${s.id})`, "none yet")}
Tag containers:
${list(r.containers, (c) => `${c.domain} (${c.id})`, "none yet")}
Inboxes:
${list(r.inboxes, (i) => `${i.address} (${i.id})`, "none yet")}

What to show:
1. A KPI row: visitors, conversion rate, revenue, revenue per visitor, bounce rate and visit duration, each with the change vs the previous period (compare=previous) and a small sparkline.
2. One main chart: visitors over time with the previous period as a dashed line, revenue as bars, and annotations as markers.
3. Breakdowns side by side: channels and sources, pages, countries, devices. Sortable, with revenue and conversions per row where the API has them.
4. Goals and saved funnels with drop-off per step, the insights endpoint as a small grid of facts, and top movers.
5. If there are tag containers: deliveries per destination and any failures in the last 7 days. If there are inboxes: each inbox with its unread count.
6. Controls: date range (today, 7 days, 30 days, 90 days, 12 months), a site switcher, and light and dark mode.

Design it like Stripe's dashboard: a calm white surface, hairline borders, generous spacing, tabular numbers, one accent colour, clear hierarchy, no chart clutter. Fast and responsive. Cache API responses for a minute.

Build it where it fits: a protected page in this project's app (behind its existing login), or a small standalone app I run locally if there's no app. When it works, tell me where to open it and how it's protected.`;
}
