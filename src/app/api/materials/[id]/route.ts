import { z } from "zod";
import { requireYardCapability, parseBody, ok, fail } from "@/lib/api";
import { publishMany } from "@/lib/realtime";
import { audit } from "@/lib/audit";
import { countSkuReferences } from "@/lib/sku-references";

export const dynamic = "force-dynamic";

/**
 * Remove a material by its mixed-bucket SKU id. Owner only.
 *
 * Default is a soft delete — history and stock stay intact and the material is
 * just hidden from the inward chip list. `?permanent=1` erases the Material and
 * its SKUs, but only when nothing anywhere references them and no stock remains.
 * A material with history cannot be erased without breaking the traceability
 * chain from finished stock back to the vendor it came from.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireYardCapability("material.write");
  if ("res" in guard) return guard.res;
  const { prisma, yardId } = guard;

  const permanent = new URL(req.url).searchParams.get("permanent") === "1";

  const { id } = await ctx.params;
  const bucket = await prisma.sku.findUnique({ where: { id }, include: { inventory: true, material: true } });
  if (!bucket) return fail("NOT_FOUND", "Material not found", 404);
  if (!bucket.materialId || !bucket.material) return fail("NO_MATERIAL", "Not a deletable material", 422);

  const hasStock = (bucket.inventory?.quantityKg ?? 0) > 0;
  const loadCount = await prisma.inwardLoad.count({ where: { materialId: bucket.materialId } });
  const hadHistory = loadCount > 0;

  if (permanent) {
    const materialId = bucket.materialId;
    const skus = await prisma.sku.findMany({ where: { materialId }, select: { id: true, name: true } });
    const skuIds = skus.map((s) => s.id);

    // Every table that can point at any of this material's SKUs, shared with
    // sort-type deletion so the two can never disagree about what is safe.
    const skuRefs = await countSkuReferences(prisma, skuIds);
    // Plus load lines that name the material directly without naming one of its
    // SKUs. Excluding the SKU ones keeps them from being counted twice — the
    // decision is the same either way, but the refusal message states a number.
    const materialLines = await prisma.inwardLoadLine.count({
      where: { materialId, NOT: { skuId: { in: skuIds } } },
    });

    const refs = loadCount + materialLines + skuRefs.total;
    const remaining = skuRefs.stockKg;

    if (refs > 0) {
      return fail(
        "HAS_REFERENCES",
        `"${bucket.material.name}" has ${refs} linked record(s) — loads, stock batches or sales — so it can only be deactivated.`,
        409
      );
    }
    if (remaining > 0) {
      return fail(
        "HAS_STOCK",
        `"${bucket.material.name}" still holds ${remaining} kg of stock, so it can only be deactivated.`,
        409
      );
    }

    // Zero references and zero stock: safe to erase. Inventory rows are the
    // only children, and they are all at 0 kg.
    await prisma.$transaction(async (tx) => {
      await tx.inventory.deleteMany({ where: { skuId: { in: skuIds } } });
      await tx.sku.deleteMany({ where: { materialId } });
      await tx.material.delete({ where: { id: materialId } });
    });

    await audit({
      action: "material.permanent_delete",
      entity: "Material",
      entityId: materialId,
      yardId,
      actorId: guard.user.id,
      before: { name: bucket.material.name, code: bucket.material.code, skus: skus.map((s) => s.name) },
      req,
    });

    publishMany(yardId, [
      { channel: "materials", action: "deleted", entity: "Material", entityId: materialId, actorId: guard.user.id },
      { channel: "stock", action: "updated", entity: "Sku", actorId: guard.user.id },
    ]);
    return ok({ id, deleted: true });
  }

  await prisma.material.update({ where: { id: bucket.materialId }, data: { active: false } });

  publishMany(yardId, [
    { channel: "materials", action: "updated", entity: "Material", entityId: bucket.materialId, actorId: guard.user.id },
  ]);
  return ok({ id, active: false, hasStock, hadHistory });
}

const patchSchema = z.object({ active: z.boolean() });

/** Restore (reactivate) a material by its mixed-bucket SKU id. Owner only. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireYardCapability("material.write");
  if ("res" in guard) return guard.res;
  const { prisma, yardId } = guard;

  const body = await parseBody(req, patchSchema);
  if ("res" in body) return body.res;

  const { id } = await ctx.params;
  const bucket = await prisma.sku.findUnique({ where: { id }, select: { materialId: true } });
  if (!bucket?.materialId) return fail("NOT_FOUND", "Material not found", 404);

  await prisma.material.update({ where: { id: bucket.materialId }, data: { active: body.data.active } });

  publishMany(yardId, [
    { channel: "materials", action: "updated", entity: "Material", entityId: bucket.materialId, actorId: guard.user.id },
  ]);
  return ok({ id, active: body.data.active });
}
