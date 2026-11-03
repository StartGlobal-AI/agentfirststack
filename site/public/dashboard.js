// Copy buttons for the dashboard. Progressive enhancement: without this script every prompt,
// key and URL is still click-to-select (user-select: all in dashboard.css).
// Loaded by every page the site Worker renders; the CSP allows scripts from this origin only.
(() => {
  const root = document.documentElement;
  root.classList.add("js");

  const status = document.createElement("p");
  status.className = "sr-only";
  status.setAttribute("aria-live", "polite");
  document.body.append(status);

  const selectText = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };

  const copy = async (source, button) => {
    const text = source.textContent.trim();
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      selectText(source);
    }
    button.dataset.state = ok ? "copied" : "select";
    button.textContent = ok ? "Copied" : "Press ⌘C";
    status.textContent = ok ? "Copied to the clipboard." : "Selected. Press Command or Control C to copy.";
    clearTimeout(button._t);
    button._t = setTimeout(() => {
      button.textContent = button.dataset.label;
      delete button.dataset.state;
    }, 1600);
  };

  const addButton = (source, place, label, extraClass) => {
    if (!source || source.dataset.copyReady) return;
    source.dataset.copyReady = "1";
    const button = document.createElement("button");
    button.type = "button";
    button.className = `copy-btn ${extraClass || ""}`.trim();
    button.dataset.label = label;
    button.textContent = label;
    button.setAttribute("aria-label", `${label}: ${source.textContent.trim().slice(0, 80)}`);
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      copy(source, button);
    });
    place(button);
  };

  // Hero prompts: the whole card copies, and a button shows where the "Select" chip was.
  for (const card of document.querySelectorAll(".ask")) {
    const q = card.querySelector(".ask-q");
    addButton(q, (b) => card.append(b), "Copy", "copy-on-ink copy-corner");
  }
  // Inline prompts ("Ask your agent ...").
  for (const q of document.querySelectorAll(".ask-line .ask-q")) {
    addButton(q, (b) => q.after(b), "Copy");
  }
  // New keys and invite links (shown once).
  for (const s of document.querySelectorAll(".secret")) {
    addButton(s, (b) => s.after(b), "Copy", "copy-on-ink copy-wide");
  }
  // "Have your agent build it": one Copy button per card, outside the collapsed prompt.
  for (const card of document.querySelectorAll(".build")) {
    const s = card.querySelector(".prompt-block");
    const details = card.querySelector("details");
    if (s && details) addButton(s, (b) => card.insertBefore(b, details), "Copy prompt", "copy-on-ink");
  }
  // URLs such as the MCP endpoint.
  for (const s of document.querySelectorAll(".url-chip .select")) {
    addButton(s, (b) => s.after(b), "Copy");
  }

  const hint = document.querySelector(".hero-hint[data-js-text]");
  if (hint) hint.textContent = hint.dataset.jsText;
})();
