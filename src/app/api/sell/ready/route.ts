import { requireOwnerYard, ok } from "@/backend/http/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireOwnerYard();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  /**
   * One batch, not two sequential awaits.
   *
   * The receivables read depends on nothing in the SKU read, so running them in
   * series cost the Sell page an extra full round trip to Neon on every load for
   * no reason. Same two queries, same results, half the latency.
   */
  const [skus, receivables] = await Promise.all([
    prisma.sku.findMany({
      relationLoadStrategy: "join",
      where: { isMixedBucket: false },
      orderBy: { sortOrder: "asc" },
      include: { inventory: true },
    }),
    prisma.receivable.findMany({
      relationLoadStrategy: "join",
      where: { status: { in: ["PENDING", "PARTIAL"] } },
      orderBy: { createdAt: "desc" },
      include: { buyer: { select: { name: true } }, sale: { select: { invoiceNumber: true } } },
    }),
  ]);

  const ready = skus
    .filter((s) => (s.inventory?.quantityKg ?? 0) >= s.saleThresholdKg)
    .map((s) => ({
      skuId: s.id,
      name: s.name,
      icon: s.icon,
      quantityKg: s.inventory?.quantityKg ?? 0,
      thresholdKg: s.saleThresholdKg,
    }));

  return ok({
    ready,
    receivables: receivables.map((r) => ({
      id: r.id,
      buyerName: r.buyer.name,
      invoiceNumber: r.sale.invoiceNumber,
      amount: r.amount,
    })),
  });
}
