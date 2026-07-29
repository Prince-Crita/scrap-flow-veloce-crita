/**
 * Per-account login lockout.
 *
 * The Edge middleware limiter counts login attempts per IP, and is deliberately
 * generous: a yard office is one NAT address, so a tight per-IP limit would lock
 * out the whole shift. That leaves targeted brute force against a single known
 * email essentially unthrottled — a hundred guesses a minute against
 * `owner@…` looks identical to a busy shift change.
 *
 * This closes that gap, and does it where the email is actually known: inside
 * the Auth.js `authorize()` callback. The two layers stack — the IP limiter is
 * NOT replaced.
 *
 * State lives in the `LoginAttempt` table, so the lockout is shared across
 * instances (an in-memory counter would give an attacker one full budget per
 * instance, which is the same bug the shared rate limiter fixed).
 *
 * Backoff is exponential in `lockCount`, not in `failedCount`: an operator who
 * fat-fingers their password twice a week should never accumulate a long lock,
 * while an account under sustained attack escalates towards the cap quickly.
 *
 * Fails OPEN. If the table is unreachable the login proceeds to the normal
 * password check — a database blip must not lock every user out of the yard. The
 * password is still verified, so failing open costs throttling, never access.
 */
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";

/** Overridable per deployment; the defaults suit a yard with tens of users. */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function lockoutConfig() {
  return {
    /** Consecutive failures that trigger a lock. */
    threshold: intFromEnv("LOGIN_LOCKOUT_THRESHOLD", 5),
    /** First lock duration. Doubles per prior lock. */
    baseLockMs: intFromEnv("LOGIN_LOCKOUT_BASE_SECONDS", 60) * 1000,
    /** Ceiling, so an account is never bricked — auto-unlock always arrives. */
    maxLockMs: intFromEnv("LOGIN_LOCKOUT_MAX_SECONDS", 3600) * 1000,
    /**
     * Idle window after which the failure streak is forgotten. Without this a
     * single typo in January plus four in July would lock the account.
     */
    decayMs: intFromEnv("LOGIN_LOCKOUT_DECAY_SECONDS", 900) * 1000,
    /** Escape hatch for load tests / CI. */
    enabled: process.env.LOGIN_LOCKOUT !== "0",
  };
}

function lockDurationMs(lockCount: number): number {
  const { baseLockMs, maxLockMs } = lockoutConfig();
  // lockCount is the number of PRIOR locks, so the first lock uses the base.
  const ms = baseLockMs * 2 ** Math.max(0, lockCount);
  return Math.min(ms, maxLockMs);
}

export type LockState = {
  locked: boolean;
  /** Seconds until automatic unlock. 0 when not locked. */
  retryAfter: number;
  failedCount: number;
};

const NOT_LOCKED: LockState = { locked: false, retryAfter: 0, failedCount: 0 };

