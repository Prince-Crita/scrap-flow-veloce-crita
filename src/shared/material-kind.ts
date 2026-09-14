/**
 * Mixed / Main-category material vs. Direct sub-material — in one place.
 *
 * ── Why there is no new column ────────────────────────────────────────────────
 * The schema already carries this fact, and has since the first migration:
 *
 *   • `Material`            — the MAIN CATEGORY ("PET Plastic", "MS Scrap").
 *   • `Sku.materialId`      — which main category a material belongs to.
 *   • `Sku.isMixedBucket`   — true for the category's unsorted bucket
 *                             ("PET Mixed", "Mixed MS"), false for a finished
 *                             sub-material ("PET White", "MS Bazar").
 *
 * `isMixedBucket` was already the authority for the segregation tree
 * (`/api/sort-types` builds targets from `isMixedBucket: false`), for stock
 * readiness (`/api/stock`: `!isMixedBucket && qty >= threshold`) and for the
 * sort source (`/api/sort/complete`: the source must be a mixed bucket). So the
 * business rule this module names is not new — it is the rule the yard has been
 * running on, applied one step earlier, at Inward.
 *
 * Adding a second flag would create a way for two columns to disagree about the
 * same material, and every historical row would need back-filling. Nothing here
 * inspects a NAME: "Mixed" appearing in a label is a coincidence of how yards
 * name things, not a fact about the material.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 *   MIXED  (isMixedBucket)  → inward stock lands in the bucket, and the load
 *                             line stays RECEIVED until Sort segregates it.
 *   DIRECT (!isMixedBucket) → inward stock lands straight in that sub-material,
 *                             and the line owes Sort nothing.
 */

/** The minimum a caller needs to know to classify a material. */
export type MaterialKindInput = { isMixedBucket: boolean };

export type MaterialKind = "MIXED" | "DIRECT";

export function materialKind(sku: MaterialKindInput): MaterialKind {
  return sku.isMixedBucket ? "MIXED" : "DIRECT";
}

/**
 * Does a load line booked against this material still owe segregation?
 *
 * The single question Sort asks. A direct sub-material arrived already in its
 * finished grade, so there is nothing to segregate it INTO — it is not "hidden"
 * from Sort, it is genuinely not a candidate.
 */
export function requiresSort(sku: MaterialKindInput): boolean {
  return sku.isMixedBucket;
}

/**
 * The status an inward line is created with.
 *
 * `LoadStatus` already models exactly this: RECEIVED means "segregation
 * outstanding" and SEGREGATED means "no segregation outstanding" — which is why
 * every existing reader (`/api/sort/pending`, the admin "Pending sort" counters,
 * `/api/stock/summary`) stays correct without being touched. A direct line is
 * born with its segregation obligation already discharged, so it never inflates
 * a pending-sort count and never reaches the Sort queue.
 *
 * This is the reason no third enum value was added: a new `LoadStatus` would
 * have made every one of those `status === "RECEIVED"` readers ambiguous.
 */
export function initialLineStatus(sku: MaterialKindInput): "RECEIVED" | "SEGREGATED" {
  return requiresSort(sku) ? "RECEIVED" : "SEGREGATED";
}

/**
 * A load is pending sort when ANY of its lines is. A vehicle carrying mixed PET
 * and direct PET White is pending sort because of the mixed line alone; one
 * carrying only direct sub-materials is finished the moment it is saved.
 */
export function initialLoadStatus(skus: MaterialKindInput[]): "RECEIVED" | "SEGREGATED" {
  return skus.some(requiresSort) ? "RECEIVED" : "SEGREGATED";
}
