"use client";

import { SessionProvider } from "next-auth/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { AUTH_BASE_PATH } from "@/shared/config/paths";

/**
 * Client providers.
 *
 * ── Session ───────────────────────────────────────────────────────────────────
 * `ClientFetchError: Failed to fetch` came from `SessionProvider` re-fetching
 * `/api/auth/session` on window focus and on visibility changes. Two things made
 * that fail loudly: the browser fires focus while a tab is waking and the network
 * stack is not ready, and Auth.js has no retry — one refused fetch surfaces as an
 * unhandled console error.
 *
 * The session is a JWT with a long lifetime; it does not change because a tab
 * regained focus. So focus refetching is off and the provider does not poll.
 * Sign-in and sign-out still update it — those go through Auth.js directly.
 *
 * ── Queries ───────────────────────────────────────────────────────────────────
 * Freshness is driven by the realtime bus (SSE), not by polling: a mutation
 * publishes an event and the affected queries invalidate. A 10-second
 * `staleTime` therefore bought nothing and cost a refetch on every remount —
 * which on the admin console meant re-running a 29-query dashboard aggregate
 * each time you switched tabs.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            /**
             * Remounting a component that already has data must not refetch just
             * because time passed — the bus is what says the data changed. But
             * `false` was too blunt, and it is why "save a load, go to Sort, see
             * nothing until you refresh" happened:
             *
             * `invalidateQueries` refetches immediately only for queries that
             * currently have a mounted observer. Sort, Stock and Sell are separate
             * routes, so at the moment Inward writes, the query it invalidates is
             * inactive — the invalidation just marks it. Arriving at the page then
             * mounts that query with cached data, and `refetchOnMount: false` made
             * React Query skip the refetch (`shouldFetchOn` short-circuits on
             * `value !== false`), so the marked-stale data was rendered as-is.
             *
             * Refetching only when the query was actually invalidated keeps the
             * original optimisation exactly — age alone still never triggers a
             * refetch on mount — while honouring an invalidation that arrived
             * while the page was away. Nothing polls; only queries something
             * genuinely changed refetch, and only once, when they are next shown.
             */
            refetchOnMount: (query) => query.state.isInvalidated,
            refetchOnReconnect: true,
            staleTime: 60_000,
            // Keep unmounted results long enough that navigating away and back
            // is instant instead of a fresh round trip.
            gcTime: 5 * 60_000,
            retry: 1,
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
          },
        },
      })
  );
  return (
    // `basePath` is where the provider fetches the session from. It defaults to
    // "/api/auth" at the origin root, which is a 404 once the app is mounted
    // under a prefix — so it follows the configured base path. Unchanged
    // ("/api/auth") when no base path is set.
    <SessionProvider
      basePath={AUTH_BASE_PATH}
      refetchOnWindowFocus={false}
      refetchInterval={0}
      refetchWhenOffline={false}
    >
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </SessionProvider>
  );
}
