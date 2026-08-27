import { requireAdmin } from "@/backend/http/api";
import { subscribePlatform, type YardEvent } from "@/backend/realtime/realtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Platform-wide SSE stream: every yard's events, tagged with their yard.
 *
 * ADMIN only. This is the one subscription that intentionally crosses tenant
 * boundaries, which is why it lives behind `requireAdmin` on its own route
 * rather than as a parameter on the yard stream — there is no way to ask the
 * yard stream for "all yards".
 */
const HEARTBEAT_MS = 25_000;

export async function GET(req: Request) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (payload: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          open = false;
        }
      };

      send(`event: ready\ndata: ${JSON.stringify({ scope: "platform" })}\n\n`);

      const unsubscribe = subscribePlatform((yardId: string, event: YardEvent) => {
        send(`event: platform\ndata: ${JSON.stringify({ yardId, ...event })}\n\n`);
      });

      const heartbeat = setInterval(() => send(`: ping ${Date.now()}\n\n`), HEARTBEAT_MS);

      const cleanup = () => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
