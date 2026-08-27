import { requireYard, ok, fail } from "@/backend/http/api";

export const dynamic = "force-dynamic";

/**
 * Vendor-attributed drill-down for a SKU: which vendors/vehicles contributed the
 * current stock, how much was added, consumed, and remains. Powers the stock
 * traceability bottom sheet.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireYard();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  const { id } = await ctx.params;
  // Scoped findUnique returns null for another yard's SKU, so this 404s rather
  // than leaking the existence of a foreign record.
  const sku = await prisma.sku.findUnique({ where: { id }, include: { inventory: true } });
  if (!sku) return fail("NOT_FOUND", "SKU not found", 404);

  const lots = await prisma.inventoryLot.findMany({
    where: { skuId: id },
    orderBy: { createdAt: "asc" },
    include: { vendor: { select: { name: true } } },
  });

  const consumedLabel = sku.isMixedBucket ? "segregated" : "sold";

  const sources = lots.map((l) => ({
    vendorName: l.vendor?.name ?? "Opening balance",
    vehicleNumber: l.vehicleNumber ?? "—",
    addedKg: l.originalKg,
    remainingKg: l.remainingKg,
    consumedKg: l.originalKg - l.remainingKg,
    createdAt: l.createdAt,
  }));

  return ok({
    sku: { id: sku.id, name: sku.name, icon: sku.icon, quantityKg: sku.inventory?.quantityKg ?? 0, isMixedBucket: sku.isMixedBucket },
    consumedLabel,
    sources,
  });
}
