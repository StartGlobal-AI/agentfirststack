import type { SiteRow } from "./context";

export const FRAMEWORKS = [
  "html",
  "nextjs",
  "react",
  "astro",
  "wordpress",
  "gtm",
  "shopify",
  "webflow",
  "wix",
  "squarespace",
  "framer",
] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export const loaderUrl = (base: string, siteId: string) => `${base}/r/${siteId}.js`;

export function scriptSnippet(base: string, siteId: string): string {
  return `<script defer src="${loaderUrl(base, siteId)}"></script>`;
}

/** Keeps afsr('identify' | 'event' | 'consent') calls made before the loader runs. */
export const QUEUE_STUB = "<script>window.afsr=window.afsr||function(){(afsr.q=afsr.q||[]).push(arguments)}</script>";

const code = (base: string, id: string): Record<Framework, { file: string; code: string }> => ({
  html: { file: "every page, inside <head>", code: `${QUEUE_STUB}\n${scriptSnippet(base, id)}` },
  nextjs: {
    file: "app/layout.tsx (App Router), inside <head>; Pages Router: inside <Head> of pages/_document.tsx",
    // A plain <script> is in the server HTML (verify finds it); next/script with afterInteractive isn't.
    code: `// inside <head> of the root layout (a plain <script>, not next/script: it must be in the server HTML)\n<script defer src="${loaderUrl(base, id)}" />`,
  },
  react: { file: "index.html (Vite, CRA), inside <head>", code: `${QUEUE_STUB}\n${scriptSnippet(base, id)}` },
  astro: { file: "src/layouts/Layout.astro, inside <head>", code: `<script is:inline defer src="${loaderUrl(base, id)}"></script>` },
  wordpress: {
    file: "your theme's functions.php (or a header-scripts plugin)",
    code: `add_action('wp_head', function () {\n  echo '${scriptSnippet(base, id)}';\n});`,
  },
  gtm: {
    file: "Google Tag Manager: Custom HTML tag, trigger All Pages",
    code: `<script>(function(){var s=document.createElement('script');s.defer=true;s.src='${loaderUrl(base, id)}';document.head.appendChild(s);})();</script>`,
  },
  shopify: {
    file: "Shopify admin: Online Store > Themes > ... > Edit code > layout/theme.liquid, just before </head> (Shopify's own checkout pages can't take scripts, except on Plus via checkout extensibility)",
    code: `${QUEUE_STUB}\n${scriptSnippet(base, id)}`,
  },
  webflow: {
    file: "Webflow: Site settings > Custom code > Head code (a paid site plan), then publish",
    code: `${QUEUE_STUB}\n${scriptSnippet(base, id)}`,
  },
  wix: {
    file: "Wix: Settings > Custom code (Advanced) > + Add custom code: paste, Add code to pages: All pages, Place code in: Head (a premium plan with a connected domain)",
    code: `${QUEUE_STUB}\n${scriptSnippet(base, id)}`,
  },
  squarespace: {
    file: "Squarespace: Settings > Advanced (Developer tools) > Code injection > Header (Core plan or above)",
    code: `${QUEUE_STUB}\n${scriptSnippet(base, id)}`,
  },
  framer: {
    file: "Framer: Site settings > General > Custom code > End of <head> tag, then publish",
    code: `${QUEUE_STUB}\n${scriptSnippet(base, id)}`,
  },
});

/**
 * Join replay to a product analytics tool: the replay session id as an event property (so an
 * analytics event links to its recording), and the tool's identify passed on to afsr('identify').
 */
