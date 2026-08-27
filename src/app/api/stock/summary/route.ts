import { requireYard, ok } from "@/backend/http/api";

export const dynamic = "force-dynamic";

/**
 * Yard KPI strip for the Owner's dashboard — the screen that now sits in front
 * of the stock hierarchy.
 *
 * Read-only and purely derivative: every figure is the SAME calculation the app
 * already performs somewhere else, just scoped to the acting yard.
 *
 *   stockKg / readyToSell → identical to /api/stock (`!isMixedBucket && qty >= threshold`)
 *   pendingLoads          → InwardLoad.status === "RECEIVED", as the admin dashboard counts it
 *   inwardToday / outwardToday → the admin dashboard's today window over the same tables
 *
 * It exists because the alternatives lie: /api/inward/recent is capped at 8 rows
 * so it cannot total a busy day, and nothing yard-scoped reports dispatches by
 * date at all. No table is written and no existing route changed.
 */
export async function GET() {
  const guard = await requireYard();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  // Server-local start of day — the same boundary the admin dashboard uses, so
  // the two never disagree about what "today" means.
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [skus, pendingLoads, inwardToday, outwardToday] = await Promise.all([
    prisma.sku.findMany({
      relationLoadStrategy: "join",
      select: { isMixedBucket: true, saleThresholdKg: true, visible: true, inventory: { select: { quantityKg: true } } },
    }),
    prisma.inwardLoad.count({ where: { status: "RECEIVED" } }),
    prisma.inwardLoad.aggregate({ where: { createdAt: { gte: startOfToday } }, _count: { _all: true }, _sum: { totalKg: true } }),
    prisma.outwardLoad.aggregate({ where: { createdAt: { gte: startOfToday } }, _count: { _all: true }, _sum: { totalKg: true } }),
  ]);

  let stockKg = 0;
  let readyToSell = 0;
  for (const s of skus) {
    const qty = s.inventory?.quantityKg ?? 0;
    stockKg += qty;
    if (!s.isMixedBucket && qty >= s.saleThresholdKg) readyToSell += 1;
  }

  return ok({
    stockKg,
    readyToSell,
    pendingLoads,
    inwardToday: { count: inwardToday._count._all, kg: inwardToday._sum.totalKg ?? 0 },
    outwardToday: { count: outwardToday._count._all, kg: outwardToday._sum.totalKg ?? 0 },
  });
}
