import { requireAdmin, ok } from "@/lib/api";
import { inLiveYards, liveYardUsers } from "@/lib/active-yards";

export const dynamic = "force-dynamic";

/**
 * Cross-yard platform KPIs.
 *
 * Every figure comes from a grouped aggregate, never a per-yard loop, so the
 * round-trip count is fixed regardless of how many yards exist. The heaviest
 * queries are index-covered by the yard-leading composite indexes
 * (yardId, createdAt) / (yardId, status) that already exist on the hot tables.
 */
export async function GET() {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const last30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Platform KPIs describe yards that are still operating. Archived yards keep
  // their rows and stay in the league table below, but stop being counted.
  const activeYardsOnly = inLiveYards;

  const [
    yardCounts,
    userCounts,
    stockByYard,
    salesAll,
    salesToday,
    sales30,
    pendingLoads,
    outstanding,
    yards,
    recentSales,
    recentLoads,
    openImpersonations,
    recentAudit,
  ] = await Promise.all([
    prisma.yard.groupBy({ by: ["active"], _count: { _all: true } }),
    prisma.user.groupBy({
      by: ["role"],
      where: { active: true, ...liveYardUsers },
      _count: { _all: true },
    }),
    prisma.inventory.groupBy({ by: ["yardId"], where: activeYardsOnly, _sum: { quantityKg: true } }),
    prisma.sale.aggregate({ where: activeYardsOnly, _count: { _all: true }, _sum: { total: true } }),
    prisma.sale.aggregate({ where: { createdAt: { gte: startOfToday }, ...activeYardsOnly }, _count: { _all: true }, _sum: { total: true } }),
    prisma.sale.groupBy({
      by: ["yardId"],
      where: { createdAt: { gte: last30 }, ...activeYardsOnly },
      _count: { _all: true },
      _sum: { total: true, quantityKg: true },
    }),
    prisma.inwardLoad.groupBy({ by: ["yardId"], where: { status: "RECEIVED", ...activeYardsOnly }, _count: { _all: true } }),
    prisma.receivable.aggregate({
      where: { status: { in: ["PENDING", "PARTIAL"] }, ...activeYardsOnly },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.yard.findMany({
      orderBy: { yardCode: "asc" },
      select: { id: true, yardCode: true, yardName: true, city: true, state: true, active: true },
    }),
    prisma.sale.findMany({
      relationLoadStrategy: "join",
      where: activeYardsOnly,
      orderBy: { createdAt: "desc" },
      take: 12,
      select: {
        id: true,
        invoiceNumber: true,
        total: true,
        quantityKg: true,
        createdAt: true,
        yard: { select: { yardCode: true, yardName: true } },
        buyer: { select: { name: true } },
        sku: { select: { name: true } },
      },
    }),
    prisma.inwardLoad.findMany({
      relationLoadStrategy: "join",
      where: activeYardsOnly,
      orderBy: { createdAt: "desc" },
      take: 12,
      select: {
        id: true,
        lotNumber: true,
        materialLabel: true,
        totalKg: true,
        status: true,
        createdAt: true,
        yard: { select: { yardCode: true, yardName: true } },
        vendor: { select: { name: true } },
      },
    }),
    prisma.impersonationSession.findMany({
      relationLoadStrategy: "join",
      where: { endedAt: null },
      select: {
        id: true,
        startedAt: true,
        admin: { select: { name: true, email: true } },
        yard: { select: { id: true, yardCode: true, yardName: true } },
      },
    }),
    prisma.auditLog.findMany({
      relationLoadStrategy: "join",
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        action: true,
        entity: true,
        createdAt: true,
        actor: { select: { name: true } },
        yard: { select: { yardCode: true } },
      },
    }),
  ]);

  const num = (v: number | null | undefined) => v ?? 0;
  const activeYards = yardCounts.find((y) => y.active)?._count._all ?? 0;
  const inactiveYards = yardCounts.find((y) => !y.active)?._count._all ?? 0;

  return ok({
    kpis: {
      yardsActive: activeYards,
      yardsInactive: inactiveYards,
      yardsTotal: activeYards + inactiveYards,
      owners: userCounts.find((u) => u.role === "OWNER")?._count._all ?? 0,
      managers: userCounts.find((u) => u.role === "MANAGER")?._count._all ?? 0,
      admins: userCounts.find((u) => u.role === "ADMIN")?._count._all ?? 0,
      stockKg: stockByYard.reduce((a, s) => a + num(s._sum.quantityKg), 0),
      salesCount: salesAll._count._all,
      salesValue: num(salesAll._sum.total),
      salesTodayCount: salesToday._count._all,
      salesTodayValue: num(salesToday._sum.total),
      pendingLoads: pendingLoads.reduce((a, p) => a + p._count._all, 0),
      outstanding: num(outstanding._sum.amount),
      outstandingCount: outstanding._count._all,
      adminsInsideYards: openImpersonations.length,
    },
    /** Per-yard league table, last 30 days. */
    yards: yards.map((y) => {
      const s = sales30.find((g) => g.yardId === y.id);
      return {
        ...y,
        stockKg: num(stockByYard.find((g) => g.yardId === y.id)?._sum.quantityKg),
        pendingLoads: pendingLoads.find((g) => g.yardId === y.id)?._count._all ?? 0,
        sales30Count: s?._count._all ?? 0,
        sales30Value: num(s?._sum.total),
        sales30Kg: num(s?._sum.quantityKg),
      };
    }),
    recentSales: recentSales.map((s) => ({
      id: s.id,
      invoiceNumber: s.invoiceNumber,
      total: s.total,
      quantityKg: s.quantityKg,
      createdAt: s.createdAt,
      yardCode: s.yard.yardCode,
      yardName: s.yard.yardName,
      buyerName: s.buyer.name,
      skuName: s.sku.name,
    })),
    recentLoads: recentLoads.map((l) => ({
      id: l.id,
      lotNumber: l.lotNumber,
      materialLabel: l.materialLabel,
      totalKg: l.totalKg,
      status: l.status,
      createdAt: l.createdAt,
      yardCode: l.yard.yardCode,
      yardName: l.yard.yardName,
      vendorName: l.vendor?.name ?? "Walk-in",
    })),
    activeImpersonations: openImpersonations.map((i) => ({
      id: i.id,
      adminName: i.admin.name,
      adminEmail: i.admin.email,
      yardId: i.yard.id,
      yardCode: i.yard.yardCode,
      yardName: i.yard.yardName,
      startedAt: i.startedAt.toISOString(),
    })),
    recentAudit: recentAudit.map((a) => ({
      id: a.id,
      action: a.action,
      entity: a.entity,
      createdAt: a.createdAt,
      actorName: a.actor?.name ?? "system",
      yardCode: a.yard?.yardCode ?? null,
    })),
  });
}
