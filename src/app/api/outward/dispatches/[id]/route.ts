import { z } from "zod";
import { requireYardCapability, parseBody, ok, fail } from "@/backend/http/api";
import { ensureShortCode } from "@/backend/services/yard-short-code";
import { publishMany } from "@/backend/realtime/realtime";
import { dispatchRef } from "@/shared/load-ref";
import {
  proofComplete,
  transitComplete,
  stateFor,
  transitionError,
  type DispatchState,
} from "@/shared/dispatch-stage";

export const dynamic = "force-dynamic";

/**
 * One dispatch: read it, and advance it through the workflow.
 *
 * GET   — the detail view, and the resume path. Everything a screen needs to
 *         decide which stage to open is here, so a refresh or a new device
 *         lands on the same step: the backend is the source of truth, never
 *         React state (§32).
 * PATCH — Material Entry "Update" and Dispatch Proof "Complete". Both write to
 *         the SAME record found by `id`, which is why the workflow can never
 *         produce a second dispatch or a second reference.
 *
 * Tenant safety is structural: `prisma` here is the yard-scoped client, so
 * `findUnique({ where: { id } })` for a dispatch belonging to another yard
 * returns null — a Yard A id guessed in Yard B is a 404, not a leak.
 */

const DETAIL_SELECT = {
  id: true,
  dispatchNumber: true,
  vehicleNumber: true,
  vehicleType: true,
  driverName: true,
  driverPhone: true,
  ocrConfidence: true,
  frontImageUrl: true,
  backImageUrl: true,
  emptySlipUrl: true,
  filledImageUrl: true,
  dcUrl: true,
  dispatchedAt: true,
  loadedSlipUrl: true,
  proofById: true,
  invoiceUrl: true,
  totalKg: true,
  stage: true,
  state: true,
  createdAt: true,
  dispatchedBy: { select: { name: true, role: true } },
  proofBy: { select: { name: true, role: true } },
  lines: {
    orderBy: { sequence: "asc" as const },
    select: { id: true, skuId: true, materialLabel: true, quantityKg: true, ratePerKg: true, sequence: true },
  },
  /** Material photographs, so a resumed dispatch does not re-ask for them. */
  images: { select: { url: true } },
} as const;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireYardCapability("outward.dispatch");
  if ("res" in guard) return guard.res;
  const { prisma, yardId } = guard;
  const { id } = await params;

  const [yard, row] = await Promise.all([
    prisma.yard.findUnique({ where: { id: yardId }, select: { shortCode: true, yardCode: true } }),
    prisma.outwardLoad.findUnique({ where: { id }, select: DETAIL_SELECT }),
  ]);
  if (!row) return fail("NOT_FOUND", "Dispatch not found in this yard", 404);
  const shortCode = yard?.shortCode ?? yard?.yardCode ?? "";

  return ok({ dispatch: shape(row, shortCode) });
}

/** One shape for the detail screen, so GET and PATCH always agree. */
function shape(row: Record<string, unknown>, shortCode: string) {
  const lines = (row.lines ?? []) as { materialLabel: string | null; quantityKg: number; ratePerKg: number | null; id: string; skuId: string }[];
  const by = row.dispatchedBy as { name: string | null; role: string } | null;
  const proofBy = row.proofBy as { name: string | null; role: string } | null;
  return {
    id: row.id as string,
    ref: dispatchRef({ shortCode, dispatchNumber: row.dispatchNumber as string }),
    dispatchNumber: row.dispatchNumber as string,
    vehicleNumber: row.vehicleNumber as string | null,
    vehicleType: row.vehicleType as string | null,
    driverName: row.driverName as string | null,
    driverPhone: row.driverPhone as string | null,
    ocrConfidence: row.ocrConfidence as number | null,
    frontImageUrl: row.frontImageUrl as string | null,
    backImageUrl: row.backImageUrl as string | null,
    emptySlipUrl: row.emptySlipUrl as string | null,
    filledImageUrl: row.filledImageUrl as string | null,
    dcUrl: row.dcUrl as string | null,
    dispatchedAt: row.dispatchedAt as Date | null,
    loadedSlipUrl: row.loadedSlipUrl as string | null,
    invoiceUrl: row.invoiceUrl as string | null,
    totalKg: row.totalKg as number,
    stage: row.stage as string,
    state: row.state as string,
    createdAt: row.createdAt as Date,
    dispatchedBy: by?.name ?? null,
    dispatchedByRole: by?.role ?? null,
    /** "Entered By" on the Proof step — whoever signed it off. */
    proofBy: proofBy?.name ?? null,
    lineCount: lines.length,
    materialImages: ((row.images ?? []) as { url: string }[]).map((i) => i.url),
    hasTransit: transitComplete({ dispatchedAt: row.dispatchedAt, filledImageUrl: row.filledImageUrl }),
    hasProof: proofComplete({ loadedSlipUrl: row.loadedSlipUrl, proofById: row.proofById }),
    materials: lines.map((l) => ({
      id: l.id,
      skuId: l.skuId,
      label: l.materialLabel ?? "Material",
      kg: l.quantityKg,
      ratePerKg: l.ratePerKg,
    })),
  };
}

