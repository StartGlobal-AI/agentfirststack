import { ApiError, hmacSha256Hex, type Standing } from "@afs/shared";
import type { ContainerConfig } from "../config/schema";
import { readTextBounded } from "../lib/http";
import { limits, standingFlag } from "./limits";
import { fetchPage, hasSnippet, homepageProof, isHomepage } from "./scan";

export { hasSnippet };

/**
 * Custom code (custom_html, custom_js, and analytics tags that load a script from a host other
 * than this platform's analytics app) is served from this deployment's domain to every visitor of
 * the site. So a version containing it is published only when:
 *   - the account may publish custom code: ALLOW_CUSTOM_CODE (default true) for claimed accounts,
 *     UNCLAIMED_ALLOW_CUSTOM_CODE (default false) for agent-only ones;
 *   - the container's domain is verified: a DNS TXT record `_afs-verify.<domain>` with the value
 *     from GET /v1/containers/:id (checked over DNS-over-HTTPS), or this container's snippet in a
 *     real <script src> on https://<domain>/ itself (or www.; no query string, answered 2xx; found
 *     by scan or verify);
 *   - its size is within MAX_CUSTOM_CODE_BYTES (when set).
 * Preview links of an unverified draft are served without the custom code.
 */

export interface CustomCode {
  /** Config paths of the tags that count as custom code. */
  paths: string[];
  /** UTF-8 bytes of custom_html + custom_js bodies. */
  bytes: number;
}

