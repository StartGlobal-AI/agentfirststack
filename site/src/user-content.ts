import { onUserContentHost } from "@afs/shared";
import type { MiddlewareHandler } from "hono";
import type { SiteEnv } from "./env";

/**
 * The user-content domain (USER_CONTENT_BASE_URL, from the profile's user_content_domain, e.g.
 * afsusercontent.com). Analytics owns /a/* there and replay /r/* (Worker routes; the more specific
 * route wins), and this Worker gets the rest of the host. Runs before everything else, so nothing of
 * the platform (pages, API, sign-in, MCP) is served there: a short page saying what the domain is
 * and where to report a page, a robots.txt, and a plain 404 for every other path.
 */
export const userContentSite: MiddlewareHandler<SiteEnv> = async (c, next) => {
  if (!onUserContentHost(c.env, c.req.raw)) return next();
  const url = new URL(c.req.url);
  const read = c.req.method === "GET" || c.req.method === "HEAD";
  if (read && url.pathname === "/robots.txt") return answer(200, "text/plain", "User-agent: *\nDisallow: /\n", 86_400);
  if (read && url.pathname === "/") return answer(200, "text/html", page(url.hostname, platformOrigin(c.env)), 3_600);
  return answer(404, "text/plain", "Not found.\n", 300);
};

/** The platform's own origin (PUBLIC_BASE_URL, else AUTH_ISSUER), or null when neither is set. */
function platformOrigin(env: { PUBLIC_BASE_URL?: string; AUTH_ISSUER?: string }): string | null {
  for (const base of [env.PUBLIC_BASE_URL, env.AUTH_ISSUER]) {
    try {
      if (base) return new URL(base).origin;
    } catch {
      /* try the next */
    }
  }
  return null;
}

function answer(status: number, type: string, body: string, maxAge: number): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": `public, max-age=${maxAge}`,
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    },
  });
}

const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(host: string, platform: string | null): string {
  const h = escape(host);
  const p = platform ? escape(platform) : "";
  const name = platform ? escape(new URL(platform).hostname) : "the platform";
  const on = platform ? `<a href="${p}/">${name}</a>` : name;
  const report = platform
    ? `<p>If a page here is being used for phishing, malware or spam, <a href="${p}/report-abuse">report it</a>.</p>\n`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${h}</title>
<style>
  body { margin: 0; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: #0f1626; background: #fff; }
  main { max-width: 36rem; padding: 4rem 1.5rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  p { margin: 0 0 1rem; }
  a { color: #0f1626; }
  code { font-size: 0.92em; }
</style>
</head>
<body>
<main>
<h1>${h}</h1>
<p>This domain serves pages that people share from their projects on ${on}: analytics dashboards (<code>/a/…</code>) and session replays (<code>/r/…</code>).</p>
<p>It is a domain of its own so that shared pages never share cookies or an origin with ${name}. A page here shows what the project's owner chose to share; ${name} does not vouch for its content.</p>
${report}</main>
</body>
</html>
`;
}
