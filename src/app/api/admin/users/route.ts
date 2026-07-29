import { z } from "zod";
import bcrypt from "bcryptjs";
import { requireAdmin, parseQuery, parseBody, ok, fail } from "@/lib/api";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  yardId: z.string().optional(),
  role: z.enum(["OWNER", "MANAGER", "ADMIN"]).optional(),
  q: z.string().max(120).optional(),
});

/** GET — all users across all yards, filterable. Password hashes are never returned. */
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  const q = parseQuery(req, querySchema);
  if ("res" in q) return q.res;
  const f = q.data;

  const users = await prisma.user.findMany({
    where: {
      ...(f.yardId ? { yardId: f.yardId } : {}),
      ...(f.role ? { role: f.role } : {}),
      ...(f.q
        ? { OR: [{ name: { contains: f.q, mode: "insensitive" } }, { email: { contains: f.q, mode: "insensitive" } }] }
        : {}),
    },
    orderBy: [{ role: "asc" }, { name: "asc" }],
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

  return ok({ users });
}

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  role: z.enum(["OWNER", "MANAGER"]),
  yardId: z.string().min(1),
  /** Force a password change on first login (recommended). */
  mustChangePassword: z.boolean().optional().default(true),
});

/**
 * POST — create an Owner or Manager inside a yard.
 *
 * Creating another ADMIN is intentionally not exposed here: a platform
 * super-admin is provisioned deliberately (prisma/seed.ts), not through a web
 * form, so privilege escalation has no self-service path.
 */
export async function POST(req: Request) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma, user } = guard;

  const body = await parseBody(req, createSchema);
  if ("res" in body) return body.res;
  const d = body.data;

  const yard = await prisma.yard.findUnique({ where: { id: d.yardId }, select: { id: true, yardCode: true, active: true } });
  if (!yard) return fail("BAD_YARD", "Yard not found", 422, { yardId: "Unknown yard" });
  if (!yard.active) return fail("YARD_INACTIVE", "Cannot add users to an inactive yard", 409);

  const clash = await prisma.user.findUnique({ where: { email: d.email } });
  if (clash) return fail("DUPLICATE", "That email is already registered", 409, { email: "Already registered" });

  const created = await prisma.user.create({
    data: {
      name: d.name,
      email: d.email,
      passwordHash: await bcrypt.hash(d.password, 10),
      role: d.role,
      yardId: d.yardId,
      mustChangePassword: d.mustChangePassword,
      active: true,
    },
    select: { id: true, name: true, email: true, role: true, yardId: true },
  });

  await audit({
    action: "user.create",
    entity: "User",
    entityId: created.id,
    yardId: d.yardId,
    actorId: user.id,
    after: { name: d.name, email: d.email, role: d.role, yardCode: yard.yardCode, mustChangePassword: d.mustChangePassword },
    req,
  });

  return ok({ user: created }, { status: 201 });
}
