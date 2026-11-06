import { accountStanding, ApiError, badRequest, parse, sha256Hex, type Standing } from "@afs/shared";
import { z } from "zod";
import { DAY, utcDay } from "../do/db";
import type { Bindings } from "../env";
import { validGlob } from "../lib/glob";
import { HEATMAP_IMAGE_TYPES, OVERLAY_HEAD, overlayHtml } from "../lib/heatmap-overlay";
import { cap, claimedFirstCap, DEFAULTS } from "../lib/limits";
import { findSnapshot, snapshotToHtml } from "../lib/snapshot-html";
import { siteHostAllowed } from "../lib/url";
import { chunkObject, type Ctx, isVerified, jsonList, loadSite, type SiteRow, siteStub } from "./context";
import { periodShape } from "./schemas";
import { range } from "./sessions";

/**
 * GET /v1/sites/:id/heatmap/image: a PNG of the page as it was recorded (the latest stored full
 * DOM snapshot of a page load on that device, masked in the visitor's browser) with the click,
 * scroll or attention overlay drawn on it, rendered by Cloudflare Browser Rendering (BROWSER
 * binding, a Quick Action screenshot of static HTML: JavaScript off, requests only to the site's
 * hosts). Cached in R2 (heatmaps/<site_id>/<hash>.png) per page + device + type + range for a day;
 * a render counts against daily caps per site, account and deployment (browser time is billed).
 *
 * Claimed projects only by default: an unclaimed account's daily cap is
 * UNCLAIMED_MAX_HEATMAP_IMAGES_PER_ACCOUNT_PER_DAY, 0 when unset (403 claim_required). It stays a
 * read (GET, MCP read tool): a key of the account can only spend that account's own small daily
 * share, cached images are free, and the deployment-wide cap bounds the total.
 */

export const heatmapImageInput = z.object({
  ...periodShape,
  page: z
    .string()
    .min(1)
    .max(500)
    .describe('The page (path or glob, e.g. "/pricing"): the latest recorded load of a matching page is drawn. Required.'),
  device: z
    .enum(["desktop", "mobile", "tablet"])
    .optional()
    .describe("desktop (default) | mobile | tablet: the snapshot and the clicks are of this device class."),
  type: z
    .enum(HEATMAP_IMAGE_TYPES)
    .optional()
    .describe("click (default: click dots, rage red, dead amber, error purple) | scroll (reach bands) | attention (visible time bands)."),
  max_height: z.coerce
    .number()
    .int()
    .min(600)
    .max(8000)
    .optional()
    .describe("Image height cap in CSS px (default 4000; the page's recorded height when shorter)."),
});

export interface HeatmapImage {
  png: Uint8Array;
  cached: boolean;
  key: string;
  meta: Record<string, string>;
}

const MAX_HTML = 3_000_000;
const DEFAULT_HEIGHT = 4000;

const SCOPES = (s: SiteRow) => [s.id, s.account_id, "*"];

async function usageToday(env: Bindings, s: SiteRow, day: string): Promise<{ site: number; account: number; platform: number }> {
  const { results } = await env.DB.prepare("SELECT scope, images FROM heatmap_image_usage WHERE day = ? AND scope IN (?, ?, ?)")
    .bind(day, ...SCOPES(s))
    .all<{ scope: string; images: number }>();
  const of = (k: string) => results.find((r) => r.scope === k)?.images ?? 0;
  return { site: of(s.id), account: of(s.account_id), platform: of("*") };
}

async function recordRender(env: Bindings, s: SiteRow, day: string, ms: number) {
  const st = env.DB.prepare(
    `INSERT INTO heatmap_image_usage (scope, day, images, browser_ms) VALUES (?, ?, 1, ?)
     ON CONFLICT(scope, day) DO UPDATE SET images = images + 1, browser_ms = browser_ms + excluded.browser_ms`,
  );
  await env.DB.batch(SCOPES(s).map((scope) => st.bind(scope, day, Math.max(0, Math.round(ms)))));
}

