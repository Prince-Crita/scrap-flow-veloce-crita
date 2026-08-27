import { requireYard, ok } from "@/backend/http/api";
import { loadRef } from "@/shared/load-ref";

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
  const { prisma, yardId } = guard;

  // The yard's code does not depend on the loads, so the two run together rather
  // than costing this panel two serial round trips. Read-only: a yard with no
  // short code yet falls back to `yardCode` rather than being assigned one here.
  const [yard, loads] = await Promise.all([
    prisma.yard.findUnique({ where: { id: yardId }, select: { shortCode: true, yardCode: true } }),
    prisma.inwardLoad.findMany({
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      include: {
        vendor: { select: { name: true } },
        lines: { orderBy: { sequence: "asc" }, select: { materialLabel: true, quantityKg: true } },
        /**
         * The individual weighments, because they are the only rows that survive
         * the SKU grouping with their own rate attached — "Mixed MS 500 kg at ₹20"
         * and "Mixed MS 300 kg at ₹25" are one line but two weighments.
         */
        weightEntries: {
          orderBy: { sequence: "asc" },
          select: { kg: true, ratePerKg: true, line: { select: { materialLabel: true } } },
        },
        capturedBy: { select: { name: true, role: true } },
      },
    }),
  ]);
  const shortCode = yard?.shortCode ?? yard?.yardCode ?? "";

  return ok({
    loads: loads.map((l) => ({
      id: l.id,
      lotNumber: l.lotNumber,
      loadRef: loadRef({ shortCode, lotNumber: l.lotNumber }),
      vendorName: l.vendor?.name ?? "Walk-in",
      vehicleNumber: l.vehicleNumber ?? "—",
      vehicleType: l.vehicleType ?? null,
      driverName: l.driverName ?? null,
      driverPhone: l.driverPhone ?? null,
      totalKg: l.totalKg,
      // Loads saved before line items existed have none; fall back to the
      // load's own single material so history renders identically.
      materials:
        l.lines.length > 0
          ? l.lines.map((ln) => ({ label: ln.materialLabel, kg: ln.quantityKg }))
          : [{ label: l.materialLabel, kg: l.totalKg }],
      /**
       * One row per "Add to Cart", with its rate. Empty for loads saved before
       * weighments carried a rate — the reader falls back to `materials`, which
       * is exactly what those loads recorded.
       */
      entries: l.weightEntries.map((w) => ({
        label: w.line?.materialLabel ?? l.materialLabel,
        kg: w.kg,
        ratePerKg: w.ratePerKg,
      })),
      /** Tri-state: null is "not recorded", which is not the same as "No". */
      hasInvoice: l.hasInvoice,
      invoiceNumber: l.invoiceNumber,
      invoiceUrl: l.invoiceUrl,
      slipUrl: l.weighbridgeSlipUrl,
      capturedByName: l.capturedBy?.name ?? null,
      capturedByRole: l.capturedBy?.role ?? null,
      createdAt: l.createdAt,
    })),
  });
}
