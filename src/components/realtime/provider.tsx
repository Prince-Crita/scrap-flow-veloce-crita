"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Realtime — client side.
 *
 * ── Swap point ───────────────────────────────────────────────────────────────
 * The rest of the app only ever uses `useYardChannel()` / `useRealtime()`.
 * Replacing SSE with Ably or WebSockets means reimplementing the connection in
 * this file; no page, sheet, or business logic changes.
 *
 * Behaviour:
 *  • One connection per tab, mounted at the yard-app layout.
 *  • Incoming events invalidate the affected React Query keys, so screens
 *    refresh themselves. Pages need no realtime code of their own.
 *  • An event caused by this user is ignored — their mutation response already
 *    updated the cache, so refetching would be wasted work and can flicker.
 *  • Reconnects with capped exponential backoff. EventSource retries on its
 *    own, but an auth or server error closes it for good, so we manage it.
 */

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
  at: number;
  actorId?: string | null;
};

/**
 * Which cached queries a channel affects. Mirrors the queryKeys used by the
 * pages and sheets — keep this table and those keys in step.
 */
export const CHANNEL_QUERY_KEYS: Record<YardChannel, string[][]> = {
  stock: [["stock"], ["sellReady"], ["stockSources"]],
  inward: [["sortPending"], ["recentLoads"]],
  // `sortTypesAll` is the Sort screen's target list. The sort-types API
  // publishes on `sort` and `materials`, so both must cover that key or a sort
  // type added in one browser never appears in another.
  sort: [["sortPending"], ["stock"], ["sellReady"], ["sortTypesAll"]],
  sales: [["sales"], ["sellReady"], ["stock"], ["outwardQueue"], ["dispatchStatus"]],
  // A dispatch moves physical stock AND satisfies an allocation, so it
  // refreshes the Manager queue, the Owner dispatch view and stock alike.
  outward: [["outwardQueue"], ["dispatchStatus"], ["stock"], ["sales"], ["sellReady"]],
  vendors: [["vendors"], ["vendorsAll"]],
  materials: [["materials"], ["materialsAll"], ["stock"], ["sortTypesAll"]],
  xp: [],
  yard: [["stock"], ["sortPending"], ["sellReady"], ["sales"], ["vendors"], ["materials"], ["outwardQueue"], ["dispatchStatus"]],
};

type Listener = (event: YardEvent) => void;

type RealtimeState = {
  connected: boolean;
  /** Subscribe to raw events. Returns an unsubscribe function. */
  subscribe: (listener: Listener) => () => void;
  lastEventAt: number | null;
};

const RealtimeContext = createContext<RealtimeState>({
  connected: false,
  subscribe: () => () => {},
  lastEventAt: null,
});

const MAX_BACKOFF_MS = 30_000;

export function RealtimeProvider({
  children,
  currentUserId,
  enabled = true,
}: {
  children: React.ReactNode;
  /** Used to ignore this user's own echo. */
  currentUserId?: string;
  enabled?: boolean;
}) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      source = new EventSource("/api/realtime/stream");

      source.addEventListener("ready", () => {
        attempt = 0;
        setConnected(true);
      });

      source.addEventListener("yard", (e) => {
        let event: YardEvent;
        try {
          event = JSON.parse((e as MessageEvent).data) as YardEvent;
        } catch {
          return;
        }

        setLastEventAt(event.at ?? Date.now());

        /**
         * Skip our own echo — the mutation already refreshed this client.
         *
         * This is an optimisation with a CONTRACT: whatever a channel would have
         * invalidated, the mutation that caused it must invalidate locally. Break
         * that and the bug is invisible to the person testing, because every OTHER
         * browser updates correctly — only the actor's own view goes stale.
         *
         * That is exactly what happened with vendor and material creation. Use
         * `invalidateForChannel()` in a mutation rather than hand-listing keys, and
         * the two cannot drift apart again.
         */
        const isOwnEcho = !!currentUserId && event.actorId === currentUserId;
        if (!isOwnEcho) {
          for (const key of CHANNEL_QUERY_KEYS[event.channel] ?? []) {
            qc.invalidateQueries({ queryKey: key });
          }
        }

        for (const l of listeners.current) {
          try {
            l(event);
          } catch (err) {
            console.error("[realtime] listener error", err);
          }
        }
      });

      source.onerror = () => {
        setConnected(false);
        source?.close();
        source = null;
        if (disposed) return;
        // 1s, 2s, 4s … capped. Jittered so many tabs don't reconnect in lockstep.
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
        attempt = Math.min(attempt + 1, 5);
        retry = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      source?.close();
      setConnected(false);
    };
  }, [qc, currentUserId, enabled]);

  const value = useMemo<RealtimeState>(
    () => ({
      connected,
      lastEventAt,
      subscribe: (listener: Listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [connected, lastEventAt]
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeState {
  return useContext(RealtimeContext);
}

/**
 * Subscribe to this yard's events, optionally filtered to some channels.
 * Query invalidation is already automatic — use this only when a component
 * needs to react to an event itself (a toast, an animation, a counter).
 */
export function useYardChannel(
  handler: Listener,
  options?: { channels?: YardChannel[] }
): { connected: boolean } {
  const { subscribe, connected } = useRealtime();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const channelKey = options?.channels?.join(",") ?? "*";

  useEffect(() => {
    const allowed = channelKey === "*" ? null : new Set(channelKey.split(","));
    return subscribe((event) => {
      if (allowed && !allowed.has(event.channel)) return;
      handlerRef.current(event);
    });
  }, [subscribe, channelKey]);

  return { connected };
}

/**
 * Invalidates exactly what a realtime channel would have.
 *
 * For use by the mutation that CAUSED an event. The provider suppresses the
 * actor's own echo (see above), so a create/update handler has to do the same
 * invalidation locally — and doing it by hand is how vendor creation ended up
 * refreshing the vendor list but not Stock, even though the server published a
 * `stock` event correctly.
 *
 * Pass the channels the API publishes for that mutation.
 */
export function useInvalidateChannels() {
  const qc = useQueryClient();
  return useCallback(
    (...channels: YardChannel[]) => {
      for (const c of channels) {
        for (const key of CHANNEL_QUERY_KEYS[c] ?? []) {
          qc.invalidateQueries({ queryKey: key });
        }
      }
    },
    [qc]
  );
}
