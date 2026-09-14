/**
 * Forces the database connection onto IPv4, permanently fixing the recurring
 * local "Can't reach database server" / PrismaClientInitializationError.
 *
 * Kept in its own module — rather than inline in `instrumentation.ts` — for the
 * same reason `initRealtime` and `startOcrSupervisor` are reached through a
 * dynamic `@/...` import there: `instrumentation.ts` is bundled once for both
 * the Node and the Edge runtime, and a Node builtin referenced DIRECTLY in that
 * file (even behind a runtime check, even behind `await import("node:...")`) is
 * flagged by Next's edge-compat scanner, because the check is only evaluated at
 * runtime and the file is still bundled for both targets. A literal Node
 * builtin specifier in a LOCAL module the scanner does not need to open is not.
 *
 * ── Root cause, confirmed directly on this machine ───────────────────────────
 * Neon's hostname resolves to BOTH an AAAA (IPv6) and an A (IPv4) record. A raw
 * TCP test on port 5432 against all three of the resolved IPv6 addresses timed
 * out; the same test against the IPv4 address succeeded on the first attempt,
 * same host, same second. So the database was never actually unreachable —
 * Prisma's Rust query engine was resolving the hostname, trying the IPv6
 * address(es) first, and exhausting `connect_timeout` on a route that does not
 * exist on this network before it ever tried the address that works.
 *
 * ── Why this couldn't be fixed from the Node side ────────────────────────────
 * `dns.setDefaultResultOrder("ipv4first")` (see `src/backend/db/prisma.ts`)
 * only reorders lookups Node's OWN resolver performs — it has no effect here,
 * because Prisma's query engine is a separate Rust binary that resolves DNS on
 * its own. That is also why the realtime LISTEN connection (which goes through
 * the `pg` package, a Node-level client) was unaffected by this bug while every
 * Prisma query failed: two different network stacks in the same process, only
 * one of which Node's `dns` module can influence.
 *
 * ── The fix ───────────────────────────────────────────────────────────────────
 * `hostaddr` is a standard libpq connection parameter Prisma's Postgres
 * connector honours: it says WHICH IP to open the TCP socket against, while
 * `host` (unchanged, still the real hostname) continues to be what is checked
 * against the TLS certificate and sent as SNI — which is also what Neon's
 * pooler uses to route the connection to the right project. So this changes
 * nothing about identity, trust or routing; it only removes the DNS step that
 * was picking the wrong address family. Verified directly: the rewritten URL
 * connects and queries successfully with `sslmode=require` unchanged.
 *
 * Resolved via Node's OWN resolver (`dns.resolve4`, IPv4-only, so it can never
 * itself pick the address that doesn't work) fresh on every process start —
 * not a hardcoded IP pinned in `.env` — so if Neon ever moves this endpoint to
 * a new IP, the app picks up the new one on its next start instead of silently
 * pinning a stale, dead address. If resolution fails for any reason (offline,
 * DNS blocked), the URL is left exactly as it was and the app behaves exactly
 * as before this fix — never a new failure mode, only a removed one.
 */
export async function pinDatabaseHostToIPv4() {
  const dns = await import("node:dns/promises");
  for (const key of ["DATABASE_URL", "DIRECT_URL"] as const) {
    const raw = process.env[key];
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.searchParams.has("hostaddr")) continue; // already pinned explicitly
      const [addr] = await dns.resolve4(url.hostname);
      if (!addr) continue;
      url.searchParams.set("hostaddr", addr);
      process.env[key] = url.toString();
    } catch (e) {
      // Never the credentials or the URL — just which var and why.
      console.error(`[startup] could not pre-resolve ${key} to IPv4; DNS resolution is left to the driver`, e);
    }
  }
}
