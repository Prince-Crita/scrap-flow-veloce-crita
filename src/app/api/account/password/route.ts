import { z } from "zod";
import bcrypt from "bcryptjs";
import { requireUser, parseBody, ok, fail } from "@/lib/api";
import { adminDb } from "@/lib/tenant";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const schema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

/**
 * Self-service password change. Also the exit from the forced-change state after
 * an admin reset. Always requires the current password — an admin-issued
 * temporary password is still a password the holder must know.
 */
export async function POST(req: Request) {
  const guard = await requireUser();
  if ("res" in guard) return guard.res;

  const body = await parseBody(req, schema);
  if ("res" in body) return body.res;
  const { currentPassword, newPassword } = body.data;

  const user = await adminDb.user.findUnique({ where: { id: guard.user.id } });
  if (!user) return fail("NOT_FOUND", "Account not found", 404);

  const matches = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!matches) return fail("BAD_PASSWORD", "Current password is incorrect", 422, { currentPassword: "Incorrect" });

  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    return fail("SAME_PASSWORD", "Choose a password you have not used here before", 422, {
      newPassword: "Must differ from the current password",
    });
  }

  await adminDb.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: false },
  });

  await audit({
    action: "password.change",
    entity: "User",
    entityId: user.id,
    yardId: user.yardId,
    actorId: user.id,
    after: { self: true },
    req,
  });

  return ok({ changed: true });
}
