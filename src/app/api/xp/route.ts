import { z } from "zod";
import { requireUser, parseBody, ok } from "@/backend/http/api";
import { adminDb } from "@/backend/db/tenant";
import { publish } from "@/backend/realtime/realtime";
import { nextStreak } from "@/backend/services/streak";

const schema = z.object({
  xp: z.number().int().min(0).max(100_000_000),
  level: z.number().int().min(1).max(1000),
});

/**
 * Gamification state is per user, not per yard, so this writes through the
 * unscoped client but only ever to the caller's own row (`id: guard.user.id`).
 *
 * It is also where the daily streak is maintained: any XP-earning action counts
 * as activity for that day, evaluated in the yard's own timezone (see
 * src/backend/services/streak.ts). Doing it here means the streak follows real work rather
 * than page visits.
 *
 * ADMIN is deliberately excluded: an admin inspecting a yard must not accrue
 * that yard's XP or streak, and must not alter the owner's.
 */
export async function POST(req: Request) {
  const guard = await requireUser();
  if ("res" in guard) return guard.res;

  const body = await parseBody(req, schema);
  if ("res" in body) return body.res;

  if (guard.user.role === "ADMIN") {
    return ok({ xp: body.data.xp, level: body.data.level, streak: 0, persisted: false });
  }

  const current = await adminDb.user.findUnique({
    where: { id: guard.user.id },
    select: { streak: true, lastActiveDate: true, yardId: true, yard: { select: { timezone: true } } },
  });
  if (!current) return ok({ xp: body.data.xp, level: body.data.level, streak: 0, persisted: false });

  const now = new Date();
  const timeZone = current.yard?.timezone || "Asia/Kolkata";
  const s = nextStreak(current.streak, current.lastActiveDate, now, timeZone);

  const user = await adminDb.user.update({
    where: { id: guard.user.id },
    data: {
      xp: body.data.xp,
      level: body.data.level,
      lastActiveDate: now,
      ...(s.changed ? { streak: s.streak } : {}),
    },
    select: { xp: true, level: true, streak: true, yardId: true },
  });

  if (user.yardId) {
    publish(user.yardId, {
      channel: "xp",
      action: "updated",
      entity: "User",
      entityId: guard.user.id,
      actorId: guard.user.id,
    });
  }

  return ok({
    xp: user.xp,
    level: user.level,
    streak: user.streak,
    persisted: true,
    // Lets the client celebrate a newly extended streak without a second call.
    streakExtended: s.extended,
    streakReset: s.reset,
  });
}
