import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./env";
import { runScheduled } from "./service/send";

export interface WaitResult {
  /** true: a message was committed since `since` (re-check D1); false: the timeout passed. */
  woken: boolean;
  /** The inbox's notification version now; pass it to the next wait. */
  version: number;
}

/** Most waiters one inbox object accepts at once (D1 slots cap them far lower; this is a backstop). */
export const MAX_SOCKETS_PER_INBOX = 50;

/**
 * One per inbox (idFromName(inbox_id)). Holds no mail: D1 is the source of truth. It parks
 * wait_for_email callers and wakes them when the email() handler calls notify().
 *
 * Cost: a waiter is a WebSocket from the Worker to this object, accepted with the Hibernation API
 * (ctx.acceptWebSocket) and no timers, so the object hibernates while callers wait and is not
 * billed for duration; the timeout runs in the calling Worker, which is billed for CPU only. (A
 * parked RPC promise or a setTimeout here would keep the object in memory and billed for the
 * whole wait.)
 *
 * Race-free by construction. notify() runs after the message is committed to D1 and bumps a
 * persisted version counter. A waiter reads the version (version()) BEFORE its last D1 check, then
 * connects with ?since=<version>. Any message committed before that read is visible to the D1
 * check; any notify after it has bumped the version, so the connect either answers at once (plain
 * JSON, no socket) or the socket is woken by it. A Durable Object handles one event at a time, so
 * the counter has no lost updates. (Comparing received_at timestamps instead is not enough:
 * concurrent deliveries can commit out of order and share a millisecond.)
 */
export class InboxDO extends DurableObject<AppEnv> {
  private current: number | null = null;

  private async load(): Promise<number> {
    if (this.current === null) this.current = (await this.ctx.storage.get<number>("version")) ?? 0;
    return this.current;
  }

  /** The notification version: how many messages this inbox has been told about. */
  async version(): Promise<number> {
    return this.load();
  }

  /** GET /wait?since=<version> with `Upgrade: websocket`: park a waiter (see parkOnInbox). */
  override async fetch(req: Request): Promise<Response> {
    const since = Number(new URL(req.url).searchParams.get("since") ?? "NaN");
    if (!Number.isFinite(since)) return Response.json({ error: "since is required" }, { status: 400 });
    const version = await this.load();
    if (version > since) return Response.json({ woken: true, version } satisfies WaitResult);
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a websocket upgrade", { status: 426 });
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS_PER_INBOX) return Response.json({ error: "too many waiters" }, { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ since });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Called by the email() handler after the message is committed to D1. Returns waiters woken. */
  async notify(_receivedAt?: number): Promise<number> {
    const version = (await this.load()) + 1;
    this.current = version;
    await this.ctx.storage.put("version", version);
    let woken = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as { since?: number } | null;
      if (a && typeof a.since === "number" && version <= a.since) continue;
      try {
        ws.send(JSON.stringify({ woken: true, version } satisfies WaitResult));
        ws.close(1000, "woken");
      } catch {
        // already closing: the waiter re-checks D1 on close anyway
      }
      woken++;
    }
    return woken;
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  override async webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, "error");
    } catch {
      // already closed
    }
  }

  /** Number of parked waiters (diagnostics, tests). */
  async waiting(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  /**
   * Scheduled sends: wake at `at` (or earlier, if an earlier one is already set) and send what is
   * due for this inbox. D1 holds the messages; the object only keeps its inbox id and the alarm.
   */
  async schedule(inboxId: string, at: number): Promise<void> {
    await this.ctx.storage.put("inbox_id", inboxId);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  override async alarm(): Promise<void> {
    const inboxId = await this.ctx.storage.get<string>("inbox_id");
    if (!inboxId) return;
    const r = await runScheduled(this.env, inboxId);
    console.log(JSON.stringify({ event: "mail.scheduled", inbox_id: inboxId, ...r }));
    // Next one; a deleted (canceled) message simply leaves nothing to do. The hourly cron catches
    // anything an alarm missed.
    if (r.next_at !== null) await this.ctx.storage.setAlarm(Math.max(r.next_at, Date.now() + 1_000));
  }
}