export const WITH_TOOLS: Record<"segment" | "mixpanel" | "amplitude", { what: string; code: string }> = {
  segment: {
    what: "Analytics.js: every event gets replay_session_id; identify() is passed to replay (traits you list become tags).",
    code: `analytics.addSourceMiddleware(({ payload, next }) => {
  const id = window.afsr && afsr.sessionId && afsr.sessionId();
  if (id && payload.obj.properties) payload.obj.properties.replay_session_id = id;
  next(payload);
});
analytics.on("identify", (userId, traits) => userId && afsr("identify", userId, { plan: traits && traits.plan }));`,
  },
  mixpanel: {
    what: "Mixpanel: a super property on every event once the replay loader has run; identify alongside mixpanel.identify.",
    code: `window.addEventListener("load", () => {
  const id = window.afsr && afsr.sessionId && afsr.sessionId();
  if (id) mixpanel.register({ replay_session_id: id });
});
// where you call mixpanel.identify(userId):
afsr("identify", userId);`,
  },
  amplitude: {
    what: "Amplitude Browser SDK 2: an enrichment plugin adds replay_session_id to every event; identify alongside setUserId.",
    code: `amplitude.add({
  name: "afs-replay",
  type: "enrichment",
  execute: async (event) => {
    const id = window.afsr && afsr.sessionId && afsr.sessionId();
    if (id) event.event_properties = { ...event.event_properties, replay_session_id: id };
    return event;
  },
});
// where you call amplitude.setUserId(userId):
afsr("identify", userId);`,
  },
};

/** Linked, and the analytics site confirmed its tracker loads this site's recorder. */
export const loadsWithAnalytics = (s: SiteRow) => !!s.analytics_site_id && s.analytics_linked_at != null;

/** An analytics site of the account to link instead of pasting a second snippet (see suggestAnalyticsSite). */
export type AnalyticsSuggestion = { site: { id: string; domain: string } | null; count: number } | null;

const linkBody = (id: string) => `{"analytics_site_id": "${id}"}`;

/**
 * How the recorder gets onto pages, given the analytics link: one sentence for install, next_steps
 * and verify. `paste` = the snippet is still the way in (no confirmed link).
 */
export function analyticsInstallNote(site: SiteRow, suggestion: AnalyticsSuggestion): { text: string; paste: boolean } {
  const a = site.analytics_site_id;
  if (a && loadsWithAnalytics(site))
    return {
      paste: false,
      text: `Nothing to paste on pages that run the AgentFirstStack analytics tracker for ${a}: it loads this site's recorder by itself. The snippet is the alternative, for pages without that tracker, or for a strict Content-Security-Policy where you'd rather serve replay through your own first-party proxy (the tracker fetches the loader from the replay host directly).`,
    };
  if (a)
    return {
      paste: true,
      text: `Linked to analytics site ${a}, but it hasn't confirmed that its tracker loads this recorder (the call failed, or this deployment can't reach analytics). Retry with PATCH /v1/sites/${site.id} ${linkBody(a)} (the same id again re-asserts the link); until then add the snippet.`,
    };
  if (suggestion?.site)
    return {
      paste: true,
      text: `This account has analytics site ${suggestion.site.id} (${suggestion.site.domain}). Link it instead of pasting a second snippet: PATCH /v1/sites/${site.id} ${linkBody(suggestion.site.id)}. Pages that run its tracker then load the recorder by themselves, and frustration signals and JS errors appear in analytics as events.`,
    };
  if (suggestion?.count)
    return {
      paste: true,
      text: `This account has ${suggestion.count} analytics site(s), none for ${site.domain}. If one runs on these pages, link it instead of pasting a second snippet: PATCH /v1/sites/${site.id} ${linkBody("site_...")} (analytics GET /v1/sites lists them).`,
    };
  return {
    paste: true,
    text: `Pages that also run the AgentFirstStack analytics tracker (afsa) get the analytics visitor id attached to each recording automatically. Link the sites with PATCH /v1/sites/:id ${linkBody("site_...")} and the analytics tracker loads this recorder by itself (no second snippet); frustration signals and JS errors are then forwarded to analytics as events.`,
  };
}

/** Where first-party domains are created: the platform site (AUTH_ISSUER), or null when this service runs alone. */
export const platformBase = (env: { AUTH_ISSUER?: string }) => env.AUTH_ISSUER?.trim().replace(/\/+$/, "") || null;

/**
 * The three ways replay reaches pages from the site's own domain, best first. With the analytics
 * tracker loaded from a first-party domain, the recorder comes from that domain by itself.
 */
