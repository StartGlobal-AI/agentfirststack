import {
  type AuthBindings,
  ApiError,
  accountStanding,
  type CapabilityPause,
  capabilityPaused,
  capabilityPausedError,
  hmacSha256Hex,
  requestCapabilityPause,
  type Standing,
} from "@afs/shared";
import type { ContainerConfig } from "../config/schema";
import { readTextBounded } from "../lib/http";
import { type CodeFinding, describeFindings, type ScanContext, scanConfig } from "./code-scan";
import { limits, standingFlag } from "./limits";
import { fetchPage, hasSnippet, homepageProof, isHomepage } from "./scan";

export { hasSnippet };

/**
 * Custom code (custom_html, custom_js tags, custom_js variables, and analytics tags that load a script from a host other
 * than this platform's analytics app) is served from this deployment's domain to every visitor of
 * the site. So a version containing it is published only when:
 *   - the account may publish custom code: ALLOW_CUSTOM_CODE (default true) for claimed accounts,
 *     UNCLAIMED_ALLOW_CUSTOM_CODE (default false) for agent-only ones;
 *   - the container's domain is verified: a DNS TXT record `_afs-verify.<domain>` with the value
 *     from GET /v1/containers/:id (checked over DNS-over-HTTPS), or this container's snippet in a
 *     real <script src> on https://<domain>/ itself (or www.; no query string, answered 2xx; found
 *     by scan or verify);
 *   - its size is within MAX_CUSTOM_CODE_BYTES (when set);
 *   - it passes the known-bad pattern check (code-scan.ts: miners, skimmers, obfuscated eval chains,
 *     malicious hosts); a strong match at publish also pauses tags.custom_code for the account;
 *   - tags.custom_code isn't paused for the account (a pause also strips custom code from the live
 *     script until the operator lifts it).
 * Preview links and environment builds that fail any of these are served without the custom code.
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
  (config?.variables ?? []).forEach((v, i) => {
    if (v.type !== "custom_js") return;
    out.paths.push(`variables.${i}`);
    out.bytes += enc.encode(v.code).byteLength;
  });
  return out;
}

/** Whether a config has custom code at all (cheaper than customCodeIn: nothing is measured). */
export function hasCustomCode(config: ContainerConfig | null | undefined, env: { ANALYTICS_BASE_URL?: string }): boolean {
  return (
    (config?.tags ?? []).some(
      (t) =>
        t.type === "custom_html" ||
        t.type === "custom_js" ||
        (t.type === "analytics" && !!t.params.base_url && hostOf(t.params.base_url) !== hostOf(env.ANALYTICS_BASE_URL)),
    ) || (config?.variables ?? []).some((v) => v.type === "custom_js")
  );
}

/** The config without its custom code (for preview links of a container that may not run it). */
export function stripCustomCode(config: ContainerConfig, env: { ANALYTICS_BASE_URL?: string }): ContainerConfig {
  const paths = customCodeIn(config, env).paths;
  if (!paths.length) return config;
  const drop = (kind: string) => new Set(paths.filter((p) => p.startsWith(`${kind}.`)).map((p) => Number(p.split(".")[1])));
  const tags = drop("tags");
  const vars = drop("variables");
  return {
    ...config,
    tags: (config.tags ?? []).filter((_, i) => !tags.has(i)),
    variables: (config.variables ?? []).filter((_, i) => !vars.has(i)),
  };
}

export interface CustomCodeIssue {
  path: string;
  code: "custom_code_not_allowed" | "domain_not_verified" | "custom_code_too_large" | "custom_code_blocked" | "capability_paused";
  message: string;
  hint: string;
  /** custom_code_blocked: every match. */
  findings?: CodeFinding[];
}

type CodeEnv = object & Omit<ScanContext, "domain"> & { AUTH_ISSUER?: string };

const scanContext = (env: CodeEnv, domain: string): ScanContext => ({
  domain,
  ANALYTICS_BASE_URL: env.ANALYTICS_BASE_URL,
  PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
  EXTRA_BLOCKED_CODE_HOSTS: env.EXTRA_BLOCKED_CODE_HOSTS,
});

const CHECKED =
  'Checked at publish: crypto miners, code that reads password or card fields and sends them out, eval of decoded or obfuscated code, and known malicious hosts (GET /llms.txt, "Custom code checks").';

