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
  // Exposed so pages swapped in without a reload (dashboard-app.js) get the same buttons.
  window.afsEnhance = (scope) => enhance(scope || document);

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

  function enhance(scope) {
    // Hero prompts: the whole card copies, and a button shows where the "Select" chip was.
    for (const card of scope.querySelectorAll(".ask")) {
      const q = card.querySelector(".ask-q");
      addButton(q, (b) => card.append(b), "Copy", "copy-on-ink copy-corner");
    }
    // Inline prompts ("Ask your agent ...").
    for (const q of scope.querySelectorAll(".ask-line .ask-q")) {
      addButton(q, (b) => q.after(b), "Copy");
    }
    // New keys and invite links (shown once).
    for (const s of scope.querySelectorAll(".secret")) {
      addButton(s, (b) => s.after(b), "Copy", "copy-on-ink copy-wide");
    }
    // "Have your agent build it": one Copy button per card, outside the collapsed prompt.
    for (const card of scope.querySelectorAll(".build")) {
      const s = card.querySelector(".prompt-block");
      const details = card.querySelector("details");
      if (s && details) addButton(s, (b) => card.insertBefore(b, details), "Copy prompt", "copy-on-ink");
    }
    // URLs such as the MCP endpoint.
    for (const s of scope.querySelectorAll(".url-chip .select")) {
      addButton(s, (b) => s.after(b), "Copy");
    }

    const hint = scope.querySelector(".hero-hint[data-js-text]");
    if (hint) hint.textContent = hint.dataset.jsText;
    for (const d of scope.querySelectorAll("details.pick, details.newproj")) {
      if (d.dataset.menuReady) continue;
      d.dataset.menuReady = "1";
      d.addEventListener("toggle", () => {
        if (!d.open) return;
        for (const o of document.querySelectorAll("details.pick[open], details.newproj[open]")) if (o !== d) o.removeAttribute("open");
      });
    }
  }
  enhance(document);
})();

// The top bar's <details> menus (project switcher, your account) and the projects page's
// "Set up a new project": close on an outside click or Escape, and one at a time.
(() => {
  const menus = () => document.querySelectorAll("details.pick[open], details.newproj[open]");
  document.addEventListener("click", (e) => {
    for (const d of menus()) if (!d.contains(e.target)) d.removeAttribute("open");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const d of menus()) {
      d.removeAttribute("open");
      d.querySelector("summary")?.focus();
    }
  });
})();
