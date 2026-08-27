import { z } from "zod";
import { requireAdmin, parseBody, ok, fail } from "@/backend/http/api";
import { clearLock, lockoutConfig } from "@/backend/auth/login-lockout";

export const dynamic = "force-dynamic";

/**
 * Admin visibility into per-account login lockouts.
 *
 * Locks expire on their own, so this is not required to restore access — it
 * exists because "why can't I log in?" must be answerable without reading the
 * database, and because a row with a high `lockCount` is the clearest evidence
 * that one account is being targeted.
 */
export async function GET() {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;

  const rows = await guard.prisma.loginAttempt.findMany({
    orderBy: [{ lockedUntil: "desc" }, { updatedAt: "desc" }],
    take: 100,
  });
  const now = Date.now();
  return ok({
    config: lockoutConfig(),
    attempts: rows.map((r) => ({
      email: r.email,
      failedCount: r.failedCount,
      lockCount: r.lockCount,
      lastFailedAt: r.lastFailedAt,
      lastSuccessAt: r.lastSuccessAt,
      lockedUntil: r.lockedUntil,
      /** Derived, not stored: a past `lockedUntil` simply reads as unlocked. */
      locked: !!r.lockedUntil && r.lockedUntil.getTime() > now,
      retryAfter:
        r.lockedUntil && r.lockedUntil.getTime() > now
          ? Math.ceil((r.lockedUntil.getTime() - now) / 1000)
          : 0,
    })),
  });
}

const unlockSchema = z.object({ email: z.string().email() });

/** Release a lock early, for the case where a real operator is at the gate. */
export async function POST(req: Request) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;

  const body = await parseBody(req, unlockSchema);
  if ("res" in body) return body.res;

  const email = body.data.email.toLowerCase();
  const existing = await guard.prisma.loginAttempt.findUnique({ where: { email } });
  if (!existing) return fail("NOT_FOUND", "No login attempts recorded for that address", 404);

  await clearLock(email, guard.user.id, req);
  return ok({ email, locked: false });
}