function blockedIssue(findings: CodeFinding[]): CustomCodeIssue {
  return {
    path: findings[0]!.path,
    code: "custom_code_blocked",
    message: `The custom code matches a known-bad pattern: ${describeFindings(findings)}.`,
    hint: `Remove it (findings has each match and its path); publishing is refused while it's there. ${CHECKED}`,
    findings,
  };
}

/** The account's standing and whether tags.custom_code is paused (both cached per isolate for a minute). */
export async function codeGate(env: AuthBindings, accountId: string): Promise<{ standing: Standing; pause: CapabilityPause | null }> {
  const [standing, pause] = await Promise.all([accountStanding(env, accountId), capabilityPaused(env, accountId, "tags.custom_code")]);
  return { standing, pause };
}

export function customCodeProblem(
  env: CodeEnv,
  row: { id: string; domain: string; verified_at?: number | null },
  config: ContainerConfig | null | undefined,
  standing: Standing,
  pause?: CapabilityPause | null,
): CustomCodeIssue | null {
  const cc = customCodeIn(config, env);
  const findings = scanConfig(config, scanContext(env, row.domain));
  if (!cc.paths.length && !findings.length) return null;
  const path = cc.paths[0] ?? findings[0]!.path;
  if (pause && cc.paths.length) {
    const e = capabilityPausedError(pause);
    return { path, code: "capability_paused", message: e.message, hint: e.hint ?? "" };
  }
  if (findings.length) return blockedIssue(findings);
  if (!standingFlag(env, standing, "ALLOW_CUSTOM_CODE", true, false)) {
    return standing.claimed
      ? {
          path,
          code: "custom_code_not_allowed",
          message:
            "This deployment doesn't allow custom code (custom_html, custom_js tags and variables, analytics tags loading another host's script).",
          hint: "Use the built-in tag types, or load your script from your own site.",
        }
      : {
          path,
          code: "custom_code_not_allowed",
          message:
            "Agent-only (unclaimed) accounts can't publish custom code (custom_html, custom_js tags and variables, analytics tags loading another host's script).",
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

/**
 * Before a config goes live (publish, publishing a saved version, pinning an environment to one):
 * custom code while tags.custom_code is paused is refused (403 capability_paused); custom code that
 * matches a known-bad pattern is refused (422 custom_code_blocked), and a strong match pauses
 * tags.custom_code for the account first (the site emails the project's people and the operator).
 * Nothing else is checked here; customCodeProblem() does the rest.
 */
export async function assertCodeSafe(
  env: CodeEnv & AuthBindings & { SITE?: Fetcher },
  row: { id: string; domain: string; account_id: string },
  config: ContainerConfig | null | undefined,
  what = "nothing was published",
): Promise<void> {
  if (hasCustomCode(config, env)) {
    const pause = await capabilityPaused(env, row.account_id, "tags.custom_code");
    if (pause) throw capabilityPausedError(pause);
  }
  const findings = scanConfig(config, scanContext(env, row.domain));
  if (!findings.length) return;
  const strong = findings.filter((f) => f.strong);
  let paused = false;
  if (strong.length) {
    const r = await requestCapabilityPause(env, {
      accountId: row.account_id,
      capability: "tags.custom_code",
      reason: `container ${row.id} (${row.domain}) tried to publish ${describeFindings(strong)}`,
      by: "tags",
      details: { container_id: row.id, domain: row.domain, findings: strong },
    });
    paused = r.paused;
    console.log(JSON.stringify({ event: "tags.custom_code_blocked", container_id: row.id, rules: strong.map((f) => f.rule), paused }));
  }
  const issue = blockedIssue(findings);
  throw new ApiError(
    422,
    "custom_code_blocked",
    `${issue.message.replace(/\.$/, "")}; ${what}.`,
    paused
      ? `${issue.hint} This is a strong match, so custom code is now paused for this project (the live script runs without it); the project's people and the operator were emailed. If it's a mistake, reply to that email or write to the platform's support address with the account id.`
      : issue.hint,
    findings,
  );
}

/** Drafts with more custom code than MAX_CUSTOM_CODE_BYTES are refused when saved (413). */
export function assertCustomCodeSize(env: CodeEnv, config: ContainerConfig, standing: Standing) {
  const max = limits(env, standing).maxCustomCodeBytes;
  if (!Number.isFinite(max)) return;
  const { bytes } = customCodeIn(config, env);
  if (bytes > max)
    throw new ApiError(
      413,
      "custom_code_too_large",
      `The draft has ${bytes} bytes of custom_html/custom_js (tags and variables); the most allowed here is ${max}.`,
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
