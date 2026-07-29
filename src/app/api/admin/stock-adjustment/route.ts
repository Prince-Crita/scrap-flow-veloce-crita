import { z } from "zod";
import { requireAdmin, parseBody, ok, fail } from "@/lib/api";
import { audit } from "@/lib/audit";
import { publishMany } from "@/lib/realtime";
import { scopedDb } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * Stock adjustment — the ONLY sanctioned way to change a quantity after the fact.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * Every other quantity in the system is derived: inward adds, segregation moves,
 * a sale reserves, a dispatch deducts. But physical yards drift — a weighbridge
 * miscalibrates, a bag splits, someone keys 1200 for 120. Without a sanctioned
 * correction the only remedy is editing `Inventory` directly, which leaves the
 * ledger disagreeing with the stock it is supposed to explain and destroys the
 * audit trail. So a correction is itself a ledger entry.
 *
 * ── Invariants it must not break ──────────────────────────────────────────────
 * `npm run db:verify` asserts `Inventory.quantityKg === Σ InventoryLot.remainingKg`
 * per SKU. An adjustment therefore reconciles BOTH sides in one transaction:
 *   • increase → a new lot carries the added kilograms, so they stay traceable
 *   • decrease → FIFO-consume existing lots, exactly as a dispatch does
 * Doing one without the other would leave the database failing its own audit.
 *
 * Admin only, reason mandatory, actor recorded, single transaction, and the
 * resulting `InventoryTransaction` is typed `STOCK_ADJUSTMENT` so a correction is
 * never mistaken for trade in any report.
 */

const schema = z.object({
  yardId: z.string().min(1),
  skuId: z.string().min(1),
  /**
   * The count that is actually on the ground. Deliberately absolute rather than a
   * delta: an operator reads a number off a scale, and asking for the difference
   * invites arithmetic mistakes in exactly the situation where the existing
   * number is already known to be wrong.
   */
  actualKg: z.number().int().min(0).max(100_000_000),
  /** Mandatory, and long enough to be a real explanation rather than "fix". */
  reason: z.string().trim().min(10).max(500),
});

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { user } = guard;

  const body = await parseBody(req, schema);
  if ("res" in body) return body.res;
  const { yardId, skuId, actualKg, reason } = body.data;

  const yard = await guard.prisma.yard.findUnique({
    where: { id: yardId },
    select: { id: true, yardCode: true, active: true },
  });
  if (!yard) return fail("NOT_FOUND", "Yard not found", 404);
  // Adjusting a switched-off yard would change numbers nobody is watching.
  if (!yard.active) return fail("YARD_INACTIVE", "That yard is deactivated", 409);

  /**
   * Scoped to the target yard even though the caller is an admin. An admin write
   * must always name its yard — this is what stops a mistyped skuId from
   * adjusting a different tenant's stock.
   */
  const db = scopedDb(yardId);

  const sku = await db.sku.findUnique({
    where: { id: skuId },
    select: { id: true, name: true, code: true, inventory: { select: { quantityKg: true } } },
  });
  if (!sku) return fail("NOT_FOUND", "SKU not found in that yard", 404);

  const currentKg = sku.inventory?.quantityKg ?? 0;
  const changeKg = actualKg - currentKg;
  // A no-op adjustment would write an audit row claiming a correction happened.
  if (changeKg === 0) {
    return fail("NO_CHANGES", `${sku.name} is already recorded at ${currentKg} kg`, 422);
  }

  const result = await db.$transaction(async (tx) => {
    // Upsert, because a SKU created before its inventory row still needs to be
    // correctable rather than failing on a missing row.
    await tx.inventory.upsert({
      where: { skuId },
      update: { quantityKg: actualKg },
      create: { yardId, skuId, quantityKg: actualKg },
    });

    let lotId: string | null = null;
    if (changeKg > 0) {
      // Found stock needs a batch of its own, or the lot total would fall short
      // of inventory. It carries no vendor: its origin is genuinely unknown, and
      // inventing one would be worse than recording the gap honestly.
      const lot = await tx.inventoryLot.create({
        data: { yardId, skuId, originalKg: changeKg, remainingKg: changeKg },
      });
      lotId = lot.id;
    } else {
      // FIFO, exactly as a dispatch consumes — oldest batches go first so vendor
      // attribution stays meaningful for whatever remains.
      let toConsume = -changeKg;
      const lots = await tx.inventoryLot.findMany({
        where: { skuId, remainingKg: { gt: 0 } },
        orderBy: { createdAt: "asc" },
      });
      for (const lot of lots) {
        if (toConsume <= 0) break;
        const take = Math.min(lot.remainingKg, toConsume);
        await tx.inventoryLot.update({ where: { id: lot.id }, data: { remainingKg: lot.remainingKg - take } });
        toConsume -= take;
      }
      // If the batches could not cover the decrease, the lots were already short
      // of inventory before this call. Failing loudly is right: silently
      // continuing would leave db:verify broken with no record of why.
      if (toConsume > 0) {
        throw new LotShortfall(toConsume);
      }
    }

    const txn = await tx.inventoryTransaction.create({
      data: {
        yardId,
        skuId,
        changeKg,
        type: "STOCK_ADJUSTMENT",
        // The reason lives in the audit log; refId points at the lot created for
        // an increase so the found stock is traceable back to this correction.
        refId: lotId,
        refType: lotId ? "InventoryLot" : null,
        byUserId: user.id,
      },
    });

    return { txnId: txn.id, lotId };
  }).catch((e: unknown) => {
    if (e instanceof LotShortfall) return { shortfall: e.kg };
    throw e;
  });

  if ("shortfall" in result) {
    return fail(
      "LOT_SHORTFALL",
      `${sku.name} has ${result.shortfall} kg less in its batches than in its inventory total, so it cannot be reduced without first repairing the batches. Nothing was changed.`,
      409
    );
  }

  await audit({
    action: "stock.adjust",
    entity: "Inventory",
    entityId: skuId,
    yardId,
    actorId: user.id,
    before: { quantityKg: currentKg },
    after: { quantityKg: actualKg, changeKg, reason, transactionId: result.txnId },
    req,
  });

  // Owner and Manager stock screens update with no refresh and no polling.
  publishMany(yardId, [
    { channel: "stock", action: "updated", entity: "Sku", entityId: skuId, actorId: user.id },
    // A correction can push a SKU over or under its sale threshold.
    { channel: "sales", action: "updated", entity: "Sku", entityId: skuId, actorId: user.id },
  ]);

  return ok({
    adjustment: {
      skuId,
      skuName: sku.name,
      yardCode: yard.yardCode,
      previousKg: currentKg,
      newKg: actualKg,
      changeKg,
      reason,
      transactionId: result.txnId,
      lotId: result.lotId,
    },
  });
}

/** Signals that the batches cannot cover a decrease, so the whole txn rolls back. */
class LotShortfall extends Error {
  constructor(readonly kg: number) {
    super(`lot shortfall of ${kg} kg`);
  }
}
