import { requireYard, ok } from "@/backend/http/api";
import { dispatchStatusFor, remainingKg } from "@/backend/services/allocation";

export const dynamic = "force-dynamic";

/**
 * The Manager's outward queue: sale allocations still waiting to be loaded.
 *
 * A sale reserves stock rather than removing it, so everything here is material
 * the yard has physically got but has already promised to a buyer. Legacy sales
 * (`dispatchedKg === null`) were deducted at sale time and are excluded — they
 * have nothing left to load.
 */
export async function GET() {
  const guard = await requireYard();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  const sales = await prisma.sale.findMany({
    // Sale → buyer, and Sale → sku → inventory: three relation levels, which
    // cost three serial round trips under Prisma's default strategy.
    relationLoadStrategy: "join",
    where: { dispatchedKg: { not: null } },
    orderBy: { createdAt: "asc" },
    include: {
      buyer: { select: { name: true } },
      sku: { select: { id: true, name: true, icon: true, inventory: { select: { quantityKg: true } } } },
    },
  });

  const allocations = sales.map((s) => ({
    saleId: s.id,
    invoiceNumber: s.invoiceNumber,
    buyerName: s.buyer.name,
    skuId: s.sku.id,
    skuName: s.sku.name,
    icon: s.sku.icon,
    allocatedKg: s.quantityKg,
    loadedKg: s.dispatchedKg ?? 0,
    // What the keypad is allowed to add. The UI caps on this and the server
    // re-checks it — an operator must not be able to over-dispatch by racing
    // two phones against the same allocation.
    balanceKg: remainingKg(s),
    // Physically on hand. Can be lower than the balance if stock was sorted or
    // adjusted after the sale, so the Manager sees the real constraint.
    physicalKg: s.sku.inventory?.quantityKg ?? 0,
    status: dispatchStatusFor(s),
    createdAt: s.createdAt,
  }));

  return ok({
    allocations,
    pending: allocations.filter((a) => a.status !== "COMPLETED"),
  });
}