const hostOf = (u: string | undefined) => {
  try {
    return u ? new URL(u).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

export function customCodeIn(config: ContainerConfig | null | undefined, env: { ANALYTICS_BASE_URL?: string }): CustomCode {
  const out: CustomCode = { paths: [], bytes: 0 };
  const own = hostOf(env.ANALYTICS_BASE_URL);
  const enc = new TextEncoder();
  (config?.tags ?? []).forEach((t, i) => {
    if (t.type === "custom_html") {
      out.paths.push(`tags.${i}`);
      out.bytes += enc.encode(t.params.html).byteLength;
    } else if (t.type === "custom_js") {
      out.paths.push(`tags.${i}`);
      out.bytes += enc.encode(t.params.code).byteLength;
    } else if (t.type === "analytics" && t.params.base_url && hostOf(t.params.base_url) !== own) {
      out.paths.push(`tags.${i}.params.base_url`);
    }
  });
  return out;
}

/** The config without its custom code (for preview links of a container that may not run it). */
export function stripCustomCode(config: ContainerConfig, env: { ANALYTICS_BASE_URL?: string }): ContainerConfig {
  const paths = new Set(customCodeIn(config, env).paths.map((p) => Number(p.split(".")[1])));
  if (!paths.size) return config;
  return { ...config, tags: (config.tags ?? []).filter((_, i) => !paths.has(i)) };
}

export interface CustomCodeIssue {
  path: string;
  code: "custom_code_not_allowed" | "domain_not_verified" | "custom_code_too_large";
  message: string;
  hint: string;
}

export function customCodeProblem(
  env: object & { ANALYTICS_BASE_URL?: string },
  row: { id: string; domain: string; verified_at?: number | null },
  config: ContainerConfig | null | undefined,
  standing: Standing,
): CustomCodeIssue | null {
  const cc = customCodeIn(config, env);
  if (!cc.paths.length) return null;
  const path = cc.paths[0]!;
  if (!standingFlag(env, standing, "ALLOW_CUSTOM_CODE", true, false)) {
    return standing.claimed
      ? {
          path,
          code: "custom_code_not_allowed",
          message: "This deployment doesn't allow custom code (custom_html, custom_js, analytics tags loading another host's script).",
          hint: "Use the built-in tag types, or load your script from your own site.",
        }
      : {
          path,
          code: "custom_code_not_allowed",
          message:
            "Agent-only (unclaimed) accounts can't publish custom code (custom_html, custom_js, analytics tags loading another host's script).",
          hint: "Ask a person to claim the project (a claim link from the platform's POST /v1/claim-link, opened while signed in), or remove those tags and use the built-in tag types.",
        };
  }
  if (!row.verified_at) {
    return {
      path,
      code: "domain_not_verified",
      message: `Custom code is served to every visitor of ${row.domain}, so publishing it needs the domain verified.`,
      hint: `Add the DNS TXT record from GET /v1/containers/${row.id} (verification.dns_record) and call POST /v1/containers/${row.id}/verify, or install the snippet on https://${row.domain}/ and run scan or verify.`,
    };
  }
  const max = limits(env, standing).maxCustomCodeBytes;
  if (cc.bytes > max) {
    return {
      path,
      code: "custom_code_too_large",
      message: `The config has ${cc.bytes} bytes of custom code; the most allowed here is ${max}.`,
      hint: "Load large code from your own site (<script src=...>) instead of inlining it.",
    };
  }
  return null;
}

/** Drafts with more custom code than MAX_CUSTOM_CODE_BYTES are refused when saved (413). */
export function assertCustomCodeSize(env: object & { ANALYTICS_BASE_URL?: string }, config: ContainerConfig, standing: Standing) {
  const max = limits(env, standing).maxCustomCodeBytes;
  if (!Number.isFinite(max)) return;
  const { bytes } = customCodeIn(config, env);
  if (bytes > max)
    throw new ApiError(
      413,
      "custom_code_too_large",
      `The draft has ${bytes} bytes of custom_html/custom_js; the most allowed here is ${max}.`,
      "Load large code from your own site (<script src=...>) instead of inlining it.",
    );
}

// ------------------------------------------------------------------ verification

/** The TXT value proving control of a container's domain (HMAC of the id with ENCRYPTION_KEY). */
export async function verifyToken(env: { ENCRYPTION_KEY?: string }, containerId: string): Promise<string | null> {
  if (!env.ENCRYPTION_KEY) return null;
  return `afs-verify=${(await hmacSha256Hex(env.ENCRYPTION_KEY, `afs-tags-verify:${containerId}`)).slice(0, 32)}`;
}

export async function dnsRecord(env: { ENCRYPTION_KEY?: string }, row: { id: string; domain: string }) {
  const value = await verifyToken(env, row.id);
  return value ? { name: `_afs-verify.${row.domain}`, type: "TXT", value } : null;
}

export function verificationInfo(row: { verified_at?: number | null; verified_method?: string | null }) {
  return { verified: !!row.verified_at, method: row.verified_method ?? null, verified_at: row.verified_at ?? null };
}

export const DOH_URL = "https://cloudflare-dns.com/dns-query";

/** TXT strings for a name, over DNS-over-HTTPS (JSON API). Empty on any failure. */
export async function dnsTxt(name: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<string[]> {
  try {
    const res = await fetchImpl(`${DOH_URL}?name=${encodeURIComponent(name)}&type=TXT`, {
      headers: { accept: "application/dns-json" },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const j = JSON.parse((await readTextBounded(res, 64 * 1024)).text) as { Answer?: { type: number; data: string }[] };
    return (j.Answer ?? [])
      .filter((a) => a.type === 16 && typeof a.data === "string")
      .map((a) => a.data.replace(/"\s+"/g, "").replace(/^"|"$/g, "").trim());
  } catch {
    return [];
  }
}

export type VerifyMethod = "dns" | "snippet";

export interface VerifyCheck {
  method: VerifyMethod;
  ok: boolean;
  detail: string;
}

/** Try DNS, then the homepage snippet (or just one of them). Pure apart from fetch. */
export async function checkDomain(
  env: { ENCRYPTION_KEY?: string },
  row: { id: string; domain: string },
  method: VerifyMethod | "auto" = "auto",
  fetchImpl?: typeof fetch,
): Promise<{ verified: VerifyMethod | null; checks: VerifyCheck[] }> {
  const checks: VerifyCheck[] = [];
  if (method !== "snippet") {
    const rec = await dnsRecord(env, row);
    if (!rec) checks.push({ method: "dns", ok: false, detail: "ENCRYPTION_KEY isn't set on this deployment, so there is no TXT value." });
    else {
      const txt = await dnsTxt(rec.name, fetchImpl);
      const ok = txt.includes(rec.value);
      checks.push({
        method: "dns",
        ok,
        detail: ok ? `${rec.name} TXT matches.` : `${rec.name} has ${txt.length ? "no matching" : "no"} TXT record (want "${rec.value}").`,
      });
      if (ok) return { verified: "dns", checks };
    }
  }
  if (method !== "dns") {
    const home = `https://${row.domain}/`;
    const page = await fetchPage(home, row.domain, fetchImpl);
    const ok = homepageProof(page, row.domain, row.id);
    checks.push({
      method: "snippet",
      ok,
      detail: ok
        ? `The snippet for ${row.id} is on ${page.url}.`
        : page.error
          ? `Couldn't read ${home}: ${page.error}`
          : !isHomepage(page.url, row.domain)
            ? `${home} redirected to ${page.url}; only https://${row.domain}/ or https://www.${row.domain}/ itself counts (or use the DNS TXT record).`
            : `No <script src=".../c/${row.id}.js"> in a script tag on ${page.url} (status ${page.status}).`,
    });
    if (ok) return { verified: "snippet", checks };
  }
  return { verified: null, checks };
}

export async function markVerified(env: { DB: D1Database }, containerId: string, method: VerifyMethod, now = Date.now()) {
  await env.DB.prepare("UPDATE containers SET verified_at = ?, verified_method = ?, updated_at = ? WHERE id = ? AND verified_at IS NULL")
    .bind(now, method, now, containerId)
    .run();
  return now;
}
