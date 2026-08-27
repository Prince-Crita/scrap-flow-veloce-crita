import { requireYard, ok } from "@/backend/http/api";
import { dispatchStatusFor, remainingKg } from "@/backend/services/allocation";

export const dynamic = "force-dynamic";

/**
 * Dispatch status for the Owner's Sell page — what has physically left the yard
 * against each invoice, and in which vehicles.
 *
 * Replaces the old static Report block. Read-only: the Owner sells and watches;
 * only the Manager's Outward workflow moves stock.
 */
export async function GET() {
  const guard = await requireYard();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  /**
   * `join` because this is the deepest read in the yard app: Sale → its outward
   * lines → each line's load → that load's images and dispatcher. Prisma's
   * default resolves one relation LEVEL per round trip, and levels cannot
   * overlap, so the Owner's Dispatch Status tab was paying five serial trips to
   * Neon for one screen. One LATERAL-joined statement returns the same rows.
   */
  const sales = await prisma.sale.findMany({
    relationLoadStrategy: "join",
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      buyer: { select: { name: true } },
      sku: { select: { name: true, icon: true } },
      outwardLoadLines: {
        orderBy: { createdAt: "asc" },
        include: {
          load: {
            include: {
              images: { select: { url: true } },
              dispatchedBy: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  const rows = sales.map((s) => {
    const status = dispatchStatusFor(s);
    return {
      saleId: s.id,
      invoiceNumber: s.invoiceNumber,
      buyerName: s.buyer.name,
      skuName: s.sku.name,
      icon: s.sku.icon,
      allocatedKg: s.quantityKg,
      // A legacy sale has no dispatch record; it left before tracking existed,
      // so it reads as fully dispatched rather than as a gap.
      dispatchedKg: s.dispatchedKg ?? s.quantityKg,
      remainingKg: remainingKg(s),
      status,
      legacy: s.dispatchedKg === null,
      total: s.total,
      createdAt: s.createdAt,
      /** Paperwork captured with the allocation, alongside the per-vehicle shots. */
      documents: {
        frontImageUrl: s.frontImageUrl,
        backImageUrl: s.backImageUrl,
        weighbridgeSlipUrl: s.weighbridgeSlipUrl,
        others: s.documentUrls,
      },
      vehicles: s.outwardLoadLines.map((l) => ({
        dispatchNumber: l.load.dispatchNumber,
        vehicleNumber: l.load.vehicleNumber,
        vehicleType: l.load.vehicleType,
        driverName: l.load.driverName,
        weightKg: l.quantityKg,
        frontImageUrl: l.load.frontImageUrl,
        backImageUrl: l.load.backImageUrl,
        materialImages: l.load.images.map((i) => i.url),
        dispatchedBy: l.load.dispatchedBy?.name ?? null,
        at: l.load.createdAt,
      })),
    };
  });

  return ok({
    sales: rows,
    totals: {
      pending: rows.filter((r) => r.status === "PENDING").length,
      partial: rows.filter((r) => r.status === "PARTIAL").length,
      completed: rows.filter((r) => r.status === "COMPLETED").length,
    },
  });
}
