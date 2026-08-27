/**
 * Postgres-backed (multi-instance) rate limiting.
 *
 * ── Why this is a SEPARATE module from `src/backend/http/rate-limit.ts` ────────────────
 * These two functions are the only rate-limiting code that touches Prisma, and
 * they used to live at the bottom of `rate-limit.ts`. That file is imported by
 * `middleware.ts`, which runs on the **Edge runtime** — and an ES module is
 * bundled as one unit, so a single `import { prisma }` anywhere in it pulled the
 * whole Prisma client into the middleware bundle, dragging its 2.2 MB WASM query
 * engine along with it. Compressed, that put the Edge Function at 1.04 MB
 * against Vercel's 1 MB limit, and the deployment failed at "Deploying outputs"
 * — after a completely green build, which is why it read as a mystery.
 *
 * Tree shaking does not save you here: the middleware only calls the sync
 * in-memory `rateLimit()`, but Turbopack still bundles the module's Prisma
 * dependency because the import is a side-effecting module reference.
 *
 * So the split is load-bearing, not cosmetic: `rate-limit.ts` must stay free of
 * any Prisma import so it remains Edge-safe. Keep DB-backed limiter code HERE.
 * The behaviour of both limiters is unchanged — this is purely a module
 * boundary, moved verbatim.
 */
import { prisma } from "@/backend/db/prisma";
import { RATE_LIMITS, type RateLimitName, type RateLimitResult } from "@/backend/http/rate-limit";

/**
 * Postgres-backed fixed-window limiter, shared across instances.
 *
 * The in-process limiter in `rate-limit.ts` granted each instance its own
 * budget, so the real limit was `configured × instances`. This is one atomic
 * upsert on (bucket, windowStart) — no pub/sub, no session state — so it works
 * over the pooled connection like every other query.
 *
 * The sync `rateLimit()` in `rate-limit.ts` is deliberately KEPT for the Edge
 * middleware (auth), where Prisma cannot run. Do not merge the two.
 *
 * Fails OPEN: if the counter query fails, the request proceeds. A database blip
 * must not lock a yard out of uploading weighbridge photos; abuse protection is
 * secondary to the yard being able to work.
 */
export async function rateLimitShared(name: RateLimitName, identity: string): Promise<RateLimitResult> {
  const rule = RATE_LIMITS[name];
  const now = Date.now();
  const windowStart = now - (now % rule.windowMs);
  const bucket = `${name}:${identity}`;
  const retryAfter = Math.max(1, Math.ceil((windowStart + rule.windowMs - now) / 1000));

  try {
    const row = await prisma.rateLimitCounter.upsert({
      where: { bucket_windowStart: { bucket, windowStart: BigInt(windowStart) } },
      create: { bucket, windowStart: BigInt(windowStart), count: 1 },
      update: { count: { increment: 1 } },
      select: { count: true },
    });
    if (row.count > rule.limit) {
      return { ok: false, remaining: 0, retryAfter, limit: rule.limit };
    }
    return { ok: true, remaining: Math.max(0, rule.limit - row.count), retryAfter, limit: rule.limit };
  } catch (e) {
    console.error("[rate-limit] shared counter failed; allowing request", e);
    return { ok: true, remaining: rule.limit, retryAfter: 0, limit: rule.limit };
  }
}

/** Delete windows that can no longer be current. Safe to call any time. */
export async function sweepSharedRateLimits(olderThanMs = 10 * 60_000): Promise<number> {
  try {
    const cutoff = BigInt(Date.now() - olderThanMs);
    const r = await prisma.rateLimitCounter.deleteMany({ where: { windowStart: { lt: cutoff } } });
    return r.count;
  } catch {
    return 0;
  }
}
