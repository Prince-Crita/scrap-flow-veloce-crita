/**
 * Rate limiting — fixed-window counters held in process memory.
 *
 * ── Swap point ───────────────────────────────────────────────────────────────
 * Same constraint as `src/lib/realtime.ts`: this assumes ONE Node process. With
 * several instances each keeps its own counters, so the effective limit
 * multiplies by the instance count. Before running multi-instance, replace the
 * `hits` map with Redis (or Vercel KV) — the exported API does not change.
 *
 * Fixed windows rather than a sliding log: a yard has tens of users, not
 * thousands, so the memory a per-request log would cost buys nothing. The
 * tradeoff is a burst at a window boundary, which is harmless for the limits
 * below (they exist to stop abuse and runaway retries, not to shape traffic).
 */

type Bucket = { count: number; resetAt: number };

const hits = new Map<string, Bucket>();

/** Stop the map growing without bound in a long-lived process. */
const SWEEP_EVERY = 500;
let sinceSweep = 0;

function sweep(now: number) {
  for (const [key, bucket] of hits) {
    if (bucket.resetAt <= now) hits.delete(key);
  }
}

export type RateLimitResult = {
  ok: boolean;
  /** Requests left in the current window. */
  remaining: number;
  /** Seconds until the window resets — sent as Retry-After. */
  retryAfter: number;
  limit: number;
};

export type RateLimitRule = { limit: number; windowMs: number };

/**
 * Limits per endpoint class. Deliberately generous for real yard work and tight
 * for the endpoints that cost real money or real memory.
 */
export const RATE_LIMITS = {
  /** Each inward/outward capture uploads several images back to back. */
  upload: { limit: 60, windowMs: 60_000 },
  /** OCR is the expensive one: a GPU pass per call, several passes per image. */
  ocr: { limit: 20, windowMs: 60_000 },
  /**
   * Credential-stuffing defence, counted per IP.
   *
   * Deliberately generous. A yard office sits behind one NAT address, so at
   * shift change a dozen staff sign in within the same minute — a tight
   * per-IP limit would lock out the whole yard, which is a worse failure than
   * the brute-force attempt it prevents. This stops naive hammering; a
   * per-ACCOUNT lockout is the right tool for targeted brute force, and lives in
   * `src/lib/login-lockout.ts`, wired into the Auth.js `authorize()` callback
   * where the email is known. The two layers stack; neither replaces the other.
   */
  auth: { limit: 60, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

/**
 * Count one request against a bucket.
 *
 * `identity` should be the narrowest stable thing available — a user id where
 * the caller is authenticated, an IP where they are not.
 */
export function rateLimit(name: RateLimitName, identity: string): RateLimitResult {
  const rule = RATE_LIMITS[name];
  const now = Date.now();

  if (++sinceSweep >= SWEEP_EVERY) {
    sinceSweep = 0;
    sweep(now);
  }

  const key = `${name}:${identity}`;
  const bucket = hits.get(key);

  if (!bucket || bucket.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { ok: true, remaining: rule.limit - 1, retryAfter: 0, limit: rule.limit };
  }

  bucket.count += 1;
  const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  if (bucket.count > rule.limit) {
    return { ok: false, remaining: 0, retryAfter, limit: rule.limit };
  }
  return { ok: true, remaining: rule.limit - bucket.count, retryAfter, limit: rule.limit };
}

/**
 * Best-effort client IP. Behind a proxy the left-most `x-forwarded-for` entry
 * is the client; it is spoofable, which is why authenticated endpoints key on
 * the user id instead and this is only the fallback for anonymous ones.
 */
export function clientIp(req: Request): string {
  const h = req.headers;
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "unknown"
  );
}

/** 429 with the headers a well-behaved client will honour. */
export function tooManyRequests(result: RateLimitResult, what: string): Response {
  return new Response(
    JSON.stringify({
      error: { code: "RATE_LIMITED", message: `Too many ${what} requests — retry in ${result.retryAfter}s` },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(result.retryAfter),
        "x-ratelimit-limit": String(result.limit),
        "x-ratelimit-remaining": "0",
      },
    }
  );
}

/** Test-only: clears every counter so suites do not leak state into each other. */
export function __resetRateLimits() {
  hits.clear();
  sinceSweep = 0;
}

/* ─────────────── shared (multi-instance) limiter ─────────────── */

import { prisma } from "@/lib/prisma";

/**
 * Postgres-backed fixed-window limiter, shared across instances.
 *
 * The in-process limiter above granted each instance its own budget, so the real
 * limit was `configured × instances`. This is one atomic upsert on
 * (bucket, windowStart) — no pub/sub, no session state — so it works over the
 * pooled connection like every other query.
 *
 * The sync `rateLimit()` above is deliberately KEPT for the Edge middleware
 * (auth), where Prisma cannot run. Do not merge the two.
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
