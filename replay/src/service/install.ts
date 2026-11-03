import type { SiteRow } from "./context";

export const FRAMEWORKS = ["html", "nextjs", "react", "astro", "wordpress", "gtm"] as const;
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
    file: "app/layout.tsx (App Router) or pages/_app.tsx",
    code: `import Script from "next/script";\n\n// inside <body> of the root layout:\n<Script src="${loaderUrl(base, id)}" strategy="afterInteractive" />`,
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
});

export function installInstructions(site: SiteRow, base: string, framework: Framework = "html") {
  const all = code(base, site.id);
  return {
    site_id: site.id,
    framework,
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
    with_analytics:
      'Pages that also run the AgentFirstStack analytics tracker (afsa) get the analytics visitor id attached to each recording automatically. Link the sites with PATCH /v1/sites/:id {"analytics_site_id": "site_..."} to forward frustration signals and JS errors to analytics as events.',
  };
}
