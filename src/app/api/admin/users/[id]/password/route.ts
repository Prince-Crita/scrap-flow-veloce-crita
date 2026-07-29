import { z } from "zod";
import bcrypt from "bcryptjs";
import { requireAdmin, parseBody, ok, fail } from "@/lib/api";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const schema = z.object({
  newPassword: z.string().min(8).max(128),
  /** Default true: the holder must replace the admin-chosen password on login. */
  mustChangePassword: z.boolean().optional().default(true),
});

/**
 * POST — admin password reset.
 *
 * The new password is set directly (no knowledge of the old one) because that is
 * the point of a reset, but `mustChangePassword` defaults to true so an
 * admin-known password cannot remain in use. The audit entry records that a
 * reset happened and by whom; it never records the password itself, and
 * src/lib/audit.ts strips anything password-shaped as a second safeguard.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma, user } = guard;
  const { id } = await ctx.params;

  const body = await parseBody(req, schema);
  if ("res" in body) return body.res;

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, role: true, yardId: true },
  });
  if (!target) return fail("NOT_FOUND", "User not found", 404);

  await prisma.user.update({
    where: { id },
    data: {
      passwordHash: await bcrypt.hash(body.data.newPassword, 10),
      mustChangePassword: body.data.mustChangePassword,
    },
  });

  await audit({
    action: "user.passwordReset",
    entity: "User",
    entityId: id,
    yardId: target.yardId,
    actorId: user.id,
    after: {
      targetEmail: target.email,
      targetName: target.name,
      targetRole: target.role,
      mustChangePassword: body.data.mustChangePassword,
    },
    req,
  });

  return ok({ reset: true, mustChangePassword: body.data.mustChangePassword });
}
