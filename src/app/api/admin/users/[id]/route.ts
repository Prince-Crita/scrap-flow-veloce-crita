import { z } from "zod";
import { requireAdmin, parseBody, ok, fail } from "@/backend/http/api";
import { audit, diffFields } from "@/backend/services/audit";

export const dynamic = "force-dynamic";

type AdminGuard = Extract<Awaited<ReturnType<typeof requireAdmin>>, { prisma: unknown }>;
type AdminPrisma = AdminGuard["prisma"];

const patchSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  role: z.enum(["OWNER", "MANAGER"]).optional(),
  /** Change yard assignment. */
  yardId: z.string().min(1).optional(),
  active: z.boolean().optional(),
});

/**
 * PATCH — edit a user: rename, change role, reassign yard, activate/deactivate.
 *
 * Two invariants are enforced here rather than trusted to the caller:
 *   • An ADMIN's role and yard cannot be edited through this endpoint. Demoting
 *     or re-homing the platform super-admin is not a routine web action, and it
 *     is how an admin could lock everyone (including themselves) out.
 *   • A yard must never lose its last active OWNER, or nobody can sell.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma, user } = guard;
  const { id } = await ctx.params;

  const body = await parseBody(req, patchSchema);
  if ("res" in body) return body.res;
  const d = body.data;

  const before = await prisma.user.findUnique({ where: { id } });
  if (!before) return fail("NOT_FOUND", "User not found", 404);

  if (before.role === "ADMIN" && (d.role !== undefined || d.yardId !== undefined)) {
    return fail("PROTECTED", "A platform admin's role and yard cannot be changed here", 409);
  }
  if (before.role === "ADMIN" && d.active === false && before.id === user.id) {
    return fail("PROTECTED", "You cannot deactivate your own admin account", 409);
  }

  if (d.email && d.email !== before.email) {
    const clash = await prisma.user.findUnique({ where: { email: d.email } });
    if (clash) return fail("DUPLICATE", "That email is already registered", 409, { email: "Already registered" });
  }

  if (d.yardId && d.yardId !== before.yardId) {
    const yard = await prisma.yard.findUnique({ where: { id: d.yardId }, select: { id: true, active: true } });
    if (!yard) return fail("BAD_YARD", "Yard not found", 422, { yardId: "Unknown yard" });
    if (!yard.active) return fail("YARD_INACTIVE", "Cannot move a user into an inactive yard", 409);
  }

  // Would this change strand the old yard without an active owner?
  const losesOwner =
    before.role === "OWNER" &&
    before.yardId &&
    (d.active === false || (d.role && d.role !== "OWNER") || (d.yardId && d.yardId !== before.yardId));

  if (losesOwner) {
    const remaining = await prisma.user.count({
      where: { yardId: before.yardId, role: "OWNER", active: true, id: { not: id } },
    });
    if (remaining === 0) {
      return fail(
        "LAST_OWNER",
        "This is the yard's only active owner. Add another owner first.",
        409
      );
    }
  }

  const after = await prisma.user.update({
    where: { id },
    data: d,
    select: { id: true, name: true, email: true, role: true, active: true, yardId: true },
  });

  const { before: b, after: a } = diffFields(before as unknown as Record<string, unknown>, d);
  await audit({
    action: d.yardId && d.yardId !== before.yardId ? "user.reassign" : "user.update",
    entity: "User",
    entityId: id,
    yardId: after.yardId ?? before.yardId,
    actorId: user.id,
    before: b,
    after: a,
    req,
  });

  return ok({ user: after });
}

/** GET — one user (no password material). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;
  const { id } = await ctx.params;

  const found = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      mustChangePassword: true,
      xp: true,
      level: true,
      streak: true,
      lastActiveDate: true,
      createdAt: true,
      yard: { select: { id: true, yardCode: true, yardName: true } },
    },
  });
  if (!found) return fail("NOT_FOUND", "User not found", 404);
  return ok({ user: found });
}

/**
 * What a user is attached to. Deleting a row that any of these point at would
 * silently NULL the reference — every one of these relations is optional, so
 * Postgres would not refuse it — and the yard would be left with loads, sales
 * and audit entries whose author had quietly become "—".
 *
 * So the check is explicit rather than left to the database: it is the
 * difference between "delete refused" and "history quietly rewritten".
 */
async function attachmentsFor(prisma: AdminPrisma, id: string) {
  const [inward, outward, sorts, sales, vendors, txns, audits, impersonations] = await Promise.all([
    prisma.inwardLoad.count({ where: { capturedById: id } }),
    prisma.outwardLoad.count({ where: { dispatchedById: id } }),
    prisma.segregationRun.count({ where: { completedById: id } }),
    prisma.sale.count({ where: { createdById: id } }),
    prisma.vendor.count({ where: { createdById: id } }),
    prisma.inventoryTransaction.count({ where: { byUserId: id } }),
    prisma.auditLog.count({ where: { actorId: id } }),
    prisma.impersonationSession.count({ where: { adminId: id } }),
  ]);
  return { inward, outward, sorts, sales, vendors, txns, audits, impersonations };
}

/** Human list of what is blocking, in the order an admin would think of them. */
function blockingSummary(a: Awaited<ReturnType<typeof attachmentsFor>>): string[] {
  const parts: [number, string, string][] = [
    [a.inward, "inward load", "inward loads"],
    [a.sorts, "sort run", "sort runs"],
    [a.sales, "invoice", "invoices"],
    [a.outward, "dispatch", "dispatches"],
    [a.vendors, "vendor", "vendors"],
    [a.txns, "stock movement", "stock movements"],
    [a.audits, "audit entry", "audit entries"],
    [a.impersonations, "yard session", "yard sessions"],
  ];
  return parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
}

/**
 * DELETE — remove a user who has no history.
 *
 * Deliberately narrow. Deletion exists for the mistake case: an account created
 * with the wrong email, a duplicate, someone who was never actually onboarded.
 * The moment a user has done anything in the yard, deactivation is the correct
 * action and this endpoint says so instead of destroying the trail — which is
 * also why the same three protections as PATCH apply.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma, user } = guard;
  const { id } = await ctx.params;

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, role: true, active: true, yardId: true },
  });
  if (!target) return fail("NOT_FOUND", "User not found", 404);

  if (target.id === user.id) {
    return fail("PROTECTED", "You cannot delete your own account", 409);
  }
  if (target.role === "ADMIN") {
    return fail("PROTECTED", "A platform admin cannot be deleted here", 409);
  }

  // Same invariant PATCH enforces: a yard must never lose its last active owner.
  if (target.role === "OWNER" && target.active && target.yardId) {
    const remaining = await prisma.user.count({
      where: { yardId: target.yardId, role: "OWNER", active: true, id: { not: id } },
    });
    if (remaining === 0) {
      return fail(
        "LAST_OWNER",
        "This is the yard's only active owner. Add another owner before deleting this one.",
        409
      );
    }
  }

  const attached = await attachmentsFor(prisma, id);
  const blocking = blockingSummary(attached);
  if (blocking.length > 0) {
    return fail(
      "HAS_RECORDS",
      `${target.name} has ${blocking.join(", ")} recorded against them, which must stay attributable. Deactivate this user instead — they lose access immediately and the history is kept.`,
      409,
      { records: blocking.join(", ") }
    );
  }

  await prisma.user.delete({ where: { id } });

  await audit({
    action: "user.delete",
    entity: "User",
    entityId: id,
    yardId: target.yardId,
    actorId: user.id,
    before: { name: target.name, email: target.email, role: target.role, active: target.active },
    after: null,
    req,
  });

  return ok({ deleted: true, id });
}
