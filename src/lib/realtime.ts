/**
 * Realtime fan-out — server side.
 *
 * Transport is Server-Sent Events to the browser, over a two-layer bus:
 *
 *   1. an in-process registry (`yardBus` / `platformBus`) for same-instance
 *      delivery, which is synchronous and therefore instant; plus
 *   2. **Postgres LISTEN/NOTIFY** (src/lib/realtime-pg.ts) to fan every event out
 *      to the other instances.
 *
 * `publish()` does both: local listeners are called directly, and a NOTIFY is
 * fired and forgotten. An instance ignores the echo of its own NOTIFY because it
 * already delivered locally. Remote events are handed to `deliverLocal` and are
 * never re-published, or they would loop.
 *
 * **MULTI-INSTANCE SAFE.** No polling anywhere; the NOTIFY is genuinely pushed.
 * The listener needs `DIRECT_URL` (unpooled): LISTEN is session state and
 * PgBouncer transaction pooling would silently lose it.
 *
 * ── Swap point ───────────────────────────────────────────────────────────────
 * Everything outside this file talks in terms of `publish(yardId, event)` and the
 * `useYardChannel` hook. To move to Ably/Pusher/WebSockets later, reimplement the
 * transport in realtime-pg.ts. No business logic, route handler, component or
 * event name needs to change.
 *
 * Degradation: if the LISTEN connection cannot be established the app keeps
 * working and falls back to same-instance delivery — the pre-2026-07-26 behaviour.
 */

/** Logical streams within a yard. Clients subscribe to the yard, not per channel. */
export type YardChannel =
  | "stock"
  | "inward"
  | "sort"
  | "sales"
  | "outward"
  | "vendors"
  | "materials"
  | "xp"
  | "yard";

export type YardEvent = {
  channel: YardChannel;
  action: string;
  entity?: string;
  entityId?: string;
  /** Epoch ms, set by the publisher. */
  at: number;
  /**
   * User id that caused the event. Clients use it to skip refetching on their
   * own echo — the mutation response already updated their cache.
   */
  actorId?: string | null;
};

type Listener = (event: YardEvent) => void;

/**
 * Module-level registries. Next dev does hot-reload, which can re-evaluate a
 * module and orphan its listeners, so these are pinned on globalThis.
 */
const g = globalThis as unknown as {
  __sfYardBus?: Map<string, Set<Listener>>;
  __sfPlatformBus?: Set<(yardId: string, event: YardEvent) => void>;
};

const yardBus: Map<string, Set<Listener>> = (g.__sfYardBus ??= new Map());
const platformBus: Set<(yardId: string, event: YardEvent) => void> = (g.__sfPlatformBus ??= new Set());

/**
 * Publish to one yard. Call AFTER the transaction commits — never inside it, or
 * subscribers can refetch and read pre-commit state.
 *
 * Never throws: a realtime failure must not fail a committed business write.
 */
export function publish(yardId: string, event: Omit<YardEvent, "at"> & { at?: number }): void {
  const full: YardEvent = { ...event, at: event.at ?? Date.now() };
  // Fan out to other instances first, then deliver locally. Ordering is
  // irrelevant to correctness (the write is already committed) but doing the
  // fire-and-forget first means a slow local listener cannot delay it.
  fanOut(yardId, full);
  deliverLocal(yardId, full);
}

/** Local delivery — unchanged behaviour, extracted so remote events reuse it. */
function deliverLocal(yardId: string, full: YardEvent): void {
  try {
    for (const l of yardBus.get(yardId) ?? []) {
      try {
        l(full);
      } catch (e) {
        console.error("[realtime] yard listener failed", e);
      }
    }
    for (const l of platformBus) {
      try {
        l(yardId, full);
      } catch (e) {
        console.error("[realtime] platform listener failed", e);
      }
    }
  } catch (e) {
    console.error("[realtime] publish failed", e);
  }
}

/** Publish several events for one yard (e.g. a sale touches stock and sales). */
export function publishMany(
  yardId: string,
  events: (Omit<YardEvent, "at"> & { at?: number })[]
): void {
  for (const e of events) publish(yardId, e);
}

/** Subscribe to a single yard. Returns an unsubscribe function. */
export function subscribeYard(yardId: string, listener: Listener): () => void {
  let set = yardBus.get(yardId);
  if (!set) {
    set = new Set();
    yardBus.set(yardId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) yardBus.delete(yardId);
  };
}

/** Admin-only: every yard's events, tagged with the yard they came from. */
export function subscribePlatform(listener: (yardId: string, event: YardEvent) => void): () => void {
  platformBus.add(listener);
  return () => platformBus.delete(listener);
}

/**
 * Cross-instance transport, lazily wired.
 *
 * Kept behind dynamic imports so the Edge runtime never pulls in `pg`: this
 * module is imported by middleware-adjacent code, and a Node-only driver in an
 * Edge bundle is a build failure. `startPgBus` is idempotent, so calling it on
 * every publish costs one boolean check after the first.
 */
type PgBus = typeof import("./realtime-pg");

/**
 * The loaded transport module lives on `globalThis`, not module scope.
 *
 * Next.js does not guarantee that the instrumentation hook and a route handler
 * share a module instance. A module-scoped reference here was initialised by the
 * startup hook and read as `null` by the SSE and stats routes — so cross-instance
 * delivery looked broken and `busStats()` reported no transport at all. Same trap
 * and same fix as the OCR supervisor; `yardBus` above is pinned for this reason too.
 */
const gb = globalThis as unknown as { __sfPgBusMod?: PgBus | null; __sfPgBusLoading?: boolean };

function ensurePgBus(): void {
  if (gb.__sfPgBusMod || gb.__sfPgBusLoading) return;
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SF_REALTIME_PG === "0") return;
  gb.__sfPgBusLoading = true;
  void import("./realtime-pg")
    .then((m) => {
      gb.__sfPgBusMod = m;
      // Events from other instances are delivered locally, and NOT re-published —
      // re-publishing would loop them straight back out.
      m.startPgBus((env) => deliverLocal(env.y, env.e as YardEvent));
    })
    .catch((e) => {
      // Degrades to same-instance delivery, which is exactly the old behaviour.
      console.error("[realtime] cross-instance transport unavailable:", e);
    });
}

function fanOut(yardId: string, full: YardEvent): void {
  try {
    ensurePgBus();
    gb.__sfPgBusMod?.notifyPgBus(yardId, full);
  } catch (e) {
    // Never let a realtime failure surface into a committed business write.
    console.error("[realtime] fan-out failed", e);
  }
}

/** Diagnostics for the admin console. */
export function busStats() {
  return {
    yards: [...yardBus.entries()].map(([yardId, set]) => ({ yardId, subscribers: set.size })),
    platformSubscribers: platformBus.size,
    /** Null until the cross-instance transport has loaded. */
    crossInstance: gb.__sfPgBusMod ? gb.__sfPgBusMod.pgBusStats() : null,
  };
}

/**
 * Start the cross-instance listener eagerly, from the server startup hook.
 *
 * Without this, an instance that only ever *receives* (no publishes of its own)
 * would never lazily load the transport, and would silently miss every remote
 * event — the exact bug this whole change exists to fix.
 */
export function initRealtime(): void {
  ensurePgBus();
}
