"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiUrl } from "@/shared/config/paths";

/**
 * Platform-wide realtime for the admin console.
 *
 * Same contract as the yard-side provider (src/frontend/components/realtime/provider.tsx)
 * but subscribed to every yard, so any Owner or Manager action anywhere shows up
 * in the console without a refresh. Swapping SSE for a hosted provider means
 * changing these two files only.
 */

export type PlatformEvent = {
  yardId: string;
  channel: string;
  action: string;
  entity?: string;
  entityId?: string;
  at: number;
  actorId?: string | null;
};

/** Any yard-side change can move the console's aggregates, so refresh broadly. */
const ADMIN_QUERY_KEYS: string[][] = [
  ["adminDashboard"],
  ["adminOverview"],
  ["adminYards"],
  ["adminYard"],
  ["adminUsers"],
  ["adminAudit"],
  ["adminSessions"],
  ["adminAnalytics"],
];

type State = {
  connected: boolean;
  lastEvent: PlatformEvent | null;
  subscribe: (l: (e: PlatformEvent) => void) => () => void;
};

const Ctx = createContext<State>({ connected: false, lastEvent: null, subscribe: () => () => {} });

const MAX_BACKOFF_MS = 30_000;
/** Aggregates are expensive; coalesce bursts instead of refetching per event. */
const INVALIDATE_DEBOUNCE_MS = 400;

export function AdminRealtimeProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<PlatformEvent | null>(null);
  const listeners = useRef(new Set<(e: PlatformEvent) => void>());

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;

    const invalidateSoon = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        for (const key of ADMIN_QUERY_KEYS) qc.invalidateQueries({ queryKey: key });
      }, INVALIDATE_DEBOUNCE_MS);
    };

    const connect = () => {
      if (disposed) return;
      source = new EventSource(apiUrl("/api/admin/realtime/stream"));

      source.addEventListener("ready", () => {
        attempt = 0;
        setConnected(true);
      });

      source.addEventListener("platform", (e) => {
        let event: PlatformEvent;
        try {
          event = JSON.parse((e as MessageEvent).data) as PlatformEvent;
        } catch {
          return;
        }
        setLastEvent(event);
        invalidateSoon();
        for (const l of listeners.current) {
          try {
            l(event);
          } catch (err) {
            console.error("[admin-realtime] listener error", err);
          }
        }
      });

      source.onerror = () => {
        setConnected(false);
        source?.close();
        source = null;
        if (disposed) return;
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
        attempt = Math.min(attempt + 1, 5);
        retry = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      if (debounce) clearTimeout(debounce);
      source?.close();
      setConnected(false);
    };
  }, [qc]);

  const value = useMemo<State>(
    () => ({
      connected,
      lastEvent,
      subscribe: (l) => {
        listeners.current.add(l);
        return () => listeners.current.delete(l);
      },
    }),
    [connected, lastEvent]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdminRealtime(): State {
  return useContext(Ctx);
}
