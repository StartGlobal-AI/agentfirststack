/**
 * The human player behind an expiring share link (/play/<token>). Bundled with rrweb-player (MIT)
 * by scripts/build-recorder.mjs (dist/player.txt), served as /assets/player-<hash>.js under a
 * strict CSP. Everything it shows comes from /play/<token>/data and /play/<token>/chunks/<seq>
 * (gzip, decompressed here). Recorded text is inserted with textContent only; the recorded page
 * itself is rebuilt by rrweb inside its sandboxed iframe (scripts never run there).
 */

import Player from "rrweb-player";

interface TimelineEntry {
  t: number;
  kind: string;
  text: string;
  signals?: string[];
}
interface PlayData {
  session: {
    id: string;
    site_domain: string;
    started_at: number;
    duration_ms: number;
    device: string | null;
    browser: string | null;
    os: string | null;
    country: string | null;
    frustration: number;
    pages: number;
    signals: Record<string, number>;
  };
  timeline: TimelineEntry[];
  chunks: number[];
  expires_at: number;
}

const $ = (id: string) => document.getElementById(id)!;
const text = (el: HTMLElement, s: string) => {
  el.textContent = s;
  return el;
};
const el = (tag: string, cls?: string, s?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (s !== undefined) e.textContent = s;
  return e;
};
const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

async function gunzipJson(res: Response): Promise<{ ev?: unknown[] }> {
  if (!res.ok || !res.body) return {};
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  return (await new Response(stream).json()) as { ev?: unknown[] };
}

async function main() {
  const base = location.pathname.replace(/\/+$/, "");
  const status = $("status");
  const res = await fetch(`${base}/data`, { headers: { accept: "application/json" } });
  if (!res.ok) {
    text(status, res.status === 404 ? "This link has expired or was revoked." : `Could not load the recording (HTTP ${res.status}).`);
    return;
  }
  const data = (await res.json()) as PlayData;
  const s = data.session;
  text($("title"), `${s.site_domain} · ${new Date(s.started_at).toISOString().replace("T", " ").slice(0, 19)} UTC`);
  const sig = Object.entries(s.signals)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`)
    .join(", ");
  text(
    $("meta"),
    [
      fmt(s.duration_ms),
      `${s.pages} page${s.pages === 1 ? "" : "s"}`,
      s.device,
      [s.browser, s.os].filter(Boolean).join(" / "),
      s.country,
      `frustration ${s.frustration}/100`,
      sig,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  text(status, `Loading ${data.chunks.length} chunk${data.chunks.length === 1 ? "" : "s"}…`);

  const events: { timestamp: number }[] = [];
  for (let i = 0; i < data.chunks.length; i += 6) {
    const batch = await Promise.all(
      data.chunks.slice(i, i + 6).map((seq) =>
        fetch(`${base}/chunks/${seq}`)
          .then(gunzipJson)
          .catch(() => ({}) as { ev?: unknown[] }),
      ),
    );
    for (const b of batch) if (Array.isArray(b.ev)) events.push(...(b.ev as { timestamp: number }[]));
  }
  events.sort((a, b) => a.timestamp - b.timestamp);
  if (events.length < 2) {
    text(status, "No playable recording is stored for this session (it may have been cut short or purged).");
    return;
  }
  status.textContent = "";
  const target = $("player");
  const width = Math.min(1100, target.clientWidth || 1000);
  const player = new Player({
    target,
    props: {
      events: events as never,
      width,
      height: Math.round(width * 0.56),
      autoPlay: false,
      skipInactive: true,
      showController: true,
      mouseTail: false,
      UNSAFE_replayCanvas: false,
    },
  });

  const list = $("timeline");
  const first = events[0]!.timestamp;
  const offset = s.started_at - first;
  for (const e of data.timeline) {
    const row = el("li", `k-${e.kind}${e.signals?.length ? " sig" : ""}`);
    const btn = el("button", "", fmt(e.t)) as HTMLButtonElement;
    btn.type = "button";
    btn.addEventListener("click", () => player.goto(Math.max(0, e.t + offset), true));
    row.append(btn, el("span", "kind", e.kind), el("span", "text", e.text));
    if (e.signals?.length) row.append(el("span", "signals", e.signals.join(" ")));
    list.append(row);
  }
  text(
    $("expires"),
    `Link expires ${new Date(data.expires_at).toISOString().replace("T", " ").slice(0, 16)} UTC. Text and inputs were masked in the visitor's browser before recording.`,
  );
}

main().catch((e) => {
  const status = document.getElementById("status");
  if (status) status.textContent = `Player error: ${e instanceof Error ? e.message : String(e)}`;
});
