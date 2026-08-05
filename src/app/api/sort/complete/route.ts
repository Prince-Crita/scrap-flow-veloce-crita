import { z } from "zod";
import { requireYard, parseBody, ok, fail } from "@/lib/api";
import { publishMany } from "@/lib/realtime";

export const dynamic = "force-dynamic";

const schema = z.object({
  loadId: z.string().min(1),
  /**
   * Which material of the load is being segregated. Omitted by clients written
   * before multi-material loads existed — see the resolution below, which keeps
   * every single-material lot behaving exactly as it always did.
   */
  lineId: z.string().min(1).optional().nullable(),
  wastageKg: z.number().int().min(0),
  allocations: z
    .array(z.object({ skuId: z.string().min(1), kg: z.number().int().min(0) }))
    .min(1)
    .max(30),
});

export async function POST(req: Request) {
  const guard = await requireYard();
  if ("res" in guard) return guard.res;
  const { prisma, yardId } = guard;

  const body = await parseBody(req, schema);
  if ("res" in body) return body.res;
  const d = body.data;

  const load = await prisma.inwardLoad.findUnique({
    where: { id: d.loadId },
    include: { lines: { orderBy: { sequence: "asc" } } },
  });
  if (!load) return fail("NOT_FOUND", "Lot not found", 404);
  if (load.status !== "RECEIVED") return fail("ALREADY_SORTED", "This lot was already segregated", 409);

  /**
   * Resolve which material is being segregated.
   *
   * With a lineId, that line. Without one, a load carrying a single material is
   * unambiguous, so the old request shape still works; a load carrying several
   * is genuinely ambiguous and is refused rather than guessed at — silently
   * sorting the wrong material would corrupt stock in a way nothing detects.
   */
  const pendingLines = load.lines.filter((l) => l.status === "RECEIVED");
  let line: (typeof load.lines)[number] | null = null;

  if (d.lineId) {
    line = load.lines.find((l) => l.id === d.lineId) ?? null;
    if (!line) return fail("NOT_FOUND", "Material line not found on this lot", 404);
    if (line.status !== "RECEIVED") return fail("ALREADY_SORTED", "This material was already segregated", 409);
  } else if (pendingLines.length === 1) {
    line = pendingLines[0];
  } else if (pendingLines.length > 1) {
    return fail("AMBIGUOUS_LOT", "This lot carries several materials — choose which one to segregate", 422);
  }

  const materialId = line ? line.materialId : load.materialId;
  const receivedKg = line ? line.quantityKg : load.totalKg;
  if (!materialId) return fail("BAD_LOT", "Lot has no material to segregate", 422);

  // Validate SKUs belong to the same parent material and are not mixed buckets.
  const skus = await prisma.sku.findMany({ where: { materialId } });
  // Prefer the bucket the stock actually landed in; fall back to the material's
  // bucket for legacy loads that have no line.
  const source = (line && skus.find((s) => s.id === line!.skuId)) || skus.find((s) => s.isMixedBucket);
  if (!source || !source.isMixedBucket) return fail("NO_SOURCE", "No mixed bucket for this material", 422);
  const targetIds = new Set(skus.filter((s) => !s.isMixedBucket).map((s) => s.id));
  for (const a of d.allocations) {
    if (!targetIds.has(a.skuId)) return fail("BAD_SKU", "Invalid target SKU in allocation", 422);
  }

  /**
   * Partial segregation.
   *
   * A run no longer has to consume the whole lot. What is not allocated stays
   * exactly where it already is — in the mixed bucket, still attributed to this
   * load — and the line stays RECEIVED so it comes back up in the Sort queue as
   * an unsorted balance. Nothing is written off, moved, or guessed into a
   * category.
   *
   * The balance is DERIVED (received minus every run booked against this load +
   * mixed bucket) rather than stored, so no column and no historical row has to
   * change: `InwardLoadLine.quantityKg` still reports what actually arrived.
   * `SegregationRun.totalKg` is the amount THIS run sorted.
   */
  const prior = await prisma.segregationRun.aggregate({
    where: { sourceLoadId: load.id, sourceSkuId: source.id },
    _sum: { totalKg: true },
  });
  const alreadySortedKg = prior._sum.totalKg ?? 0;
  const availableKg = receivedKg - alreadySortedKg;

  const allocTotal = d.allocations.reduce((a, b) => a + b.kg, 0);
  const sortedKg = allocTotal + d.wastageKg;
  if (sortedKg <= 0) return fail("NOTHING_SORTED", "Allocate at least some weight before completing", 422);
  if (sortedKg > availableKg) {
    return fail(
      "MISMATCH",
      `Allocations + wastage (${sortedKg} kg) exceed the unsorted balance (${availableKg} kg)`,
      422
    );
  }
  const remainingKg = availableKg - sortedKg;

  // Wastage is a share of what this run actually processed, not of the whole lot.
  const wastagePct = Number(((d.wastageKg / sortedKg) * 100).toFixed(2));

  await prisma.$transaction(async (tx) => {
    // Decrement mixed bucket by what this run sorted. Any balance stays in the
    // bucket as unsorted stock.
    await tx.inventory.upsert({
      where: { skuId: source.id },
      create: { yardId, skuId: source.id, quantityKg: 0 },
      update: { quantityKg: { decrement: sortedKg } },
    });
    await tx.inventoryTransaction.create({
      data: {
        yardId,
        skuId: source.id,
        changeKg: -sortedKg,
        type: "SEGREGATION_OUT",
        refId: load.id,
        refType: "InwardLoad",
        byUserId: guard.user.id,
      },
    });

    // Consume this load's mixed batch (traceability source), by the sorted
    // amount only — the rest of the batch is still on the floor.
    const sourceLot = await tx.inventoryLot.findFirst({
      where: { sourceLoadId: load.id, skuId: source.id },
    });
    if (sourceLot) {
      await tx.inventoryLot.update({
        where: { id: sourceLot.id },
        data: { remainingKg: Math.max(0, sourceLot.remainingKg - sortedKg) },
      });
    }

    // Increment each target SKU, creating attributed finished-SKU batches.
    for (const a of d.allocations) {
      if (a.kg === 0) continue;
      await tx.inventory.upsert({
        where: { skuId: a.skuId },
        create: { yardId, skuId: a.skuId, quantityKg: a.kg },
        update: { quantityKg: { increment: a.kg } },
      });
      await tx.inventoryLot.create({
        data: {
          yardId,
          skuId: a.skuId,
          vendorId: load.vendorId,
          vehicleNumber: load.vehicleNumber,
          sourceLoadId: load.id,
          originalKg: a.kg,
          remainingKg: a.kg,
        },
      });
      await tx.inventoryTransaction.create({
        data: {
          yardId,
          skuId: a.skuId,
          changeKg: a.kg,
          type: "SEGREGATION_IN",
          refId: load.id,
          refType: "InwardLoad",
          byUserId: guard.user.id,
        },
      });
    }

    const run = await tx.segregationRun.create({
      data: {
        yardId,
        lotNumber: load.lotNumber,
        sourceLoadId: load.id,
        sourceSkuId: source.id,
        totalKg: sortedKg,
        wastageKg: d.wastageKg,
        wastagePct,
        status: "COMPLETED",
        completedById: guard.user.id,
        allocations: {
          create: d.allocations.filter((a) => a.kg > 0).map((a) => ({ yardId, skuId: a.skuId, kg: a.kg })),
        },
      },
    });

    if (d.wastageKg > 0) {
      await tx.inventoryTransaction.create({
        data: {
          yardId,
          skuId: source.id,
          changeKg: -d.wastageKg,
          type: "WASTAGE",
          refId: run.id,
          refType: "SegregationRun",
          byUserId: guard.user.id,
        },
      });
    }

    // A line is finished only when its whole quantity has been sorted. With a
    // balance left it stays RECEIVED, which is what keeps it in the Sort queue
    // and its remaining kilograms counted as unsorted stock.
    //
    // The load is finished only when none of its materials are still waiting.
    // Flipping it on the first line would drop the rest out of the Sort queue
    // while their stock is still sitting in the mixed bucket.
    if (remainingKg === 0) {
      if (line) {
        await tx.inwardLoadLine.update({ where: { id: line.id }, data: { status: "SEGREGATED" } });
      }
      const stillPending = line ? pendingLines.filter((l) => l.id !== line.id).length : 0;
      if (stillPending === 0) {
        await tx.inwardLoad.update({ where: { id: load.id }, data: { status: "SEGREGATED" } });
      }
    }
  });

  publishMany(yardId, [
    { channel: "sort", action: "completed", entity: "InwardLoad", entityId: load.id, actorId: guard.user.id },
    { channel: "stock", action: "updated", entity: "Inventory", actorId: guard.user.id },
    { channel: "sales", action: "ready-changed", entity: "Sku", actorId: guard.user.id },
  ]);

  return ok({ lotNumber: load.lotNumber, wastagePct, sortedKg, remainingKg });
}
