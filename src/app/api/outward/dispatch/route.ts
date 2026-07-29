import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireYard, parseBody, ok, fail } from "@/lib/api";
import { nextCounter, formatDispatch } from "@/lib/counters";
import { publishMany } from "@/lib/realtime";
import { dispatchStatusFor, validateDispatch } from "@/lib/allocation";

export const dynamic = "force-dynamic";

const schema = z.object({
  /**
   * Idempotency key per SAVE DISPATCH attempt — see the inward route. A replay
   * here is worse than a duplicate lot: it would deduct the stock twice AND
   * over-satisfy the buyer's allocation.
   */
  clientRequestId: z.string().min(8).max(64).optional(),
  /** One entry per "Add To Load" tap: which allocation, and how many kilograms. */
  lines: z
    .array(z.object({ saleId: z.string().min(1), kg: z.number().int().positive() }))
    .min(1)
    .max(50),
  vehicleNumber: z.string().max(20).optional().nullable(),
  vehicleType: z.string().max(30).optional().nullable(),
  driverName: z.string().max(80).optional().nullable(),
  ocrConfidence: z.number().min(0).max(1).optional().nullable(),
  frontImageUrl: z.string().max(600).optional().nullable(),
  backImageUrl: z.string().max(600).optional().nullable(),
  materialImageUrls: z.array(z.string().max(600)).max(20).optional().default([]),
});

export async function POST(req: Request) {
  const guard = await requireYard();
  if ("res" in guard) return guard.res;
  const { prisma, yardId } = guard;

  const body = await parseBody(req, schema);
  if ("res" in body) return body.res;
  const d = body.data;

  // Replay check before touching stock; the unique index is the race backstop.
  if (d.clientRequestId) {
    const existing = await prisma.outwardLoad.findFirst({
      where: { clientRequestId: d.clientRequestId },
      select: { dispatchNumber: true, totalKg: true, vehicleNumber: true },
    });
    if (existing) return ok({ dispatch: existing, replayed: true }, { status: 200 });
  }

  // Group by allocation: two taps against the same invoice are one line.
  const bySale = new Map<string, number>();
  for (const l of d.lines) bySale.set(l.saleId, (bySale.get(l.saleId) ?? 0) + l.kg);
  const saleIds = [...bySale.keys()];

  const sales = await prisma.sale.findMany({
    where: { id: { in: saleIds } },
    include: { sku: { select: { id: true, name: true, inventory: { select: { quantityKg: true } } } } },
  });
  if (sales.length !== saleIds.length) {
    return fail("BAD_ALLOCATION", "Allocation not found in this yard", 422);
  }

  // Validate EVERY line before writing anything: a dispatch is all-or-nothing,
  // so a vehicle is never recorded as half-loaded because the second material
  // turned out to be over-allocated.
  for (const sale of sales) {
    const requested = bySale.get(sale.id)!;
    const verdict = validateDispatch(sale, requested, sale.sku.inventory?.quantityKg ?? 0);
    if (!verdict.ok) {
      return fail(verdict.code, `${sale.sku.name} (${sale.invoiceNumber}): ${verdict.message}`, 422);
    }
  }

  const total = [...bySale.values()].reduce((a, b) => a + b, 0);

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const seq = await nextCounter(tx, yardId, "dispatch");
      const dispatchNumber = formatDispatch(seq);

      const load = await tx.outwardLoad.create({
        data: {
          yardId,
          clientRequestId: d.clientRequestId ?? null,
          dispatchNumber,
          vehicleNumber: d.vehicleNumber ?? null,
          vehicleType: d.vehicleType ?? null,
          driverName: d.driverName ?? null,
          ocrConfidence: d.ocrConfidence ?? null,
          frontImageUrl: d.frontImageUrl ?? null,
          backImageUrl: d.backImageUrl ?? null,
          totalKg: total,
          dispatchedById: guard.user.id,
          images: { create: (d.materialImageUrls ?? []).map((url) => ({ yardId, url })) },
        },
      });

      let sequence = 0;
      for (const sale of sales) {
        const kg = bySale.get(sale.id)!;
        sequence += 1;

        await tx.outwardLoadLine.create({
          data: {
            yardId,
            loadId: load.id,
            saleId: sale.id,
            skuId: sale.sku.id,
            sequence,
            quantityKg: kg,
          },
        });

        // NOW the stock physically leaves — this is the moment the sale's
        // reservation becomes a real deduction.
        await tx.inventory.update({
          where: { skuId: sale.sku.id },
          data: { quantityKg: { decrement: kg } },
        });

        // FIFO-consume traceable batches so vendor attribution survives the
        // sale: a buyer complaint can still be traced to the vendor who
        // supplied that specific material.
        let toConsume = kg;
        const lots = await tx.inventoryLot.findMany({
          where: { skuId: sale.sku.id, remainingKg: { gt: 0 } },
          orderBy: { createdAt: "asc" },
        });
        for (const lot of lots) {
          if (toConsume <= 0) break;
          const take = Math.min(lot.remainingKg, toConsume);
          await tx.inventoryLot.update({ where: { id: lot.id }, data: { remainingKg: lot.remainingKg - take } });
          toConsume -= take;
        }

        await tx.inventoryTransaction.create({
          data: {
            yardId,
            skuId: sale.sku.id,
            changeKg: -kg,
            type: "OUTWARD",
            refId: load.id,
            refType: "OutwardLoad",
            byUserId: guard.user.id,
          },
        });

        const dispatched = (sale.dispatchedKg ?? 0) + kg;
        await tx.sale.update({
          where: { id: sale.id },
          data: {
            dispatchedKg: dispatched,
            // Derived from the quantities, never trusted from the old value.
            dispatchStatus: dispatchStatusFor({ quantityKg: sale.quantityKg, dispatchedKg: dispatched }),
          },
        });
      }

      return { id: load.id, dispatchNumber, totalKg: total, skuIds: sales.map((s) => s.sku.id) };
    });
  } catch (e) {
    // Two phones saving the same dispatch: one wins, the other is rolled back
    // whole and answered with the winner rather than an error.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && d.clientRequestId) {
      const winner = await prisma.outwardLoad.findFirst({
        where: { clientRequestId: d.clientRequestId },
        select: { dispatchNumber: true, totalKg: true, vehicleNumber: true },
      });
      if (winner) return ok({ dispatch: winner, replayed: true }, { status: 200 });
    }
    throw e;
  }

  // After commit only — a subscriber must never read pre-commit state.
  publishMany(yardId, [
    { channel: "outward", action: "dispatched", entity: "OutwardLoad", entityId: result.id, actorId: guard.user.id },
    ...result.skuIds.map((skuId) => ({
      channel: "stock" as const,
      action: "updated",
      entity: "Inventory",
      entityId: skuId,
      actorId: guard.user.id,
    })),
    { channel: "sales", action: "dispatch-changed", entity: "Sale", actorId: guard.user.id },
  ]);

  return ok(
    { dispatch: { dispatchNumber: result.dispatchNumber, totalKg: result.totalKg } },
    { status: 201 }
  );
}
