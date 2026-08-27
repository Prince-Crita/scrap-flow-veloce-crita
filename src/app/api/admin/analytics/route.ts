import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAdmin, parseQuery, ok } from "@/backend/http/api";
import { inYardScope, andYardScope } from "@/backend/services/active-yards";

export const dynamic = "force-dynamic";

/**
 * Analytics datasets for the admin console.
 *
 * Shapes are chosen so Phase 2B can bind an inline-SVG chart to each one
 * directly — every series is a flat, sorted array of `{ label, value }`-ish
 * points with no post-processing required in the component.
 *
 * ── Why raw SQL for the trends ────────────────────────────────────────────────
 * Prisma's `groupBy` cannot group by a truncated date, and bucketing in JS would
 * mean fetching every row in the window — unbounded as the platform grows. A
 * `date_trunc` aggregate keeps the work in Postgres and returns at most one row
 * per day. Values are parameterised via Prisma.sql (no interpolation), and the
 * only user input is a day count validated to a small closed set.
 *
 * Days are bucketed in Asia/Kolkata so a sale booked at 11pm IST belongs to that
 * business day, not the next UTC one. This matches src/backend/services/streak.ts.
 */

const TZ = "Asia/Kolkata";

/** `YYYY-MM-DD`. Validated by shape AND by `Date.parse`, so "2026-13-45" is rejected. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "invalid date");

const querySchema = z.object({
  /**
   * Legacy rolling window. Kept so any existing caller (and the dashboard's
   * sparkline fetches) keeps working unchanged; the console now sends from/to.
   */
  days: z.enum(["7", "30", "90"]).optional().default("30"),
  /**
   * Explicit range, inclusive of both ends. Takes precedence over `days` when
   * both are present. Inclusive because a picker that says 1–31 March and then
   * silently excludes the 31st is a bug report waiting to happen.
   */
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Optional single-yard focus; omitted means the whole platform. */
  yardId: z.string().optional(),
});

/**
 * Resolve the window.
 *
 * Days are bucketed in Asia/Kolkata everywhere else in this route, so the
 * boundaries are built in that offset too — otherwise "1 March" would start at
 * 05:30 IST and a morning load would fall outside its own day.
 */
const IST_OFFSET_MS = 5.5 * 3_600_000;
function resolveWindow(from?: string, to?: string, days = 30) {
  if (from && to) {
    const since = new Date(Date.parse(`${from}T00:00:00Z`) - IST_OFFSET_MS);
    // Exclusive upper bound one millisecond into the next IST day, so the whole
    // of `to` is included without an off-by-one on the final row.
    const until = new Date(Date.parse(`${to}T00:00:00Z`) - IST_OFFSET_MS + 86_400_000);
    if (until > since) {
      return { since, until, days: Math.max(1, Math.round((until.getTime() - since.getTime()) / 86_400_000)) };
    }
  }
  return { since: new Date(Date.now() - days * 86_400_000), until: null as Date | null, days };
}

type DayRow = { day: string; cnt: number; value: number; kg: number };

