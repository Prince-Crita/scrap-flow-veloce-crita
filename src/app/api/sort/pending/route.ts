import { requireYard, ok } from "@/backend/http/api";
import { loadRef } from "@/shared/load-ref";
import { requiresSort } from "@/shared/material-kind";

export const dynamic = "force-dynamic";

/**
 * The Sort queue is one row per MATERIAL awaiting segregation, not one per load.
 *
 * A load may arrive carrying several materials in the same vehicle, and each is
 * segregated against its own sub-SKUs, so the line is the unit of work. Loads
 * saved before line items existed have no lines; those are projected as a single
 * implicit line built from the load's own material, which keeps historical lots
 * sortable without back-filling a single row.
 */
export async function GET() {
  const guard = await requireYard();
  if ("res" in guard) return guard.res;
  const { prisma, yardId } = guard;

  // Neither the SKU tree nor the yard code depends on the loads, so all three
  // run together rather than costing the Sort screen serial round trips on open.
  const [loads, skus, yard] = await Promise.all([
    prisma.inwardLoad.findMany({
      relationLoadStrategy: "join",
      where: { status: "RECEIVED" },
      orderBy: { createdAt: "asc" },
      include: {
        vendor: { select: { name: true } },
        lines: { orderBy: { sequence: "asc" } },
        // Who booked the load in. Shown in the selector so an operator can tell
        // two same-vendor, same-vehicle lots apart by who received them.
        capturedBy: { select: { name: true, role: true } },
      },
    }),
    // Child (non-mixed) SKUs grouped by material, plus the mixed source bucket.
    prisma.sku.findMany({ select: { id: true, name: true, materialId: true, isMixedBucket: true } }),
    prisma.yard.findUnique({ where: { id: yardId }, select: { shortCode: true, yardCode: true } }),
  ]);
  const shortCode = yard?.shortCode ?? yard?.yardCode ?? "";

  /**
   * How much of each load/material has already been segregated.
   *
   * A run may now sort only part of a lot, leaving an unsorted balance that must
   * come back up here — so the queue shows what is LEFT, not what arrived. The
   * balance is derived from the runs booked against the load's mixed bucket
   * rather than stored, which is what lets `quantityKg` keep reporting the
   * quantity actually received.
   */
  const runs =
    loads.length === 0
      ? []
      : await prisma.segregationRun.groupBy({
          by: ["sourceLoadId", "sourceSkuId"],
          where: { sourceLoadId: { in: loads.map((l) => l.id) } },
          _sum: { totalKg: true },
        });
  const sortedByLoadSku = new Map(runs.map((r) => [`${r.sourceLoadId}::${r.sourceSkuId}`, r._sum.totalKg ?? 0]));

  /**
   * Which SKUs are segregation SOURCES. `requiresSort` is the one place the
   * mixed/direct rule is written down (src/shared/material-kind.ts).
   *
   * This is the authoritative filter, not a cosmetic one: a line booked against
   * a DIRECT sub-material has nothing to be segregated into, so it is not a
   * candidate — it never enters this list, rather than being hidden from a list
   * it belongs on. Inward already writes such lines as SEGREGATED, so the status
   * filter below would exclude them anyway; checking the SKU as well means the
   * rule holds even for a row written before that was true.
   */
  const sortableSkuIds = new Set(skus.filter(requiresSort).map((s) => s.id));

  // Every RECEIVED load appears in the Sort selector. Loads whose material has
  // no segregation sub-SKUs yet are shown as not-yet-sortable rather than hidden
  // (root cause of the "load missing from Sort after adding a new material" bug).
  const lots = loads.flatMap((l) => {
    const pending =
      l.lines.length > 0
        ? l.lines
            .filter((ln) => ln.status === "RECEIVED" && sortableSkuIds.has(ln.skuId))
            .map((ln) => ({
              lineId: ln.id as string | null,
              skuId: ln.skuId as string | null,
              materialId: ln.materialId,
              materialLabel: ln.materialLabel,
              kg: ln.quantityKg,
            }))
        : l.materialId
          ? [{ lineId: null, skuId: null, materialId: l.materialId, materialLabel: l.materialLabel, kg: l.totalKg }]
          : [];

    return pending.map((p) => {
      const targets = skus.filter((s) => s.materialId === p.materialId && !s.isMixedBucket);
      const source = skus.find((s) => s.materialId === p.materialId && s.isMixedBucket);
      // The line's own SKU is the mixed bucket the stock landed in; legacy loads
      // with no line fall back to the material's bucket.
      const sourceSkuId = p.skuId ?? source?.id ?? null;
      const sortedKg = sourceSkuId ? (sortedByLoadSku.get(`${l.id}::${sourceSkuId}`) ?? 0) : 0;
      const remainingKg = Math.max(0, p.kg - sortedKg);
      return {
        // Stable per-row identity. A multi-material load contributes several
        // rows sharing one loadId, so selection must key on this, not loadId.
        lotKey: p.lineId ?? l.id,
        loadId: l.id,
        lineId: p.lineId,
        lotNumber: l.lotNumber,
        /** Platform-unique, human-readable — see src/shared/load-ref.ts. */
        loadRef: loadRef({ shortCode, lotNumber: l.lotNumber }),
        materialLabel: p.materialLabel,
        /** The unsorted balance — what this run may allocate. */
        totalKg: remainingKg,
        /** What actually arrived, and how much of it earlier runs already sorted. */
        receivedKg: p.kg,
        sortedKg,
        vendorName: l.vendor?.name ?? "Walk-in",
        vehicleNumber: l.vehicleNumber ?? "—",
        // The person and the role are returned separately: the selector prefers
        // the name, the lot card shows both, and neither has to parse a label.
        capturedByName: l.capturedBy?.name ?? null,
        capturedByRole: l.capturedBy?.role ?? null,
        createdAt: l.createdAt,
        sourceSkuId: source?.id ?? null,
        targets: targets.map((t) => ({ skuId: t.id, name: t.name })),
        sortable: !!source && targets.length > 0,
      };
    });
  });

  return ok({ lots });
}
