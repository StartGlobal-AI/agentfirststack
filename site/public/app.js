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
      // The copy_prompt event (the "Copied setup prompt" goal) is sent by our tag container's
      // click trigger on [data-copy] (see AGENTFIRSTSTACK.md), so it isn't sent here as well.
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
          "Returns the prompt that tells a coding agent how to set up AgentFirstStack (analytics, tag management with server-side conversion tracking, an email inbox and session replay) for a project.",
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
          "Creates a free AgentFirstStack account and returns its API key, which works for analytics, tags, mail and replay. No email or verification. The key is shown once: store it in the project's secrets.",
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

  // ---------- live: our own analytics, from its public share link (src/live-demo.ts) ----------
  // Every value is set as text, never HTML: the numbers come from visitors.
  (function () {
    var board = document.querySelector("[data-live]");
    if (!board || !window.fetch) return;
    var SVG = "http://www.w3.org/2000/svg";
    var statusEl = board.querySelector("[data-live-status]");
    var chartEl = board.querySelector("[data-live-chart]");
    var whole = new Intl.NumberFormat("en");
    var compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
    var regions = null;
    try {
      regions = new Intl.DisplayNames(["en"], { type: "region" });
    } catch (e) {
      regions = null;
    }
    var last = null;

    function make(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }
    function svg(tag, attrs) {
      var n = document.createElementNS(SVG, tag);
      for (var k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    }
    function count(n) {
      return n >= 10000 ? compact.format(n) : whole.format(n);
    }
    function duration(s) {
      s = Math.round(s);
      var m = Math.floor(s / 60);
      return m ? m + "m " + (s % 60) + "s" : s + "s";
    }
    function day(d) {
      return new Date(d.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    }
    /** A chart point: "4 Nov" by day; "09:00" (short) or "5 Nov, 09:00 UTC" by hour. */
    function when(d, short, tz) {
      if (d.length <= 10) return day(d);
      return short ? d.slice(11, 16) : day(d) + ", " + d.slice(11, 16) + " " + (tz || "UTC");
    }
    function country(code) {
      try {
        return (regions && regions.of(code)) || code;
      } catch (e) {
        return code;
      }
    }
    function list(name, rows, label, value) {
      var ol = board.querySelector('[data-list="' + name + '"]');
      if (!ol) return;
      ol.textContent = "";
      if (!rows.length) {
        ol.appendChild(make("li", "empty", "Nothing yet"));
        return;
      }
      var max = Math.max.apply(null, rows.map(value)) || 1;
      rows.forEach(function (r) {
        var li = make("li");
        var bar = make("i");
        bar.style.setProperty("--v", String(Math.round((value(r) / max) * 100)));
        li.appendChild(bar);
        li.appendChild(make("span", null, label(r)));
        li.appendChild(make("b", null, count(value(r))));
        ol.appendChild(li);
      });
    }

    function drawChart(series, tz) {
      chartEl.textContent = "";
      chartEl.classList.remove("is-hovering");
      if (!series.length) return;
      var w = chartEl.clientWidth || 600;
      var h = chartEl.clientHeight || 190;
      var top = 16;
      var base = h - 20;
      var max = Math.max.apply(
        null,
        series.map(function (p) {
          return p.visitors;
        }),
      );
      var peak = max || 1;
      var gap = series.length > 60 ? 1 : 2;
      var slot = w / series.length;
      var bw = Math.max(1, slot - gap);
      var root = svg("svg", { viewBox: "0 0 " + w + " " + h, preserveAspectRatio: "none", "aria-hidden": "true" });
      root.appendChild(svg("line", { class: "grid", x1: 0, x2: w, y1: base + 0.5, y2: base + 0.5 }));
      root.appendChild(svg("line", { class: "grid", x1: 0, x2: w, y1: top + 0.5, y2: top + 0.5 }));
      var peakLabel = svg("text", { class: "label", x: 0, y: top - 5 });
      peakLabel.textContent = whole.format(max) + " visitors";
      root.appendChild(peakLabel);
      var bars = series.map(function (p, i) {
        var bh = p.visitors ? Math.max(2, ((base - top) * p.visitors) / peak) : 0;
        var x = i * slot + gap / 2;
        var y = base - bh;
        var r = Math.min(4, bw / 2, bh);
        var d = bh
          ? "M" +
            x +
            "," +
            base +
            "V" +
            (y + r) +
            "Q" +
            x +
            "," +
            y +
            " " +
            (x + r) +
            "," +
            y +
            "H" +
            (x + bw - r) +
            "Q" +
            (x + bw) +
            "," +
            y +
            " " +
            (x + bw) +
            "," +
            (y + r) +
            "V" +
            base +
            "Z"
          : "";
        var bar = svg("path", { class: "bar", d: d });
        root.appendChild(bar);
        return bar;
      });
      [0, series.length - 1].forEach(function (i, n) {
        var t = svg("text", { class: "label", x: n ? w : 0, y: h - 4, "text-anchor": n ? "end" : "start" });
        t.textContent = when(series[i].date, true, tz);
        root.appendChild(t);
      });
      chartEl.appendChild(root);
      var tip = make("div", "board-tip");
      tip.hidden = true;
      chartEl.appendChild(tip);
      var on = -1;
      function show(e) {
        var rect = chartEl.getBoundingClientRect();
        var i = Math.min(series.length - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * series.length)));
        if (i === on) return;
        if (on >= 0) bars[on].classList.remove("is-on");
        on = i;
        bars[i].classList.add("is-on");
        chartEl.classList.add("is-hovering");
        var p = series[i];
        tip.textContent = "";
        tip.appendChild(make("b", null, when(p.date, false, tz)));
        tip.appendChild(
          document.createTextNode(": " + whole.format(p.visitors) + " visitors, " + whole.format(p.pageviews) + " pageviews"),
        );
        tip.hidden = false;
        var cx = ((i + 0.5) / series.length) * rect.width;
        tip.style.left = Math.min(rect.width - 90, Math.max(90, cx)) + "px";
        tip.style.top = Math.max(18, base - (p.visitors ? ((base - top) * p.visitors) / peak : 0)) + "px";
      }
      function hide() {
        if (on >= 0) bars[on].classList.remove("is-on");
        on = -1;
        tip.hidden = true;
        chartEl.classList.remove("is-hovering");
      }
      chartEl.onpointermove = show;
      chartEl.onpointerdown = show;
      chartEl.onpointerleave = hide;
    }

    function render(d) {
      last = d;
      board.removeAttribute("aria-busy");
      var m = d.metrics || {};
      var set = function (k, text) {
        var dd = board.querySelector('[data-k="' + k + '"]');
        if (dd) dd.textContent = text;
      };
      set("visitors", count(m.visitors || 0));
      set("pageviews", count(m.pageviews || 0));
      set("visit_duration", duration(m.visit_duration || 0));
      set("conversions", count(m.conversions || 0));
      var series = d.series || [];
      var since = d.since ? day(d.since) : null;
      statusEl.textContent = since ? "Totals since " + since + ", updated every minute" : "Updated every minute";
      statusEl.classList.add("is-live");
      var hourly = d.interval === "hour";
      var caption = board.querySelector("[data-live-caption]");
      var total = series.reduce(function (n, p) {
        return n + p.visitors;
      }, 0);
      if (caption) caption.textContent = hourly ? "Visitors per hour, last 24 hours" : "Visitors per day";
      chartEl.setAttribute("role", "img");
      chartEl.setAttribute(
        "aria-label",
        (hourly ? "Visitors per hour over the last 24 hours: " : "Visitors per day: ") + whole.format(total) + " in all",
      );
      drawChart(series, d.timezone);
      list(
        "pages",
        d.pages || [],
        function (r) {
          return r.path;
        },
        function (r) {
          return r.visitors;
        },
      );
      list(
        "sources",
        d.sources || [],
        function (r) {
          return r.name;
        },
        function (r) {
          return r.visitors;
        },
      );
      list(
        "countries",
        d.countries || [],
        function (r) {
          return country(r.code);
        },
        function (r) {
          return r.visitors;
        },
      );
      list(
        "goals",
        d.goals || [],
        function (r) {
          return r.name;
        },
        function (r) {
          return r.conversions;
        },
      );
    }

    function load() {
      fetch("/live/analytics.json", { headers: { accept: "application/json" } })
        .then(function (r) {
          return r.ok ? r.json() : Promise.reject(r.status);
        })
        .then(render)
        .catch(function () {
          if (last) return;
          board.removeAttribute("aria-busy");
          statusEl.textContent = "The live numbers didn't load. Open the full dashboard instead.";
        });
    }
    var started = false;
    function start() {
      if (started) return;
      started = true;
      load();
      setInterval(function () {
        if (document.visibilityState === "visible") load();
      }, 60000);
    }
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(
        function (entries) {
          if (
            entries.some(function (e) {
              return e.isIntersecting;
            })
          ) {
            io.disconnect();
            start();
          }
        },
        { rootMargin: "400px 0px" },
      );
      io.observe(board);
    } else {
      start();
    }
    var resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (last) drawChart(last.series || [], last.timezone);
      }, 150);
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
