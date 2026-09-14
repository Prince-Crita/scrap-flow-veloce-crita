import dns from "node:dns";
import { Prisma, PrismaClient } from "@prisma/client";

/**
 * Prefer IPv4 when resolving the database host, process-wide.
 *
 * Root cause of the recurring "Can't reach database server" on local dev:
 * Neon's hostname returns BOTH an AAAA (IPv6) and an A (IPv4) record, Node
 * tries the AAAA addresses first, and on this network the IPv6 route to Neon
 * is not there — every IPv6 address times out before Node ever falls back to
 * the IPv4 one, which connects immediately. Confirmed directly: all three
 * IPv6 addresses failed a raw TCP test on port 5432; the IPv4 address
 * succeeded on the first try, same host, same second.
 *
 * `dns.setDefaultResultOrder("ipv4first")` is a Node built-in (no dependency
 * added) that reorders `dns.lookup()` results so the working address is tried
 * first — IPv6 is still available, just no longer tried ahead of a route that
 * doesn't exist here. Nothing about the connection itself changes: same host,
 * same port, same `sslmode=require`, same credentials.
 *
 * Set here, not in an env var or a per-request option, because this is the one
 * module every Prisma client in the app is built from — dev server, build,
 * `next start`, and any script that imports it. It has to run before the
 * first `new PrismaClient()` below, which is why it is the first thing in the
 * file rather than living in `instrumentation.ts` (which only covers the
 * Next.js server process, not a standalone script).
 */
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  // Old Node without this API: connections just behave as they did before.
}

/**
 * The Prisma client, pinned on `globalThis` in EVERY environment — production
 * included.
 *
 * Pinning in development only is the shape most Next.js guides show, and it is
 * wrong here for the same reason the realtime bus and the OCR supervisor are
 * pinned: Next.js does not guarantee one module instance per process. A second
 * evaluation of this module builds a second `PrismaClient`, and each client opens
 * its OWN connection pool. Against a PgBouncer endpoint that means duplicate
 * pools competing for the same server-side slots, and — worse for latency — a
 * cold pool that has to establish TLS on first use. Profiling the admin
 * dashboard showed exactly that: the per-query cost was one network round trip,
 * but the totals were far above `round-trip × waves`.
 *
 * One client, one pool, warm for the life of the process.
 */
const globalForPrisma = globalThis as unknown as {
  __sfPrisma: PrismaClient | undefined;
};

/**
 * Retry-once-on-a-dead-connection, for READS ONLY.
 *
 * Found in a 120-minute runtime observation: Neon's pooler reaps idle
 * connections, and the first request to pick up a reaped one fails outright —
 * `prisma.inwardLoad.findMany()` returned a 500 carrying *"Server has closed the
 * connection"*. Prisma does not retry, so this surfaces to the operator as a
 * broken page for a connection that was already dead before the query was sent.
 * Over two hours the process logged ~90 `kind: Closed` and absorbed all of them
 * except the ones that landed mid-request.
 *
 * The retry is deliberately narrow on two axes:
 *
 *  1. **Reads only.** A connection-level failure does not tell you whether a
 *     WRITE was applied before the socket died, so retrying a write risks
 *     duplicating it. Writes keep failing loudly and are protected instead by
 *     the existing `clientRequestId` idempotency on the routes that matter.
 *  2. **Connection errors only.** P1017 and the Rust engine's Closed/Io/reset
 *     strings. A constraint violation, a timeout or a bad query must fail on the
 *     first attempt — retrying real errors turns one clear failure into two slow
 *     ones and hides the cause.
 *
 * One retry, not a loop: the second attempt gets a fresh connection from the
 * pool, and if that also fails the problem is not a stale socket.
 */
const READ_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);

/** Exported for tests: the classification is the part that must not over-reach. */
export function isDeadConnection(e: unknown): boolean {
  // P1017 is Prisma's "Server has closed the connection".
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P1017") return true;
  const msg = e instanceof Error ? e.message : "";
  return (
    /Server has closed the connection/i.test(msg) ||
    /kind:\s*Closed/i.test(msg) ||
    /forcibly closed by the remote host/i.test(msg) ||
    /Connection reset by peer/i.test(msg) ||
    /ECONNRESET/i.test(msg)
  );
}

function buildClient(): PrismaClient {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

  return base.$extends({
    name: "retry-dead-connection-on-read",
    query: {
      $allModels: {
        async $allOperations({ operation, args, query }) {
          if (!READ_OPS.has(operation)) return query(args);
          try {
            return await query(args);
          } catch (e) {
            if (!isDeadConnection(e)) throw e;
            // The socket was already gone; nothing ran server-side.
            return await query(args);
          }
        },
      },
      // The dashboard and analytics aggregates are raw SQL, so they never pass
      // through $allModels — and they are the slowest, most visible reads in the
      // app, i.e. exactly the ones worth not losing to a reaped socket.
      // $executeRaw is deliberately NOT retried: it writes.
      async $queryRaw({ args, query }) {
        try {
          return await query(args);
        } catch (e) {
          if (!isDeadConnection(e)) throw e;
          return await query(args);
        }
      },
    },
  }) as unknown as PrismaClient;
}

export const prisma = globalForPrisma.__sfPrisma ?? buildClient();

globalForPrisma.__sfPrisma = prisma;
