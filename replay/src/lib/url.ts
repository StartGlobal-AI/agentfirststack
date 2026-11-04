/**
 * Hostnames a replay site may claim. A site's domain (and allowed_hostnames) decide which pages may
 * send recordings to it, so nobody may claim an IP address, a bare TLD, a public suffix (co.uk,
 * github.io, pages.dev, ...) or a wildcard over one ("*.com", "*.vercel.app"): that would admit
 * every site under it. The suffix list is a compact built-in subset of the Public Suffix List (the
 * ccTLD second levels and hosting platforms that matter in practice); anything with a single label
 * is a TLD and refused too.
 */

const ICANN_SECOND_LEVEL = `
co.uk org.uk me.uk ltd.uk plc.uk net.uk ac.uk gov.uk sch.uk nhs.uk police.uk
com.au net.au org.au edu.au gov.au asn.au id.au co.nz org.nz net.nz govt.nz ac.nz geek.nz school.nz
co.jp ne.jp or.jp ac.jp go.jp gr.jp ed.jp lg.jp co.kr or.kr ne.kr go.kr ac.kr re.kr
com.br net.br org.br gov.br edu.br art.br blog.br com.cn net.cn org.cn gov.cn edu.cn ac.cn
com.mx org.mx gob.mx edu.mx net.mx co.in net.in org.in firm.in gen.in ind.in ac.in gov.in edu.in
co.za org.za gov.za ac.za net.za web.za com.sg org.sg edu.sg gov.sg net.sg per.sg
com.hk org.hk edu.hk gov.hk net.hk idv.hk com.tw org.tw edu.tw gov.tw net.tw idv.tw
com.tr org.tr gen.tr net.tr gov.tr edu.tr biz.tr web.tr com.ar org.ar net.ar gob.ar edu.ar
com.co net.co org.co edu.co gov.co com.pe org.pe net.pe gob.pe com.ve com.ec com.uy com.py com.bo com.gt com.do com.sv
co.il org.il net.il ac.il gov.il muni.il co.id or.id ac.id go.id web.id my.id biz.id
com.my org.my net.my gov.my edu.my com.ph org.ph net.ph gov.ph edu.ph com.vn net.vn org.vn gov.vn edu.vn
com.pk org.pk net.pk gov.pk edu.pk com.ng org.ng gov.ng edu.ng co.ke or.ke go.ke ac.ke ne.ke
com.eg gov.eg edu.eg com.sa gov.sa edu.sa net.sa org.sa com.ua org.ua net.ua gov.ua in.ua kiev.ua
com.pl net.pl org.pl waw.pl co.th or.th go.th ac.th in.th net.th com.es org.es gob.es nom.es edu.es
co.at or.at ac.at gv.at com.gr edu.gr gov.gr com.pt org.pt gov.pt com.ru org.ru net.ru msk.ru spb.ru
co.it com.cy com.mt com.ro com.hr com.lb com.qa com.kw com.bh com.om com.jo com.ly com.np com.bd com.lk
ac.ae co.ae gov.ae net.ae org.ae sch.ae co.tz or.tz go.tz co.ug or.ug go.ug co.zm co.zw co.mz
gob.cl br.com cn.com de.com eu.com gb.com gb.net hu.com jp.net kr.com qc.com ru.com sa.com uk.com uk.net us.com za.com
`;

const PLATFORMS = `
github.io githubusercontent.com gitlab.io pages.dev workers.dev r2.dev vercel.app now.sh vercel.dev netlify.app netlify.com
herokuapp.com herokudns.com appspot.com firebaseapp.com web.app blogspot.com wordpress.com wpcomstaging.com wixsite.com
azurewebsites.net azurestaticapps.net cloudapp.net trafficmanager.net cloudfront.net amazonaws.com s3.amazonaws.com
elasticbeanstalk.com awsapprunner.com amplifyapp.com fly.dev onrender.com glitch.me repl.co replit.dev replit.app surge.sh
ngrok.io ngrok-free.app ngrok.app trycloudflare.com deno.dev deno.net railway.app up.railway.app webflow.io framer.app
framer.website myshopify.com bubbleapps.io carrd.co notion.site supabase.co lovable.app bolt.host stackblitz.io codesandbox.io
csb.app pythonanywhere.com readthedocs.io gitbook.io hashnode.dev substack.com tumblr.com squarespace.com weebly.com
neocities.org translate.goog azureedge.net web.core.windows.net digitaloceanspaces.com ondigitalocean.app
render.com kinsta.cloud wpengine.com pantheonsite.io code.run edgeapp.net loca.lt localtunnel.me serveo.net
`;

