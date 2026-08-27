/**
 * Rate limiting — fixed-window counters held in process memory.
 *
 * ── Swap point ───────────────────────────────────────────────────────────────
 * Same constraint as `src/backend/realtime/realtime.ts`: this assumes ONE Node process. With
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
   * `src/backend/auth/login-lockout.ts`, wired into the Auth.js `authorize()` callback
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

/* ─────────────── shared (multi-instance) limiter ───────────────
 *
 * `rateLimitShared()` and `sweepSharedRateLimits()` used to live here. They now
 * live in `src/backend/http/rate-limit-shared.ts` and MUST stay there.
 *
 * This module is imported by `middleware.ts`, which runs on the Edge runtime. An
 * ES module is bundled as one unit, so the single `import { prisma }` those two
 * functions needed pulled the entire Prisma client — and its 2.2 MB WASM query
 * engine — into the middleware bundle, putting the Edge Function at 1.04 MB
 * against Vercel's 1 MB limit and failing the deployment at "Deploying outputs".
 *
 * Keep this file free of Prisma (and of any other Node-only dependency) so it
 * stays Edge-safe. The sync in-memory `rateLimit()` above is what middleware
 * uses; DB-backed limiting belongs in the sibling module.
 */
