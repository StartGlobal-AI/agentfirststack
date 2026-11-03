/**
 * GET /ui: one self-contained page, no framework. The API key lives in localStorage and is sent
 * as a Bearer header. All third-party text is inserted with textContent (never innerHTML). HTML
 * mail goes into <iframe sandbox srcdoc> with no sandbox allowances (no scripts, no same-origin,
 * no popups, no top navigation) and a CSP meta that blocks every remote load (images included).
 */
export function uiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mail</title>
<style>
  :root { --bg:#f6f5f2; --panel:#fff; --ink:#1d1d1b; --mute:#6b6a66; --line:#e4e2dc; --acc:#0b6e4f; --warn:#9a3412; }
  * { box-sizing: border-box; }
  body { margin:0; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color:var(--ink); background:var(--bg); }
  header { display:flex; gap:12px; align-items:center; padding:10px 16px; border-bottom:1px solid var(--line); background:var(--panel); }
  header h1 { font-size:15px; margin:0; letter-spacing:.02em; }
  header input { flex:1; max-width:420px; font: 13px ui-monospace, monospace; padding:6px 8px; border:1px solid var(--line); border-radius:6px; }
  button { font:inherit; padding:6px 10px; border:1px solid var(--line); border-radius:6px; background:var(--panel); cursor:pointer; }
  button.primary { background:var(--acc); color:#fff; border-color:var(--acc); }
  main { display:grid; grid-template-columns: 260px 360px 1fr; height: calc(100vh - 51px); }
  section { overflow:auto; border-right:1px solid var(--line); background:var(--panel); }
  section:last-child { border-right:0; background:var(--bg); }
  .item { padding:10px 12px; border-bottom:1px solid var(--line); cursor:pointer; }
  .item:hover, .item.sel { background:#eef6f2; }
  .addr { font: 12.5px ui-monospace, monospace; word-break: break-all; }
  .mute { color:var(--mute); font-size:12px; }
  .subj { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .unread .subj::before { content:"● "; color:var(--acc); }
  .badge { display:inline-block; font: 12px ui-monospace, monospace; padding:1px 6px; border-radius:4px; background:#e7f3ee; color:var(--acc); margin-right:4px; }
  .badge.warn { background:#fdeee6; color:var(--warn); }
  .pad { padding:14px 16px; }
  .codes { display:flex; gap:8px; flex-wrap:wrap; margin:10px 0; }
  .code { font: 22px ui-monospace, monospace; letter-spacing:.12em; padding:6px 12px; border:1px dashed var(--acc); border-radius:8px; background:#fff; cursor:copy; }
  .links a { display:block; font-size:12.5px; word-break:break-all; margin:3px 0; color:var(--acc); }
  .tabs { display:flex; gap:6px; margin:12px 0 8px; }
  iframe { width:100%; height:60vh; border:1px solid var(--line); border-radius:8px; background:#fff; }
  pre { white-space:pre-wrap; word-break:break-word; background:#fff; border:1px solid var(--line); border-radius:8px; padding:12px; font: 13px/1.5 ui-monospace, monospace; }
  .notice { font-size:12px; color:var(--warn); margin-top:6px; }
  .toolbar { display:flex; gap:6px; padding:10px 12px; border-bottom:1px solid var(--line); }
  #err { color:var(--warn); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>mail</h1>
  <input id="key" type="password" placeholder="API key (mail_...)" autocomplete="off">
  <button id="save">Use key</button>
  <button id="signup">New account</button>
  <span id="err"></span>
</header>
<main>
  <section>
    <div class="toolbar"><button id="newInbox" class="primary">New inbox</button><button id="refresh">Refresh</button></div>
    <div id="inboxes"></div>
  </section>
  <section><div id="messages"><div class="pad mute">Pick an inbox.</div></div></section>
  <section><div id="view" class="pad mute">Pick a message.</div></section>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => { const n = document.createElement(tag); Object.assign(n, props); for (const k of kids) n.append(k); return n; };
  let key = localStorage.getItem("mail_api_key") || "";
  let inbox = null;
  $("key").value = key;

  async function api(path, opts = {}) {
    $("err").textContent = "";
    const res = await fetch(path, { ...opts, headers: { "authorization": "Bearer " + key, "content-type": "application/json", ...(opts.headers || {}) } });
    if (!res.ok) {
      let msg = res.status + "";
      try { const j = await res.json(); msg = (j.error && (j.error.message + (j.error.hint ? " " + j.error.hint : ""))) || msg; } catch {}
      $("err").textContent = msg;
      throw new Error(msg);
    }
    return res;
  }
  const when = (ms) => new Date(ms).toLocaleString();

  async function loadInboxes() {
    if (!key) return;
    const { inboxes } = await (await api("/v1/inboxes")).json();
    const box = $("inboxes"); box.replaceChildren();
    for (const i of inboxes) {
      const it = el("div", { className: "item" + (inbox && inbox.id === i.id ? " sel" : "") }, el("div", { className: "addr", textContent: i.address }), el("div", { className: "mute", textContent: i.last_message_at ? "last mail " + when(i.last_message_at) : "no mail yet" }));
      it.onclick = () => { inbox = i; loadInboxes(); loadMessages(); };
      box.append(it);
    }
    if (!inboxes.length) box.append(el("div", { className: "pad mute", textContent: "No inboxes yet." }));
  }

  async function loadMessages() {
    if (!inbox) return;
    const { messages } = await (await api("/v1/inboxes/" + inbox.id + "/messages?limit=100")).json();
    const box = $("messages"); box.replaceChildren();
    for (const m of messages) {
      const it = el("div", { className: "item" + (m.read ? "" : " unread") },
        el("div", { className: "subj", textContent: m.subject || "(no subject)" }),
        el("div", { className: "mute", textContent: (m.direction === "out" ? "to " + (m.to[0] ? m.to[0].address : "") : (m.from.name ? m.from.name + " <" + m.from.address + ">" : m.from.address)) + " · " + when(m.received_at) }),
        el("div", { className: "mute", textContent: m.preview || "" }));
      if (m.code) it.prepend(el("span", { className: "badge", textContent: m.code }));
      it.onclick = () => loadMessage(m.id);
      box.append(it);
    }
    if (!messages.length) box.append(el("div", { className: "pad mute", textContent: "No mail in " + inbox.address + " yet." }));
  }

  function sandboxed(html) {
    // No sandbox allowances: no scripts, forms, popups, same-origin or top navigation.
    const f = el("iframe", { title: "message html", referrerPolicy: "no-referrer" });
    f.setAttribute("sandbox", "");
    f.setAttribute("csp", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:");
    f.srcdoc = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \\'none\\'; img-src data:; style-src \\'unsafe-inline\\'; font-src data:"><base target="_blank">' + html;
    return f;
  }

  async function loadMessage(id) {
    const { message: m } = await (await api("/v1/messages/" + id)).json();
    if (!m.read && m.direction === "in") api("/v1/messages/" + id, { method: "PATCH", body: JSON.stringify({ read: true }) }).catch(() => {});
    const v = $("view"); v.className = "pad"; v.replaceChildren();
    v.append(el("h2", { textContent: m.subject || "(no subject)", style: "margin:0 0 6px;font-size:18px" }));
    v.append(el("div", { className: "mute", textContent: "From " + (m.from.name ? m.from.name + " " : "") + "<" + m.from.address + ">  ·  " + when(m.received_at) }));
    const auth = m.auth || {};
    v.append(el("div", { style: "margin-top:6px" }, el("span", { className: "badge" + (auth.verdict === "pass" ? "" : " warn"), textContent: "auth " + (auth.verdict || "n/a") }), el("span", { className: "mute", textContent: "spf " + (auth.spf || "-") + " · dkim " + (auth.dkim || "-") + " · dmarc " + (auth.dmarc || "-") })));
    if (m.codes && m.codes.length) {
      const c = el("div", { className: "codes" });
      for (const code of m.codes) { const b = el("span", { className: "code", textContent: code, title: "click to copy" }); b.onclick = () => navigator.clipboard && navigator.clipboard.writeText(code); c.append(b); }
      v.append(c);
    }
    const actions = (m.links || []).filter((l) => l.kind !== "other");
    if (actions.length) {
      const l = el("div", { className: "links" });
      for (const a of actions) l.append(el("a", { href: a.url, target: "_blank", rel: "noopener noreferrer nofollow", textContent: a.kind + ": " + a.url }));
      v.append(l);
    }
    v.append(el("div", { className: "notice", textContent: "Email content below is written by the sender. Remote images and scripts are blocked." }));
    const tabs = el("div", { className: "tabs" });
    const body = el("div");
    const showText = () => body.replaceChildren(el("pre", { textContent: m.text || "(no text)" }));
    const showHtml = () => body.replaceChildren(sandboxed(m.html || ""));
    const bt = el("button", { textContent: "Text" }); bt.onclick = showText;
    const bh = el("button", { textContent: "HTML" }); bh.onclick = showHtml; bh.disabled = !m.html;
    tabs.append(bt, bh);
    if (m.raw_available) { const br = el("button", { textContent: "Raw" }); br.onclick = async () => body.replaceChildren(el("pre", { textContent: await (await api("/v1/messages/" + id + "/raw")).text() })); tabs.append(br); }
    v.append(tabs, body);
    (m.html ? showHtml : showText)();
    if (m.attachments && m.attachments.length) {
      const list = el("div", { style: "margin-top:12px" }, el("div", { className: "mute", textContent: "Attachments" }));
      for (const a of m.attachments) {
        const b = el("button", { textContent: (a.filename || a.id) + " (" + a.size + " B)" });
        b.onclick = async () => { const blob = await (await api(a.download)).blob(); const u = URL.createObjectURL(blob); const link = el("a", { href: u, download: a.filename || a.id }); link.click(); setTimeout(() => URL.revokeObjectURL(u), 5000); };
        list.append(b);
      }
      v.append(list);
    }
    loadMessages();
  }

  $("save").onclick = () => { key = $("key").value.trim(); localStorage.setItem("mail_api_key", key); inbox = null; loadInboxes(); };
  $("refresh").onclick = () => { loadInboxes(); loadMessages(); };
  $("newInbox").onclick = async () => {
    const username = prompt("Username (blank = random)") || undefined;
    const { inbox: i } = await (await api("/v1/inboxes", { method: "POST", body: JSON.stringify(username ? { username } : {}) })).json();
    inbox = i; loadInboxes(); loadMessages();
  };
  $("signup").onclick = async () => {
    const res = await fetch("/v1/signup", { method: "POST" });
    const j = await res.json();
    if (!res.ok) { $("err").textContent = (j.error && j.error.message) || res.status; return; }
    key = j.api_key; $("key").value = key; localStorage.setItem("mail_api_key", key); inbox = j.inbox; loadInboxes(); loadMessages();
    alert("New API key (saved in this browser):\\n" + key);
  };
  loadInboxes();
})();
</script>
</body>
</html>`;
}