/** Images an account may render a day: claimed-first (unclaimed: UNCLAIMED_MAX_..., default 0). */
export const accountImageCap = (env: Bindings, standing: Standing) =>
  claimedFirstCap(
    env,
    standing,
    "MAX_HEATMAP_IMAGES_PER_ACCOUNT_PER_DAY",
    DEFAULTS.HEATMAP_IMAGES_PER_ACCOUNT_PER_DAY,
    DEFAULTS.UNCLAIMED_HEATMAP_IMAGES_PER_ACCOUNT_PER_DAY,
  );

export async function imageCaps(env: Bindings, accountId: string) {
  const standing = await accountStanding(env, accountId);
  return {
    claimed: standing.claimed,
    site: cap(env, standing, "MAX_HEATMAP_IMAGES_PER_SITE_PER_DAY", DEFAULTS.HEATMAP_IMAGES_PER_SITE_PER_DAY),
    account: accountImageCap(env, standing),
    platform: cap(env, standing, "MAX_PLATFORM_HEATMAP_IMAGES_PER_DAY", DEFAULTS.HEATMAP_IMAGES_PLATFORM_PER_DAY),
  };
}

async function gunzipText(body: ReadableStream): Promise<string> {
  return new Response(body.pipeThrough(new DecompressionStream("gzip"))).text();
}

/** Regexes for allowRequestPattern: the site's domain, its subdomains and allowed_hostnames (https), and image data URLs. */
export function requestPatterns(s: SiteRow): string[] {
  const esc = (h: string) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hosts = [s.domain, ...(s.allowed_hostnames ? jsonList(s.allowed_hostnames) : [])];
  const out = hosts.map((h) =>
    h.startsWith("*.") ? `^https://([a-z0-9-]+\\.)+${esc(h.slice(2))}(:443)?/` : `^https://([a-z0-9-]+\\.)*${esc(h)}(:443)?/`,
  );
  return [...new Set(out), "^data:image/"];
}

