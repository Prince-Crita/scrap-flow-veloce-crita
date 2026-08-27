import { z } from "zod";
import { requireAdmin, parseQuery, ok } from "@/backend/http/api";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  yardId: z.string().optional(),
  /** "open" | "closed" | omitted for both. */
  state: z.enum(["open", "closed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

/**
 * GET — Enter Yard history: who entered which yard, when, for how long, and how
 * the session ended. This is the queryable record the requirement asks for
 * (admin name · yard · timestamp · duration · exit time).
 *
 * Open sessions report a live elapsed time so "who is inside right now" is
 * answerable without waiting for them to leave.
 */
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  const q = parseQuery(req, querySchema);
  if ("res" in q) return q.res;
  const f = q.data;

  const sessions = await prisma.impersonationSession.findMany({
    where: {
      ...(f.yardId ? { yardId: f.yardId } : {}),
      ...(f.state === "open" ? { endedAt: null } : {}),
      ...(f.state === "closed" ? { endedAt: { not: null } } : {}),
    },
    orderBy: { startedAt: "desc" },
    take: f.limit,
    include: {
      admin: { select: { id: true, name: true, email: true } },
      yard: { select: { id: true, yardCode: true, yardName: true } },
    },
  });

  const now = Date.now();

  return ok({
    sessions: sessions.map((s) => ({
      id: s.id,
      adminId: s.admin.id,
      adminName: s.admin.name,
      adminEmail: s.admin.email,
      yardId: s.yard.id,
      yardCode: s.yard.yardCode,
      yardName: s.yard.yardName,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt?.toISOString() ?? null,
      // Closed sessions use the stored duration; open ones report elapsed time.
      durationSec: s.durationSec ?? Math.max(0, Math.round((now - s.startedAt.getTime()) / 1000)),
      open: s.endedAt === null,
      endReason: s.endReason,
      ip: s.ip,
    })),
  });
}