function norm(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Is this account currently locked?
 *
 * Automatic unlock is implicit: `lockedUntil` in the past simply reads as
 * unlocked. No sweeper job, nothing to schedule, and nothing to go wrong while
 * an operator is standing at the gate waiting to sign in.
 */
export async function checkLock(email: string): Promise<LockState> {
  if (!lockoutConfig().enabled) return NOT_LOCKED;
  try {
    const row = await prisma.loginAttempt.findUnique({
      where: { email: norm(email) },
      select: { failedCount: true, lockedUntil: true },
    });
    if (!row?.lockedUntil) return { ...NOT_LOCKED, failedCount: row?.failedCount ?? 0 };
    const remaining = row.lockedUntil.getTime() - Date.now();
    if (remaining <= 0) return { locked: false, retryAfter: 0, failedCount: row.failedCount };
    return { locked: true, retryAfter: Math.ceil(remaining / 1000), failedCount: row.failedCount };
  } catch (e) {
    console.error("[lockout] check failed; allowing the password check to proceed", e);
    return NOT_LOCKED;
  }
}

/**
 * Record a failed attempt and lock the account once the threshold is crossed.
 *
 * Called for a wrong password only — not for an unknown email, and not for a
 * deactivated user or yard. Counting unknown emails would let anyone fill the
 * table, and counting deactivated accounts would produce lock audit noise for
 * users who cannot log in regardless.
 */
export async function recordFailure(email: string, req?: Request): Promise<LockState> {
  const cfg = lockoutConfig();
  if (!cfg.enabled) return NOT_LOCKED;
  const key = norm(email);
  const now = new Date();

  try {
    const existing = await prisma.loginAttempt.findUnique({ where: { email: key } });

    // A streak that has gone quiet starts over.
    const stale =
      !!existing?.lastFailedAt && now.getTime() - existing.lastFailedAt.getTime() > cfg.decayMs;
    const priorFailures = !existing || stale ? 0 : existing.failedCount;
    const failedCount = priorFailures + 1;

    const shouldLock = failedCount >= cfg.threshold;
    const lockMs = shouldLock ? lockDurationMs(existing?.lockCount ?? 0) : 0;
    const lockedUntil = shouldLock ? new Date(now.getTime() + lockMs) : (existing?.lockedUntil ?? null);
    const lockCount = shouldLock ? (existing?.lockCount ?? 0) + 1 : (existing?.lockCount ?? 0);

    await prisma.loginAttempt.upsert({
      where: { email: key },
      create: {
        email: key,
        failedCount,
        lastFailedAt: now,
        lockedUntil: shouldLock ? lockedUntil : null,
        lockCount: shouldLock ? 1 : 0,
      },
      update: {
        // Reset the counter on lock: the next streak starts fresh, and the
        // escalation is carried by lockCount instead.
        failedCount: shouldLock ? 0 : failedCount,
        lastFailedAt: now,
        lockedUntil,
        lockCount,
      },
    });

    if (shouldLock) {
      // Security-relevant, and the only signal an admin has that an account is
      // being targeted. Platform-scoped: the yard is not known at this point
      // (and for an unknown-yard attacker it never will be).
      await audit({
        action: "LOGIN_LOCKED",
        entity: "LoginAttempt",
        entityId: key,
        after: { email: key, failedCount, lockSeconds: Math.round(lockMs / 1000), lockNumber: lockCount },
        req,
      });
      return { locked: true, retryAfter: Math.ceil(lockMs / 1000), failedCount };
    }

    return { locked: false, retryAfter: 0, failedCount };
  } catch (e) {
    console.error("[lockout] failed to record a failed attempt", e);
    return NOT_LOCKED;
  }
}

/**
 * Clear the streak after a genuine sign-in.
 *
 * `lockCount` is deliberately NOT cleared: it is the account's lifetime lock
 * history and drives the backoff. An attacker who eventually guesses the
 * password should not also reset the escalation for the next campaign.
 */
export async function recordSuccess(email: string): Promise<void> {
  if (!lockoutConfig().enabled) return;
  const key = norm(email);
  try {
    await prisma.loginAttempt.upsert({
      where: { email: key },
      create: { email: key, failedCount: 0, lastSuccessAt: new Date() },
      update: { failedCount: 0, lastFailedAt: null, lockedUntil: null, lastSuccessAt: new Date() },
    });
  } catch (e) {
    console.error("[lockout] failed to clear the failure streak", e);
  }
}

/** Admin action: release a lock immediately. */
export async function clearLock(email: string, actorId?: string | null, req?: Request): Promise<void> {
  const key = norm(email);
  await prisma.loginAttempt.updateMany({
    where: { email: key },
    data: { failedCount: 0, lastFailedAt: null, lockedUntil: null },
  });
  await audit({
    action: "LOGIN_UNLOCKED",
    entity: "LoginAttempt",
    entityId: key,
    actorId: actorId ?? null,
    after: { email: key },
    req,
  });
}
