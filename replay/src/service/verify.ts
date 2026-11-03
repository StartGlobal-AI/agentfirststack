import { badRequest, parse } from "@afs/shared";
import { z } from "zod";
import { isDev } from "../env";
import { readTextCapped } from "../lib/body";
import { siteHostAllowed } from "../lib/url";
import { type Ctx, jsonList, loadSite, type SiteRow, siteStub } from "./context";
import { scriptSnippet } from "./install";
import { LOADER_MARKER } from "./scripts";

export const verifyInput = z.object({
  url: z
    .string()
    .max(2000)
    .optional()
    .describe("Page to check (default https://<domain>/). Must be on the site's domain, a subdomain or allowed_hostnames."),
});

interface Check {
  id: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export const MAX_REDIRECTS = 3;
export const MAX_PAGE_BYTES = 1_000_000;

type Fetched = { status: number; text: string; headers: Headers; finalUrl: string } | { error: string };

/** GET a URL, following at most MAX_REDIRECTS redirects by hand, each hop checked with `allowed`. */
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
        headers: { "user-agent": "Mozilla/5.0 (compatible; afs-replay-verify/1.0)", accept: "text/html,application/javascript,*/*" },
        signal,
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (location) {
        await res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) return { error: `more than ${MAX_REDIRECTS} redirects` };
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return { error: "invalid redirect Location" };
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

/** <script> tags loading /r/<site>.js, with the site id they name. Pure. */
export function findLoaderScripts(html: string): { src: string; site: string | null; defer: boolean; async: boolean }[] {
  const out: { src: string; site: string | null; defer: boolean; async: boolean }[] = [];
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const tag = m[0];
    const sm = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const src = sm ? (sm[1] ?? sm[2] ?? sm[3] ?? "") : "";
    const id = /\/r\/(rsite_[0-9a-z]{16})\.js(?:[?#]|$)/.exec(src);
    if (!id) continue;
    out.push({ src: src.slice(0, 300), site: id[1]!, defer: /\bdefer\b/i.test(tag), async: /\basync\b/i.test(tag) });
    if (out.length >= 10) break;
  }
  // Script loaders (GTM-style) only name the URL in inline code.
  if (!out.length) {
    const inline = /['"]([^'"]*\/r\/(rsite_[0-9a-z]{16})\.js)['"]/.exec(html);
    if (inline) out.push({ src: inline[1]!.slice(0, 300), site: inline[2]!, defer: true, async: true });
  }
  return out;
}

/** Does a CSP directive allow `origin`? Rough but practical. null = no such directive. */
export function cspAllows(csp: string, directive: string, origin: string, sameOrigin: boolean): boolean | null {
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

const allowedHost = (site: SiteRow, host: string, dev: boolean) =>
  siteHostAllowed(host, site.domain, site.allowed_hostnames ? jsonList(site.allowed_hostnames) : null, dev);

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
  if (!/^https?:$/.test(pageUrl.protocol) || !allowedHost(site, pageUrl.hostname, dev))
    throw badRequest(
      `verify only fetches pages on ${site.domain} (or its subdomains / allowed_hostnames).`,
      `Pass a url on https://${site.domain}/.`,
    );

  const checks: Check[] = [];
  const snippet = scriptSnippet(ctx.baseUrl, site.id);
  if (!site.enabled)
    checks.push({
      id: "enabled",
      ok: false,
      detail: "Recording is turned off for this site.",
      fix: `PATCH /v1/sites/${site.id} {"enabled": true}`,
    });

  let scripts: ReturnType<typeof findLoaderScripts> = [];
  const siteHostOk = (u: URL) => allowedHost(site, u.hostname, dev);
  const ownHost = new URL(ctx.baseUrl).host;
  const page = await fetchCapped(pageUrl, { maxBytes: MAX_PAGE_BYTES, allowed: siteHostOk });
  if ("error" in page) {
    checks.push({
      id: "page_reachable",
      ok: false,
      detail: `Could not fetch ${pageUrl}: ${page.error}`,
      fix: `Make sure ${pageUrl} is public and redirects stay on ${site.domain}, or pass {"url": "..."} for the final page.`,
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
    scripts = findLoaderScripts(page.text);
    const mine = scripts.filter((s) => s.site === site.id);
    if (mine.length) {
      checks.push({ id: "snippet_present", ok: true, detail: `Found the loader for ${site.id}: ${mine[0]!.src}` });
      const scriptUrl = new URL(mine[0]!.src, page.finalUrl);
      const okHost = (u: URL) => u.host === ownHost || siteHostOk(u);
      const js =
        !/^https?:$/.test(scriptUrl.protocol) || !okHost(scriptUrl)
          ? ({ error: `not fetched: ${scriptUrl.origin} is neither ${ownHost} nor one of the site's hosts` } as const)
          : await fetchCapped(scriptUrl, { maxBytes: 64 * 1024, allowed: okHost });
      if ("error" in js || js.status >= 400 || !js.text.includes(LOADER_MARKER))
        checks.push({
          id: "script_loads",
          ok: false,
          detail:
            "error" in js
              ? `${scriptUrl}: ${js.error}.`
              : `${scriptUrl} returned HTTP ${js.status}${js.status < 400 ? " but not the afs-replay loader" : ""}.`,
          fix: `Use the exact src from the snippet: ${snippet}`,
        });
      else checks.push({ id: "script_loads", ok: true, detail: `${scriptUrl} serves the loader.` });
      const csp = page.headers.get("content-security-policy");
      if (csp) {
        const same = scriptUrl.origin === new URL(page.finalUrl).origin;
        const s = cspAllows(csp, "script-src", scriptUrl.origin, same);
        const c = cspAllows(csp, "connect-src", scriptUrl.origin, same);
        if (s === false || c === false)
          checks.push({
            id: "csp",
            ok: false,
            detail: `The page's Content-Security-Policy blocks ${s === false ? "script-src" : "connect-src"} for ${scriptUrl.origin} (the loader, the recorder and chunk uploads all use it).`,
            fix: same ? "Add 'self' to script-src and connect-src." : `Add ${scriptUrl.origin} to script-src and connect-src.`,
          });
      }
    } else if (scripts.length) {
      checks.push({
        id: "snippet_present",
        ok: false,
        detail: `Found a replay loader for ${scripts.map((s) => s.site).join(", ")}, not ${site.id}.`,
        fix: `Use this site's snippet: ${snippet}`,
      });
    } else {
      checks.push({
        id: "snippet_present",
        ok: false,
        detail: 'No <script src=".../r/rsite_....js"> in the page\'s HTML.',
        fix: `Add to <head>: ${snippet}. Injected with a tag manager, it won't be in static HTML; then the sessions check below is what matters.`,
      });
    }
  }

  const sum = await siteStub(ctx.env, site.id).summary();
  const drops = sum.dropped_last_7d;
  if (sum.sessions_total > 0)
    checks.push({
      id: "sessions_received",
      ok: true,
      detail: `${sum.sessions_total} sessions recorded (${sum.sessions_last_24h} in the last 24h, ${sum.forced_sessions} forced with ?afsr=1). Last chunk ${sum.last_chunk_at ? new Date(sum.last_chunk_at).toISOString() : "never"}.`,
    });
  else
    checks.push({
      id: "sessions_received",
      ok: false,
      detail: "No session recorded yet.",
      fix: `Open https://${site.domain}/?afsr=1 in a browser (it records whatever the sample rate, also in headless browsers), click something, wait ~10 s or switch tabs, then verify again. Check the browser console for afsr.status().`,
    });
  const why: Record<string, string> = {
    origin_not_allowed: `Chunks came from an origin that isn't ${site.domain} or allowed_hostnames: add it with PATCH /v1/sites/${site.id} {"allowed_hostnames":[...]} if it is yours.`,
    hostname_not_allowed: `Recorded pages named a hostname that isn't ${site.domain} or allowed_hostnames: add it with PATCH /v1/sites/${site.id} {"allowed_hostnames":[...]} if it is yours.`,
    daily_session_limit:
      "The deployment's MAX_SESSIONS_PER_SITE_PER_DAY was reached; new sessions resume after 00:00 UTC (lower sample_rate to spread them).",
    chunk_too_large: "A page produced a chunk over the size limit (very large DOM); block heavy parts with block_selectors.",
    session_bytes_limit:
      "Sessions hit the per-session size limit; block heavy, fast-changing parts (carousels, live counters) with block_selectors.",
  };
  for (const [reason, d] of Object.entries(drops)) {
    if (reason.startsWith("bot:")) continue;
    if (why[reason])
      checks.push({
        id: reason,
        ok: false,
        detail: `${d.count} chunks refused in the last 7 days (${reason}; latest: ${d.sample ?? "n/a"}).`,
        fix: why[reason],
      });
  }
  const bots = Object.entries(drops)
    .filter(([k]) => k.startsWith("bot:"))
    .reduce((n, [, v]) => n + v.count, 0);
  if (bots)
    checks.push({
      id: "bots_dropped",
      ok: true,
      detail: `${bots} chunks from automated browsers were dropped in the last 7 days (use ?afsr=1 to record a test browser).`,
    });
  if (site.mask_mode === "strict" && jsonList(site.unmask_selectors).length === 0)
    checks.push({
      id: "labels_masked",
      ok: true,
      detail: 'mask_mode is strict and no unmask_selectors are set, so every clicked label reads like "*****" in transcripts.',
      fix: `If your UI text is not personal: PATCH /v1/sites/${site.id} {"unmask_selectors":["nav","button","a","h1","h2","h3","label","[role=tab]"]}.`,
    });
  if (site.sample_rate < 1)
    checks.push({
      id: "sampling",
      ok: true,
      detail: `sample_rate is ${site.sample_rate}: about ${Math.round(site.sample_rate * 100)}% of browser sessions are recorded.`,
    });

  const failed = checks.filter((c) => !c.ok);
  const received = checks.find((c) => c.id === "sessions_received")?.ok ?? false;
  const snippetOk = checks.find((c) => c.id === "snippet_present")?.ok ?? false;
  return {
    site_id: site.id,
    ok: received && !failed.some((c) => c.id === "script_loads" || c.id === "csp" || c.id === "enabled"),
    installed: snippetOk || received,
    receiving_sessions: received,
    checked_url: pageUrl.toString(),
    checks,
    fixes: failed.filter((c) => c.fix).map((c) => c.fix!),
    found_scripts_untrusted: scripts,
    data: sum,
    next_steps: received
      ? [`GET /v1/sites/${site.id}/sessions?sort=recent`, `GET /v1/sites/${site.id}/sessions/<id>/transcript`]
      : ["Apply the fixes above, open the page with ?afsr=1, then verify again."],
  };
}
