/**
 * The setup catalog: every item the full setup expects, with the catalog version it arrived in.
 *
 * This is how projects that are already set up hear about new features. When a feature needs the
 * project's agent to do something (a new check in src/setup-check.ts, or a new step), add an entry
 * here with the next version number. The site's daily cron (src/notices.ts) then writes a notice
 * for every active project whose agent last ran the setup check at an older version; every
 * service adds it to that agent's next API or MCP answer (@afs/shared notices), and the owner sees
 * it in the weekly report and the dashboard. Running the setup check clears it.
 *
 * `checks` ties an item to setup check ids, so the check can say which of its results are new.
 */
export interface CatalogItem {
  version: number;
  /** For the agent and the owner: what's new, in a few words. */
  label: string;
  checks: string[];
}

export const SETUP_CATALOG: CatalogItem[] = [
  {
    version: 1,
    label: "the setup check itself (every part of the full setup, with the fix for each)",
    checks: [
      "project.named",
      "mail.inbox",
      "analytics.site",
      "analytics.receiving",
      "analytics.domain_verified",
      "analytics.goals",
      "analytics.goals_counted",
      "analytics.server_events",
      "analytics.owner_email",
      "analytics.weekly_report",
      "analytics.alerts",
      "tags.container",
      "tags.installed",
      "tags.published",
      "tags.events",
      "tags.to_analytics",
      "tags.goals_for_events",
      "tags.firing",
      "tags.destinations",
      "replay.site",
      "replay.linked",
      "replay.verified",
      "replay.recording",
      "replay.consent",
      "project.claimed",
    ],
  },
  {
    version: 2,
    label: "the setup test (POST /v1/setup/test: test traffic through every service, then a browser test visit)",
    checks: [],
  },
  {
    version: 2,
    label: "forwarding the inbox's email to the owner (ask them: each email as it arrives, or a daily digest)",
    checks: ["mail.forwarding"],
  },
  {
    version: 2,
    label: "an AgentFirstStack section in the repo's AGENTS.md, so later agent sessions see updates like this one",
    checks: [],
  },
  {
    version: 3,
    label:
      "reporting AI crawler and search bot visits from the site's server (sites with a server or edge code; static hosting skips it), so analytics shows which bots read which pages",
    checks: ["analytics.crawlers"],
  },
  {
    version: 4,
    label:
      "bringing over what the site used before (GA4, Google Tag Manager, Plausible, DataFast and others): its setup, its history, and a check that our numbers match before the old tools are removed",
    checks: ["migrate.tools", "migrate.compare"],
  },
];

export const CATALOG_VERSION = Math.max(...SETUP_CATALOG.map((i) => i.version));

/** What arrived after `seen` (0 = the project's agent never ran the setup check). */
export const itemsAfter = (seen: number) => SETUP_CATALOG.filter((i) => i.version > seen && i.version > 1);

/** The AgentFirstStack block for the project's AGENTS.md (the full setup's step 9 writes it). */
export const AGENTS_MD_BLOCK = (base: string) => `<!-- agentfirststack:start -->
## AgentFirstStack

This project uses AgentFirstStack (analytics, tag manager, email inbox, session replay). What is
set up is in AGENTFIRSTSTACK.md; the key is AGENTFIRSTSTACK_API_KEY in .env.

When you work on analytics, tracking, conversions, the inbox or session replay, or when an
AgentFirstStack answer carries a \`notice\` (an \`AFS-Notice\` header, or a note in an MCP result),
run the setup check first: \`GET ${base}/v1/setup\` (MCP \`afs_check_setup\`). Apply what it
lists, following ${base}/llms.txt, and update AGENTFIRSTSTACK.md.
<!-- agentfirststack:end -->`;
