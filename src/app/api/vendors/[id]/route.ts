import { z } from "zod";
import { requireYardCapability, parseBody, ok, fail } from "@/lib/api";
import { publish } from "@/lib/realtime";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Remove a vendor. Owner only.
 *
 * Default is a soft delete: history stays linked and the vendor can be
 * restored. `?permanent=1` erases the row outright, but ONLY when nothing
 * references it — the FKs from InwardLoad and InventoryLot are Restrict, so a
 * referenced vendor cannot be erased without orphaning traceable stock. That
 * check is made here rather than left to the database so the operator gets a
 * real explanation instead of a constraint violation.
 *
 * The audit log is never affected: it stores entity ids as plain strings, not
 * foreign keys, so the record of what happened outlives the row.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireYardCapability("vendor.write");
  if ("res" in guard) return guard.res;
  const { prisma, yardId } = guard;

  const permanent = new URL(req.url).searchParams.get("permanent") === "1";

  const { id } = await ctx.params;
  // Read-first through the scoped client: a foreign-yard id 404s here, and the
  // scoped update below carries the yard predicate as a second line of defence.
  const vendor = await prisma.vendor.findUnique({ where: { id }, include: { _count: { select: { loads: true } } } });
  if (!vendor) return fail("NOT_FOUND", "Vendor not found", 404);

  if (permanent) {
    const [loads, lots] = await Promise.all([
      prisma.inwardLoad.count({ where: { vendorId: id } }),
      prisma.inventoryLot.count({ where: { vendorId: id } }),
    ]);
    const refs = loads + lots;
    if (refs > 0) {
      return fail(
        "HAS_REFERENCES",
        `"${vendor.name}" is referenced by ${loads} load(s) and ${lots} stock batch(es), so it can only be deactivated.`,
        409
      );
    }

    await prisma.vendor.delete({ where: { id } });
    await audit({
      action: "vendor.permanent_delete",
      entity: "Vendor",
      entityId: id,
      yardId,
      actorId: guard.user.id,
      before: { name: vendor.name, gstNumber: vendor.gstNumber, phone: vendor.phone },
      req,
    });

    publish(yardId, { channel: "vendors", action: "deleted", entity: "Vendor", entityId: id, actorId: guard.user.id });
    return ok({ id, deleted: true });
  }

  await prisma.vendor.update({ where: { id }, data: { active: false } });

  publish(yardId, { channel: "vendors", action: "updated", entity: "Vendor", entityId: id, actorId: guard.user.id });
  return ok({ id, active: false, hadLoads: vendor._count.loads > 0 });
}

const patchSchema = z.object({ active: z.boolean() });

/** Restore (reactivate) a vendor. Owner only. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireYardCapability("vendor.write");
  if ("res" in guard) return guard.res;
  const { prisma, yardId } = guard;

  const body = await parseBody(req, patchSchema);
  if ("res" in body) return body.res;

  const { id } = await ctx.params;
  const vendor = await prisma.vendor.findUnique({ where: { id } });
  if (!vendor) return fail("NOT_FOUND", "Vendor not found", 404);

  await prisma.vendor.update({ where: { id }, data: { active: body.data.active } });

  publish(yardId, { channel: "vendors", action: "updated", entity: "Vendor", entityId: id, actorId: guard.user.id });
  return ok({ id, active: body.data.active });
}
