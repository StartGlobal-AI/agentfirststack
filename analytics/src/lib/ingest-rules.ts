import { type CompiledPathRule, cleanPath, compilePathRules } from "./pathrules";
import { redactNullable, redactProps, redactText } from "./pii";
import type { EnrichedEvent, PathRule } from "./types";

/**
 * The per-site transformations an event goes through before it is stored, in order: PII
 * redaction (redact_pii), then path cleaning (path_rules). Pure; run by the site's Durable Object on
 * every event (engagement beacons too, so they still find their pageview) and by the exclusions dry
 * run, so both always agree.
 */

/** Text fields that can carry an email or phone number by accident. */
export const REDACTED_FIELDS = [
  "pathname",
  "url",
  "referrer",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_source_platform",
  "utm_creative_format",
  "utm_marketing_tactic",
] as const;

export interface RuleSettings {
  redact_pii?: boolean;
  path_rules?: PathRule[] | null;
}

let rulesFor: string | null = null;
let rulesCompiled: CompiledPathRule[] = [];
/** Compiled once per settings change (the DO serves one site). */
export function compiledPathRules(rules: PathRule[] | null | undefined): CompiledPathRule[] {
  const key = JSON.stringify(rules ?? null);
  if (key !== rulesFor) {
    rulesCompiled = compilePathRules(rules);
    rulesFor = key;
  }
  return rulesCompiled;
}

export interface CleanedEvent {
  ev: EnrichedEvent;
  /** some field had an email or phone number replaced */
  redacted: boolean;
  /** the path rule that rewrote the path, or null */
  path_rule: string | null;
}

/** origin of a stored url ("https://example.com"), or null. */
const originOf = (url: string | null): string | null => {
  if (!url) return null;
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return m ? m[1]! : null;
};

export function cleanEvent(input: EnrichedEvent, s: RuleSettings): CleanedEvent {
  let ev = input;
  let redacted = false;
  if (s.redact_pii !== false) {
    const out: Record<string, unknown> = { ...ev };
    for (const f of REDACTED_FIELDS) {
      const v = ev[f];
      if (typeof v !== "string") continue;
      const r = redactText(v);
      if (r !== v) {
        out[f] = r;
        redacted = true;
      }
    }
    for (const f of ["title", "search_term"] as const) {
      const v = (ev as unknown as Record<string, unknown>)[f];
      if (typeof v === "string") {
        const r = redactNullable(v);
        if (r !== v) {
          out[f] = r;
          redacted = true;
        }
      }
    }
    const props = redactProps(ev.props);
    if (props !== ev.props) {
      out.props = props;
      redacted = true;
    }
    if (redacted) ev = out as unknown as EnrichedEvent;
  }
  let pathRule: string | null = null;
  const rules = compiledPathRules(s.path_rules);
  if (rules.length && ev.pathname) {
    const c = cleanPath(ev.pathname, rules);
    if (c.rule) {
      pathRule = c.rule;
      const origin = originOf(ev.url);
      ev = { ...ev, pathname: c.path, url: origin ? `${origin}${c.path}` : ev.url };
    }
  }
  if (redacted && ev.pathname && ev.url && !pathRule) {
    // The url's path is the encoded form of pathname: keep them in step after a redaction.
    const origin = originOf(ev.url);
    if (origin) ev = { ...ev, url: `${origin}${ev.pathname}` };
  }
  return { ev, redacted, path_rule: pathRule };
}
