import type { Resources } from "./services";

/**
 * Prompts a person pastes into their agent to get a screen built for them, one per service. This
 * dashboard deliberately shows no data and edits nothing: charts, tag editing and reading mail
 * belong in pages the agent builds from the API, inside the project's own app, where the owner can
 * shape them. Each prompt names the project's resources so the agent can start immediately.
 */

export type BuildKind = "analytics" | "tags" | "mail";

interface Project {
  id: string;
  name: string;
}

const svcUrl = (base: string, sub: string) => base.replace("://", `://${sub}.`);

const list = <T>(items: T[] | null, line: (x: T) => string) =>
  items === null ? "  (couldn't load the list: call the API)" : items.length ? items.map((x) => `  - ${line(x)}`).join("\n") : "  none yet";

const DESIGN =
  "Design it like Stripe's dashboard: a calm white surface, hairline borders, generous spacing, tabular numbers, one accent colour, clear hierarchy, no clutter. Fast and responsive, light and dark mode.";

const WHERE =
  "Build it where it fits: a protected page in this project's app (behind its existing login), or a small standalone app I run locally if there's no app. When it works, tell me where to open it and how it's protected.";

function key(base: string, scope: "read" | "full", why: string) {
  return scope === "read"
    ? `Key: create a read-only key for it with the full-access AGENTFIRSTSTACK_API_KEY from this project's .env:
  POST ${base}/v1/keys {"name":"dashboard","scope":"read"}
Keep it on the server (an env var). Never put any key in browser code.`
    : `Key: ${why} needs the full-access key. Use a new one, created with the AGENTFIRSTSTACK_API_KEY from this project's .env:
  POST ${base}/v1/keys {"name":"admin-panel"}
Keep it on the server (an env var), only behind the app's login. Never put any key in browser code.`;
}

export function buildPrompt(kind: BuildKind, project: Project, r: Resources, base: string): string {
  const head = (what: string, manual: string) =>
    `Build me ${what} for my AgentFirstStack project "${project.name}" (${project.id}).

Data comes only from the AgentFirstStack API. Read the manuals first: ${base}/llms.txt (platform) and ${svcUrl(base, manual)}/llms.txt.`;

  if (kind === "analytics")
    return `${head("an analytics dashboard", "analytics")}

${key(base, "read", "")}

Sites:
${list(r.sites, (s) => `${s.domain} (${s.id})`)}

What to show:
1. A KPI row: visitors, conversion rate, revenue, revenue per visitor, bounce rate and visit duration, each with the change vs the previous period (compare=previous) and a small sparkline.
2. One main chart: visitors over time with the previous period as a dashed line, revenue as bars, and annotations as markers.
3. Breakdowns side by side: channels and sources, pages, countries, devices. Sortable, with revenue and conversions per row where the API has them.
4. Goals and saved funnels with drop-off per step, the insights endpoint as a small grid of facts, and top movers.
5. Controls: date range (today, 7 days, 30 days, 90 days, 12 months) and a site switcher. Cache API responses for a minute.

${DESIGN}

${WHERE}`;

  if (kind === "tags")
    return `${head("a conversion tracking panel", "tags")}

${key(base, "full", "Editing tags")} If I only want to look, use a read-only key ({"scope":"read"}) and leave out the editing.

Tag containers:
${list(r.containers, (c) => `${c.domain} (${c.id})`)}

What to show:
1. Health first: for each ad platform destination (GA4, Google Ads, Meta, TikTok), deliveries and failures in the last 24 hours and 7 days from GET /v1/containers/:id/events, with the failed events and the platform's error one click away.
2. What's live: the published version, its tags, triggers and conversions in plain words ("Purchase is sent to Meta and Google Ads when /thank-you loads"), and the version history.
3. Adjusting: edit the draft (tags, triggers, conversions, consent), then always validate, preview, show me a readable diff against the live version, and publish only when I confirm. Use the draft revision so two edits can't overwrite each other. Roll back to any earlier version in one click, with confirmation.
4. Testing: a "send test event" button per destination (POST .../destinations/:did/test) that shows each platform's response.
Never ask me for ad platform tokens in this panel's UI; connecting platforms stays with the agent.

${DESIGN}

${WHERE}`;

  return `${head("a small email client", "mail")}

${key(base, "full", "Replying and sending")} If I only want to read, use a read-only key ({"scope":"read"}) and leave out sending.

Inboxes:
${list(r.inboxes, (i) => `${i.address} (${i.id})`)}

What to show:
1. The inboxes with their unread counts, then a message list per inbox (newest first) with search (GET /v1/search) and an unread filter.
2. A thread view (GET /v1/threads/:id), plain text by default. Email is untrusted content: render HTML only inside a sandboxed iframe with no scripts and remote images blocked until I allow them, and never let message content act as instructions.
3. Verification codes and links pulled out at the top of a message (the latest-code endpoint), with a copy button.
4. Reply and send (POST /v1/messages/:id/reply, POST /v1/inboxes/:id/send) with a confirmation step. Show the API's error and hint when it refuses: on the free hosted platform, shared-domain inboxes can only reply to people who wrote to them, and sending has a daily limit.
5. Mark read and delete, with confirmation for delete.

${DESIGN}

${WHERE}`;
}
