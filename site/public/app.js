// Home page: copy the prompt, show it on request, the pixel field, the setup card ticking in,
// WebMCP tools, and our own live analytics.
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
      status.textContent = 'Couldn\'t copy automatically. Open "See the full prompt" in the setup card and copy it by hand.';
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

  // ---------- the skill's install command (its own button: copy_skill_command, not copy_prompt) ----------
  document.querySelectorAll("[data-copy-cmd]").forEach(function (button) {
    var source = document.getElementById(button.dataset.copyCmd);
    if (!source) return;
    var timer;
    button.addEventListener("click", function () {
      var text = source.textContent.trim();
      var done = function (ok) {
        clearTimeout(timer);
        button.classList.toggle("is-copied", ok);
        button.setAttribute("aria-label", ok ? "Copied" : "Copy the install command");
        if (status) status.textContent = ok ? "Copied. Run it in your project's folder." : "Couldn't copy automatically. Select the command and copy it.";
        timer = setTimeout(function () {
          button.classList.remove("is-copied");
          button.setAttribute("aria-label", "Copy the install command");
          if (status && ok) status.textContent = "";
        }, 2000);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(
          function () {
            done(true);
          },
          function () {
            done(fallbackCopy(text));
          },
        );
      } else done(fallbackCopy(text));
    });
  });

  // ---------- the full prompt, under the setup card ----------
  var showBtn = document.querySelector("[data-show-prompt]");
  var full = document.getElementById("full-prompt");
  if (showBtn && full) {
    showBtn.addEventListener("click", function () {
      var open = full.hidden;
      full.hidden = !open;
      showBtn.setAttribute("aria-expanded", String(open));
      showBtn.textContent = open ? "Hide the full prompt" : "See the full prompt";
    });
  }

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- pixel field ----------
  // Square cells, ordered-dithered, brighter toward a focus point: a field of pixels in blues
  // that rises toward the setup card. A few cells flicker on now and then.
  var BLUES = ["#0a1a5c", "#12298a", "#1a3fd6", "#2f6bff", "#5b8cff", "#9cc2ff", "#7fd4ff"];
  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(function (v) {
    return (v + 0.5) / 16;
  });

  function field(canvas, opts) {
    var ctx = canvas.getContext("2d");
    var cell = opts.cell;
    var cells = [];
    var w = 0;
    var h = 0;
    function intensity(x, y) {
      // Distance to the focus, squashed into an ellipse, plus a glow along the bottom edge.
      // On narrow screens the text spans the width and the card sits below it: the pixels gather
      // low, around the card, and fade out from top to bottom instead of from left to right.
      var narrow = w < 760;
      if (narrow && !opts.hero) return 0; // on phones only the hero has pixels
      var dx = (x - (narrow ? 0.6 : opts.fx) * w) / (w * (narrow ? 0.8 : 0.55));
      var dy = (y - (narrow ? 0.88 : opts.fy) * h) / (h * (narrow ? 0.45 : 0.7));
      var focus = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy));
      var floor = Math.max(0, (y / h - 0.62) / 0.38) * opts.floor;
      // Fade out where the text sits (left of opts.clear), so the copy stays easy to read.
      var u = narrow ? Math.min(1, Math.max(0, (y / h - 0.5) / 0.25)) : Math.min(1, Math.max(0, (x / w - opts.clear) / 0.22));
      var keep = u * u * (3 - 2 * u);
      return Math.min(1, (focus * opts.strength + floor * 0.6) * keep);
    }
    function draw() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      cells = [];
      var cols = Math.ceil(w / cell);
      var rows = Math.ceil(h / cell);
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          var x = c * cell;
          var y = r * cell;
          var v = intensity(x + cell / 2, y + cell / 2);
          var t = BAYER[(r % 4) * 4 + (c % 4)];
          if (v < t * 0.9 || v < 0.06) continue;
          var level = Math.min(BLUES.length - 1, Math.floor(v * (BLUES.length - 0.01)));
          ctx.globalAlpha = 0.18 + v * 0.62;
          ctx.fillStyle = BLUES[level];
          ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
          cells.push({ x: x, y: y, v: v });
        }
      }
      ctx.globalAlpha = 1;
    }
    function flicker() {
      if (!cells.length) return;
      for (var i = 0; i < opts.flicker; i++) {
        var p = cells[Math.floor(Math.random() * cells.length)];
        if (p.v < 0.35) continue;
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = Math.random() < 0.5 ? "#7fd4ff" : "#ffffff";
        ctx.fillRect(p.x + 1, p.y + 1, cell - 2, cell - 2);
        (function (q) {
          setTimeout(
            function () {
              var level = Math.min(BLUES.length - 1, Math.floor(q.v * (BLUES.length - 0.01)));
              ctx.clearRect(q.x, q.y, cell, cell);
              ctx.globalAlpha = 0.18 + q.v * 0.62;
              ctx.fillStyle = BLUES[level];
              ctx.fillRect(q.x + 1, q.y + 1, cell - 2, cell - 2);
            },
            500 + Math.random() * 900,
          );
        })(p);
      }
      ctx.globalAlpha = 1;
    }
    draw();
    var t;
    window.addEventListener("resize", function () {
      clearTimeout(t);
      t = setTimeout(draw, 150);
    });
    if (!reduce && opts.flicker) setInterval(flicker, 260);
  }

  var hero = document.querySelector(".hero .pixels");
  if (hero) field(hero, { cell: 14, fx: 0.76, fy: 0.5, strength: 1.15, floor: 1, flicker: 3, clear: 0.34, hero: true });
  var freeCanvas = document.querySelector(".pixels-free");
  if (freeCanvas) field(freeCanvas, { cell: 12, fx: 1.02, fy: 1.05, strength: 0.75, floor: 0, flicker: 1, clear: 0.82 });
  var band = document.querySelector(".pixels-band");
  if (band) field(band, { cell: 12, fx: 0.92, fy: 0.5, strength: 0.9, floor: 0.4, flicker: 1, clear: 0.45 });

  // ---------- the setup card ----------
  var card = document.querySelector(".setup");
  if (card) {
    var steps = [].slice.call(card.querySelectorAll("[data-step]"));
    var state = card.querySelector("[data-state]");
    var count = card.querySelector("[data-count]");
    var replay = card.querySelector("[data-replay]");
    var timers = [];
    function setCount(n) {
      count.textContent = n + " of " + steps.length + " set up";
    }
    function finish() {
      card.classList.add("is-done");
      state.textContent = "All set up";
      replay.hidden = false;
    }
    function run() {
      timers.forEach(clearTimeout);
      timers = [];
      card.classList.remove("is-done");
      state.textContent = "Setting up";
      replay.hidden = true;
      steps.forEach(function (s) {
        s.classList.remove("is-working", "is-done");
      });
      setCount(0);
      if (reduce) {
        steps.forEach(function (s) {
          s.classList.add("is-done");
        });
        setCount(steps.length);
        finish();
        return;
      }
      var at = 700;
      steps.forEach(function (s, i) {
        timers.push(
          setTimeout(function () {
            s.classList.add("is-working");
          }, at),
        );
        at += 520 + (i % 3) * 180;
        timers.push(
          setTimeout(function () {
            s.classList.remove("is-working");
            s.classList.add("is-done");
            setCount(i + 1);
            if (i === steps.length - 1) finish();
          }, at),
        );
        at += 90;
      });
    }
    replay.addEventListener("click", run);
    run();
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
})();
