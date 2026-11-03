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
    /** null when the site's domain isn't verified: no headline naming it */
    site_domain: string | null;
    site_verified?: boolean;
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

/**
 * What one viewer's tab is asked to hold at most: a forged or huge session must not crash it.
 * Beyond these the recording plays as far as it got, with a note.
 */
const MAX_BYTES = 64 * 1_048_576;
const MAX_EVENTS = 300_000;
let budget = MAX_BYTES;

/** Decompress a chunk, reading at most what is left of the byte budget (the rest is cancelled). */
async function gunzipJson(res: Response): Promise<{ ev?: unknown[] }> {
  if (!res.ok || !res.body || budget <= 0) return {};
  const reader = res.body.pipeThrough(new DecompressionStream("gzip")).getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > budget) {
      budget = 0;
      await reader.cancel().catch(() => {});
      return {};
    }
    parts.push(value);
  }
  budget -= n;
  const all = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    all.set(p, off);
    off += p.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(all)) as { ev?: unknown[] };
  } catch {
    return {};
  }
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
  const when = `${new Date(s.started_at).toISOString().replace("T", " ").slice(0, 19)} UTC`;
  text($("title"), s.site_domain && s.site_verified !== false ? `${s.site_domain} · ${when}` : `Session replay · ${when}`);
  if (s.site_verified === false) {
    const banner = text(
      $("banner"),
      "Unverified site: the owner of this recording hasn't proven the domain it claims. Treat everything shown as unconfirmed; no page replay is shown.",
    );
    banner.hidden = false;
  }
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
  let cut = false;
  for (let i = 0; i < data.chunks.length && !cut; i += 6) {
    const batch = await Promise.all(
      data.chunks.slice(i, i + 6).map((seq) =>
        fetch(`${base}/chunks/${seq}`)
          .then(gunzipJson)
          .catch(() => ({}) as { ev?: unknown[] }),
      ),
    );
    for (const b of batch) {
      if (!Array.isArray(b.ev)) continue;
      for (const e of b.ev) {
        if (events.length >= MAX_EVENTS) {
          cut = true;
          break;
        }
        if (e && typeof e === "object" && typeof (e as { timestamp?: unknown }).timestamp === "number")
          events.push(e as { timestamp: number });
      }
    }
    if (budget <= 0) cut = true;
  }
  events.sort((a, b) => a.timestamp - b.timestamp);
  if (events.length < 2) {
    text(
      status,
      s.site_verified === false ? "" : "No playable recording is stored for this session (it may have been cut short or purged).",
    );
    if (s.site_verified !== false) return;
  }
  status.textContent = cut ? "This recording is larger than the player loads at once; it plays up to where loading stopped." : "";
  const target = $("player");
  const width = Math.min(1100, target.clientWidth || 1000);
  if (events.length < 2) {
    for (const e of data.timeline) $("timeline").append(row(e, null, 0));
    return;
  }
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
  for (const e of data.timeline) list.append(row(e, player, offset));
  text(
    $("expires"),
    `Link expires ${new Date(data.expires_at).toISOString().replace("T", " ").slice(0, 16)} UTC. Text and inputs were masked in the visitor's browser before recording.`,
  );
}

/** One timeline entry; with a player, its time seeks there. Recorded text only via textContent. */
function row(e: TimelineEntry, player: { goto(t: number, play?: boolean): void } | null, offset: number) {
  const li = el("li", `k-${e.kind}${e.signals?.length ? " sig" : ""}`);
  const btn = el("button", "", fmt(e.t)) as HTMLButtonElement;
  btn.type = "button";
  if (player) btn.addEventListener("click", () => player.goto(Math.max(0, e.t + offset), true));
  else btn.disabled = true;
  li.append(btn, el("span", "kind", e.kind), el("span", "text", e.text));
  if (e.signals?.length) li.append(el("span", "signals", e.signals.join(" ")));
  return li;
}

main().catch((e) => {
  const status = document.getElementById("status");
  if (status) status.textContent = `Player error: ${e instanceof Error ? e.message : String(e)}`;
});
