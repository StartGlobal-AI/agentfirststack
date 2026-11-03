/**
 * Host checks for everything that names a site: container domains, allowed_hostnames wildcards,
 * scan/verify targets and destination URLs. Pure (no DOM, no Workers APIs) so unit tests and the
 * Worker share them.
 */

/** IPv4 dotted quad (after URL parsing, which turns 0x7f.1 or 2130706433 into one) or IPv6. */
export function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || h.includes(":");
}

/** A last label that is numeric or hex: not a real TLD, but the URL parser reads it as an IPv4 part. */
export const numericTld = (host: string) => /^(?:\d+|0x[0-9a-f]*)$/i.test(host.split(".").pop() ?? "");

/**
 * Registries under country-code TLDs (co.uk, com.au, org.nz, ...). Compact on purpose: the full
 * Public Suffix List is ~10k entries; these cover the registrations people actually use.
 */
const CC_SECOND_LEVEL = new Set([
  "ac",
  "biz",
  "co",
  "com",
  "edu",
  "firm",
  "gen",
  "go",
  "gob",
  "gov",
  "govt",
  "gv",
  "in",
  "ind",
  "info",
  "int",
  "ltd",
  "me",
  "mil",
  "ne",
  "net",
  "nhs",
  "nic",
  "nom",
  "or",
  "org",
  "plc",
  "police",
  "sch",
  "school",
  "web",
]);

/** Shared hosting where every subdomain is a different tenant (PSL "private" section, abridged). */
const SHARED_HOSTING = new Set([
  "amazonaws.com",
  "s3.amazonaws.com",
  "appspot.com",
  "azureedge.net",
  "azurestaticapps.net",
  "azurewebsites.net",
  "b-cdn.net",
  "blogspot.com",
  "bubbleapps.io",
  "carrd.co",
  "cloudfront.net",
  "cloudfunctions.net",
  "codesandbox.io",
  "csb.app",
  "deno.dev",
  "digitaloceanspaces.com",
  "elasticbeanstalk.com",
  "firebaseapp.com",
  "fly.dev",
  "framer.app",
  "framer.website",
  "ghost.io",
  "github.dev",
  "github.io",
  "gitlab.io",
  "gitpod.io",
  "glitch.me",
  "herokuapp.com",
  "lovable.app",
  "myshopify.com",
  "netlify.app",
  "netlify.com",
  "ngrok-free.app",
  "ngrok.app",
  "ngrok.io",
  "notion.site",
  "now.sh",
  "ondigitalocean.app",
  "onrender.com",
  "pages.dev",
  "r2.dev",
  "railway.app",
  "repl.co",
  "replit.app",
  "replit.dev",
  "run.app",
  "squarespace.com",
  "stackblitz.io",
  "substack.com",
  "surge.sh",
  "trycloudflare.com",
  "tumblr.com",
  "vercel.app",
  "web.app",
  "webflow.io",
  "weebly.com",
  "wixsite.com",
  "wordpress.com",
  "workers.dev",
]);

/**
 * True for a suffix under which anyone can register a name: a TLD ("com"), a ccTLD registry
 * ("co.uk", "com.au") or a shared host ("github.io", "vercel.app"). A wildcard over one of these
 * ("*.com") would match every site on the internet.
 */
export function isPublicSuffix(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const labels = h.split(".");
  if (labels.length <= 1) return true;
  if (SHARED_HOSTING.has(h)) return true;
  return labels.length === 2 && labels[1]!.length === 2 && CC_SECOND_LEVEL.has(labels[0]!);
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".arpa", ".home.arpa", ".lan", ".test.internal"];

/**
 * A host this Worker may fetch for a site (scan, verify): a real DNS name with a dot, not an IP
 * literal, not localhost or a local-only suffix, not a public suffix.
 */
export function fetchableHost(host: string): boolean {
  const h = host.toLowerCase();
  if (!h.includes(".") || isIpLiteral(h) || numericTld(h)) return false;
  if (LOCAL_SUFFIXES.some((s) => h.endsWith(s))) return false;
  return !isPublicSuffix(h);
}
