import { requireYard, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Read-only feed for the "Recent Load Details" panel on the Inward page.
 *
 * Deliberately a viewer: it exposes no mutation and no ledger totals beyond
 * what the load itself recorded. Capped at a handful of rows because it sits
 * on a phone screen under the keypad, not in a report.
 */
const LIMIT = 8;

export async function GET() {
  const guard = await requireYard();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  const loads = await prisma.inwardLoad.findMany({
    orderBy: { createdAt: "desc" },
    take: LIMIT,
    include: {
      vendor: { select: { name: true } },
      lines: { orderBy: { sequence: "asc" }, select: { materialLabel: true, quantityKg: true } },
    },
  });

  return ok({
    loads: loads.map((l) => ({
      id: l.id,
      lotNumber: l.lotNumber,
      vendorName: l.vendor?.name ?? "Walk-in",
      vehicleNumber: l.vehicleNumber ?? "—",
      vehicleType: l.vehicleType ?? null,
      driverName: l.driverName ?? null,
      totalKg: l.totalKg,
      // Loads saved before line items existed have none; fall back to the
      // load's own single material so history renders identically.
      materials:
        l.lines.length > 0
          ? l.lines.map((ln) => ({ label: ln.materialLabel, kg: ln.quantityKg }))
          : [{ label: l.materialLabel, kg: l.totalKg }],
      slipUrl: l.weighbridgeSlipUrl,
      createdAt: l.createdAt,
    })),
  });
}
