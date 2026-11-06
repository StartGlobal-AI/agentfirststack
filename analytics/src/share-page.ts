/**
 * The public share dashboard: one self-contained HTML page, no framework, no external assets.
 * Reads GET /share/:token/data. Every data value is written with textContent (page paths and
 * referrers are visitor-controlled), and the inline SVG chart is built with createElementNS.
 * Its inline style and script carry a per-response nonce; routes/share.ts sends the matching CSP
 * (sharePageCsp), which also forbids framing. Both pages are noindex and carry a visible "Report
 * abuse" link to the platform's report form (ABUSE_REPORT_URL) with the page's URL filled in.
 */

/** The share page's Content-Security-Policy: only its own nonce'd code, reads from its own origin, never framed. */
export const sharePageCsp = (nonce: string, formAction = false) =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    // only the password page has a form, and it posts to this origin
    formAction ? "form-action 'self'" : "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

/** The platform's abuse report form (the site app's /report-abuse) when ABUSE_REPORT_URL is unset. */
export const DEFAULT_ABUSE_REPORT_URL = "https://agentfirststack.com/report-abuse";

/** The "Report abuse" link of a public page: the report form with the page's URL filled in (?url=). */
export function reportAbuseUrl(env: { ABUSE_REPORT_URL?: string }, pageUrl: string): string {
  let u: URL;
  try {
    u = new URL(env.ABUSE_REPORT_URL?.trim() || DEFAULT_ABUSE_REPORT_URL);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("not http");
  } catch {
    u = new URL(DEFAULT_ABUSE_REPORT_URL);
  }
  u.searchParams.set("url", pageUrl);
  return u.toString();
}

const reportLink = (url: string) =>
  `<a class="report" href="${esc(url)}" rel="nofollow noopener noreferrer" target="_blank">Report abuse</a>`;

