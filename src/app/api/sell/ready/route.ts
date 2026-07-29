import { requireOwnerYard, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireOwnerYard();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  const skus = await prisma.sku.findMany({
    where: { isMixedBucket: false },
    orderBy: { sortOrder: "asc" },
    include: { inventory: true },
  });

  const ready = skus
    .filter((s) => (s.inventory?.quantityKg ?? 0) >= s.saleThresholdKg)
    .map((s) => ({
      skuId: s.id,
      name: s.name,
      icon: s.icon,
      quantityKg: s.inventory?.quantityKg ?? 0,
      thresholdKg: s.saleThresholdKg,
    }));

  const receivables = await prisma.receivable.findMany({
    where: { status: { in: ["PENDING", "PARTIAL"] } },
    orderBy: { createdAt: "desc" },
    include: { buyer: { select: { name: true } }, sale: { select: { invoiceNumber: true } } },
  });

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
