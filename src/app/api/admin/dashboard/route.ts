import { requireAdmin, ok } from "@/backend/http/api";
import { ocrStatus } from "@/backend/ocr/ocr-supervisor";
import { inLiveYards, andLiveYards, liveYardUsers } from "@/backend/services/active-yards";

export const dynamic = "force-dynamic";

/**
 * The platform dashboard's data, in one round trip.
 *
 * Complements /api/admin/overview (which stays as-is, and remains the source for
 * the per-yard league table) by adding the summary sections, alerts and pending
 * actions the dashboard needs.
 *
 * ── Scaling contract ─────────────────────────────────────────────────────────
 * Every figure is a grouped aggregate or a bounded `take`, never a per-yard
 * loop, so the query count is CONSTANT as the platform grows from one yard to
 * thousands. The heavy paths are covered by the existing yard-leading composite
 * indexes: (yardId, createdAt) on Sale/InwardLoad/InventoryTransaction,
 * (yardId, status) on InwardLoad/SegregationRun/Receivable, (yardId, active) on
 * Vendor/Material, (yardId, skuId) on InventoryLot.
 *
 * Anything unbounded is deliberately excluded — this endpoint must stay O(1) in
 * round trips and bounded in rows returned.
 */

/** Rows returned per "recent activity" list. Bounded on purpose. */
const RECENT_LIMIT = 8;
/** A yard with no activity for this long is worth flagging. */
const STALE_DAYS = 7;

/**
 * Time-window rollups, one scan per table instead of one per window.
 *
 * Profiling this route showed the cost was not round trips — 36 trivial queries
 * in parallel take ~200 ms — but the database work itself: the same three tables
 * were being scanned six times each, once per time window, and the concurrent
 * scans contend on the same compute. `COUNT(*) FILTER (WHERE …)` collapses each
 * table to a single pass, which is where the real saving is.
 *
 * Raw SQL rather than Prisma aggregates because Prisma cannot express conditional
 * aggregates. Read-only, unparameterised except for the window boundaries, and
 * platform-wide by design — this endpoint is admin-only, so there is no tenant
 * predicate to preserve.
 */
type WindowRollup = {
  today_count: bigint;
  d7_count: bigint;
  month_count: bigint;
  all_count: bigint;
  /**
   * Kilograms. **bigint, not number** — `totalKg`/`quantityKg` are INTEGER
   * columns and Postgres widens `SUM(integer)` to bigint. Typing these as
   * `number` compiled fine and then failed at runtime with "Do not know how to
   * serialize a BigInt", because the value reached `JSON.stringify` untouched.
   * Every read goes through `num()`.
   */
  today_kg: bigint | null;
  d7_kg: bigint | null;
  month_kg: bigint | null;
  all_kg: bigint | null;
  /** Sale value only — `total` is DOUBLE PRECISION, so these really are numbers. */
  today_value: number | null;
  d7_value: number | null;
  all_value: number | null;
};

/** COUNT returns bigint over the wire; every consumer here wants a number. */
const num = (v: bigint | number | null | undefined) => Number(v ?? 0);

