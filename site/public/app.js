// Landing page: copy the prompt, show it on request, play the agent session, nav border.
(function () {
  var tpl = document.getElementById("prompt-text");
  var promptText = tpl ? tpl.innerHTML.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim() : "";
  var status = document.querySelector(".copy-status");
  var copyButtons = document.querySelectorAll("[data-copy]");
  var copyTimer;

  // ---------- copy ----------
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
  function copied(button, ok) {
    clearTimeout(copyTimer);
    copyButtons.forEach(function (b) {
      b.classList.remove("is-copied");
      if (b.dataset.label) b.textContent = b.dataset.label;
    });
    if (ok) {
      button.dataset.label = button.dataset.label || button.textContent;
      button.textContent = "Copied";
      button.classList.add("is-copied");
      status.textContent = "Copied. Paste it into your agent's chat.";
    } else {
      status.textContent = 'Couldn\'t copy automatically. Click "Pasted prompt" in the chat to see it and copy it by hand.';
    }
    copyTimer = setTimeout(function () {
      button.classList.remove("is-copied");
      if (button.dataset.label) button.textContent = button.dataset.label;
      if (ok) status.textContent = "";
    }, 2600);
  }
  copyButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(promptText).then(
          function () {
            copied(button, true);
          },
          function () {
            copied(button, fallbackCopy(promptText));
          },
        );
      } else {
        copied(button, fallbackCopy(promptText));
      }
    });
  });

  // ---------- the pasted prompt, inside the user's chat bubble ----------
  var attach = document.querySelector("[data-show-prompt]");
  if (attach && promptText) {
    var lines = promptText.split("\n").length;
    attach.lastChild.textContent = "Pasted prompt, " + lines + " lines";
    attach.addEventListener("click", function () {
      var bubble = attach.closest(".bubble");
      var pre = bubble.querySelector(".bubble-prompt");
      if (pre) {
        pre.remove();
        attach.setAttribute("aria-expanded", "false");
        return;
      }
      pre = document.createElement("pre");
      pre.className = "bubble-prompt";
      pre.textContent = promptText;
      bubble.appendChild(pre);
      attach.setAttribute("aria-expanded", "true");
    });
  }

  // ---------- agent session playback ----------
  var chat = document.getElementById("chat");
  var scroller = document.getElementById("chat-scroll");
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (chat && scroller && !reduce && window.Promise) {
    var steps = Array.prototype.slice.call(chat.querySelectorAll("[data-step]"));
    var pill = chat.querySelector("[data-status]");
    var replay = chat.querySelector("[data-replay]");
    var timers = [];
    var run = 0;
    steps.forEach(function (el) {
      var p = el.querySelector("p");
      if (el.dataset.step === "say" && p) {
        el._p = p;
        el._text = p.textContent;
      }
    });

    var wait = function (ms) {
      return new Promise(function (res) {
        timers.push(setTimeout(res, ms));
      });
    };
    var down = function () {
      scroller.scrollTop = scroller.scrollHeight;
    };

    var reset = function () {
      timers.forEach(clearTimeout);
      timers = [];
      chat.querySelectorAll(".typing").forEach(function (t) {
        t.remove();
      });
      steps.forEach(function (el) {
        el.classList.remove("is-shown", "is-running");
        if (el._p) el._p.textContent = el._text;
        var asks = el.querySelector(".asks");
        if (asks) asks.classList.remove("is-pending");
      });
    };

    var play = async function () {
      var mine = ++run;
      reset();
      chat.classList.add("is-playing");
      pill.textContent = "Working";
      pill.classList.add("is-working");
      replay.hidden = true;
      scroller.scrollTop = 0;
      for (var i = 0; i < steps.length; i++) {
        if (mine !== run) return;
        var el = steps[i];
        var kind = el.dataset.step;
        if (kind === "user") {
          el.classList.add("is-shown");
          await wait(700);
        } else if (kind === "say") {
          var dots = document.createElement("div");
          dots.className = "typing";
          dots.setAttribute("aria-hidden", "true");
          dots.innerHTML = "<i></i><i></i><i></i>";
          el.parentNode.insertBefore(dots, el);
          down();
          await wait(620);
          dots.remove();
          var asks = el.querySelector(".asks");
          if (asks) asks.classList.add("is-pending");
          var words = el._text.split(" ");
          el._p.textContent = "";
          el.classList.add("is-shown");
          for (var w = 0; w < words.length; w++) {
            if (mine !== run) return;
            el._p.textContent += (w ? " " : "") + words[w];
            if (w % 3 === 0) down();
            await wait(26);
          }
          if (asks) {
            await wait(180);
            asks.classList.remove("is-pending");
          }
          down();
          await wait(220);
        } else {
          el.classList.add("is-shown", "is-running");
          down();
          await wait(380 + Math.round(Math.random() * 360));
          if (mine !== run) return;
          el.classList.remove("is-running");
          down();
          await wait(140);
        }
      }
      pill.textContent = "Done";
      pill.classList.remove("is-working");
      replay.hidden = false;
    };

    replay.addEventListener("click", function () {
      play();
    });

    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(
        function (entries) {
          if (
            !entries.some(function (e) {
              return e.isIntersecting;
            })
          )
            return;
          io.disconnect();
          play();
        },
        { threshold: 0.3 },
      );
      io.observe(chat);
    } else {
      play();
    }
  }

  // ---------- WebMCP: let an agent in the browser use the page's key actions ----------
  (function registerWebMcp() {
    var mc = document.modelContext || navigator.modelContext;
    if (!mc || typeof mc.registerTool !== "function") return;
    var text = function (t) {
      return { content: [{ type: "text", text: t }] };
    };
    var tools = [
      {
        name: "get_setup_prompt",
        description:
          "Returns the prompt that tells a coding agent how to set up AgentFirstStack (analytics, tag management with server-side conversion tracking, and an email inbox) for a project.",
        inputSchema: { type: "object", properties: {} },
        execute: async function () {
          return text(promptText);
        },
      },
      {
        name: "read_manual",
        description:
          "Returns the AgentFirstStack manual for agents (llms.txt): signup, every service, common tasks, ad account connection and MCP setup.",
        inputSchema: { type: "object", properties: {} },
        execute: async function () {
          var res = await fetch("/llms.txt");
          return text(await res.text());
        },
      },
      {
        name: "create_api_key",
        description:
          "Creates a free AgentFirstStack account and returns its API key, which works for analytics, tags and mail. No email or verification. The key is shown once: store it in the project's secrets.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string", description: "Optional label, usually the project or site name" } },
        },
        execute: async function (input) {
          var res = await fetch("/v1/signup", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input && input.name ? { name: String(input.name).slice(0, 200) } : {}),
          });
          return text(await res.text());
        },
      },
    ];
    var controller = window.AbortController ? new AbortController() : null;
    tools.forEach(function (tool) {
      try {
        var p = mc.registerTool(tool, controller ? { signal: controller.signal } : undefined);
        if (p && p.catch) p.catch(function () {});
      } catch (e) {
        /* an older or partial implementation: skip quietly */
      }
    });
  })();

  // ---------- nav ----------
  var nav = document.querySelector(".nav");
  if (nav) {
    var onScroll = function () {
      nav.classList.toggle("is-scrolled", window.scrollY > 6);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
})();
