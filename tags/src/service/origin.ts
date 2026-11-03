import { isPublicSuffix } from "../lib/domain";

/**
 * Which page hosts may send /collect hits for a container (pure; used by ContainerDO and tests).
 * A wildcard over a public suffix ("*.com", saved before those were refused) matches nothing.
 */
export function hostAllowed(host: string, state: { domain: string; allowed_hostnames: string[] }): boolean {
  const h = host.toLowerCase();
  const d = state.domain.toLowerCase();
  if (h === d || (h.endsWith(`.${d}`) && !isPublicSuffix(d))) return true;
  return state.allowed_hostnames.some((a) => {
    const x = a.toLowerCase();
    if (!x.startsWith("*.")) return h === x;
    if (isPublicSuffix(x.slice(2))) return false;
    return h === x.slice(2) || h.endsWith(x.slice(1));
  });
}

export function originHost(origin: string | undefined, pageUrl: string | undefined): string | null {
  for (const u of [origin, pageUrl]) {
    if (!u || u === "null") continue;
    try {
      return new URL(u).hostname;
    } catch {
      /* next */
    }
  }
  return null;
}
