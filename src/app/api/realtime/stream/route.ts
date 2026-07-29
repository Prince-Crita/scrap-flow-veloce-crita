import { requireYard } from "@/lib/api";
import { subscribeYard, type YardEvent } from "@/lib/realtime";

export const dynamic = "force-dynamic";
// SSE needs a long-lived Node stream, not the edge runtime.
export const runtime = "nodejs";

/**
 * Server-Sent Events stream for ONE yard.
 *
 * The yard is resolved from the signed session (or an active Enter Yard
 * session) — never from a query parameter. A client therefore cannot subscribe
 * to a yard it does not belong to: there is no input to tamper with.
 *
 * Kept intentionally small; see src/lib/realtime.ts for the swap point if this
 * moves to a hosted provider.
 */
const HEARTBEAT_MS = 25_000;

export async function GET(req: Request) {
  const guard = await requireYard();
  if ("res" in guard) return guard.res;
  const { yardId } = guard;

  const encoder = new TextEncoder();

  /**
   * Teardown correctness matters more here than anywhere else in the app.
   *
   * A leaked stream is not one wasted socket: it leaves a 25-second heartbeat
   * timer running AND a listener pinned in the yard bus, so every dropped tab
   * costs a permanent timer and a permanent closure. Over a long session that is
   * unbounded growth in handles and heap — which is what "the app freezes / stops
   * after a few minutes" actually was.
   *
   * Three bugs are fixed here, all in the old teardown:
   *  1. `send()` marked the stream closed when the client vanished mid-write but
   *     never cleared the interval or unsubscribed.
   *  2. `cleanup()` began with `if (!open) return`, so once (1) had happened the
   *     abort handler became a no-op and the timer survived for good.
   *  3. `cancel()` was not implemented, so a stream torn down without an abort
   *     signal never cleaned up at all.
   * The heartbeat is also unref'd: a live timer keeps the event loop alive, which
   * is why shutdown hung on "Waiting for application shutdown".
   */
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      let torn = false;

      const send = (payload: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Client vanished mid-write. Tear down NOW rather than waiting for an
          // abort that may never arrive.
          open = false;
          cleanup();
        }
      };

      // Tell the client which yard this stream is for; it asserts the match.
      send(`event: ready\ndata: ${JSON.stringify({ yardId })}\n\n`);

      const unsubscribe = subscribeYard(yardId, (event: YardEvent) => {
        send(`event: yard\ndata: ${JSON.stringify(event)}\n\n`);
      });

      // Comment frames keep proxies and browsers from closing an idle stream.
      const heartbeat = setInterval(() => send(`: ping ${Date.now()}\n\n`), HEARTBEAT_MS);
      heartbeat.unref?.();

      cleanup = () => {
        // Guarded on its own flag, NOT on `open` — `send()` clears `open` before
        // calling us, and the old code read that as "already cleaned up".
        if (torn) return;
        torn = true;
        open = false;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      req.signal.addEventListener("abort", cleanup, { once: true });
      // Already aborted before we attached (a fast client disconnect).
      if (req.signal.aborted) cleanup();
    },
    // Reached when the consumer tears the stream down without an abort signal.
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Defensive: stops any intermediary from buffering the stream.
      "x-accel-buffering": "no",
    },
  });
}
