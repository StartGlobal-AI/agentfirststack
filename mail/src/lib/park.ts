import type { InboxDO, WaitResult } from "../inbox-do";

/**
 * Worker side of a wait: connect to the inbox's object and wait up to `ms` for it to say a message
 * landed. Resolves { woken: false } on timeout. A socket closed without a message (object restart,
 * deploy) resolves woken, so the caller re-checks D1 and parks again.
 */
export async function parkOnInbox(stub: DurableObjectStub<InboxDO>, since: number, ms: number): Promise<WaitResult> {
  if (ms <= 0) return { woken: false, version: since };
  const res = await stub.fetch(`https://inbox.internal/wait?since=${since}`, { headers: { upgrade: "websocket" } });
  const ws = res.webSocket;
  if (!ws) {
    if (res.ok) return (await res.json()) as WaitResult;
    // The object refused (too many waiters): behave like a short timeout rather than spin.
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, Math.min(ms, 1_000)));
    return { woken: false, version: since };
  }
  ws.accept();
  return new Promise<WaitResult>((resolve) => {
    let done = false;
    const finish = (r: WaitResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close(1000, r.woken ? "done" : "timeout");
      } catch {
        // already closed
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ woken: false, version: since }), ms);
    ws.addEventListener("message", (e) => {
      try {
        const r = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)) as WaitResult;
        finish({ woken: true, version: typeof r.version === "number" ? r.version : since });
      } catch {
        finish({ woken: true, version: since });
      }
    });
    ws.addEventListener("close", () => finish({ woken: true, version: since }));
    ws.addEventListener("error", () => finish({ woken: true, version: since }));
  });
}
