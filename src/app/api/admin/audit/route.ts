import { z } from "zod";
import { requireAdmin, parseQuery, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  yardId: z.string().optional(),
  action: z.string().max(60).optional(),
  entity: z.string().max(60).optional(),
  actorId: z.string().optional(),
  /** Keyset cursor: the id of the last row of the previous page. */
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

/**
 * GET — the audit trail.
 *
 * Keyset (cursor) pagination, not offset: the audit log grows without bound and
 * `OFFSET 50000` degrades linearly, while `(createdAt, id)` ordering with a
 * cursor stays flat. Backed by the (yardId, createdAt) index.
 */
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  const q = parseQuery(req, querySchema);
  if ("res" in q) return q.res;
  const f = q.data;

  const where = {
    ...(f.yardId ? { yardId: f.yardId } : {}),
    ...(f.action ? { action: { contains: f.action } } : {}),
    ...(f.entity ? { entity: f.entity } : {}),
    ...(f.actorId ? { actorId: f.actorId } : {}),
  };

  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: f.limit + 1, // one extra row tells us whether another page exists
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      action: true,
      entity: true,
      entityId: true,
      before: true,
      after: true,
      ip: true,
      userAgent: true,
      createdAt: true,
      actor: { select: { id: true, name: true, email: true, role: true } },
      yard: { select: { id: true, yardCode: true, yardName: true } },
    },
  });

  const hasMore = rows.length > f.limit;
  const page = hasMore ? rows.slice(0, f.limit) : rows;

  // Distinct actions/entities so the UI can build filter dropdowns without
  // hard-coding a list that would drift as new audited actions are added.
  const [actions, entities] = await Promise.all([
    prisma.auditLog.findMany({ distinct: ["action"], select: { action: true }, orderBy: { action: "asc" }, take: 100 }),
    prisma.auditLog.findMany({ distinct: ["entity"], select: { entity: true }, orderBy: { entity: "asc" }, take: 100 }),
  ]);

  return ok({
    entries: page,
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    filters: {
      actions: actions.map((a) => a.action),
      entities: entities.map((e) => e.entity),
    },
  });
}