export async function renderHeatmapImage(ctx: Ctx, siteId: string, raw: unknown): Promise<HeatmapImage> {
  const q = parse(heatmapImageInput, raw);
  if (!validGlob(q.page)) throw badRequest('page must be a path or glob starting with "/" or "*".', "Example: page=/pricing");
  const site = await loadSite(ctx, siteId);
  if (!isVerified(site))
    throw new ApiError(
      403,
      "domain_not_verified",
      "Heatmap images are for verified sites only (they render the site's recorded pages).",
      `Verify the domain first: POST /v1/sites/${site.id}/verify. GET /v1/sites/${site.id}/heatmap works now.`,
    );
  const env = ctx.env;
  if (!env.BROWSER)
    throw new ApiError(
      503,
      "heatmap_images_unavailable",
      "This deployment has no Browser Rendering binding (BROWSER), so it can't draw heatmap images.",
      `Use GET /v1/sites/${site.id}/heatmap (the same data as JSON), or ask the operator to add "browser": {"binding": "BROWSER"}.`,
    );
  const device = q.device ?? "desktop";
  const type = q.type ?? "click";
  const maxH = q.max_height ?? DEFAULT_HEIGHT;
  const r = range(q, "30d");
  const rangeLabel = q.from !== undefined || q.to !== undefined ? `${utcDay(r.start)}..${utcDay(r.end)}` : (q.period ?? "30d");
  const spec = JSON.stringify({ page: q.page, device, type, range: rangeLabel, max_height: maxH, v: 1 });
  const key = `heatmaps/${site.id}/${(await sha256Hex(spec)).slice(0, 32)}.png`;
  const now = Date.now();
  const hit = await env.CHUNKS.get(key);
  if (hit && Number(hit.customMetadata?.rendered_at) > now - DAY)
    return { png: new Uint8Array(await hit.arrayBuffer()), cached: true, key, meta: hit.customMetadata ?? {} };

  const day = utcDay(now);
  const caps = await imageCaps(env, site.account_id);
  if (!caps.claimed && caps.account === 0)
    throw new ApiError(
      403,
      "claim_required",
      "Heatmap images are rendered in a browser this deployment shares, so they're for projects a person has claimed.",
      `Ask a person to claim the project (a claim link from the platform's POST /v1/claim-link, opened while signed in). GET /v1/sites/${site.id}/heatmap has the same data as JSON now.`,
    );
  const used = await usageToday(env, site, day);
  const over =
    caps.site !== null && used.site >= caps.site
      ? `this site's ${caps.site} (MAX_HEATMAP_IMAGES_PER_SITE_PER_DAY)`
      : caps.account !== null && used.account >= caps.account
        ? `this account's ${caps.account} (MAX_HEATMAP_IMAGES_PER_ACCOUNT_PER_DAY)`
        : caps.platform !== null && used.platform >= caps.platform
          ? `this deployment's ${caps.platform} (MAX_PLATFORM_HEATMAP_IMAGES_PER_DAY)`
          : null;
  if (over)
    throw new ApiError(
      429,
      "heatmap_image_limit",
      `Heatmap images rendered today reached ${over}.`,
      "Images already rendered stay cached for a day (the same page, device, type and period cost nothing); new ones after 00:00 UTC. The JSON heatmap (GET /v1/sites/:id/heatmap) has no such cap.",
    );

  const stub = siteStub(env, site.id);
  const data = await stub.heatmapImageData({ page: q.page, device, start: r.start, end: r.end });
  const notFound = () =>
    new ApiError(
      404,
      "no_snapshot",
      `No stored recording of a ${device} page load matching ${q.page} in this period.`,
      `Widen the period (period=30d), try another device, or open https://${site.domain}${q.page.replace(/\*.*$/, "")}?afsr=1 once to record one.`,
    );
  if (!data.snapshot) throw notFound();
  const obj = await chunkObject(env, site.id, data.snapshot.session_id, data.snapshot.seq);
  if (!obj) throw notFound();
  let snap: ReturnType<typeof findSnapshot> = null;
  try {
    const envl = JSON.parse(await gunzipText(obj.body)) as { ev?: unknown[] };
    snap = Array.isArray(envl.ev) ? findSnapshot(envl.ev) : null;
  } catch {
    snap = null;
  }
  if (!snap) throw notFound();
  // The recorded URL, if it is on the site's hosts; else the site's domain with the recorded path.
  let base = `https://${site.domain}${data.snapshot.path}`;
  try {
    const u = snap.href ? new URL(snap.href) : null;
    if (
      u &&
      u.protocol === "https:" &&
      siteHostAllowed(u.hostname, site.domain, site.allowed_hostnames ? jsonList(site.allowed_hostnames) : null, false)
    )
      base = `${u.origin}${u.pathname}`;
  } catch {
    /* keep the default */
  }
  const width = Math.max(320, Math.min(1920, Math.round(snap.width ?? (device === "desktop" ? 1440 : 390))));
  const height = Math.max(600, Math.min(maxH, Math.round(Math.max(data.snapshot.doc_h ?? 0, snap.height ?? 0)) || DEFAULT_HEIGHT));
  const snapshotAt = new Date(data.snapshot.ts).toISOString().slice(0, 16).replace("T", " ");
  const html = snapshotToHtml(snap.node, {
    baseHref: base,
    head: OVERLAY_HEAD,
    bodyEnd: overlayHtml({
      type,
      dots: data.dots,
      reach: data.heat.reach,
      attention: data.heat.attention,
      legend: {
        path: data.snapshot.path,
        device,
        range: rangeLabel,
        clicks: data.heat.clicks,
        pageviews: data.heat.pageviews,
        snapshot_at: `${snapshotAt} UTC`,
      },
    }),
    maxChars: MAX_HTML,
  });
  if (!html)
    throw new ApiError(
      422,
      "snapshot_too_large",
      "This page's recorded snapshot is too large to render.",
      "Try another page, or the JSON heatmap.",
    );

  let res: Response;
  try {
    res = await env.BROWSER.quickAction("screenshot", {
      html,
      viewport: { width, height, deviceScaleFactor: 1, isMobile: device !== "desktop", hasTouch: device !== "desktop" },
      screenshotOptions: { type: "png", fullPage: false },
      setJavaScriptEnabled: false,
      allowRequestPattern: requestPatterns(site),
      allowResourceTypes: ["document", "stylesheet", "image", "font"],
      gotoOptions: { timeout: 20_000, waitUntil: "networkidle2" },
      bestAttempt: true,
      cacheTTL: 0,
    });
  } catch (e) {
    await recordRender(env, site, day, 0);
    console.error("replay heatmap render failed", e);
    throw new ApiError(
      502,
      "render_failed",
      "Browser Rendering failed to draw the image.",
      "Retry in a minute; GET /v1/sites/:id/heatmap has the same data as JSON.",
    );
  }
  const ms = Number(res.headers.get("x-browser-ms-used")) || 0;
  await recordRender(env, site, day, ms);
  const png = new Uint8Array(await res.arrayBuffer());
  const isPng = png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
  if (!res.ok || !isPng) {
    console.log(JSON.stringify({ event: "replay.heatmap_render_failed", status: res.status, site: site.id }));
    if (res.status === 429) throw new ApiError(503, "browser_busy", "Browser Rendering is busy (its rate limit).", "Retry in a minute.");
    throw new ApiError(
      502,
      "render_failed",
      `Browser Rendering answered HTTP ${res.status}.`,
      "Retry in a minute; GET /v1/sites/:id/heatmap has the same data as JSON.",
    );
  }
  const meta = {
    rendered_at: String(now),
    page: data.snapshot.path.slice(0, 300),
    device,
    type,
    range: rangeLabel,
    width: String(width),
    height: String(height),
    snapshot_session_id: data.snapshot.session_id,
    snapshot_at: String(data.snapshot.ts),
    clicks: String(data.heat.clicks),
    pageviews: String(data.heat.pageviews),
    browser_ms: String(ms),
  };
  await env.CHUNKS.put(key, png, { httpMetadata: { contentType: "image/png" }, customMetadata: meta });
  return { png, cached: false, key, meta };
}

