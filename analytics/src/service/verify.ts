import { badRequest, parse } from "@afs/shared";
import { z } from "zod";
import { isDev } from "../env";
import { readTextCapped } from "../lib/body";
import { hostAllowed } from "../lib/url";
import { EXCLUSION_REASONS } from "../lib/exclusions";
import { type Ctx, type PaymentsSummary, type SiteRow, type SiteSummary, loadSite, siteStub } from "./context";
import { linkingInstructions } from "./payments";
import { PROXY_PATH, scriptSnippet } from "./install";

export const verifyInput = z.object({
  url: z
    .string()
    .max(2000)
    .optional()
    .describe("Page to check (default https://<domain>/). Must be on the site's domain or allowed_hostnames."),
});

interface Check {
  id: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

/** The marker esbuild puts at the top of the tracker bundle. */
export const TRACKER_MARKER = "afs-analytics";

const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
const attrVal = (tag: string, name: string) => {
  const m = attr(tag, name);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
};

/** <script> tags whose src ends in s.js, with the attributes we care about. Pure. */
export function findTrackerScripts(html: string): { src: string; site: string | null; defer: boolean; async: boolean }[] {
  const out: { src: string; site: string | null; defer: boolean; async: boolean }[] = [];
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const tag = m[0];
    const src = attrVal(tag, "src");
    if (!src || !/(^|\/)s\.js(\?|#|$)/.test(src)) continue;
    out.push({
      src: src.slice(0, 300),
      site: attrVal(tag, "data-site")?.slice(0, 64) ?? null,
      defer: /\bdefer\b/i.test(tag),
      async: /\basync\b/i.test(tag),
    });
    if (out.length >= 10) break;
  }
  return out;
}

function allowedHost(site: SiteRow, host: string, dev: boolean): boolean {
  if (dev && (host === "localhost" || host === "127.0.0.1")) return true;
  if (host === site.domain || host.endsWith(`.${site.domain}`)) return true;
  const extra = site.allowed_hostnames ? (JSON.parse(site.allowed_hostnames) as string[]) : [];
  return extra.length > 0 && hostAllowed(host, extra);
}

/** Does a CSP directive allow loading from `origin`? Rough but practical. */
function cspAllows(csp: string, directive: string, origin: string, sameOrigin: boolean): boolean | null {
  const dirs = new Map(
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map((d) => [d[0]!.toLowerCase(), d.slice(1)] as const),
  );
  const list = dirs.get(directive) ?? dirs.get("default-src");
  if (!list) return null;
  const host = new URL(origin).host;
  return list.some(
    (s) =>
      s === "*" ||
      s === "https:" ||
      s === origin ||
      s === host ||
      s === `https://${host}` ||
      (sameOrigin && s === "'self'") ||
      (s.startsWith("*.") && host.endsWith(s.slice(1))) ||
      (s.startsWith("https://*.") && host.endsWith(s.slice(9))),
  );
}

export const MAX_REDIRECTS = 3;
export const MAX_PAGE_BYTES = 1_000_000;
export const MAX_SCRIPT_BYTES = 256 * 1024;

type Fetched = { status: number; text: string; headers: Headers; finalUrl: string } | { error: string };

/**
 * GET a URL following at most MAX_REDIRECTS redirects by hand: every hop must be http(s) and pass
 * `allowed`, so a page can't steer the fetch to some other host. Reads at most `maxBytes`.
 */
export async function fetchCapped(
  url: URL,
  opts: { maxBytes: number; allowed: (u: URL) => boolean; timeoutMs?: number },
): Promise<Fetched> {
  try {
    const signal = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
    let current = url;
    for (let hop = 0; ; hop++) {
      const res = await fetch(current.toString(), {
        redirect: "manual",
        headers: { "user-agent": "Mozilla/5.0 (compatible; afs-analytics-verify/1.0)", accept: "text/html,application/javascript,*/*" },
        signal,
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (location) {
        await res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) return { error: `more than ${MAX_REDIRECTS} redirects (last to ${location.slice(0, 200)})` };
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return { error: `invalid redirect Location ${JSON.stringify(location.slice(0, 200))}` };
        }
        if (!/^https?:$/.test(next.protocol) || !opts.allowed(next))
          return { error: `redirected to ${next.origin}, which verify does not fetch` };
        current = next;
        continue;
      }
      const { text } = await readTextCapped(res.body, opts.maxBytes);
      return { status: res.status, text, headers: res.headers, finalUrl: current.toString() };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function verifyInstall(ctx: Ctx, siteId: string, raw: unknown) {
  const input = parse(verifyInput, raw);
  const site = await loadSite(ctx, siteId);
  const dev = isDev(ctx.env);
  let pageUrl: URL;
  try {
    pageUrl = new URL(input.url ?? `https://${site.domain}/`);
  } catch {
    throw badRequest("`url` is not a valid URL.", `Example: {"url":"https://${site.domain}/pricing"}`);
  }
  if (!/^https?:$/.test(pageUrl.protocol) || !allowedHost(site, pageUrl.hostname, dev)) {
    throw badRequest(
      `verify only fetches pages on ${site.domain} (or its subdomains / allowed_hostnames).`,
      `Pass a url on https://${site.domain}/.`,
    );
  }

  const checks: Check[] = [];
  const snippet = scriptSnippet(ctx.baseUrl, site.id);
  let scripts: ReturnType<typeof findTrackerScripts> = [];

  // Fetch only the site's own hosts (every redirect hop included); the tracker script also from here.
  const siteHost = (u: URL) => allowedHost(site, u.hostname, dev);
  const ownHost = new URL(ctx.baseUrl).host;
  const page = await fetchCapped(pageUrl, { maxBytes: MAX_PAGE_BYTES, allowed: siteHost });
  if ("error" in page) {
    checks.push({
      id: "page_reachable",
      ok: false,
      detail: `Could not fetch ${pageUrl}: ${page.error}`,
      fix: `Make sure ${pageUrl} is publicly reachable and redirects (at most ${MAX_REDIRECTS}) stay on ${site.domain}, its subdomains or allowed_hostnames, or pass {"url": "..."} for the final page.`,
    });
  } else if (page.status >= 400) {
    checks.push({
      id: "page_reachable",
      ok: false,
      detail: `${pageUrl} returned HTTP ${page.status}.`,
      fix: "Pass a url that returns 200 and includes the snippet.",
    });
  } else {
    checks.push({ id: "page_reachable", ok: true, detail: `HTTP ${page.status} from ${page.finalUrl}` });
    scripts = findTrackerScripts(page.text);
    const mine = scripts.filter((s) => s.site === site.id);
    if (mine.length) {
      checks.push({ id: "snippet_present", ok: true, detail: `Found <script src="${mine[0]!.src}" data-site="${site.id}">.` });
      if (!mine[0]!.defer && !mine[0]!.async) {
        checks.push({
          id: "snippet_defer",
          ok: false,
          detail: "The script has neither defer nor async, so it blocks rendering.",
          fix: "Add `defer` to the script tag.",
        });
      }
      const scriptUrl = new URL(mine[0]!.src, page.finalUrl);
      const scriptHostOk = (u: URL) => u.host === ownHost || siteHost(u);
      const js: Fetched =
        !/^https?:$/.test(scriptUrl.protocol) || !scriptHostOk(scriptUrl)
          ? {
              error: `not fetched, because ${scriptUrl.origin} is neither ${ownHost} nor on ${site.domain}, its subdomains or allowed_hostnames`,
            }
          : await fetchCapped(scriptUrl, { maxBytes: MAX_SCRIPT_BYTES, allowed: scriptHostOk });
      if ("error" in js || js.status >= 400 || !js.text.includes(TRACKER_MARKER)) {
        const proxied = scriptUrl.origin === new URL(page.finalUrl).origin;
        checks.push({
          id: "script_loads",
          ok: false,
          detail:
            "error" in js
              ? `${scriptUrl}: ${js.error}.`
              : `${scriptUrl} returned HTTP ${js.status}${js.status < 400 ? " but not the tracker" : ""}.`,
          fix: proxied
            ? `Your first-party proxy at ${scriptUrl.pathname.replace(/s\.js$/, "")} does not reach ${ctx.baseUrl}. Apply one of the snippets in GET /v1/sites/${site.id}/install (first_party_proxy), so ${PROXY_PATH}/* is forwarded.`
            : `Use the exact src from the snippet: ${snippet}`,
        });
      } else {
        checks.push({ id: "script_loads", ok: true, detail: `${scriptUrl} serves the tracker.` });
      }
      const csp = page.headers.get("content-security-policy");
      if (csp) {
        const same = scriptUrl.origin === new URL(page.finalUrl).origin;
        const s = cspAllows(csp, "script-src", scriptUrl.origin, same);
        const c = cspAllows(csp, "connect-src", scriptUrl.origin, same);
        if (s === false || c === false) {
          checks.push({
            id: "csp",
            ok: false,
            detail: `The page's Content-Security-Policy blocks ${s === false ? "script-src" : "connect-src"} for ${scriptUrl.origin}.`,
            fix: same
              ? "Add 'self' to script-src and connect-src."
              : `Add ${scriptUrl.origin} to script-src and connect-src (or use the first-party proxy and 'self').`,
          });
        }
      }
    } else if (scripts.length) {
      checks.push({
        id: "snippet_present",
        ok: false,
        detail: `Found a tracker script but data-site is ${scripts.map((s) => JSON.stringify(s.site)).join(", ")}, not "${site.id}".`,
        fix: `Set data-site="${site.id}" on the script tag.`,
      });
    } else {
      checks.push({
        id: "snippet_present",
        ok: false,
        detail: "No <script ... s.js data-site=...> in the page's HTML.",
        fix: `Add to <head>: ${snippet}. If you inject it with GTM or the tags app it won't appear in static HTML; then the events check below is what matters.`,
      });
    }
  }

  const summary = (await siteStub(ctx.env, site.id).summary()) as SiteSummary | { error: unknown };
  const sum = "error" in summary ? null : summary;
  const drops = sum?.dropped_last_7d ?? {};
  if (sum && sum.total_events > 0) {
    checks.push({
      id: "events_received",
      ok: true,
      detail: `${sum.total_events} events stored (${sum.events_last_24h} in the last 24h; ${sum.browser_events} browser, ${sum.server_events} server). Last at ${new Date(Number(sum.last_event_at)).toISOString()}.`,
    });
  } else {
    checks.push({
      id: "events_received",
      ok: false,
      detail: "No events stored yet.",
      fix: "Open the page in a normal browser (headless browsers and bots are filtered), wait a few seconds and run verify again. Check the browser console/network for a POST to /e.",
    });
  }
  const hostDrop = drops["hostname_not_allowed"];
  if (hostDrop) {
    checks.push({
      id: "hostname_allowed",
      ok: false,
      detail: `${hostDrop.count} events in the last 7 days came from a hostname not in allowed_hostnames (latest: ${hostDrop.sample}).`,
      fix: `PATCH /v1/sites/${site.id} {"allowed_hostnames": [..., "${hostDrop.sample}"]} if that hostname is yours.`,
    });
  }
  const warnings = sum?.warnings_last_7d ?? {};
  const keyWarn = [warnings["proxy_key_missing"], warnings["proxy_key_invalid"]].filter((w) => !!w);
  if (keyWarn.length) {
    const n = keyWarn.reduce((a, w) => a + w.count, 0);
    checks.push({
      id: "proxy_key",
      ok: false,
      detail: `${n} events in the last 7 days came through a first-party proxy (latest from ${keyWarn[0]!.sample}) ${warnings["proxy_key_invalid"] ? "with a wrong" : "without an"} x-afs-proxy-key header, so their visitor IP and geo are the proxy's own: visitors may merge into one and countries are wrong.`,
      fix: `Re-apply the proxy snippet from GET /v1/sites/${site.id}/install (first_party_proxy): it sends x-afs-proxy-key with this site's proxy_key, plus the visitor IP and geo.`,
    });
  }
  const botDrops = Object.entries(drops)
    .filter(([k]) => k.startsWith("bot:"))
    .reduce((n, [, v]) => n + v.count, 0);
  if (sum?.hostnames_last_7d.length) {
    const foreign = sum.hostnames_last_7d.filter((h) => h.hostname && !allowedHost(site, h.hostname, true));
    if (foreign.length) {
      checks.push({
        id: "foreign_hostnames",
        ok: true,
        detail: `Events also arrive from ${foreign.map((h) => h.hostname).join(", ")}. If those aren't yours, set allowed_hostnames.`,
      });
    }
  }
  const excluded = EXCLUSION_REASONS.map((r) => [r, drops[r]] as const).filter(([, v]) => !!v);
  if (excluded.length) {
    const n = excluded.reduce((a, [, v]) => a + v!.count, 0);
    const ev = checks.find((c) => c.id === "events_received");
    const detail = `${n} events in the last 7 days were dropped by this site's exclusions (${excluded.map(([r, v]) => `${r}: ${v!.count}, latest rule ${v!.sample}`).join("; ")}).`;
    checks.push({ id: "exclusions", ok: true, detail });
    if (ev && !ev.ok)
      ev.fix = `${ev.fix} Your own visits may be excluded: ${detail} Check with GET /v1/sites/${site.id}/exclusions?ip=<your ip>.`;
  }
  const stripe = await ctx.env.DB.prepare(
    "SELECT events_received, last_event_at, last_result, last_error FROM integrations WHERE site_id = ? AND provider = 'stripe'",
  )
    .bind(site.id)
    .first<{ events_received: number; last_event_at: number | null; last_result: string | null; last_error: string | null }>();
  if (stripe) {
    if (stripe.last_error) {
      checks.push({
        id: "stripe_webhook",
        ok: false,
        detail: `The last Stripe delivery failed: ${stripe.last_error}.`,
        fix: `Re-connect with the endpoint's current signing secret: POST /v1/sites/${site.id}/integrations/stripe {"webhook_secret":"whsec_..."}.`,
      });
    } else if (!stripe.events_received) {
      checks.push({
        id: "stripe_webhook",
        ok: false,
        detail: "Stripe is connected but no webhook delivery has arrived yet.",
        fix: `Make sure the Stripe endpoint URL is ${ctx.baseUrl}/webhooks/stripe/${site.id} and send a test event (stripe trigger checkout.session.completed), then GET /v1/sites/${site.id}/integrations/stripe.`,
      });
    } else {
      checks.push({
        id: "stripe_webhook",
        ok: true,
        detail: `${stripe.events_received} Stripe deliveries; last at ${new Date(Number(stripe.last_event_at)).toISOString()} (${stripe.last_result}).`,
      });
    }
  }
  const pay = (await siteStub(ctx.env, site.id)
    .paymentsSummary()
    .catch(() => ({ error: "unavailable" }))) as PaymentsSummary | { error: unknown };
  if (!("error" in pay) && pay.unlinked_30d > 0) {
    checks.push({
      id: "payment_linking",
      ok: false,
      detail: `${pay.unlinked_30d} of ${pay.payments_30d} payments in the last 30 days found no visitor, so their revenue shows as channel "Unattributed".`,
      fix: linkingInstructions().stripe_checkout,
    });
  }
  const failed = checks.filter((c) => !c.ok);
  const eventsOk = checks.find((c) => c.id === "events_received")?.ok ?? false;
  const snippetOk = checks.find((c) => c.id === "snippet_present")?.ok ?? false;
  return {
    site_id: site.id,
    // Working = events arrive and nothing on the page blocks the tracker. A snippet missing from
    // static HTML is fine when events arrive (GTM / tags injection).
    ok: eventsOk && !failed.some((c) => c.id === "script_loads" || c.id === "csp"),
    installed: snippetOk || eventsOk,
    receiving_events: eventsOk,
    checked_url: pageUrl.toString(),
    checks,
    fixes: failed.filter((c) => c.fix).map((c) => c.fix!),
    found_scripts_untrusted: scripts,
    dropped_last_7d: { ...drops, bots_total: botDrops },
    warnings_last_7d: warnings,
    next_steps: eventsOk
      ? [`GET /v1/sites/${site.id}/stats?period=today`, `POST /v1/sites/${site.id}/goals to define conversions`]
      : ["Apply the fixes above, load the page in a browser, then verify again."],
  };
}
