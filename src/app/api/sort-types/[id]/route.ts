import { z } from "zod";
import { requireYardCapability, parseBody, ok, fail } from "@/backend/http/api";
import { publishMany } from "@/backend/realtime/realtime";
import { audit } from "@/backend/services/audit";
import { countSkuReferences, describeReferences } from "@/backend/services/sku-references";
import type { ScopedDb } from "@/backend/db/tenant";

export const dynamic = "force-dynamic";

/**
 * One sort type. Owner/Admin only — see ../route.ts for what a sort type is.
 *
 * Rename and activate/deactivate are PATCH; DELETE deactivates unless
 * `?permanent=1`, which erases the row only when nothing references it and no
 * stock remains. Those rules are the same ones Materials uses, and they are
 * shared rather than restated — see src/backend/services/sku-references.ts.
 */

const patchSchema = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    icon: z.string().trim().max(8).optional(),
    saleThresholdKg: z.number().int().positive().max(1_000_000).optional(),
    /** Restore or deactivate. Stored as `Sku.visible`. */
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });

/** Loads a sort type. Callers check `isMixedBucket` and refuse if it is set. */
function loadSortType(prisma: ScopedDb, id: string) {
  return prisma.sku.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      code: true,
      icon: true,
      visible: true,
      isMixedBucket: true,
      materialId: true,
      saleThresholdKg: true,
      inventory: { select: { quantityKg: true } },
    },
  });
}

/** PATCH — rename, re-icon, re-threshold, deactivate or restore. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireYardCapability("sortType.write");
  if ("res" in guard) return guard.res;
  const { prisma, yardId } = guard;

  const body = await parseBody(req, patchSchema);
  if ("res" in body) return body.res;

  const { id } = await ctx.params;
  const sku = await loadSortType(prisma, id);
  if (!sku) return fail("NOT_FOUND", "Sort type not found", 404);
  // The mixed bucket is the inward material itself, managed by /api/materials.
  // Renaming it here would let one screen edit another screen's entity.
  if (sku.isMixedBucket || !sku.materialId) {
    return fail("NOT_SORT_TYPE", "That is a material, not a sort type", 422);
  }

  if (body.data.name && body.data.name !== sku.name) {
    const clash = await prisma.sku.findFirst({
      where: { name: body.data.name, id: { not: id } },
      select: { id: true },
    });
    if (clash) return fail("DUPLICATE", `"${body.data.name}" already exists in this yard`, 409);
  }

  const data: Record<string, unknown> = {};
  if (body.data.name !== undefined) data.name = body.data.name;
  if (body.data.icon !== undefined) data.icon = body.data.icon;
  if (body.data.saleThresholdKg !== undefined) data.saleThresholdKg = body.data.saleThresholdKg;
  // `visible` is the active flag — history and stock are untouched either way.
  if (body.data.active !== undefined) data.visible = body.data.active;
  if (Object.keys(data).length === 0) return fail("NO_CHANGES", "Nothing to change", 422);

  const updated = await prisma.sku.update({ where: { id }, data });

  await audit({
    action: body.data.active === false ? "sortType.deactivate" : "sortType.update",
    entity: "Sku",
    entityId: id,
    yardId,
    actorId: guard.user.id,
    before: {
      name: sku.name,
      icon: sku.icon,
      saleThresholdKg: sku.saleThresholdKg,
      active: sku.visible,
    },
    after: { ...data, ...(data.visible !== undefined ? { active: data.visible } : {}) },
    req,
  });

  publishMany(yardId, [
    { channel: "materials", action: "updated", entity: "Sku", entityId: id, actorId: guard.user.id },
    { channel: "stock", action: "updated", entity: "Sku", entityId: id, actorId: guard.user.id },
    { channel: "sort", action: "updated", entity: "Sku", entityId: id, actorId: guard.user.id },
  ]);

  return ok({
    sortType: {
      id: updated.id,
      name: updated.name,
      code: updated.code,
      icon: updated.icon,
      active: updated.visible,
      saleThresholdKg: updated.saleThresholdKg,
    },
  });
}

/**
 * DELETE — deactivate by default, erase with `?permanent=1`.
 *
 * A sort type with any history cannot be erased: finished stock traces back
 * through its segregation allocations to the vendor lot it came from, and
 * deleting the SKU would sever that chain. Deactivating keeps every row.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireYardCapability("sortType.write");
  if ("res" in guard) return guard.res;
  const { prisma, yardId } = guard;

  const permanent = new URL(req.url).searchParams.get("permanent") === "1";

  const { id } = await ctx.params;
  const sku = await loadSortType(prisma, id);
  if (!sku) return fail("NOT_FOUND", "Sort type not found", 404);
  if (sku.isMixedBucket || !sku.materialId) {
    return fail("NOT_SORT_TYPE", "That is a material, not a sort type", 422);
  }

  if (permanent) {
    const refs = await countSkuReferences(prisma, [id]);

    if (refs.total > 0) {
      return fail(
        "HAS_REFERENCES",
        `"${sku.name}" has ${refs.total} linked record(s) — ${describeReferences(refs)} — so it can only be deactivated.`,
        409
      );
    }
    if (refs.stockKg > 0) {
      return fail(
        "HAS_STOCK",
        `"${sku.name}" still holds ${refs.stockKg} kg of stock, so it can only be deactivated.`,
        409
      );
    }

    // Zero references and zero stock. The inventory row is the only child, and
    // it is at 0 kg, so both go in one transaction.
    await prisma.$transaction(async (tx) => {
      await tx.inventory.deleteMany({ where: { skuId: id } });
      await tx.sku.delete({ where: { id } });
    });

    await audit({
      action: "sortType.permanent_delete",
      entity: "Sku",
      entityId: id,
      yardId,
      actorId: guard.user.id,
      before: { name: sku.name, code: sku.code, materialId: sku.materialId },
      req,
    });

    publishMany(yardId, [
      { channel: "materials", action: "deleted", entity: "Sku", entityId: id, actorId: guard.user.id },
      { channel: "stock", action: "updated", entity: "Sku", entityId: id, actorId: guard.user.id },
      { channel: "sort", action: "updated", entity: "Sku", entityId: id, actorId: guard.user.id },
    ]);
    return ok({ id, deleted: true });
  }

  await prisma.sku.update({ where: { id }, data: { visible: false } });

  await audit({
    action: "sortType.deactivate",
    entity: "Sku",
    entityId: id,
    yardId,
    actorId: guard.user.id,
    before: { active: sku.visible },
    after: { active: false },
    req,
  });

  publishMany(yardId, [
    { channel: "materials", action: "updated", entity: "Sku", entityId: id, actorId: guard.user.id },
    { channel: "stock", action: "updated", entity: "Sku", entityId: id, actorId: guard.user.id },
    { channel: "sort", action: "updated", entity: "Sku", entityId: id, actorId: guard.user.id },
  ]);
  // `hasStock` lets the caller explain why a permanent delete would be refused.
  return ok({ id, active: false, hasStock: (sku.inventory?.quantityKg ?? 0) > 0 });
}
