import type { ScopedDb } from "@/backend/db/tenant";

/**
 * "Is anything pointing at this SKU?" — the single implementation.
 *
 * Permanent deletion is only ever safe when a row is genuinely unreferenced.
 * Materials and sort types both need that answer, and they must agree: a rule
 * that lives in two routes will eventually diverge, and the version that drifts
 * is the one that erases a row still hanging off a sale.
 *
 * Every table that can hold a `skuId` is counted explicitly rather than relying
 * on a foreign-key error, so a refusal can name what is holding the row. Adding a
 * new table that references Sku means adding it here — the count is the contract.
 */

/**
 * The tenant-scoped client. Taking `ScopedDb` rather than a bare `PrismaClient`
 * is deliberate: these counts decide whether a row may be erased, and they must
 * be answered inside the caller's yard. An unscoped client would count another
 * tenant's rows and could refuse — or worse, permit — for the wrong reason.
 */
type Db = ScopedDb;

export type SkuReferences = {
  /** Per-table counts, for a message that says which table is holding the row. */
  counts: Record<string, number>;
  /** Total references across every table. Zero means erasable. */
  total: number;
  /** Kilograms still on hand. Non-zero blocks deletion even with zero references. */
  stockKg: number;
};

export async function countSkuReferences(db: Db, skuIds: string[]): Promise<SkuReferences> {
  if (skuIds.length === 0) return { counts: {}, total: 0, stockKg: 0 };

  const inIds = { skuId: { in: skuIds } };
  const [loadLines, lots, txns, sales, runs, allocs, weights, outwardLines, stock] = await Promise.all([
    db.inwardLoadLine.count({ where: inIds }),
    db.inventoryLot.count({ where: inIds }),
    db.inventoryTransaction.count({ where: inIds }),
    db.sale.count({ where: inIds }),
    db.segregationRun.count({ where: { sourceSkuId: { in: skuIds } } }),
    db.segregationAllocation.count({ where: inIds }),
    db.weightEntry.count({ where: inIds }),
    // Outward (Phase 4). Omitting this would let a dispatched SKU be erased.
    db.outwardLoadLine.count({ where: inIds }),
    db.inventory.aggregate({ where: inIds, _sum: { quantityKg: true } }),
  ]);

  const counts = {
    "load lines": loadLines,
    "stock batches": lots,
    "ledger entries": txns,
    sales: sales,
    "segregation runs": runs,
    "segregation allocations": allocs,
    weighments: weights,
    dispatches: outwardLines,
  };

  return {
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    stockKg: stock._sum.quantityKg ?? 0,
  };
}

/** Human-readable list of what is holding the row, for a refusal message. */
export function describeReferences(refs: SkuReferences): string {
  return (
    Object.entries(refs.counts)
      .filter(([, n]) => n > 0)
      .map(([table, n]) => `${n} ${table}`)
      .join(", ") || "no linked records"
  );
}