export async function GET() {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start7 = new Date(now.getTime() - 7 * 86_400_000);
  const start30 = new Date(now.getTime() - 30 * 86_400_000);
  /** Calendar month, not a rolling 30 days — "this month" means the month. */
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const staleBefore = new Date(now.getTime() - STALE_DAYS * 86_400_000);

  /**
   * Every figure below is scoped to yards that are still operating.
   *
   * A decommissioned yard stops contributing to stock, sales, receivables, vendor
   * and material totals while keeping all of its rows in the database. The yard
   * table further down deliberately still lists inactive yards — it is a register,
   * not a metric.
   */
  const activeYards = inLiveYards;
  const activeSql = andLiveYards();
  const activeYardUsers = liveYardUsers;

  const [
    // ---- yards + users ----
    yards,
    userGroups,
    pendingPasswordResets,
    // ---- stock ----
    stockByYard,
    skuStock,
    mixedStock,
    lotRemainders,
    // ---- vendors + materials ----
    vendorGroups,
    topVendors,
    materialGroups,
    materialVolume,
    // ---- inward / sort ----
    pendingByYard,
    oldestPending,
    inwardWindows,
    sortRuns7,
    // ---- sell ----
    saleWindows,
    sales30,
    receivableGroups,
    topBuyers,
    // ---- activity ----
    recentSales,
    recentLoads,
    recentAudit,
    openImpersonations,
    lastSaleByYard,
    perYardUsers,
    // ---- outward / dispatch ----
    dispatchStatusGroups,
    dispatchByYard,
    dispatchWindows,
    recentDispatches,
  ] = await Promise.all([
    prisma.yard.findMany({
      orderBy: { yardCode: "asc" },
      select: {
        id: true,
        yardCode: true,
        yardName: true,
        city: true,
        state: true,
        active: true,
        createdAt: true,
        deactivatedAt: true,
      },
    }),
    prisma.user.groupBy({ by: ["role", "active"], where: activeYardUsers, _count: { _all: true } }),
    prisma.user.count({ where: { mustChangePassword: true, active: true, ...activeYardUsers } }),

    prisma.inventory.groupBy({ by: ["yardId"], where: activeYards, _sum: { quantityKg: true } }),
    // Per-SKU stock across the platform, so the dashboard can show which
    // materials dominate without a per-yard fan-out.
    prisma.inventory.findMany({
      relationLoadStrategy: "join",
      where: { quantityKg: { gt: 0 }, ...activeYards },
      select: {
        quantityKg: true,
        yardId: true,
        sku: { select: { name: true, code: true, icon: true, isMixedBucket: true, saleThresholdKg: true } },
      },
    }),
    prisma.sku.count({ where: { isMixedBucket: true, ...activeYards } }),
    prisma.inventoryLot.aggregate({ where: activeYards, _sum: { remainingKg: true }, _count: { _all: true } }),

    prisma.vendor.groupBy({ by: ["active"], where: activeYards, _count: { _all: true } }),
    prisma.inwardLoad.groupBy({
      by: ["vendorId"],
      where: { createdAt: { gte: start30 }, vendorId: { not: null }, ...activeYards },
      _sum: { totalKg: true },
      _count: { _all: true },
      orderBy: { _sum: { totalKg: "desc" } },
      take: 6,
    }),
    prisma.material.groupBy({ by: ["active"], where: activeYards, _count: { _all: true } }),
    prisma.inwardLoad.groupBy({
      by: ["materialLabel"],
      where: { createdAt: { gte: start30 }, ...activeYards },
      _sum: { totalKg: true },
      _count: { _all: true },
      orderBy: { _sum: { totalKg: "desc" } },
      take: 8,
    }),

    prisma.inwardLoad.groupBy({ by: ["yardId"], where: { status: "RECEIVED", ...activeYards }, _count: { _all: true }, _sum: { totalKg: true } }),
    prisma.inwardLoad.findFirst({
      relationLoadStrategy: "join",
      where: { status: "RECEIVED", ...activeYards },
      orderBy: { createdAt: "asc" },
      select: { id: true, lotNumber: true, createdAt: true, totalKg: true, yard: { select: { id: true, yardCode: true, yardName: true } } },
    }),
    // Today + last 7 days in ONE pass over InwardLoad, instead of one aggregate
    // per window.
    prisma.$queryRaw<WindowRollup[]>`
      SELECT
        COUNT(*) FILTER (WHERE "createdAt" >= ${startOfToday})       AS today_count,
        COALESCE(SUM("totalKg") FILTER (WHERE "createdAt" >= ${startOfToday}), 0) AS today_kg,
        COUNT(*) FILTER (WHERE "createdAt" >= ${start7})             AS d7_count,
        COALESCE(SUM("totalKg") FILTER (WHERE "createdAt" >= ${start7}), 0)       AS d7_kg,
        0::bigint AS month_count, 0::bigint AS month_kg,
        COUNT(*) AS all_count, COALESCE(SUM("totalKg"), 0) AS all_kg,
        NULL::float8 AS today_value, NULL::float8 AS d7_value, NULL::float8 AS all_value
      FROM "InwardLoad" WHERE true ${activeSql}`,
    prisma.segregationRun.aggregate({ where: { createdAt: { gte: start7 }, ...activeYards }, _count: { _all: true }, _sum: { totalKg: true, wastageKg: true } }),

    // Lifetime + today + last 7 days in ONE pass over Sale.
    prisma.$queryRaw<WindowRollup[]>`
      SELECT
        COUNT(*) FILTER (WHERE "createdAt" >= ${startOfToday})       AS today_count,
        COALESCE(SUM("quantityKg") FILTER (WHERE "createdAt" >= ${startOfToday}), 0) AS today_kg,
        COUNT(*) FILTER (WHERE "createdAt" >= ${start7})             AS d7_count,
        COALESCE(SUM("quantityKg") FILTER (WHERE "createdAt" >= ${start7}), 0)       AS d7_kg,
        0::bigint AS month_count, 0::bigint AS month_kg,
        COUNT(*) AS all_count, COALESCE(SUM("quantityKg"), 0) AS all_kg,
        COALESCE(SUM("total") FILTER (WHERE "createdAt" >= ${startOfToday}), 0) AS today_value,
        COALESCE(SUM("total") FILTER (WHERE "createdAt" >= ${start7}), 0)       AS d7_value,
        COALESCE(SUM("total"), 0) AS all_value
      FROM "Sale" WHERE true ${activeSql}`,
    prisma.sale.groupBy({
      by: ["yardId"],
      where: { createdAt: { gte: start30 }, ...activeYards },
      _count: { _all: true },
      _sum: { total: true, quantityKg: true },
    }),
    prisma.receivable.groupBy({ by: ["status"], where: activeYards, _count: { _all: true }, _sum: { amount: true } }),
    prisma.sale.groupBy({
      by: ["buyerId"],
      where: { createdAt: { gte: start30 }, ...activeYards },
      _sum: { total: true },
      _count: { _all: true },
      orderBy: { _sum: { total: "desc" } },
      take: 6,
    }),

    prisma.sale.findMany({
      relationLoadStrategy: "join",
      where: activeYards,
      orderBy: { createdAt: "desc" },
      take: RECENT_LIMIT,
      select: {
        id: true,
        invoiceNumber: true,
        total: true,
        quantityKg: true,
        createdAt: true,
        yard: { select: { id: true, yardCode: true } },
        buyer: { select: { name: true } },
        sku: { select: { name: true, icon: true } },
      },
    }),
    prisma.inwardLoad.findMany({
      relationLoadStrategy: "join",
      where: activeYards,
      orderBy: { createdAt: "desc" },
      take: RECENT_LIMIT,
      select: {
        id: true,
        lotNumber: true,
        materialLabel: true,
        totalKg: true,
        status: true,
        createdAt: true,
        yard: { select: { id: true, yardCode: true } },
        vendor: { select: { name: true } },
      },
    }),
    prisma.auditLog.findMany({
      relationLoadStrategy: "join",
      orderBy: { createdAt: "desc" },
      take: RECENT_LIMIT,
      select: {
        id: true,
        action: true,
        entity: true,
        createdAt: true,
        actor: { select: { name: true } },
        yard: { select: { id: true, yardCode: true } },
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
    // Latest sale per yard — drives the "quiet yard" alert.
    prisma.sale.groupBy({ by: ["yardId"], where: activeYards, _max: { createdAt: true } }),
    // Owners/managers per yard — drives the "no owner" alert. Depends on nothing
    // else in this route, so it belongs in the batch: run serially it added a
    // whole extra round trip (~85 ms) to every dashboard load for no reason.
    prisma.user.groupBy({
      by: ["yardId", "role"],
      where: { active: true, ...inLiveYards },
      _count: { _all: true },
    }),
    // ---- outward / dispatch ----
    // Grouped aggregates only, matching the rest of this route: no per-yard
    // fan-out, so adding dispatch KPIs costs a fixed number of round trips.
    prisma.sale.groupBy({
      by: ["dispatchStatus"],
      where: activeYards,
      _count: { _all: true },
      _sum: { quantityKg: true, dispatchedKg: true },
    }),
    prisma.outwardLoad.groupBy({ by: ["yardId"], where: activeYards, _count: { _all: true }, _sum: { totalKg: true } }),
    // Today + week + calendar month + lifetime in ONE pass over OutwardLoad,
    // replacing four separate aggregates over the same rows.
    prisma.$queryRaw<WindowRollup[]>`
      SELECT
        COUNT(*) FILTER (WHERE "createdAt" >= ${startOfToday})       AS today_count,
        COALESCE(SUM("totalKg") FILTER (WHERE "createdAt" >= ${startOfToday}), 0) AS today_kg,
        COUNT(*) FILTER (WHERE "createdAt" >= ${start7})             AS d7_count,
        COALESCE(SUM("totalKg") FILTER (WHERE "createdAt" >= ${start7}), 0)       AS d7_kg,
        COUNT(*) FILTER (WHERE "createdAt" >= ${startOfMonth})       AS month_count,
        COALESCE(SUM("totalKg") FILTER (WHERE "createdAt" >= ${startOfMonth}), 0) AS month_kg,
        COUNT(*) AS all_count, COALESCE(SUM("totalKg"), 0) AS all_kg,
        NULL::float8 AS today_value, NULL::float8 AS d7_value, NULL::float8 AS all_value
      FROM "OutwardLoad" WHERE true ${activeSql}`,
    prisma.outwardLoad.findMany({
      relationLoadStrategy: "join",
      where: activeYards,
      orderBy: { createdAt: "desc" },
      take: RECENT_LIMIT,
      select: {
        id: true,
        yardId: true,
        dispatchNumber: true,
        vehicleNumber: true,
        driverName: true,
        totalKg: true,
        createdAt: true,
        dispatchedBy: { select: { name: true } },
        lines: { select: { quantityKg: true, sku: { select: { name: true } }, sale: { select: { invoiceNumber: true, buyer: { select: { name: true } } } } } },
      },
    }),
  ]);

  const n = (v: number | null | undefined) => v ?? 0;

  /**
   * The rollups come back as a single row each. Unpacked into the same shapes the
   * response builder already used, so nothing below this line changed.
   */
  const inward = inwardWindows[0];
  const sale = saleWindows[0];
  const dispatch = dispatchWindows[0];
  const inwardToday = { count: num(inward.today_count), kg: num(inward.today_kg) };
  const inward7 = { count: num(inward.d7_count), kg: num(inward.d7_kg) };
  const salesToday = { count: num(sale.today_count), kg: num(sale.today_kg), value: n(sale.today_value) };
  const sales7 = { count: num(sale.d7_count), kg: num(sale.d7_kg), value: n(sale.d7_value) };
  const salesAll = { count: num(sale.all_count), kg: num(sale.all_kg), value: n(sale.all_value) };
  const dispatchToday = { count: num(dispatch.today_count), kg: num(dispatch.today_kg) };
  const dispatchWeek = { count: num(dispatch.d7_count), kg: num(dispatch.d7_kg) };
  const dispatchMonth = { count: num(dispatch.month_count), kg: num(dispatch.month_kg) };
  const dispatchAll = { count: num(dispatch.all_count), kg: num(dispatch.all_kg) };
  /** Derived from `userGroups` rather than its own COUNT — one less table scan. */
  const inactiveUsers = userGroups
    .filter((g) => !g.active)
    .reduce((a, g) => a + g._count._all, 0);

  /* ---------------- resolve grouped ids to names (bounded lookups) ---------------- */
  const vendorIds = topVendors.map((v) => v.vendorId).filter((x): x is string => !!x);
  const buyerIds = topBuyers.map((b) => b.buyerId);
  const [vendorNames, buyerNames] = await Promise.all([
    vendorIds.length
      ? prisma.vendor.findMany({
          relationLoadStrategy: "join",
          where: { id: { in: vendorIds } },
          select: { id: true, name: true, active: true, yard: { select: { yardCode: true } } },
        })
      : Promise.resolve([]),
    buyerIds.length
      ? prisma.buyer.findMany({
          relationLoadStrategy: "join",
          where: { id: { in: buyerIds } },
          select: { id: true, name: true, yard: { select: { yardCode: true } } },
        })
      : Promise.resolve([]),
  ]);
  const vendorById = new Map(vendorNames.map((v) => [v.id, v]));
  const buyerById = new Map(buyerNames.map((b) => [b.id, b]));

  /* ---------------- users ---------------- */
  const roleCount = (role: string, active: boolean) =>
    userGroups.find((g) => g.role === role && g.active === active)?._count._all ?? 0;

  /* ---------------- stock ---------------- */
  const stockKg = stockByYard.reduce((a, s) => a + n(s._sum.quantityKg), 0);
  const finished = skuStock.filter((s) => !s.sku.isMixedBucket);
  const mixed = skuStock.filter((s) => s.sku.isMixedBucket);
  const finishedKg = finished.reduce((a, s) => a + s.quantityKg, 0);
  const unsortedKg = mixed.reduce((a, s) => a + s.quantityKg, 0);
  const readyToSell = finished.filter((s) => s.quantityKg >= s.sku.saleThresholdKg);

  // Platform-wide stock by SKU name (a SKU name repeats across yards).
  const byName = new Map<string, { name: string; icon: string; kg: number; yards: number }>();
  for (const s of skuStock) {
    const e = byName.get(s.sku.name) ?? { name: s.sku.name, icon: s.sku.icon, kg: 0, yards: 0 };
    e.kg += s.quantityKg;
    e.yards += 1;
    byName.set(s.sku.name, e);
  }
  const topSkus = [...byName.values()].sort((a, b) => b.kg - a.kg).slice(0, 8);

  /* ---------------- receivables ---------------- */
  const recvOutstanding = receivableGroups
    .filter((r) => r.status !== "PAID")
    .reduce((a, r) => a + n(r._sum.amount), 0);
  const recvOutstandingCount = receivableGroups
    .filter((r) => r.status !== "PAID")
    .reduce((a, r) => a + r._count._all, 0);
  const recvPaid = receivableGroups.find((r) => r.status === "PAID");

  /* ---------------- alerts + pending actions ---------------- */
  type Alert = { id: string; tone: "warn" | "bad" | "good" | "muted"; icon: string; title: string; detail: string; href?: string };
  const alerts: Alert[] = [];
  const pending: Alert[] = [];

  const inactiveYards = yards.filter((y) => !y.active);
  if (inactiveYards.length) {
    /**
     * Deactivating a yard is a decision, not a fault, so this is informational.
     * It used to be tone `bad`, which read as an incident every time a yard was
     * deliberately archived.
     */
    alerts.push({
      id: "yards-inactive",
      tone: "muted",
      icon: "🗄️",
      title: `${inactiveYards.length} yard${inactiveYards.length === 1 ? "" : "s"} archived`,
      detail:
        inactiveYards.map((y) => y.yardCode).join(", ") +
        " — users cannot sign in and they are excluded from every platform total. Data is intact.",
      href: "/admin/yards",
    });
  }

  // A yard with no owner cannot sell; a yard with no users cannot operate.
  const usersByYard = new Map<string, { owners: number; managers: number }>();
  for (const y of yards) usersByYard.set(y.id, { owners: 0, managers: 0 });
  for (const g of perYardUsers) {
    if (!g.yardId) continue;
    const e = usersByYard.get(g.yardId);
    if (!e) continue;
    if (g.role === "OWNER") e.owners = g._count._all;
    if (g.role === "MANAGER") e.managers = g._count._all;
  }
  const ownerless = yards.filter((y) => y.active && (usersByYard.get(y.id)?.owners ?? 0) === 0);
  if (ownerless.length) {
    alerts.push({
      id: "yards-ownerless",
      tone: "bad",
      icon: "⚠️",
      title: `${ownerless.length} active yard${ownerless.length === 1 ? "" : "s"} without an owner`,
      detail: ownerless.map((y) => y.yardCode).join(", ") + " — nobody can raise a sale there.",
      href: "/admin/users",
    });
  }

  if (openImpersonations.length) {
    alerts.push({
      id: "admin-inside",
      tone: "warn",
      icon: "👁️",
      title: `${openImpersonations.length} admin session${openImpersonations.length === 1 ? "" : "s"} open inside a yard`,
      detail: openImpersonations.map((i) => `${i.admin.name} → ${i.yard.yardCode}`).join(", "),
      href: "/admin/audit",
    });
  }

  // Quiet yards: active, but nothing sold for a week.
  const lastSale = new Map(lastSaleByYard.map((g) => [g.yardId, g._max.createdAt]));
  const quiet = yards.filter((y) => {
    if (!y.active) return false;
    if (y.createdAt > staleBefore) return false; // brand new, not "quiet"
    const ls = lastSale.get(y.id);
    return !ls || ls < staleBefore;
  });
  if (quiet.length) {
    alerts.push({
      id: "yards-quiet",
      tone: "warn",
      icon: "💤",
      title: `${quiet.length} yard${quiet.length === 1 ? "" : "s"} with no sales in ${STALE_DAYS} days`,
      detail: quiet.map((y) => y.yardCode).join(", "),
      href: "/admin/yards",
    });
  }

  // "Nothing needs attention" is about warnings and faults; an archived-yard
  // note is a statement of fact and must not suppress the all-clear.
  if (!alerts.some((a) => a.tone === "warn" || a.tone === "bad")) {
    alerts.push({
      id: "all-clear",
      tone: "good",
      icon: "✅",
      title: "No alerts",
      detail: "Every active yard has an owner, and no admin is inside a yard.",
    });
  }

  /* ---- pending actions: work waiting on somebody ---- */
  const pendingLoadTotal = pendingByYard.reduce((a, p) => a + p._count._all, 0);
  if (pendingLoadTotal > 0) {
    pending.push({
      id: "pending-sort",
      tone: "warn",
      icon: "🧲",
      title: `${pendingLoadTotal} lot${pendingLoadTotal === 1 ? "" : "s"} awaiting segregation`,
      detail: `${n(pendingByYard.reduce((a, p) => a + n(p._sum.totalKg), 0)).toLocaleString("en-IN")} kg unsorted across ${pendingByYard.length} yard${pendingByYard.length === 1 ? "" : "s"}${oldestPending ? ` · oldest ${oldestPending.lotNumber} in ${oldestPending.yard.yardCode}` : ""}`,
      href: oldestPending ? `/admin/yards/${oldestPending.yard.id}` : "/admin/yards",
    });
  }
  if (readyToSell.length > 0) {
    pending.push({
      id: "ready-to-sell",
      tone: "good",
      icon: "🔔",
      title: `${readyToSell.length} SKU${readyToSell.length === 1 ? "" : "s"} ready to sell`,
      detail: `${readyToSell.reduce((a, s) => a + s.quantityKg, 0).toLocaleString("en-IN")} kg at or above the sale threshold`,
    });
  }
  if (recvOutstandingCount > 0) {
    pending.push({
      id: "receivables",
      tone: "bad",
      icon: "💰",
      title: `${recvOutstandingCount} unpaid invoice${recvOutstandingCount === 1 ? "" : "s"}`,
      detail: `₹${Math.round(recvOutstanding).toLocaleString("en-IN")} outstanding across the platform`,
    });
  }
  if (pendingPasswordResets > 0) {
    pending.push({
      id: "password-resets",
      tone: "warn",
      icon: "🔑",
      title: `${pendingPasswordResets} user${pendingPasswordResets === 1 ? "" : "s"} must change their password`,
      detail: "An admin reset it; they cannot use the app until they set a new one.",
      href: "/admin/users",
    });
  }
  if (pending.length === 0) {
    pending.push({
      id: "nothing-pending",
      tone: "good",
      icon: "🎯",
      title: "Nothing pending",
      detail: "No unsorted lots, no unpaid invoices, no forced password changes.",
    });
  }

  /** Count sales in a dispatch state. `null` is a pre-Outward (legacy) sale. */
  const dispatchCount = (status: string | null) =>
    dispatchStatusGroups.find((g) => g.dispatchStatus === status)?._count._all ?? 0;

  /**
   * Kilograms allocated but not yet loaded. Legacy sales are excluded: their
   * stock left the yard at sale time, so they are not awaiting anything.
   */
  const awaitingKg = dispatchStatusGroups
    .filter((g) => g.dispatchStatus === "PENDING" || g.dispatchStatus === "PARTIAL")
    .reduce((total, g) => total + (n(g._sum.quantityKg) - n(g._sum.dispatchedKg)), 0);

  /**
   * Index every per-yard aggregate once.
   *
   * These were `array.find()` inside `yards.map()`, i.e. O(yards × groups) with a
   * fresh scan per field. Correct, and invisible at three yards — but this route's
   * stated contract is that it stays flat as the platform grows to thousands of
   * yards, and a nested scan is the one thing in it that did not.
   */
  const dispatchByYardMap = new Map(dispatchByYard.map((d) => [d.yardId, d]));
  const yardById = new Map(yards.map((y) => [y.id, y]));
  const sales30ByYard = new Map(sales30.map((s) => [s.yardId, s]));
  const pendingByYardMap = new Map(pendingByYard.map((p) => [p.yardId, p]));
  const stockByYardMap = new Map(stockByYard.map((s) => [s.yardId, s]));
  const impersonatedYardIds = new Set(openImpersonations.map((i) => i.yard.id));

  return ok({
    generatedAt: now.toISOString(),
    kpis: {
      yardsActive: yards.filter((y) => y.active).length,
      yardsInactive: inactiveYards.length,
      yardsTotal: yards.length,
      usersTotal: roleCount("OWNER", true) + roleCount("MANAGER", true),
      owners: roleCount("OWNER", true),
      managers: roleCount("MANAGER", true),
      admins: roleCount("ADMIN", true),
      usersInactive: inactiveUsers,
      stockKg,
      finishedKg,
      unsortedKg,
      pendingLoads: pendingLoadTotal,
      // ---- dispatch (Phase 4 Outward) ----
      // A sale is an allocation: PENDING means nothing has left the yard yet,
      // PARTIAL means some has. Legacy sales carry a null status and are
      // counted as completed, matching how they render everywhere else.
      dispatchesTotal: dispatchAll.count,
      dispatchesPending: dispatchCount("PENDING"),
      dispatchesPartial: dispatchCount("PARTIAL"),
      dispatchesCompleted: dispatchCount("COMPLETED") + dispatchCount(null),
      dispatchKgToday: dispatchToday.kg,
      dispatchKgWeek: dispatchWeek.kg,
      dispatchKgMonth: dispatchMonth.kg,
      dispatchKgLifetime: dispatchAll.kg,
      dispatchCountToday: dispatchToday.count,
      dispatchCountWeek: dispatchWeek.count,
      dispatchCountMonth: dispatchMonth.count,
      /** Allocated kilograms still sitting in the yard, awaiting a vehicle. */
      awaitingDispatchKg: awaitingKg,
      readyToSellCount: readyToSell.length,
      salesTodayValue: salesToday.value,
      salesTodayCount: salesToday.count,
      sales7Value: sales7.value,
      sales7Count: sales7.count,
      salesLifetimeValue: salesAll.value,
      salesLifetimeCount: salesAll.count,
      salesLifetimeKg: salesAll.kg,
      outstanding: recvOutstanding,
      outstandingCount: recvOutstandingCount,
      collected: n(recvPaid?._sum.amount),
      collectedCount: recvPaid?._count._all ?? 0,
      inwardTodayCount: inwardToday.count,
      inwardTodayKg: inwardToday.kg,
      inward7Count: inward7.count,
      inward7Kg: inward7.kg,
      adminsInsideYards: openImpersonations.length,
    },

    /** Yard overview — active/inactive plus 30-day trade, no per-yard queries. */
    yardSummary: yards.map((y) => {
      const s = sales30ByYard.get(y.id);
      const p = pendingByYardMap.get(y.id);
      const u = usersByYard.get(y.id) ?? { owners: 0, managers: 0 };
      return {
        id: y.id,
        yardCode: y.yardCode,
        yardName: y.yardName,
        city: y.city,
        state: y.state,
        active: y.active,
        owners: u.owners,
        managers: u.managers,
        stockKg: n(stockByYardMap.get(y.id)?._sum.quantityKg),
        pendingLoads: p?._count._all ?? 0,
        dispatches: dispatchByYardMap.get(y.id)?._count._all ?? 0,
        dispatchKg: n(dispatchByYardMap.get(y.id)?._sum.totalKg),
        pendingKg: n(p?._sum.totalKg),
        sales30Count: s?._count._all ?? 0,
        sales30Value: n(s?._sum.total),
        lastSaleAt: lastSale.get(y.id)?.toISOString() ?? null,
        adminInside: impersonatedYardIds.has(y.id),
      };
    }),

    /**
     * Dispatch overview — the Outward half of the business flow.
     *
     * A sale allocates stock; a dispatch is what physically removes it. These
     * two numbers therefore answer different questions: `awaitingKg` is what the
     * yard still owes its buyers, `kg.month` is what actually left.
     */
    dispatchSummary: {
      total: dispatchAll.count,
      pending: dispatchCount("PENDING"),
      partial: dispatchCount("PARTIAL"),
      completed: dispatchCount("COMPLETED") + dispatchCount(null),
      awaitingKg,
      kg: {
        today: dispatchToday.kg,
        week: dispatchWeek.kg,
        month: dispatchMonth.kg,
        lifetime: dispatchAll.kg,
      },
      count: {
        today: dispatchToday.count,
        week: dispatchWeek.count,
        month: dispatchMonth.count,
      },
      /** Status distribution, ready for the existing pie/donut primitives. */
      statusDistribution: [
        { label: "Pending", value: dispatchCount("PENDING") },
        { label: "Partial", value: dispatchCount("PARTIAL") },
        { label: "Completed", value: dispatchCount("COMPLETED") + dispatchCount(null) },
      ],
      byYard: dispatchByYard
        .map((d) => ({
          yardId: d.yardId,
          yardCode: yardById.get(d.yardId)?.yardCode ?? "—",
          yardName: yardById.get(d.yardId)?.yardName ?? "—",
          dispatches: d._count._all,
          kg: n(d._sum.totalKg),
        }))
        .sort((a, b) => b.kg - a.kg),
    },

    /**
     * OCR sidecar health. Not a query — the supervisor's cached view, so it costs
     * nothing and arrives with the dashboard rather than needing its own request.
     */
    ocr: ocrStatus(),

    /** Recent dispatches, for the activity feed. Read-only. */
    recentDispatches: recentDispatches.map((d) => ({
      id: d.id,
      yardCode: yardById.get(d.yardId)?.yardCode ?? "—",
      dispatchNumber: d.dispatchNumber,
      vehicleNumber: d.vehicleNumber,
      driverName: d.driverName,
      totalKg: d.totalKg,
      dispatchedBy: d.dispatchedBy?.name ?? null,
      at: d.createdAt.toISOString(),
      // One vehicle can satisfy several invoices, so this is a list.
      materials: d.lines.map((l) => ({
        name: l.sku.name,
        kg: l.quantityKg,
        // Null since the Supervisor dispatch workflow: that flow loads a
        // vehicle directly rather than against a buyer's allocation.
        invoiceNumber: l.sale?.invoiceNumber ?? null,
        buyerName: l.sale?.buyer.name ?? null,
      })),
    })),

    /** Stock overview — what the platform is holding, and in what form. */
    stockSummary: {
      totalKg: stockKg,
      finishedKg,
      unsortedKg,
      mixedBuckets: mixedStock,
      batches: lotRemainders._count._all,
      batchRemainingKg: n(lotRemainders._sum.remainingKg),
      readyToSell: readyToSell
        .sort((a, b) => b.quantityKg - a.quantityKg)
        .slice(0, 8)
        .map((s) => ({ name: s.sku.name, icon: s.sku.icon, kg: s.quantityKg, thresholdKg: s.sku.saleThresholdKg })),
      topSkus,
    },

    /** Vendor overview — who is supplying, and how much. */
    vendorSummary: {
      active: vendorGroups.find((g) => g.active)?._count._all ?? 0,
      inactive: vendorGroups.find((g) => !g.active)?._count._all ?? 0,
      top: topVendors.map((v) => {
        const meta = v.vendorId ? vendorById.get(v.vendorId) : undefined;
        return {
          id: v.vendorId,
          name: meta?.name ?? "Unknown vendor",
          yardCode: meta?.yard.yardCode ?? null,
          active: meta?.active ?? true,
          kg: n(v._sum.totalKg),
          loads: v._count._all,
        };
      }),
    },

    /** Material overview — what is coming in, by material. */
    materialSummary: {
      active: materialGroups.find((g) => g.active)?._count._all ?? 0,
      inactive: materialGroups.find((g) => !g.active)?._count._all ?? 0,
      byVolume: materialVolume.map((m) => ({
        label: m.materialLabel,
        kg: n(m._sum.totalKg),
        loads: m._count._all,
      })),
    },

    /** Sell overview — trade and collection health. */
    sellSummary: {
      today: { count: salesToday.count, value: salesToday.value, kg: salesToday.kg },
      last7: { count: sales7.count, value: sales7.value, kg: sales7.kg },
      lifetime: { count: salesAll.count, value: salesAll.value, kg: salesAll.kg },
      receivables: receivableGroups.map((r) => ({ status: r.status, count: r._count._all, amount: n(r._sum.amount) })),
      topBuyers: topBuyers.map((b) => {
        const meta = buyerById.get(b.buyerId);
        return {
          id: b.buyerId,
          name: meta?.name ?? "Unknown buyer",
          yardCode: meta?.yard.yardCode ?? null,
          value: n(b._sum.total),
          invoices: b._count._all,
        };
      }),
    },

    /** Operations overview — inward/sort throughput. */
    opsSummary: {
      inwardToday: { count: inwardToday.count, kg: inwardToday.kg },
      inward7: { count: inward7.count, kg: inward7.kg },
      sort7: {
        runs: sortRuns7._count._all,
        kg: n(sortRuns7._sum.totalKg),
        wastageKg: n(sortRuns7._sum.wastageKg),
      },
      pendingByYard: pendingByYard.map((p) => ({
        yardId: p.yardId,
        yardCode: yardById.get(p.yardId)?.yardCode ?? "?",
        loads: p._count._all,
        kg: n(p._sum.totalKg),
      })),
      oldestPending: oldestPending
        ? {
            id: oldestPending.id,
            lotNumber: oldestPending.lotNumber,
            totalKg: oldestPending.totalKg,
            createdAt: oldestPending.createdAt.toISOString(),
            yardId: oldestPending.yard.id,
            yardCode: oldestPending.yard.yardCode,
          }
        : null,
    },

    alerts,
    pendingActions: pending,

    recentActivity: {
      sales: recentSales.map((s) => ({
        id: s.id,
        invoiceNumber: s.invoiceNumber,
        total: s.total,
        quantityKg: s.quantityKg,
        createdAt: s.createdAt.toISOString(),
        yardId: s.yard.id,
        yardCode: s.yard.yardCode,
        buyerName: s.buyer.name,
        skuName: s.sku.name,
        skuIcon: s.sku.icon,
      })),
      loads: recentLoads.map((l) => ({
        id: l.id,
        lotNumber: l.lotNumber,
        materialLabel: l.materialLabel,
        totalKg: l.totalKg,
        status: l.status,
        createdAt: l.createdAt.toISOString(),
        yardId: l.yard.id,
        yardCode: l.yard.yardCode,
        vendorName: l.vendor?.name ?? "Walk-in",
      })),
      audit: recentAudit.map((a) => ({
        id: a.id,
        action: a.action,
        entity: a.entity,
        createdAt: a.createdAt.toISOString(),
        actorName: a.actor?.name ?? "system",
        yardId: a.yard?.id ?? null,
        yardCode: a.yard?.yardCode ?? null,
      })),
    },

    activeImpersonations: openImpersonations.map((i) => ({
      id: i.id,
      adminName: i.admin.name,
      adminEmail: i.admin.email,
      yardId: i.yard.id,
      yardCode: i.yard.yardCode,
      yardName: i.yard.yardName,
      startedAt: i.startedAt.toISOString(),
    })),
  });
}
