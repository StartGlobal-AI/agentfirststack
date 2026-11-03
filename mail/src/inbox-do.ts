import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./env";

export interface WaitResult {
  /** true: a message was committed since `since` (re-check D1); false: the timeout passed. */
  woken: boolean;
  /** The inbox's notification version now; pass it to the next wait(). */
  version: number;
}

interface Waiter {
  since: number;
  resolve: (r: WaitResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One per inbox (idFromName(inbox_id)). Holds no mail: D1 is the source of truth. It parks
 * wait_for_email callers and wakes them when the email() handler calls notify().
 *
 * Race-free by construction. notify() runs after the message is committed to D1 and bumps a
 * persisted version counter. A waiter reads the version (version()) BEFORE its last D1 check, then
 * parks with wait(version). Any message committed before that read is visible to the D1 check; any
 * notify after it has bumped the version, so wait() either returns at once or is woken by it. A
 * Durable Object handles one event at a time, so the counter has no lost updates. (Comparing
 * received_at timestamps instead is not enough: concurrent deliveries can commit out of order and
 * share a millisecond.)
 */
export class InboxDO extends DurableObject<AppEnv> {
  private waiters = new Set<Waiter>();
  private current: number | null = null;

  private async load(): Promise<number> {
    if (this.current === null) this.current = (await this.ctx.storage.get<number>("version")) ?? 0;
    return this.current;
  }

  /** The notification version: how many messages this inbox has been told about. */
  async version(): Promise<number> {
    return this.load();
  }

  async wait(since: number, timeoutMs: number): Promise<WaitResult> {
    const version = await this.load();
    if (version > since) return { woken: true, version };
    const ms = Math.max(0, Math.min(timeoutMs, 125_000));
    return new Promise<WaitResult>((resolve) => {
      const w: Waiter = {
        since,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(w);
          resolve({ woken: false, version: this.current ?? 0 });
        }, ms),
      };
      this.waiters.add(w);
    });
  }

  /** Called by the email() handler after the message is committed to D1. Returns waiters woken. */
  async notify(_receivedAt?: number): Promise<number> {
    const version = (await this.load()) + 1;
    this.current = version;
    await this.ctx.storage.put("version", version);
    let woken = 0;
    for (const w of [...this.waiters]) {
      if (version > w.since) {
        clearTimeout(w.timer);
        this.waiters.delete(w);
        w.resolve({ woken: true, version });
        woken++;
      }
    }
    return woken;
  }

  /** Number of parked waiters (diagnostics). */
  async waiting(): Promise<number> {
    return this.waiters.size;
  }
}