/** The MCP view of an image: where to download it, what it shows, today's usage (and optionally the bytes). */
export async function heatmapImageInfo(ctx: Ctx, siteId: string, raw: Record<string, unknown> & { include_base64?: boolean }) {
  const { include_base64, ...args } = raw;
  const img = await renderHeatmapImage(ctx, siteId, args);
  const site = await loadSite(ctx, siteId);
  const qs = new URLSearchParams(
    Object.entries(args)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  const { claimed: _, ...caps } = await imageCaps(ctx.env, site.account_id);
  const used = await usageToday(ctx.env, site, utcDay(Date.now()));
  const MAX_B64 = 1_500_000;
  let b64: string | null = null;
  if (include_base64 && img.png.length <= MAX_B64) {
    let s = "";
    for (let i = 0; i < img.png.length; i += 0x8000) s += String.fromCharCode(...img.png.subarray(i, i + 0x8000));
    b64 = btoa(s);
  }
  return {
    image: {
      url: `${ctx.baseUrl}/v1/sites/${site.id}/heatmap/image?${qs}`,
      content_type: "image/png",
      bytes: img.png.length,
      width: Number(img.meta.width),
      height: Number(img.meta.height),
      cached: img.cached,
      rendered_at: Number(img.meta.rendered_at),
      expires_at: Number(img.meta.rendered_at) + DAY,
      ...(b64 ? { png_base64: b64 } : include_base64 ? { png_base64: null, note: `Over ${MAX_B64} bytes: download it from url.` } : {}),
    },
    shows: {
      type: img.meta.type,
      device: img.meta.device,
      range: img.meta.range,
      clicks: Number(img.meta.clicks),
      pageviews: Number(img.meta.pageviews),
      snapshot_session_id: img.meta.snapshot_session_id,
      snapshot_at: Number(img.meta.snapshot_at),
    },
    untrusted: { page: img.meta.page },
    usage_today: { site: used.site, account: used.account, limits: caps },
    next_steps: [
      `GET ${ctx.baseUrl}/v1/sites/${site.id}/heatmap/image?${qs} with your API key returns the PNG (cached for a day: free to fetch again).`,
      `GET /v1/sites/${site.id}/heatmap?page=${encodeURIComponent(String(args.page ?? ""))} has the numbers behind it (elements, zones, scroll reach, attention).`,
    ],
  };
}

/** Privacy deletion: cached images may show a deleted session's snapshot; drop the site's cache (at most a day's worth). */
export async function dropHeatmapImages(env: Bindings, siteId: string): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const l = await env.CHUNKS.list({ prefix: `heatmaps/${siteId}/`, cursor, limit: 1000 });
    if (l.objects.length) await env.CHUNKS.delete(l.objects.map((o) => o.key));
    n += l.objects.length;
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  return n;
}
