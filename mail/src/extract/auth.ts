/**
 * SPF / DKIM / DMARC results from the headers the receiving server added.
 *
 * Email Routing prepends an `Authentication-Results: mx.cloudflare.net; ...` header. Anything
 * further down was written by earlier hops or by the sender, and a sender can forge it. So:
 * use the first Authentication-Results whose authserv-id is Cloudflare's (`trusted: true`);
 * failing that the first one at all (`trusted: false`, verdict "unknown"); failing that
 * Received-SPF.
 *
 * `verdict: "pass"` means the From address's domain is authenticated, on the trusted header only:
 * DMARC pass for that domain (header.from, when given, must be the From domain), or a DKIM pass
 * (header.d) or SPF pass (smtp.mailfrom) whose domain is aligned with it. SHARED_SEND_POLICY=
 * reply_only relies on this, so a forged From never counts.
 */

export type AuthResult = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy" | null;

export interface AuthResults {
  spf: AuthResult;
  dkim: AuthResult;
  dmarc: AuthResult;
  arc: AuthResult;
  /** Domains (header.d) with a passing DKIM signature. */
  dkim_domains: string[];
  /** Who wrote the header we read, e.g. "mx.cloudflare.net". */
  authserv_id: string | null;
  /** True when that header came from Cloudflare Email Routing (not forgeable by the sender). */
  trusted: boolean;
  /**
   * pass: the From domain is authenticated (DMARC pass for it, or an aligned DKIM or SPF pass).
   * fail: DMARC failed. unknown: anything else (incl. any untrusted header).
   */
  verdict: "pass" | "fail" | "unknown";
}

export interface HeaderLike {
  key: string;
  value: string;
}

const RESULTS = new Set(["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror", "policy"]);

/** Remove RFC 5322 comments "(...)", which may nest. */
function stripComments(s: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length) {
      if (!depth) out += ch + s[i + 1];
      i++;
      continue;
    }
    if (ch === '"' && !depth) quoted = !quoted;
    if (!quoted && ch === "(") {
      depth++;
      continue;
    }
    if (!quoted && ch === ")" && depth) {
      depth--;
      continue;
    }
    if (!depth) out += ch;
  }
  return out;
}

interface ParsedAR {
  authservId: string;
  methods: { method: string; result: string; props: Record<string, string> }[];
}

export function parseAuthenticationResults(value: string): ParsedAR {
  const parts = stripComments(value)
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  const authservId = (parts.shift() ?? "").split(/\s+/)[0]!.toLowerCase();
  const methods: ParsedAR["methods"] = [];
  for (const p of parts) {
    const m = /^([a-z0-9_-]+)\s*=\s*([a-z]+)(.*)$/i.exec(p);
    if (!m) continue;
    const props: Record<string, string> = {};
    for (const kv of m[3]!.matchAll(/([a-z0-9_-]+\.[a-z0-9_-]+)\s*=\s*("[^"]*"|\S+)/gi)) {
      props[kv[1]!.toLowerCase()] = kv[2]!.replace(/^"|"$/g, "").toLowerCase();
    }
    methods.push({ method: m[1]!.toLowerCase(), result: m[2]!.toLowerCase(), props });
  }
  return { authservId, methods };
}

function asResult(r: string | undefined): AuthResult {
  return r && RESULTS.has(r) ? (r as AuthResult) : null;
}

/** Organisational-domain-ish (relaxed) alignment: equal, or one is a subdomain of the other. Never a bare TLD. */
function aligned(a: string, b: string): boolean {
  if (!a.includes(".") || !b.includes(".")) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

const domainOf = (v: string | undefined) =>
  v ? (v.includes("@") ? v.slice(v.lastIndexOf("@") + 1) : v).toLowerCase().replace(/\.$/, "") : null;

export function extractAuth(headers: HeaderLike[], fromAddress?: string | null): AuthResults {
  const empty: AuthResults = {
    spf: null,
    dkim: null,
    dmarc: null,
    arc: null,
    dkim_domains: [],
    authserv_id: null,
    trusted: false,
    verdict: "unknown",
  };
  const ars = headers.filter((h) => h.key.toLowerCase() === "authentication-results").map((h) => parseAuthenticationResults(h.value));
  const chosen = ars.find((a) => /(^|\.)cloudflare\.(net|com)$/.test(a.authservId)) ?? ars[0];
  const res = { ...empty };
  let dmarcFrom: string[] = [];
  let spfDomains: string[] = [];

  if (chosen) {
    res.authserv_id = chosen.authservId || null;
    res.trusted = /(^|\.)cloudflare\.(net|com)$/.test(chosen.authservId);
    const by = (m: string) => chosen.methods.filter((x) => x.method === m);
    const pick = (m: string): AuthResult => {
      const all = by(m);
      if (!all.length) return null;
      return asResult(all.find((x) => x.result === "pass")?.result ?? all[0]!.result);
    };
    res.spf = pick("spf");
    res.dkim = pick("dkim");
    res.dmarc = pick("dmarc");
    res.arc = pick("arc");
    res.dkim_domains = [
      ...new Set(
        by("dkim")
          .filter((x) => x.result === "pass" && x.props["header.d"])
          .map((x) => x.props["header.d"]!),
      ),
    ];
    const passing = (m: string, prop: string) =>
      by(m)
        .filter((x) => x.result === "pass")
        .map((x) => domainOf(x.props[prop]));
    dmarcFrom = passing("dmarc", "header.from").map((d) => d ?? "");
    spfDomains = passing("spf", "smtp.mailfrom").filter((d): d is string => !!d);
  }
  if (!res.spf) {
    const rs = headers.find((h) => h.key.toLowerCase() === "received-spf");
    if (rs) res.spf = asResult(/^\s*([a-z]+)/i.exec(rs.value)?.[1]?.toLowerCase());
  }

  const fromDomain = fromAddress?.split("@")[1]?.toLowerCase() ?? null;
  if (res.trusted && fromDomain) {
    // A DMARC pass counts for the From domain it names ("" = not named, i.e. the From Cloudflare saw).
    const dmarcPass = dmarcFrom.some((d) => d === "" || d === fromDomain);
    if (dmarcPass) res.verdict = "pass";
    else if (res.dmarc === "fail") res.verdict = "fail";
    else if (res.dkim_domains.some((d) => aligned(d, fromDomain))) res.verdict = "pass";
    else if (spfDomains.some((d) => aligned(d, fromDomain))) res.verdict = "pass";
  } else if (res.trusted && res.dmarc === "fail") {
    res.verdict = "fail";
  }
  return res;
}
