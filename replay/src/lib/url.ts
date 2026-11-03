/** "https://www.Example.com/path" -> "example.com". Throws on anything that isn't a hostname. */
export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  const host = new URL(s).hostname.replace(/^www\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host) || host.length > 253) throw new Error("bad domain");
  if (!host.includes(".") && host !== "localhost") throw new Error("bad domain");
  return host;
}

/** Does `host` match one of the patterns ("example.com", "*.example.com")? */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((p) => {
    const q = p.toLowerCase();
    return q.startsWith("*.") ? h === q.slice(2) || h.endsWith(q.slice(1)) : h === q;
  });
}

/** The site's domain, its subdomains, and allowed_hostnames; localhost in dev. */
export function siteHostAllowed(host: string, domain: string, allowed: readonly string[] | null, dev: boolean): boolean {
  const h = host.toLowerCase();
  if (dev && (h === "localhost" || h === "127.0.0.1")) return true;
  if (h === domain || h.endsWith(`.${domain}`)) return true;
  return !!allowed && allowed.length > 0 && hostAllowed(h, allowed);
}