/** The password form of a protected share link (no data on it). */
export function sharePasswordPage(
  token: string,
  domain: string | null,
  nonce: string,
  wrong: boolean,
  retryAfterS?: number,
  reportUrl = DEFAULT_ABUSE_REPORT_URL,
): string {
  const heading = domain ? esc(domain) : "Shared analytics";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${heading} · password</title>
<style nonce="${nonce}">
body{margin:0;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f4f2;color:#0b0b0b;display:flex;min-height:100vh;align-items:center;justify-content:center}
@media (prefers-color-scheme:dark){body{background:#111110;color:#f0efec}input{background:#1a1a19;color:#f0efec;border-color:#2c2c2a}}
form{width:min(340px,90vw);display:grid;gap:10px}
h1{font-size:18px;margin:0}
input{font:inherit;padding:8px 10px;border:1px solid #d6d5d0;border-radius:8px}
button{font:inherit;padding:8px 10px;border:0;border-radius:8px;background:#2a78d6;color:#fff;cursor:pointer}
.err{color:#b42318;font-size:13px}
.report{color:inherit;opacity:.7;font-size:12px}
</style>
</head>
<body>
<form method="post" action="/share/${esc(token)}/unlock">
<h1>${heading}</h1>
<label for="pw">This dashboard is protected. Password:</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required minlength="1" maxlength="200" autofocus>
${
  retryAfterS
    ? `<div class="err" role="alert">Too many wrong passwords. Try again in ${Math.ceil(retryAfterS / 60)} minute(s).</div>`
    : wrong
      ? '<div class="err" role="alert">That password is not right.</div>'
      : ""
}
<button type="submit">View dashboard</button>
${reportLink(reportUrl)}
</form>
</body>
</html>`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * `domain`: the site's domain when it is verified, else null (the page then names no site). The
 * site's free-form name is never shown: anyone can call a site "Stripe", only the owner of a
 * domain can verify it.
 */
export function sharePage(token: string, domain: string | null, nonce: string, reportUrl = DEFAULT_ABUSE_REPORT_URL): string {
  const heading = domain ? esc(domain) : "Unverified site";
  const title = domain ? `${esc(domain)} · analytics` : "Shared analytics (unverified site)";
  const source = domain
    ? `The numbers come from the analytics tracker on ${esc(domain)} and its own server, as they reported them; they are not audited.`
    : "This site's domain isn't verified, so its name isn't shown. The numbers come from the site's own tracker, as it reported them; they are not audited.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style nonce="${nonce}">
.viz-root{color-scheme:light;--surface-0:#f4f4f2;--surface-1:#fcfcfb;--grid:#e6e5e1;--text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#7a7974;--series-1:#2a78d6;--series-1-wash:rgba(42,120,214,.10);--bar-track:#e9eef6}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--surface-0:#111110;--surface-1:#1a1a19;--grid:#2c2c2a;--text-primary:#f0efec;--text-secondary:#c3c2b7;--text-muted:#8f8e86;--series-1:#3987e5;--series-1-wash:rgba(57,135,229,.14);--bar-track:#22303f}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;--surface-0:#111110;--surface-1:#1a1a19;--grid:#2c2c2a;--text-primary:#f0efec;--text-secondary:#c3c2b7;--text-muted:#8f8e86;--series-1:#3987e5;--series-1-wash:rgba(57,135,229,.14);--bar-track:#22303f}
*{box-sizing:border-box}
body{margin:0}
.viz-root{min-height:100vh;background:var(--surface-0);color:var(--text-primary);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px 16px 48px}
.wrap{max-width:1040px;margin:0 auto}
header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}
h1{font-size:20px;margin:0;font-weight:650;letter-spacing:-.01em}
.sub{color:var(--text-secondary);font-size:13px}
.periods{display:flex;gap:4px;background:var(--surface-1);border:1px solid var(--grid);border-radius:8px;padding:3px}
.periods button{font:inherit;font-size:13px;border:0;background:transparent;color:var(--text-secondary);padding:5px 10px;border-radius:6px;cursor:pointer}
.periods button[aria-pressed="true"]{background:var(--surface-0);color:var(--text-primary);font-weight:600}
.card{background:var(--surface-1);border:1px solid var(--grid);border-radius:10px;padding:16px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:12px}
.kpi .label{color:var(--text-secondary);font-size:12px}
.kpi .value{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums;margin-top:2px}
.kpi .delta{color:var(--text-muted);font-size:12px;font-variant-numeric:tabular-nums;margin-top:2px}
.chart-card{margin-bottom:12px;position:relative}
.chart-card h2,.tables h2{font-size:13px;font-weight:600;margin:0 0 10px;color:var(--text-secondary)}
svg{display:block;width:100%;height:240px;overflow:visible}
.tip{position:absolute;pointer-events:none;background:var(--surface-1);border:1px solid var(--grid);border-radius:6px;padding:6px 8px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.12);white-space:nowrap;display:none}
.tip b{font-variant-numeric:tabular-nums}
.tables{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:5px 0;vertical-align:middle}
td.n{text-align:right;font-variant-numeric:tabular-nums;color:var(--text-secondary);width:70px}
.name{position:relative;padding:4px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0}
.name i{position:absolute;inset:2px auto 2px 0;background:var(--bar-track);border-radius:0 4px 4px 0;z-index:0}
.name span{position:relative;z-index:1}
.empty{color:var(--text-muted);font-size:13px;padding:8px 0}
footer{margin-top:20px;color:var(--text-muted);font-size:12px}
details{margin-top:8px;color:var(--text-secondary);font-size:12px}
.report{color:var(--text-secondary)}
</style>
</head>
<body>
<div class="viz-root"><div class="wrap">
<header>
  <div><h1>${heading}</h1><div class="sub" id="range">Loading…</div></div>
  <div class="periods" role="group" aria-label="Period">
    <button data-p="today">Today</button><button data-p="7d">7 days</button><button data-p="30d">30 days</button><button data-p="90d">90 days</button><button data-p="12mo">12 months</button>
  </div>
</header>
<section class="kpis" id="kpis"></section>
<section class="card chart-card">
  <h2>Visitors</h2>
  <svg id="chart" role="img" aria-label="Visitors over time"></svg>
  <div class="tip" id="tip"></div>
  <details><summary>Table view</summary><table id="series-table"></table></details>
</section>
<section class="tables">
  <div class="card"><h2>Top pages</h2><table id="t-pages"></table></div>
  <div class="card"><h2>Top sources</h2><table id="t-sources"></table></div>
  <div class="card"><h2>Countries</h2><table id="t-countries"></table></div>
  <div class="card"><h2>Devices</h2><table id="t-devices"></table></div>
  <div class="card"><h2>Goals</h2><table id="t-goals"></table></div>
</section>
<footer>${source} Cookieless analytics; aggregate numbers only. ${reportLink(reportUrl)}</footer>
</div></div>
<script nonce="${nonce}">
(function(){
var TOKEN=${JSON.stringify(token)};
var period=new URLSearchParams(location.search).get("period")||"30d";
var NS="http://www.w3.org/2000/svg";
function el(tag,attrs,text){var e=document.createElement(tag);for(var k in attrs||{})e.setAttribute(k,attrs[k]);if(text!=null)e.textContent=text;return e}
function svg(tag,attrs){var e=document.createElementNS(NS,tag);for(var k in attrs)e.setAttribute(k,attrs[k]);return e}
function fmt(n){return n>=1e6?(n/1e6).toFixed(1)+"M":n>=1e4?(n/1e3).toFixed(1)+"k":Math.round(n).toLocaleString()}
function dur(s){s=Math.round(s);return s<60?s+"s":Math.floor(s/60)+"m "+(s%60)+"s"}
var COUNTRY=(function(){try{return new Intl.DisplayNames(undefined,{type:"region"})}catch(e){return null}})();
function country(c){if(!c||c==="(none)")return "Unknown";try{return COUNTRY?COUNTRY.of(c)+" ("+c+")":c}catch(e){return c}}
function kpis(d){
  var box=document.getElementById("kpis");box.textContent="";
  var m=d.metrics,ch=d.comparison&&d.comparison.change_percent||{};
  var items=[["Visitors","visitors",fmt],["Pageviews","pageviews",fmt],["Visit duration","visit_duration",dur],["Bounce rate","bounce_rate",function(v){return v.toFixed(0)+"%"}],["Conversions","conversions",fmt],["Revenue","revenue",function(v){return v.toLocaleString(undefined,{maximumFractionDigits:2})}]];
  items.forEach(function(it){
    var c=el("div",{class:"card kpi"});c.appendChild(el("div",{class:"label"},it[0]));
    c.appendChild(el("div",{class:"value"},it[2](m[it[1]]||0)));
    var p=ch[it[1]];c.appendChild(el("div",{class:"delta"},p==null?"no previous data":(p>0?"▲ ":p<0?"▼ ":"")+Math.abs(p)+"% vs previous"));
    box.appendChild(c);
  });
}
function chart(rows,interval){
  var s=document.getElementById("chart"),tip=document.getElementById("tip");s.textContent="";
  var W=s.clientWidth||800,H=240,L=40,R=12,T=10,B=26,iw=W-L-R,ih=H-T-B;
  s.setAttribute("viewBox","0 0 "+W+" "+H);
  var max=Math.max(1,Math.max.apply(null,rows.map(function(r){return r.visitors})));
  var raw=max/4,mag=Math.pow(10,Math.floor(Math.log10(raw))),step=Math.max(1,[1,2,5,10].map(function(m){return m*mag}).filter(function(v){return v>=raw})[0]),nice=Math.ceil(max/step)*step;
  var x=function(i){return L+(rows.length<2?iw/2:i*iw/(rows.length-1))},y=function(v){return T+ih-v/nice*ih};
  for(var gv=0;gv<=nice;gv+=step){var gy=y(gv);s.appendChild(svg("line",{x1:L,x2:W-R,y1:gy,y2:gy,stroke:"var(--grid)","stroke-width":1}));var t=svg("text",{x:L-6,y:gy+4,"text-anchor":"end","font-size":11,fill:"var(--text-muted)"});t.textContent=fmt(gv);s.appendChild(t)}
  var every=Math.max(1,Math.ceil(rows.length/8));
  rows.forEach(function(r,i){if(i%every)return;var t=svg("text",{x:x(i),y:H-6,"text-anchor":"middle","font-size":11,fill:"var(--text-muted)"});t.textContent=label(r.date,interval);s.appendChild(t)});
  if(!rows.length)return;
  var d=rows.map(function(r,i){return (i?"L":"M")+x(i).toFixed(1)+","+y(r.visitors).toFixed(1)}).join("");
  s.appendChild(svg("path",{d:d+"L"+x(rows.length-1)+","+y(0)+"L"+x(0)+","+y(0)+"Z",fill:"var(--series-1-wash)",stroke:"none"}));
  s.appendChild(svg("path",{d:d,fill:"none",stroke:"var(--series-1)","stroke-width":2,"stroke-linejoin":"round","stroke-linecap":"round"}));
  var last=rows.length-1;s.appendChild(svg("circle",{cx:x(last),cy:y(rows[last].visitors),r:4,fill:"var(--series-1)",stroke:"var(--surface-1)","stroke-width":2}));
  var cross=svg("line",{y1:T,y2:T+ih,stroke:"var(--text-muted)","stroke-width":1,visibility:"hidden"});s.appendChild(cross);
  var dot=svg("circle",{r:4,fill:"var(--series-1)",stroke:"var(--surface-1)","stroke-width":2,visibility:"hidden"});s.appendChild(dot);
  var hit=svg("rect",{x:L,y:T,width:iw,height:ih,fill:"transparent"});s.appendChild(hit);
  function show(ev){var rect=s.getBoundingClientRect(),px=(ev.clientX-rect.left)*W/rect.width;var i=Math.round((px-L)/(rows.length<2?1:iw/(rows.length-1)));i=Math.max(0,Math.min(rows.length-1,i));var r=rows[i];
    cross.setAttribute("x1",x(i));cross.setAttribute("x2",x(i));cross.setAttribute("visibility","visible");dot.setAttribute("cx",x(i));dot.setAttribute("cy",y(r.visitors));dot.setAttribute("visibility","visible");
    tip.textContent="";tip.appendChild(el("div",{},r.date));var l=el("div");l.appendChild(document.createTextNode("Visitors "));l.appendChild(el("b",{},fmt(r.visitors)));tip.appendChild(l);var l2=el("div");l2.appendChild(document.createTextNode("Pageviews "));l2.appendChild(el("b",{},fmt(r.pageviews)));tip.appendChild(l2);
    tip.style.display="block";var tx=x(i)*rect.width/W+16;if(tx+tip.offsetWidth>rect.width)tx-=tip.offsetWidth+32;tip.style.left=(tx+16)+"px";tip.style.top=(y(r.visitors)*rect.height/H+20)+"px"}
  hit.addEventListener("mousemove",show);hit.addEventListener("mouseleave",function(){tip.style.display="none";cross.setAttribute("visibility","hidden");dot.setAttribute("visibility","hidden")});
  var tb=document.getElementById("series-table");tb.textContent="";rows.forEach(function(r){var tr=el("tr");tr.appendChild(el("td",{},r.date));tr.appendChild(el("td",{class:"n"},fmt(r.visitors)+" visitors"));tr.appendChild(el("td",{class:"n"},fmt(r.pageviews)+" views"));tb.appendChild(tr)});
}
function label(d,interval){if(interval==="hour")return d.slice(11,16);if(interval==="month")return d;return d.slice(5)}
function table(id,rows,name){
  var t=document.getElementById(id);t.textContent="";
  if(!rows||!rows.length){t.appendChild(el("tr")).appendChild(el("td",{class:"empty"},"No data yet"));return}
  var max=Math.max.apply(null,rows.map(function(r){return r.visitors}))||1;
  rows.forEach(function(r){var tr=el("tr"),td=el("td",{class:"name",title:String(r.value)});var bar=el("i");bar.style.width=(r.visitors/max*100).toFixed(1)+"%";td.appendChild(bar);td.appendChild(el("span",{},name?name(r.value):String(r.value)));tr.appendChild(td);tr.appendChild(el("td",{class:"n"},fmt(r.visitors)));t.appendChild(tr)});
}
function goals(rows){
  var t=document.getElementById("t-goals");t.textContent="";
  if(!rows.length){t.appendChild(el("tr")).appendChild(el("td",{class:"empty"},"No goals"));return}
  rows.forEach(function(r){var tr=el("tr");tr.appendChild(el("td",{class:"name",title:String(r.value)})).appendChild(el("span",{},String(r.value)));tr.appendChild(el("td",{class:"n"},fmt(r.conversions||0)));tr.appendChild(el("td",{class:"n"},(r.conversion_rate||0)+"%"));t.appendChild(tr)});
}
function load(){
  document.querySelectorAll(".periods button").forEach(function(b){b.setAttribute("aria-pressed",String(b.dataset.p===period))});
  fetch("/share/"+TOKEN+"/data?period="+encodeURIComponent(period)).then(function(r){return r.json()}).then(function(d){
    if(d.error){document.getElementById("range").textContent=d.error.message;return}
    var extra=(d.share&&d.share.segment?" · segment: "+d.share.segment:"")+(d.share&&d.share.expires_at?" · link expires "+new Date(d.share.expires_at).toISOString().slice(0,10):"");
    document.getElementById("range").textContent=d.period.from+" to "+d.period.to+" ("+d.period.timezone+")"+extra;
    kpis(d);chart(d.timeseries,d.interval);
    table("t-pages",d.top_pages);table("t-sources",d.top_sources,function(v){return v==="(none)"?"Direct / none":v});table("t-countries",d.top_countries,country);table("t-devices",d.top_devices,function(v){return v==="(none)"?"Unknown":v.charAt(0).toUpperCase()+v.slice(1)});
    goals(d.goals||[]);
  }).catch(function(){document.getElementById("range").textContent="Could not load data."});
}
document.querySelectorAll(".periods button").forEach(function(b){b.addEventListener("click",function(){period=b.dataset.p;history.replaceState(null,"","?period="+period);load()})});
var rt;addEventListener("resize",function(){clearTimeout(rt);rt=setTimeout(load,200)});
load();
})();
</script>
</body>
</html>`;
}