/**
 * Two mutually exclusive shapes, discriminated on `step`, rather than one bag
 * of optional fields: it makes "which stage is being saved" explicit at the
 * boundary, and stops a proof payload from silently rewriting the materials.
 */
const patchSchema = z.discriminatedUnion("step", [
  z.object({
    step: z.literal("MATERIALS"),
    /** The whole cart, replacing what is stored — see the handler for why. */
    lines: z
      .array(
        z.object({
          skuId: z.string().min(1),
          kg: z.number().int().positive().max(10_000_000),
          ratePerKg: z.number().min(0).max(1_000_000),
        })
      )
      .min(1)
      .max(50),
    /** Photographs of the material loaded, per the Inward image requirement. */
    materialImageUrls: z.array(z.string().max(600)).max(40).optional().default([]),
  }),
  z.object({
    /** Step 3 — the vehicle leaves: when, and what it looked like loaded. */
    step: z.literal("TRANSIT"),
    dispatchedAt: z.string().datetime(),
    filledImageUrl: z.string().min(1).max(600),
    /** Optional by design. Its absence never blocks the step. */
    dcUrl: z.string().max(600).optional().nullable(),
  }),
  z.object({
    /** Step 4 — the loaded weighbridge slip. This is what COMPLETES a dispatch. */
    step: z.literal("PROOF"),
    loadedSlipUrl: z.string().min(1).max(600),
  }),
  z.object({
    /**
     * Owner-only paperwork after completion (Ready to Invoice). Not a workflow
     * stage: it neither changes `stage` nor `state`, so it cannot move a
     * dispatch through the machine.
     */
    step: z.literal("INVOICE"),
    invoiceUrl: z.string().min(1).max(600),
  }),
]);

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireYardCapability("outward.dispatch");
  if ("res" in guard) return guard.res;
  const { prisma, yardId } = guard;
  const { id } = await params;

  const body = await parseBody(req, patchSchema);
  if ("res" in body) return body.res;
  const d = body.data;

  const current = await prisma.outwardLoad.findUnique({
    where: { id },
    select: {
      id: true,
      state: true,
      dispatchedAt: true,
      filledImageUrl: true,
      loadedSlipUrl: true,
      proofById: true,
      _count: { select: { lines: true } },
    },
  });
  if (!current) return fail("NOT_FOUND", "Dispatch not found in this yard", 404);

  const progress = {
    state: current.state as DispatchState,
    lineCount: current._count.lines,
    hasTransit: transitComplete(current),
  };

  /**
   * The transition guard, applied to EVERY workflow write.
   *
   * `transitionError` lives in src/shared/dispatch-stage.ts beside the step
   * order, so the rule the UI draws and the rule the API enforces are the same
   * rule. A client cannot skip In Transit by POSTing a PROOF payload: without a
   * recorded departure this refuses, whatever screen the request came from.
   *
   * INVOICE is exempt on purpose — it is paperwork filed against a dispatch
   * that is already finished, not a stage of the machine.
   */
  if (d.step !== "INVOICE") {
    const problem = transitionError(d.step, progress);
    if (problem) {
      return fail(current.state === "COMPLETED" ? "ALREADY_COMPLETED" : "INVALID_TRANSITION", problem, 409);
    }
  }

  const shortCode = (await ensureShortCode(prisma, yardId)) ?? "";

  if (d.step === "MATERIALS") {
    // The SKUs have to exist in THIS yard. The scoped client already restricts
    // the read, so a count mismatch means at least one id was not the caller's
    // to use — refuse the whole write rather than silently dropping a line.
    const skuIds = [...new Set(d.lines.map((l) => l.skuId))];
    const found = await prisma.sku.findMany({ where: { id: { in: skuIds } }, select: { id: true, name: true } });
    if (found.length !== skuIds.length) {
      return fail("BAD_MATERIAL", "A selected material does not belong to this yard", 422);
    }
    const nameById = new Map(found.map((s) => [s.id, s.name]));
    const totalKg = d.lines.reduce((a, l) => a + l.kg, 0);

    /**
     * Replace, not append.
     *
     * Material Entry sends the cart as the operator sees it, so re-opening a
     * dispatch and pressing Update again has to leave the stored lines equal to
     * that cart — appending would double every material on a resumed edit. Both
     * halves run in ONE transaction so a dispatch is never left with its old
     * lines deleted and its new ones unwritten.
     */
    await prisma.$transaction(async (tx) => {
      await tx.outwardLoadLine.deleteMany({ where: { loadId: id } });
      await tx.outwardLoadLine.createMany({
        data: d.lines.map((l, i) => ({
          yardId,
          loadId: id,
          skuId: l.skuId,
          saleId: null,
          sequence: i + 1,
          quantityKg: l.kg,
          ratePerKg: l.ratePerKg,
          materialLabel: nameById.get(l.skuId) ?? "Material",
        })),
      });

      /**
       * Material photographs, in the SAME shape Inward stores them: one row per
       * image against the load. `OutwardImage` already existed for exactly this
       * and had no writer; replaced wholesale alongside the lines so re-saving
       * the cart cannot accumulate duplicates.
       */
      await tx.outwardImage.deleteMany({ where: { loadId: id } });
      if (d.materialImageUrls.length > 0) {
        await tx.outwardImage.createMany({
          data: [...new Set(d.materialImageUrls)].map((url) => ({ yardId, loadId: id, url })),
        });
      }

      await tx.outwardLoad.update({
        where: { id },
        data: {
          totalKg,
          stage: "MATERIALS",
          // Materials committed → IN_TRANSIT, so the dispatch shows up in the
          // Active Dispatch "In Transit" tab while step 3 is the outstanding
          // work. Derived in one place so the tabs, the rail and the record can
          // never disagree.
          state: stateFor(true, false),
        },
      });
    });
  } else if (d.step === "TRANSIT") {
    // Step 3 — the vehicle leaves. Does not complete the dispatch; the loaded
    // weighbridge slip at step 4 is what does.
    await prisma.outwardLoad.update({
      where: { id },
      data: {
        dispatchedAt: new Date(d.dispatchedAt),
        filledImageUrl: d.filledImageUrl,
        dcUrl: d.dcUrl ?? null,
        stage: "TRANSIT",
        // Already IN_TRANSIT from the materials write; recomputed rather than
        // assumed so the record cannot drift if it arrived here another way.
        state: stateFor(true, false),
      },
    });
  } else if (d.step === "PROOF") {
    /**
     * Step 4 — the loaded weighbridge slip, and the moment the dispatch is
     * finished. "Entered By" is taken from the authenticated session, never
     * from the request body: a client must not be able to name someone else as
     * the person who signed off the proof.
     *
     * The stock leaves HERE, in the same transaction, because this is the point
     * the goods are confirmed gone — the same deduction, FIFO batch consumption
     * and OUTWARD ledger entry the allocation flow has always written. Without
     * it a completed dispatch would never move the yard's stock, and Ready to
     * Sell would keep offering material that had already driven away.
     */
    await prisma.$transaction(async (tx) => {
      const lines = await tx.outwardLoadLine.findMany({
        where: { loadId: id },
        select: { skuId: true, quantityKg: true },
      });

      for (const line of lines) {
        await tx.inventory.update({
          where: { skuId: line.skuId },
          data: { quantityKg: { decrement: line.quantityKg } },
        });

        // FIFO-consume traceable batches so vendor attribution survives the
        // dispatch, exactly as the allocation flow does.
        let toConsume = line.quantityKg;
        const lots = await tx.inventoryLot.findMany({
          where: { skuId: line.skuId, remainingKg: { gt: 0 } },
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
            skuId: line.skuId,
            changeKg: -line.quantityKg,
            type: "OUTWARD",
            refId: id,
            refType: "OutwardLoad",
            byUserId: guard.user.id,
          },
        });
      }

      await tx.outwardLoad.update({
        where: { id },
        data: {
          loadedSlipUrl: d.loadedSlipUrl,
          proofById: guard.user.id,
          stage: "PROOF",
          state: stateFor(true, true),
        },
      });
    });
  } else {
    // INVOICE — Owner paperwork against an already-completed dispatch. Neither
    // `stage` nor `state` moves.
    await prisma.outwardLoad.update({ where: { id }, data: { invoiceUrl: d.invoiceUrl } });
  }

  const fresh = await prisma.outwardLoad.findUnique({ where: { id }, select: DETAIL_SELECT });
  /**
   * `outward` carries every status view. Completing a dispatch ALSO moves the
   * yard's stock, so it publishes `stock` too — that is what makes the Owner's
   * Ready to Sell drop a material whose balance has just fallen back under its
   * threshold, with no refresh.
   */
  publishMany(
    yardId,
    d.step === "PROOF"
      ? [
          { channel: "outward", action: "completed", entity: "OutwardLoad", entityId: id, actorId: guard.user.id },
          { channel: "stock", action: "updated", entity: "Inventory", entityId: id, actorId: guard.user.id },
        ]
      : [{ channel: "outward", action: "updated", entity: "OutwardLoad", entityId: id, actorId: guard.user.id }]
  );
  return ok({ dispatch: shape(fresh as Record<string, unknown>, shortCode) });
}
