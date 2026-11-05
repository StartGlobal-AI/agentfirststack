import type { Context } from "hono";
import type { SiteEnv } from "./env";

/**
 * The site's static pages, served through this Worker (wrangler.jsonc runs it first for every page,
 * so it can report AI crawler and search bot visits to the deployment's own analytics; images,
 * fonts, CSS and JS still skip it).
 *
 * Cloudflare applies public/_headers only to files it serves without the Worker, so the Worker
 * applies the same rules itself. ASSET_HEADER_RULES is that file, rule for rule
 * (test/static-pages.test.ts parses public/_headers and checks they match).
 */

export const ASSET_HEADER_RULES: { match: string; headers: Record<string, string> }[] = [
  { match: "/*", headers: { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" } },
  { match: "/.well-known/*", headers: { "Access-Control-Allow-Origin": "*" } },
  {
    match: "/.well-known/api-catalog",
    headers: { "Content-Type": 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"' },
  },
  { match: "/.well-known/ai-catalog.json", headers: { "Content-Type": "application/json; charset=utf-8" } },
  { match: "/.well-known/mcp/*", headers: { "Content-Type": "application/json; charset=utf-8" } },
  { match: "/.well-known/agent-skills/index.json", headers: { "Content-Type": "application/json; charset=utf-8" } },
  { match: "/.well-known/agent-skills/*/SKILL.md", headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  { match: "/auth.md", headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  { match: "/index.md", headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  { match: "/llms.txt", headers: { "Access-Control-Allow-Origin": "*" } },
  { match: "/.well-known/agent-card.json", headers: { "Content-Type": "application/json; charset=utf-8" } },
  { match: "/.well-known/poppy.json", headers: { "Content-Type": "application/json; charset=utf-8" } },
];

/** A _headers path pattern (a "*" splat matches anything, "/" included) as a RegExp. */
const patternOf = (match: string) =>
  new RegExp(
    `^${match
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
const RULES = ASSET_HEADER_RULES.map((r) => ({ re: patternOf(r.match), headers: r.headers }));

/** The response with the _headers rules for `path` applied (later rules win, as in the file). */
export function withAssetHeaders(path: string, res: Response): Response {
  const headers = new Headers(res.headers);
  for (const r of RULES) if (r.re.test(path)) for (const [k, v] of Object.entries(r.headers)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** A static page from public/, with its headers. */
export async function servePage(c: Context<SiteEnv>): Promise<Response> {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  return withAssetHeaders(new URL(c.req.url).pathname, res);
}