export async function GET(req: Request) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  const q = parseQuery(req, querySchema);
  if ("res" in q) return q.res;
  const yardId = q.data.yardId || null;
  const { since, until, days } = resolveWindow(q.data.from, q.data.to, Number(q.data.days));

  /** Prisma `where` fragment for the window; `lte` only exists for explicit ranges. */
  const inWindow = until ? { gte: since, lt: until } : { gte: since };
  /** The same bound for raw SQL. `Prisma.empty` when the window is open-ended. */
  const untilFilter = until ? Prisma.sql`AND "createdAt" < ${until}` : Prisma.empty;
  const lineUntilFilter = until ? Prisma.sql`AND l."createdAt" < ${until}` : Prisma.empty;

  /**
   * Which yards these figures cover.
   *
   * Unfiltered, analytics describe the yards that are still operating — an
   * archived yard stopped trading, so leaving it in would keep its history
   * inflating every platform total. An explicit `yardId` is a deliberate
   * drill-down and is always honoured, archived or not.
   */
  const scopeWhere = inYardScope(yardId);

  // Reused predicate fragment. `yardId` is a validated string or null.
  const yardFilter = andYardScope(yardId);
  /**
   * The same predicate, qualified. Sku and Sale both carry a `yardId`, so a bare
   * `"yardId"` inside a joined query would be ambiguous and fail to plan.
   */
  const lineYardFilter = andYardScope(yardId, Prisma.sql`l."yardId"`);

  /**
   * ONE batch, not two.
   *
   * These were two sequential `Promise.all`s even though the second depends on
   * nothing in the first — which cost an extra full round trip to Neon (~90 ms)
   * on every analytics load, for no reason. Merged; the destructuring order below
   * is the only thing that changed.
   */
  const [
    salesRaw,
    inwardRaw,
    sortRaw,
    yards,
    stockRows,
    materialVolume,
    vendorVolume,
    receivables,
    skuStock,
    salesByYard,
    inwardByYard,
    pendingByYard,
    // ---- outward / dispatch (Phase 4) ----
    dispatchRaw,
    dispatchByYardRows,
    dispatchStatusRows,
    dispatchMaterialRows,
    dispatchBuyerRows,
  ] = await Promise.all([
      prisma.$queryRaw<DayRow[]>`
        SELECT to_char(date_trunc('day', "createdAt" AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS day,
               count(*)::int AS cnt,
               coalesce(sum("total"), 0)::float AS value,
               coalesce(sum("quantityKg"), 0)::float AS kg
        FROM "Sale"
        WHERE "createdAt" >= ${since} ${untilFilter} ${yardFilter}
        GROUP BY 1 ORDER BY 1`,

      prisma.$queryRaw<DayRow[]>`
        SELECT to_char(date_trunc('day', "createdAt" AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS day,
               count(*)::int AS cnt,
               0::float AS value,
               coalesce(sum("totalKg"), 0)::float AS kg
        FROM "InwardLoad"
        WHERE "createdAt" >= ${since} ${untilFilter} ${yardFilter}
        GROUP BY 1 ORDER BY 1`,

      prisma.$queryRaw<{ day: string; runs: number; sorted: number; wastage: number }[]>`
        SELECT to_char(date_trunc('day', "createdAt" AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS day,
               count(*)::int AS runs,
               coalesce(sum("totalKg"), 0)::float AS sorted,
               coalesce(sum("wastageKg"), 0)::float AS wastage
        FROM "SegregationRun"
        WHERE "createdAt" >= ${since} ${untilFilter} ${yardFilter}
        GROUP BY 1 ORDER BY 1`,

      prisma.yard.findMany({
        where: yardId ? { id: yardId } : { active: true },
        orderBy: { yardCode: "asc" },
        select: { id: true, yardCode: true, yardName: true, active: true },
      }),
      prisma.inventory.groupBy({
        by: ["yardId"],
        where: scopeWhere,
        _sum: { quantityKg: true },
      }),
      prisma.inwardLoad.groupBy({
        by: ["materialLabel"],
        where: { createdAt: inWindow, ...scopeWhere },
        _sum: { totalKg: true },
        _count: { _all: true },
        orderBy: { _sum: { totalKg: "desc" } },
        take: 12,
      }),
      /**
       * Vendor supply WITH the vendor's name, in one statement.
       *
       * This was a `groupBy(vendorId)` followed by a second, dependent
       * `vendor.findMany({ id: { in: … } })` to resolve names — which forced a
       * whole extra round trip (~90 ms) after the batch had already finished, and
       * was the last thing keeping this route above its latency budget. The join
       * gives the same twelve rows and needs no follow-up.
       */
      prisma.$queryRaw<{ vendorId: string; label: string; yardCode: string | null; kg: number; cnt: number }[]>`
        SELECT v."id"       AS "vendorId",
               v."name"     AS label,
               y."yardCode" AS "yardCode",
               coalesce(sum(i."totalKg"), 0)::float AS kg,
               count(*)::int AS cnt
        FROM "InwardLoad" i
        JOIN "Vendor" v ON v."id" = i."vendorId"
        LEFT JOIN "Yard" y ON y."id" = v."yardId"
        WHERE i."createdAt" >= ${since} ${until ? Prisma.sql`AND i."createdAt" < ${until}` : Prisma.empty} ${andYardScope(yardId, Prisma.sql`i."yardId"`)}
        GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 12`,
      prisma.receivable.groupBy({
        by: ["status"],
        where: scopeWhere,
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.inventory.findMany({
        relationLoadStrategy: "join",
        where: { quantityKg: { gt: 0 }, ...scopeWhere },
        select: { quantityKg: true, sku: { select: { name: true, icon: true, isMixedBucket: true } } },
      }),

    // ---- per-yard trade over the window, for the comparison series ----
    prisma.sale.groupBy({
      by: ["yardId"],
      where: { createdAt: inWindow, ...scopeWhere },
      _sum: { total: true, quantityKg: true },
      _count: { _all: true },
    }),
    prisma.inwardLoad.groupBy({
      by: ["yardId"],
      where: { createdAt: inWindow, ...scopeWhere },
      _sum: { totalKg: true },
      _count: { _all: true },
    }),
    prisma.inwardLoad.groupBy({
      by: ["yardId"],
      where: { status: "RECEIVED", ...scopeWhere },
      _count: { _all: true },
    }),

    // ---- outward / dispatch (Phase 4) ----
    // Same raw-SQL `date_trunc` shape as the inward trend above, for the same
    // reason: bucketing in JS would mean fetching every dispatch in the window.
    prisma.$queryRaw<DayRow[]>`
      SELECT to_char(date_trunc('day', "createdAt" AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS day,
             count(*)::int AS cnt,
             0::float AS value,
             coalesce(sum("totalKg"), 0)::float AS kg
      FROM "OutwardLoad"
      WHERE "createdAt" >= ${since} ${untilFilter} ${yardFilter}
      GROUP BY 1 ORDER BY 1`,

    prisma.outwardLoad.groupBy({
      by: ["yardId"],
      where: { createdAt: inWindow, ...scopeWhere },
      _sum: { totalKg: true },
      _count: { _all: true },
    }),

    // Allocation state for sales booked in the window. Window-scoped like every
    // other series here; the dashboard carries the all-time equivalent.
    prisma.sale.groupBy({
      by: ["dispatchStatus"],
      where: { createdAt: inWindow, ...scopeWhere },
      _count: { _all: true },
      _sum: { quantityKg: true, dispatchedKg: true },
    }),

    // Dispatched weight by material. Grouped on the SKU *name* because the same
    // material exists as a separate row per yard — grouping on skuId would split
    // one material across yards and read as several materials in the chart.
    prisma.$queryRaw<{ label: string; kg: number; cnt: number }[]>`
      SELECT s."name" AS label,
             coalesce(sum(l."quantityKg"), 0)::float AS kg,
             count(*)::int AS cnt
      FROM "OutwardLoadLine" l
      JOIN "Sku" s ON s."id" = l."skuId"
      WHERE l."createdAt" >= ${since} ${lineUntilFilter} ${lineYardFilter}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,

    // Dispatched weight by buyer, attributed through the invoice each line pays.
    prisma.$queryRaw<{ label: string; kg: number; cnt: number }[]>`
      SELECT b."name" AS label,
             coalesce(sum(l."quantityKg"), 0)::float AS kg,
             count(DISTINCT l."loadId")::int AS cnt
      FROM "OutwardLoadLine" l
      JOIN "Sale" sa ON sa."id" = l."saleId"
      JOIN "Buyer" b ON b."id" = sa."buyerId"
      WHERE l."createdAt" >= ${since} ${lineUntilFilter} ${lineYardFilter}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
  ]);

  const n = (v: number | null | undefined) => v ?? 0;

  /**
   * Zero-fill the window so a chart's x-axis is continuous. A gap day must
   * render as zero, not be skipped — otherwise the line lies about the trend.
   */
  function fillDays<T extends Record<string, number>>(
    rows: { day: string }[],
    pick: (r: unknown) => T,
    zero: T
  ): ({ day: string } & T)[] {
    const byDay = new Map(rows.map((r) => [r.day, pick(r)]));
    const out: ({ day: string } & T)[] = [];
    const cursor = new Date(since);
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    // An explicit range must stop AT its last day. The rolling window keeps the
    // inclusive `<= days` it always had, so `days=30` still renders 31 points.
    const lastKey = until ? fmt.format(new Date(until.getTime() - 1)) : null;
    for (let i = 0; i <= days; i++) {
      const key = fmt.format(cursor);
      if (lastKey && key > lastKey) break;
      out.push({ day: key, ...(byDay.get(key) ?? zero) });
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }

  const salesTrend = fillDays(
    salesRaw,
    (r) => {
      const x = r as DayRow;
      return { count: x.cnt, value: x.value, kg: x.kg };
    },
    { count: 0, value: 0, kg: 0 }
  );

  const inwardTrend = fillDays(
    inwardRaw,
    (r) => {
      const x = r as DayRow;
      return { count: x.cnt, kg: x.kg };
    },
    { count: 0, kg: 0 }
  );

  const sortTrend = fillDays(
    sortRaw,
    (r) => {
      const x = r as { runs: number; sorted: number; wastage: number };
      return { runs: x.runs, sortedKg: x.sorted, wastageKg: x.wastage };
    },
    { runs: 0, sortedKg: 0, wastageKg: 0 }
  );

  const dispatchTrend = fillDays(
    dispatchRaw,
    (r) => {
      const x = r as DayRow;
      return { count: x.cnt, kg: x.kg };
    },
    { count: 0, kg: 0 }
  );

  /** Sales in a given allocation state. `null` is a pre-Outward legacy sale. */
  const dispatchStatusCount = (status: string | null) =>
    dispatchStatusRows.find((g) => g.dispatchStatus === status)?._count._all ?? 0;

  // Current stock by SKU name (a name repeats across yards).
  const stockByName = new Map<string, { label: string; icon: string; kg: number; mixed: boolean }>();
  for (const row of skuStock) {
    const e =
      stockByName.get(row.sku.name) ??
      { label: row.sku.name, icon: row.sku.icon, kg: 0, mixed: row.sku.isMixedBucket };
    e.kg += row.quantityKg;
    stockByName.set(row.sku.name, e);
  }

  return ok({
    window: {
      days,
      since: since.toISOString(),
      until: until ? until.toISOString() : null,
      /** Echoed back so the picker can show exactly what the server used. */
      from: q.data.from ?? null,
      to: q.data.to ?? null,
      timeZone: TZ,
      yardId,
    },

    /** Line/area series. Continuous — one point per day, gaps zero-filled. */
    trends: {
      sales: salesTrend,
      inward: inwardTrend,
      sort: sortTrend,
      dispatch: dispatchTrend,
    },

    /**
     * Dispatch analytics — the Outward half of the flow.
     *
     * `awaitingKg` is what the yard still owes its buyers: allocated but not yet
     * loaded. Legacy sales are excluded because their stock left at sale time,
     * so they are not awaiting a vehicle.
     */
    dispatch: {
      statusDistribution: [
        { label: "Pending", value: dispatchStatusCount("PENDING") },
        { label: "Partial", value: dispatchStatusCount("PARTIAL") },
        { label: "Completed", value: dispatchStatusCount("COMPLETED") + dispatchStatusCount(null) },
      ],
      awaitingKg: dispatchStatusRows
        .filter((g) => g.dispatchStatus === "PENDING" || g.dispatchStatus === "PARTIAL")
        .reduce((total, g) => total + Math.max(0, n(g._sum.quantityKg) - n(g._sum.dispatchedKg)), 0),
      /** Bar series: dispatched weight by material over the window. */
      byMaterial: dispatchMaterialRows.map((m) => ({ label: m.label, value: m.kg, count: m.cnt })),
      /** Bar series: dispatched weight by buyer over the window. */
      byBuyer: dispatchBuyerRows.map((b) => ({ label: b.label, value: b.kg, count: b.cnt })),
      /** Bar series: dispatched weight by yard over the window. */
      byYard: yards
        .map((y) => {
          const d = dispatchByYardRows.find((g) => g.yardId === y.id);
          return {
            yardId: y.id,
            label: y.yardCode,
            yardName: y.yardName,
            value: n(d?._sum.totalKg),
            count: d?._count._all ?? 0,
          };
        })
        .sort((a, b) => b.value - a.value),
    },

    /** Bar series: yard-versus-yard over the window. */
    yardComparison: yards.map((y) => {
      const s = salesByYard.find((g) => g.yardId === y.id);
      const i = inwardByYard.find((g) => g.yardId === y.id);
      return {
        yardId: y.id,
        label: y.yardCode,
        yardName: y.yardName,
        active: y.active,
        salesValue: n(s?._sum.total),
        salesKg: n(s?._sum.quantityKg),
        salesCount: s?._count._all ?? 0,
        inwardKg: n(i?._sum.totalKg),
        inwardCount: i?._count._all ?? 0,
        stockKg: n(stockByYard(stockRows, y.id)),
        pendingLoads: pendingByYard.find((g) => g.yardId === y.id)?._count._all ?? 0,
      };
    }),

    /** Pie/bar series: inward volume by material over the window. */
    materialBreakdown: materialVolume.map((m) => ({
      label: m.materialLabel,
      value: n(m._sum.totalKg),
      count: m._count._all,
    })),

    /** Pie/bar series: current stock by SKU. */
    stockBreakdown: [...stockByName.values()]
      .sort((a, b) => b.kg - a.kg)
      .map((s) => ({ label: s.label, icon: s.icon, value: s.kg, mixed: s.mixed })),

    /** Bar series: supply by vendor over the window. */
    vendorBreakdown: vendorVolume.map((v) => ({
      label: v.label ?? "Unknown vendor",
      yardCode: v.yardCode,
      value: n(v.kg),
      count: v.cnt,
    })),

    /** Pie series: collection status. */
    receivableBreakdown: receivables.map((r) => ({
      label: r.status,
      value: n(r._sum.amount),
      count: r._count._all,
    })),

    totals: {
      salesValue: salesTrend.reduce((a, d) => a + d.value, 0),
      salesCount: salesTrend.reduce((a, d) => a + d.count, 0),
      salesKg: salesTrend.reduce((a, d) => a + d.kg, 0),
      inwardKg: inwardTrend.reduce((a, d) => a + d.kg, 0),
      inwardCount: inwardTrend.reduce((a, d) => a + d.count, 0),
      sortedKg: sortTrend.reduce((a, d) => a + d.sortedKg, 0),
      wastageKg: sortTrend.reduce((a, d) => a + d.wastageKg, 0),
      dispatchKg: dispatchTrend.reduce((a, d) => a + d.kg, 0),
      dispatchCount: dispatchTrend.reduce((a, d) => a + d.count, 0),
      stockKg: stockRows.reduce((a, s) => a + n(s._sum.quantityKg), 0),
    },
  });
}

/** Small helper: current stock for one yard out of the grouped result. */
function stockByYard(rows: { yardId: string; _sum: { quantityKg: number | null } }[], yardId: string): number {
  return rows.find((r) => r.yardId === yardId)?._sum.quantityKg ?? 0;
}
