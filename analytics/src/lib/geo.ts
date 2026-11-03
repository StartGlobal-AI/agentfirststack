/**
 * Geo enrichment. Browser events (/e): from Cloudflare's edge (`request.cf`), or, when the request
 * carries the site's valid x-afs-proxy-key, from headers the first-party proxy forwards
 * (x-afs-geo-*, Vercel's x-vercel-ip-*), because behind a proxy request.cf describes the proxy,
 * not the visitor. Anyone can send those headers, so without the key they are ignored. Server
 * events: only explicit body fields (or the session's geo, inherited in the DO). Local dev:
 * x-dev-geo-* when DEV_MODE=true.
 */

/** Header a first-party proxy sends so the collector trusts its forwarded IP and geo. */
export const PROXY_KEY_HEADER = "x-afs-proxy-key";

export interface Geo {
  country: string | null;
  region: string | null;
  region_code: string | null;
  city: string | null;
  continent: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  asn: number | null;
  as_org: string | null;
}

export const EMPTY_GEO: Geo = {
  country: null,
  region: null,
  region_code: null,
  city: null,
  continent: null,
  timezone: null,
  latitude: null,
  longitude: null,
  asn: null,
  as_org: null,
};

const str = (v: unknown, n = 100): string | null => {
  if (v == null) return null;
  let s = String(v).trim();
  try {
    if (/%[0-9a-f]{2}/i.test(s)) s = decodeURIComponent(s);
  } catch {
    /* keep raw */
  }
  return s ? s.slice(0, n) : null;
};
/** Coarse coordinates: 1 decimal (~11 km), never a precise location. */
const coarse = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
};
const country = (v: unknown): string | null => {
  const s = str(v, 8)?.toUpperCase() ?? null;
  // Cloudflare uses XX for unknown and T1 for Tor.
  return s && /^[A-Z]{2}$/.test(s) && s !== "XX" ? s : null;
};

export function geoFromCf(cf: Record<string, unknown> | undefined | null): Geo {
  if (!cf) return { ...EMPTY_GEO };
  return {
    country: country(cf.country),
    region: str(cf.region),
    region_code: str(cf.regionCode, 10),
    city: str(cf.city),
    continent: str(cf.continent, 4),
    timezone: str(cf.timezone, 64),
    latitude: coarse(cf.latitude),
    longitude: coarse(cf.longitude),
    asn: typeof cf.asn === "number" ? cf.asn : cf.asn ? Number(cf.asn) || null : null,
    as_org: str(cf.asOrganization, 200),
  };
}

function fromPrefixedHeaders(h: Headers, prefix: string): Partial<Geo> | null {
  const get = (k: string) => h.get(`${prefix}${k}`);
  const c = get("country");
  if (!c) return null;
  return {
    country: country(c),
    region: str(get("region")),
    region_code: str(get("region-code"), 10),
    city: str(get("city")),
    continent: str(get("continent"), 4),
    timezone: str(get("timezone"), 64),
    latitude: coarse(get("lat") ?? get("latitude")),
    longitude: coarse(get("lon") ?? get("longitude")),
    asn: get("asn") ? Number(get("asn")) || null : null,
    as_org: str(get("as-org"), 200),
  };
}

/**
 * Geo for a browser request: dev override > proxy-forwarded headers (only when `trustForwarded`,
 * i.e. the request carried the site's proxy key) > request.cf.
 */
export function geoFromRequest(req: Request, opts: { devMode: boolean; trustForwarded: boolean }): Geo {
  const cf = (req as unknown as { cf?: Record<string, unknown> }).cf;
  const base = geoFromCf(cf);
  const h = req.headers;
  if (opts.devMode) {
    const dev = fromPrefixedHeaders(h, "x-dev-geo-");
    if (dev) return { ...EMPTY_GEO, ...stripNull(dev) };
  }
  if (!opts.trustForwarded) return base;
  const fwd = fromPrefixedHeaders(h, "x-afs-geo-");
  if (fwd) return { ...EMPTY_GEO, ...stripNull(fwd) };
  const vercel = h.get("x-vercel-ip-country");
  if (vercel) {
    return {
      ...EMPTY_GEO,
      country: country(vercel),
      region_code: str(h.get("x-vercel-ip-country-region"), 10),
      city: str(h.get("x-vercel-ip-city")),
      latitude: coarse(h.get("x-vercel-ip-latitude")),
      longitude: coarse(h.get("x-vercel-ip-longitude")),
      timezone: str(h.get("x-vercel-ip-timezone"), 64),
    };
  }
  return base;
}

function stripNull<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v != null) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Geo from explicit server-event fields. Anything missing stays null (the DO may inherit it). */
export function geoFromFields(f: {
  country?: string | null;
  region?: string | null;
  region_code?: string | null;
  city?: string | null;
  continent?: string | null;
}): Geo {
  return {
    ...EMPTY_GEO,
    country: country(f.country),
    region: str(f.region),
    region_code: str(f.region_code, 10),
    city: str(f.city),
    continent: str(f.continent, 4)?.toUpperCase() ?? null,
  };
}

/**
 * Client IP for the visitor hash. Direct requests: cf-connecting-ip, which Cloudflare sets and
 * clients can't. Through a first-party proxy that sent the site's proxy key (`trustForwarded`):
 * the first X-Forwarded-For hop, where the proxy puts the visitor's IP (all install snippets do).
 */
export function requestIp(req: Request, trustForwarded: boolean): string {
  const first = trustForwarded ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() : null;
  return first || req.headers.get("cf-connecting-ip") || "0.0.0.0";
}