const SUFFIXES = new Set(`${ICANN_SECOND_LEVEL} ${PLATFORMS}`.split(/\s+/).filter(Boolean));

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** An IP literal (v4 dotted, or anything with ":" / brackets, i.e. v6). */
export function isIpLiteral(host: string): boolean {
  const h = host.toLowerCase();
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || h.startsWith("[") || /^\d+$/.test(h);
}

/** A TLD or a public suffix: claiming it would cover unrelated sites. */
export function isPublicSuffix(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return !h.includes(".") || SUFFIXES.has(h);
}

export type HostProblem = "invalid" | "ip" | "single_label" | "public_suffix";

/** Why `host` can't be a site's own hostname, or null when it can. localhost only in dev. */
export function hostProblem(host: string, dev = false): HostProblem | null {
  const h = host.toLowerCase();
  if (dev && (h === "localhost" || h === "127.0.0.1")) return null;
  if (isIpLiteral(h)) return "ip";
  if (h.length > 253 || !HOST_RE.test(h)) return "invalid";
  if (!h.includes(".")) return "single_label";
  if (isPublicSuffix(h)) return "public_suffix";
  return null;
}

export class DomainError extends Error {
  constructor(readonly problem: HostProblem) {
    super(`bad domain: ${problem}`);
  }
}

/** "https://www.Example.com/path" -> "example.com". Throws DomainError on anything a site can't claim. */
export function normalizeDomain(input: string, dev = false): string {
  let s = input.trim().toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  let host: string;
  try {
    const u = new URL(s);
    if (u.port && u.port !== "443" && u.port !== "80") throw new DomainError("invalid");
    host = u.hostname.replace(/\.$/, "");
  } catch (e) {
    throw e instanceof DomainError ? e : new DomainError("invalid");
  }
  if (!isIpLiteral(host)) host = host.replace(/^www\./, "");
  const p = hostProblem(host, dev);
  if (p) throw new DomainError(p);
  return host;
}

/**
 * An allowed_hostnames entry ("shop.example.net" or "*.example.net"), lowercased, or the reason
 * it is refused: the hostname under a wildcard must itself be claimable (no "*.com", "*.co.uk").
 */
export function checkHostPattern(pattern: string, dev = false): { pattern: string } | { problem: HostProblem } {
  const p = pattern.trim().toLowerCase().replace(/\.$/, "");
  const base = p.startsWith("*.") ? p.slice(2) : p;
  const problem = hostProblem(base, dev);
  return problem ? { problem } : { pattern: p };
}

/** Does `host` match one of the patterns ("example.com", "*.example.com")? */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((p) => {
    const q = p.toLowerCase();
    return q.startsWith("*.") ? h === q.slice(2) || h.endsWith(q.slice(1)) : h === q;
  });
}

/** allowed_hostnames as stored, minus entries the current rules refuse (rows written before them). */
export const safePatterns = (list: readonly string[] | null, dev = false): string[] =>
  (list ?? []).filter((p) => "pattern" in checkHostPattern(p, dev));

/** The site's domain, its subdomains, and allowed_hostnames; localhost in dev. */
export function siteHostAllowed(host: string, domain: string, allowed: readonly string[] | null, dev: boolean): boolean {
  const h = host.toLowerCase();
  if (dev && (h === "localhost" || h === "127.0.0.1")) return true;
  if (isIpLiteral(h)) return false;
  if (h === domain || h.endsWith(`.${domain}`)) return true;
  const safe = safePatterns(allowed, dev);
  return safe.length > 0 && hostAllowed(h, safe);
}

/** The site's domain or one of its subdomains (verify fetches nothing else). */
export const ownHost = (host: string, domain: string) => {
  const h = host.toLowerCase();
  return !isIpLiteral(h) && (h === domain || h.endsWith(`.${domain}`));
};

/**
 * A page's Origin we accept browser uploads from: https, or plain http only for localhost /
 * 127.0.0.1 in local development (DEV_MODE). Returns its hostname, or null.
 */
export function secureOriginHost(origin: string | null, dev: boolean): string | null {
  if (!origin || origin === "null") return null;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  if (u.protocol === "https:") return u.hostname;
  if (u.protocol === "http:" && dev && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return u.hostname;
  return null;
}
