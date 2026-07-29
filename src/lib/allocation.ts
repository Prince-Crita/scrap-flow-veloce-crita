import type { DispatchStatus } from "@prisma/client";

/**
 * Sale allocations — the shared vocabulary between Sell and Outward.
 *
 * A sale RESERVES stock; the kilograms only leave inventory when a vehicle is
 * physically loaded. That split is what makes partial dispatch possible, and it
 * means "available to sell" is no longer the same number as "physically here".
 *
 * ── The legacy rule ─────────────────────────────────────────────────────────
 * `Sale.dispatchedKg === null` marks a sale created BEFORE Outward existed. Its
 * stock was already deducted at sale time, so it is treated as fully dispatched
 * and never appears in the outward queue. No historical row was rewritten to
 * introduce this model — the same approach used for inward line items.
 */

/** A sale that has not been fully loaded still holds stock back. */
export type AllocationLike = {
  quantityKg: number;
  dispatchedKg: number | null;
};

/** Pre-Outward sale: stock already left, nothing to dispatch. */
export function isLegacySale(sale: AllocationLike): boolean {
  return sale.dispatchedKg === null;
}

/** Kilograms still to be loaded. Always 0 for a legacy sale. */
export function remainingKg(sale: AllocationLike): number {
  if (isLegacySale(sale)) return 0;
  return Math.max(0, sale.quantityKg - (sale.dispatchedKg ?? 0));
}

/**
 * Status derived from the numbers rather than trusted from the column, so a
 * stored value can never contradict the quantities it is meant to describe.
 */
export function dispatchStatusFor(sale: AllocationLike): DispatchStatus {
  if (isLegacySale(sale)) return "COMPLETED";
  const done = sale.dispatchedKg ?? 0;
  if (done <= 0) return "PENDING";
  if (done >= sale.quantityKg) return "COMPLETED";
  return "PARTIAL";
}

/**
 * How much of a SKU's physical stock is spoken for by undispatched sales.
 *
 * Selling against stock that is already promised to another invoice is the
 * failure this prevents: the yard would accept an order it cannot load.
 */
export function reservedKg(sales: AllocationLike[]): number {
  return sales.reduce((total, s) => total + remainingKg(s), 0);
}

/**
 * Stock the owner may still sell: physically present, minus what is already
 * promised. Never negative — a yard that over-committed shows 0, not a deficit.
 */
export function sellableKg(physicalKg: number, sales: AllocationLike[]): number {
  return Math.max(0, physicalKg - reservedKg(sales));
}

/**
 * Can this dispatch be accepted? Returns the reason when it cannot, so the
 * caller reports something the operator can act on rather than a bare refusal.
 */
export function validateDispatch(
  sale: AllocationLike,
  requestedKg: number,
  physicalKg: number
): { ok: true } | { ok: false; code: string; message: string } {
  if (isLegacySale(sale)) {
    return { ok: false, code: "LEGACY_SALE", message: "This sale was completed before dispatch tracking existed" };
  }
  if (requestedKg <= 0) {
    return { ok: false, code: "EMPTY_DISPATCH", message: "Enter a weight first" };
  }
  const left = remainingKg(sale);
  if (left === 0) {
    return { ok: false, code: "ALREADY_COMPLETE", message: "This allocation is already fully dispatched" };
  }
  if (requestedKg > left) {
    return {
      ok: false,
      code: "OVER_ALLOCATION",
      message: `Only ${left} kg left on this allocation`,
    };
  }
  if (requestedKg > physicalKg) {
    return {
      ok: false,
      code: "INSUFFICIENT_STOCK",
      message: `Only ${physicalKg} kg physically in stock`,
    };
  }
  return { ok: true };
}
