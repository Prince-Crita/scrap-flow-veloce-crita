import { z } from "zod";

/**
 * What an ADMIN may edit on an existing yard record, and what they may not.
 *
 * ── Why there is a boundary at all ───────────────────────────────────────────
 * "Admin can edit any record" is honoured for every descriptive and
 * administrative field. It is deliberately NOT honoured for the four quantities
 * that the inventory ledger is derived from:
 *
 *     InwardLoad.totalKg / WeightEntry.kg
 *     SegregationRun.wastageKg / SegregationAllocation.kg
 *     Sale.quantityKg / ratePerKg / subtotal / gstAmount / total
 *     Inventory.quantityKg / InventoryLot.remainingKg
 *
 * Those numbers are already reflected in Inventory running totals, InventoryLot
 * batch remainders, and InventoryTransaction history. Editing one column in
 * place would silently desynchronise the other three, and the resulting stock
 * figures would be wrong in a way nobody could detect or reconstruct — the exact
 * class of corruption that traceability exists to prevent.
 *
 * Correcting a quantity is a business event, not a text edit: it needs a
 * compensating transaction (a reversal plus a re-entry) so the ledger still adds
 * up and the correction is itself auditable. That belongs in a purpose-built
 * "adjustment" flow with its own TxnType, which is scoped as follow-on work
 * rather than smuggled in behind a generic field editor. Until it exists this
 * module refuses those fields with an explanatory error instead of quietly
 * accepting them.
 *
 * Everything an admin edits here is audited with before/after values.
 */

export const EDITABLE_ENTITIES = [
  "vendor",
  "buyer",
  "material",
  "sku",
  "inwardLoad",
  "outwardLoad",
  "sale",
  "receivable",
] as const;

export type EditableEntity = (typeof EDITABLE_ENTITIES)[number];

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** Per-entity whitelist. A field absent from the schema is rejected by zod. */
export const RECORD_SCHEMAS = {
  vendor: z.object({
    name: z.string().trim().min(2).max(120).optional(),
    gstNumber: optionalText(20),
    phone: optionalText(15),
    address: optionalText(300),
    active: z.boolean().optional(),
  }),
  buyer: z.object({
    name: z.string().trim().min(2).max(120).optional(),
    gstNumber: optionalText(20),
    phone: optionalText(15),
    address: optionalText(300),
  }),
  material: z.object({
    name: z.string().trim().min(2).max(60).optional(),
    category: optionalText(60),
    active: z.boolean().optional(),
  }),
  sku: z.object({
    name: z.string().trim().min(2).max(60).optional(),
    icon: z.string().trim().min(1).max(8).optional(),
    saleThresholdKg: z.number().int().min(1).max(10_000_000).optional(),
    visible: z.boolean().optional(),
  }),
  inwardLoad: z.object({
    vendorId: z.string().min(1).nullable().optional(),
    vehicleNumber: optionalText(20),
    vehicleType: optionalText(30),
    driverName: optionalText(80),
  }),
  /**
   * A dispatch's descriptive fields only. `totalKg` is excluded by
   * LEDGER_FIELDS below: it is the sum of the load's lines, and each line has
   * already deducted inventory and consumed FIFO batches. Correcting a
   * dispatched weight needs the stock-adjustment flow, not a field edit.
   */
  outwardLoad: z.object({
    vehicleNumber: optionalText(20),
    vehicleType: optionalText(30),
    driverName: optionalText(80),
  }),
  sale: z.object({
    vehicleNumber: optionalText(20),
    driverName: optionalText(80),
    driverPhone: optionalText(15),
    status: z.enum(["DRAFT", "DISPATCHED"]).optional(),
  }),
  receivable: z.object({
    status: z.enum(["PENDING", "PARTIAL", "PAID"]).optional(),
  }),
} satisfies Record<EditableEntity, z.ZodTypeAny>;

/** Fields that look editable but would desynchronise the ledger. */
export const LEDGER_FIELDS = new Set([
  "totalKg",
  "kg",
  "quantityKg",
  "remainingKg",
  "originalKg",
  "wastageKg",
  "wastagePct",
  "ratePerKg",
  "subtotal",
  "gstRate",
  "gstAmount",
  "total",
  "amount",
  "yardId", // tenancy is never editable through a record editor
  "invoiceNumber",
  "lotNumber",
  // Dispatch quantities: each one has already moved stock and consumed batches.
  "dispatchedKg",
  "dispatchStatus",
  "dispatchNumber",
]);

export function findLedgerFields(payload: Record<string, unknown>): string[] {
  return Object.keys(payload).filter((k) => LEDGER_FIELDS.has(k));
}

/** Which realtime channel a change to this entity should notify. */
export const ENTITY_CHANNEL: Record<
  EditableEntity,
  "stock" | "inward" | "outward" | "sales" | "vendors" | "materials"
> = {
  vendor: "vendors",
  buyer: "sales",
  material: "materials",
  sku: "stock",
  inwardLoad: "inward",
  outwardLoad: "outward",
  sale: "sales",
  receivable: "sales",
};

/** Prisma model name for each editable entity. */
export const ENTITY_MODEL: Record<EditableEntity, string> = {
  vendor: "Vendor",
  buyer: "Buyer",
  material: "Material",
  sku: "Sku",
  inwardLoad: "InwardLoad",
  outwardLoad: "OutwardLoad",
  sale: "Sale",
  receivable: "Receivable",
};