export function firstPartyBlock(base: string, site: SiteRow, siteBase: string | null) {
  const endpoint = siteBase ? `${siteBase}/v1/first-party-domains` : null;
  return {
    default: true,
    why: "Ad blockers block recorder scripts and uploads on third-party hosts. Serve replay from the site's own domain: use the first of these that works for the site.",
    order: ["first_party_domain", "path_proxy", "direct"],
    first_party_domain: {
      rank: 1,
      what: "A subdomain of the site (e.g. edge.example.com) with one CNAME to this platform, no server code; it serves replay (/_r), analytics (/_a) and tags (/_t) for the whole project. Pages that load the linked analytics tracker from it get the recorder from it too, with nothing to paste; pages without the tracker use the snippet here.",
      when: "You can add a DNS record. If you can't, it's one record to hand the owner.",
      create: endpoint
        ? `POST ${endpoint} {"hostname":"edge.<the site's domain>"} (MCP afs_add_first_party_domain): returns the CNAME to add and next_steps`
        : "Not on this deployment (this replay service runs without the platform site): use the path proxy.",
      status: endpoint ? `GET ${endpoint} until status is "active"` : null,
      snippet: `<script defer src="https://<hostname>/_r/r/${site.id}.js"></script>`,
      label:
        "Pick a neutral label (edge, go, www2), not analytics, stats, track, metrics, pixel, tag or collect: filter lists target those names too.",
    },
    path_proxy: {
      rank: 2,
      what: `Forward /_r/* on the site's own server to ${base}/_r/* unchanged (the loader, recorder and uploads are served under any path prefix and derive their base from the loader's src).`,
      when: "DNS can't be changed, but the site's server or host can forward a path.",
      snippet: `<script defer src="/_r/r/${site.id}.js"></script>`,
    },
    direct: {
      rank: 3,
      what: "The plain snippet (or the analytics tracker loading the recorder from this service's host). Last resort: ad blockers block it.",
      snippet: scriptSnippet(base, site.id),
    },
  };
}

export function installInstructions(
  site: SiteRow,
  base: string,
  framework: Framework = "html",
  suggestion: AnalyticsSuggestion = null,
  siteBase: string | null = null,
) {
  const all = code(base, site.id);
  const note = analyticsInstallNote(site, suggestion);
  return {
    first_party: firstPartyBlock(base, site, siteBase),
    site_id: site.id,
    framework,
    loads_with_analytics: loadsWithAnalytics(site),
    ...(!note.paste ? { nothing_to_paste: note.text } : {}),
    ...(suggestion?.site && !site.analytics_site_id ? { suggested_analytics_site_id: suggestion.site.id } : {}),
    snippet: scriptSnippet(base, site.id),
    file: all[framework].file,
    code: all[framework].code,
    other_frameworks: FRAMEWORKS.filter((f) => f !== framework),
    page_api: {
      "afsr.sessionId()":
        "this tab's replay_session_id (null when the tab isn't recorded). Send it with your analytics events as a prop to link them to the recording.",
      "afsr.status()":
        "loading | recording | not_sampled | dnt | ignored | disabled | consent_pending | excluded | idle | stopped:<reason>",
      "afsr('identify', userId)": "attach your user id to the session (searchable, and deletable with delete_visitor_data).",
      "afsr('event', name, props)": "a named step in the transcript (and usable as a funnel step: event:<name>).",
      "afsr('consent', true | false)": "with require_consent, recording starts only after consent true; false stops it.",
      "afsr('stop')": "stop recording this tab.",
    },
    html_attributes: {
      "data-afsr-unmask": "show this element's text (and its inputs' values, except passwords, card and one-time-code fields) as is",
      "data-afsr-mask": "always mask this element's text",
      "data-afsr-block": "don't record this element at all (a same-size placeholder is recorded)",
      "data-afsr-ignore": "don't record input into this field or clicks on it",
    },
    testing: [
      `Open https://${site.domain}/?afsr=1 in any browser (headless is fine with ?afsr=1): it records regardless of sample_rate and bot filtering.`,
      "localStorage.afsr_ignore = 1 in your own browser stops your visits being recorded.",
      "Browsers sending Global Privacy Control or Do Not Track are never recorded.",
    ],
    with_analytics: note.text,
    with_tools: WITH_TOOLS,
  };
}
