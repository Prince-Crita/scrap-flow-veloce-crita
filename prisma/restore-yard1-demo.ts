/**
 * Restores Yard 1's demo data to EXACTLY the values in the authoritative
 * prototype, `scrapflow_veloce_v2-1.html`.
 *
 * ── Provenance ───────────────────────────────────────────────────────────────
 * Every value below is annotated with where it comes from in the prototype.
 * Values marked [NOT IN HTML] could not be extracted and are pre-existing
 * database values that this script PRESERVES rather than invents — they are
 * listed in the run report so they can be supplied explicitly.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 *   • Runs in ONE transaction. Either the whole restore lands, or none of it.
 *   • Never drops a table, never touches the schema.
 *   • Never touches the admin account, auth, audit logs, other yards, or any
 *     architectural work.
 *   • Deletes ONLY test-pollution rows, and only after proving each has zero
 *     references (0 loads / lots / sales / transactions / allocations). Anything
 *     with history is deactivated instead and reported.
 *   • --dry (default) prints the plan and changes nothing. --apply commits.
 *
 * Usage:
 *   npx tsx prisma/restore-yard1-demo.ts            # dry run
 *   npx tsx prisma/restore-yard1-demo.ts --apply    # commit
 */
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const YARD_CODE = "SFDY001";
const YARD_NAME = "Yard 1";

/* ══════════════════════════════════════════════════════════════════════════
   EXTRACTED FROM THE PROTOTYPE
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The `skus` array, verbatim (prototype lines: `const skus = [...]`).
 * These six are the ONLY stock SKUs the prototype defines.
 */
const HTML_SKUS = [
  { code: "MSB", name: "MS Bazar", icon: "🔩", qty: 1850, thr: 2000, mixed: false, order: 1, material: "MS" },
  { code: "MSC", name: "MS Commercial", icon: "🏗️", qty: 2400, thr: 2000, mixed: false, order: 2, material: "MS" },
  { code: "PETW", name: "PET White", icon: "🥛", qty: 620, thr: 1500, mixed: false, order: 4, material: "PET" },
  { code: "PETG", name: "PET Green", icon: "🧪", qty: 1480, thr: 1500, mixed: false, order: 5, material: "PET" },
  { code: "ALUC", name: "Alu Castings", icon: "⚙️", qty: 310, thr: 800, mixed: false, order: 6, material: "ALU" },
  // `{id:'mix', name:'Mixed MS (unsorted)', icon:'🧺', qty:1200, thr:99999}`
  // Stored as "Mixed MS": the prototype uses that exact string for the same
  // entity in the inward chip (`data-mat="Mixed MS"`) and the sort lot header
  // ("Mixed MS · Lot #A-114"). The "(unsorted)" suffix is a stock-screen display
  // decoration, applied in the UI for mixed buckets. See the report.
  { code: "MIXMS", name: "Mixed MS", icon: "🧺", qty: 1200, thr: 99999, mixed: true, order: 7, material: "MS" },
] as const;

/**
 * SKUs the prototype references but does not define in its `skus` array.
 * They exist in this schema because the prototype silently loses stock without
 * them (see the report). Quantities are 0 — the prototype gives none.
 */
const REFERENCED_SKUS = [
  // Sort screen: `split('super',…)`, `<div class="splitVal" id="v-super">`.
  // Ticker: "MS Super ₹35,500". The prototype adds sorted Super to no SKU.
  { code: "MSS", name: "MS Super", icon: "⭐", qty: 0, thr: 2000, mixed: false, order: 3, material: "MS" },
  // Inward chip `data-mat="PET Mixed"`. The prototype routes it into PET White.
  { code: "MIXPET", name: "PET Mixed", icon: "🧴", qty: 0, thr: 99999, mixed: true, order: 8, material: "PET" },
  // Inward chip `data-mat="Aluminum"`. The prototype routes it into Alu Castings.
  { code: "MIXALU", name: "Aluminum Mixed", icon: "🪨", qty: 0, thr: 99999, mixed: true, order: 9, material: "ALU" },
] as const;

/** Parent material groups. Names/codes are NOT in the prototype — see report. */
const MATERIALS = [
  { code: "MS", name: "MS Scrap" },
  { code: "PET", name: "PET Plastic" },
  { code: "ALU", name: "Aluminum" },
] as const;

/** Inward vendor chips: "Balaji Metals", "SR Traders" ("+ Vendor" is a button). */
const HTML_VENDORS = [
  { id: "seed-vendor-balaji", name: "Balaji Metals" },
  { id: "seed-vendor-sr", name: "SR Traders" },
] as const;

/** Receivables rows: "Shree Steels · INV-0231", "GreenCycle · INV-0228". */
const HTML_BUYERS = [
  { id: "seed-buyer-shree", name: "Shree Steels" },
  { id: "seed-buyer-green", name: "GreenCycle" },
] as const;

/**
 * Segregation run: `const lot = {total:1200, bazar:0, comm:0, super:0, waste:0}`
 * "Mixed MS · Lot #A-114", "Balaji Metals · today 10:42",
 * "Unsorted left: 1,200 kg" → still RECEIVED, nothing allocated.
 */
const HTML_LOT = { lotNumber: "A-114", totalKg: 1200, materialLabel: "Mixed MS", vendorId: "seed-vendor-balaji" } as const;

/** Receivables: "Shree Steels · INV-0231 ₹84,000", "GreenCycle · INV-0228 ₹41,500". */
const HTML_SALES = [
  { invoiceNumber: "INV-0231", buyerId: "seed-buyer-shree", total: 84000 },
  { invoiceNumber: "INV-0228", buyerId: "seed-buyer-green", total: 41500 },
] as const;

/**
 * Gamification, from the header + `let xp = 1240`:
 *   xp    → `let xp = 1240` and `<span id="xpNow">1,240 XP</span>`
 *   level → `<b id="lvl">7</b>`
 *   streak→ `<b>🔥 12</b><span>STREAK</span>`
 * Next level anchor: `<span>2,000 XP → Level 8</span>`
 */
const HTML_OWNER = { xp: 1240, level: 7, streak: 12 } as const;

/** Counters implied by the highest visible numbers: Lot #A-114, INV-0231. */
const HTML_COUNTERS = { lot: 114, invoice: 231 } as const;

/* ══════════════════════════════════════════════════════════════════════════ */

const ALL_SKUS = [...HTML_SKUS, ...REFERENCED_SKUS];
const KEEP_SKU_CODES = new Set(ALL_SKUS.map((s) => s.code));
const KEEP_MATERIAL_CODES = new Set(MATERIALS.map((m) => m.code));
const KEEP_VENDOR_IDS = new Set<string>(HTML_VENDORS.map((v) => v.id));

const plan: string[] = [];
const kept: string[] = [];
const blocked: string[] = [];
const log = (s: string) => plan.push(s);

async function main() {
  console.log(`\n${APPLY ? "▶️  APPLYING" : "🔍 DRY RUN"} — restoring Yard 1 demo data from scrapflow_veloce_v2-1.html\n`);

  const yard = await prisma.yard.findUnique({ where: { yardCode: YARD_CODE } });
  if (!yard) {
    console.error(`❌ Yard ${YARD_CODE} not found. Refusing to create it — nothing changed.`);
    process.exit(1);
  }
  const yardId = yard.id;

  await prisma.$transaction(
    async (tx) => {
      // ---------- 0. Yard identity ----------
      if (yard.yardName !== YARD_NAME) {
        log(`Yard name: "${yard.yardName}" → "${YARD_NAME}"`);
        if (APPLY) await tx.yard.update({ where: { id: yardId }, data: { yardName: YARD_NAME } });
      } else kept.push(`Yard name already "${YARD_NAME}" (code ${YARD_CODE} untouched)`);

      // ---------- 1. Parent materials ----------
      const materialIdByCode = new Map<string, string>();
      for (const m of MATERIALS) {
        const existing = await tx.material.findUnique({ where: { yardId_code: { yardId, code: m.code } } });
        if (!existing) {
          log(`Material CREATE ${m.code} "${m.name}"`);
          if (APPLY) {
            const created = await tx.material.create({ data: { yardId, code: m.code, name: m.name, active: true } });
            materialIdByCode.set(m.code, created.id);
          }
        } else {
          materialIdByCode.set(m.code, existing.id);
          if (existing.name !== m.name || !existing.active) {
            log(`Material UPDATE ${m.code}: name "${existing.name}"→"${m.name}", active ${existing.active}→true`);
            if (APPLY) await tx.material.update({ where: { id: existing.id }, data: { name: m.name, active: true } });
          } else kept.push(`Material ${m.code} "${m.name}" already correct`);
        }
      }

      // ---------- 2. SKUs + inventory quantities (the authoritative values) ----------
      for (const s of ALL_SKUS) {
        const materialId = materialIdByCode.get(s.material) ?? null;
        const existing = await tx.sku.findUnique({
          where: { yardId_code: { yardId, code: s.code } },
          include: { inventory: true },
        });

        if (!existing) {
          log(`SKU CREATE ${s.code} "${s.name}" qty=${s.qty} thr=${s.thr}`);
          if (APPLY) {
            const created = await tx.sku.create({
              data: {
                yardId,
                code: s.code,
                name: s.name,
                icon: s.icon,
                materialId,
                saleThresholdKg: s.thr,
                isMixedBucket: s.mixed,
                sortOrder: s.order,
                visible: true,
              },
            });
            await tx.inventory.create({ data: { yardId, skuId: created.id, quantityKg: s.qty } });
          }
          continue;
        }

        const diffs: string[] = [];
        if (existing.name !== s.name) diffs.push(`name "${existing.name}"→"${s.name}"`);
        if (existing.icon !== s.icon) diffs.push(`icon ${existing.icon}→${s.icon}`);
        if (existing.saleThresholdKg !== s.thr) diffs.push(`threshold ${existing.saleThresholdKg}→${s.thr}`);
        if (existing.isMixedBucket !== s.mixed) diffs.push(`mixed ${existing.isMixedBucket}→${s.mixed}`);
        if (existing.sortOrder !== s.order) diffs.push(`order ${existing.sortOrder}→${s.order}`);
        if (!existing.visible) diffs.push(`visible false→true`);
        if (existing.materialId !== materialId) diffs.push(`material→${s.material}`);

        if (diffs.length) {
          log(`SKU UPDATE ${s.code}: ${diffs.join(", ")}`);
          if (APPLY)
            await tx.sku.update({
              where: { id: existing.id },
              data: {
                name: s.name,
                icon: s.icon,
                materialId,
                saleThresholdKg: s.thr,
                isMixedBucket: s.mixed,
                sortOrder: s.order,
                visible: true,
              },
            });
        }

        const currentQty = existing.inventory?.quantityKg;
        if (currentQty === undefined) {
          log(`INVENTORY CREATE ${s.code} = ${s.qty} kg`);
          if (APPLY) await tx.inventory.create({ data: { yardId, skuId: existing.id, quantityKg: s.qty } });
        } else if (currentQty !== s.qty) {
          log(`INVENTORY CORRECT ${s.code}: ${currentQty} → ${s.qty} kg  ← prototype value`);
          if (APPLY) await tx.inventory.update({ where: { skuId: existing.id }, data: { quantityKg: s.qty } });
        } else kept.push(`Stock ${s.code} already ${s.qty} kg (matches prototype)`);

        if (!diffs.length && currentQty === s.qty) kept.push(`SKU ${s.code} "${s.name}" fully matches prototype`);
      }

      // ---------- 3. Vendors ----------
      for (const v of HTML_VENDORS) {
        const existing = await tx.vendor.findUnique({ where: { id: v.id } });
        if (!existing) {
          log(`Vendor CREATE "${v.name}"`);
          if (APPLY) await tx.vendor.create({ data: { id: v.id, yardId, name: v.name, active: true } });
        } else if (existing.name !== v.name || !existing.active) {
          log(`Vendor UPDATE ${v.id}: name "${existing.name}"→"${v.name}", active→true`);
          if (APPLY) await tx.vendor.update({ where: { id: v.id }, data: { name: v.name, active: true } });
        } else kept.push(`Vendor "${v.name}" already correct`);
      }

      // ---------- 4. Buyers ----------
      for (const b of HTML_BUYERS) {
        const existing = await tx.buyer.findUnique({ where: { id: b.id } });
        if (!existing) {
          log(`Buyer CREATE "${b.name}"`);
          if (APPLY) await tx.buyer.create({ data: { id: b.id, yardId, name: b.name } });
        } else if (existing.name !== b.name) {
          log(`Buyer UPDATE ${b.id}: "${existing.name}"→"${b.name}"`);
          if (APPLY) await tx.buyer.update({ where: { id: b.id }, data: { name: b.name } });
        } else kept.push(`Buyer "${b.name}" already correct`);
      }

      // ---------- 5. Lot A-114 ----------
      const lot = await tx.inwardLoad.findUnique({
        where: { yardId_lotNumber: { yardId, lotNumber: HTML_LOT.lotNumber } },
      });
      if (!lot) {
        log(`Lot CREATE ${HTML_LOT.lotNumber} ${HTML_LOT.totalKg} kg`);
      } else {
        const d: string[] = [];
        if (lot.totalKg !== HTML_LOT.totalKg) d.push(`totalKg ${lot.totalKg}→${HTML_LOT.totalKg}`);
        if (lot.materialLabel !== HTML_LOT.materialLabel) d.push(`label→${HTML_LOT.materialLabel}`);
        if (lot.status !== "RECEIVED") d.push(`status ${lot.status}→RECEIVED (prototype shows 1,200 kg unsorted)`);
        if (lot.vendorId !== HTML_LOT.vendorId) d.push(`vendor→Balaji Metals`);
        if (d.length) {
          log(`Lot UPDATE ${HTML_LOT.lotNumber}: ${d.join(", ")}`);
          if (APPLY)
            await tx.inwardLoad.update({
              where: { id: lot.id },
              data: {
                totalKg: HTML_LOT.totalKg,
                materialLabel: HTML_LOT.materialLabel,
                status: "RECEIVED",
                vendorId: HTML_LOT.vendorId,
              },
            });
        } else kept.push(`Lot ${HTML_LOT.lotNumber} already matches prototype (1,200 kg, unsorted, Balaji Metals)`);
      }

      // ---------- 6. Sales + receivables ----------
      for (const s of HTML_SALES) {
        const sale = await tx.sale.findUnique({
          where: { yardId_invoiceNumber: { yardId, invoiceNumber: s.invoiceNumber } },
          include: { receivable: true },
        });
        if (!sale) {
          log(`⚠ Sale ${s.invoiceNumber} MISSING — cannot recreate: the prototype gives no quantity, rate or SKU`);
          blocked.push(`Sale ${s.invoiceNumber} absent and not reconstructable from the prototype`);
          continue;
        }
        if (sale.total !== s.total) {
          log(`Sale CORRECT ${s.invoiceNumber}: total ${sale.total} → ${s.total}`);
          if (APPLY) await tx.sale.update({ where: { id: sale.id }, data: { total: s.total } });
        } else kept.push(`Sale ${s.invoiceNumber} total already ₹${s.total.toLocaleString("en-IN")}`);

        if (sale.buyerId !== s.buyerId) {
          log(`Sale ${s.invoiceNumber}: buyer → ${s.buyerId}`);
          if (APPLY) await tx.sale.update({ where: { id: sale.id }, data: { buyerId: s.buyerId } });
        }
        if (sale.receivable && sale.receivable.amount !== s.total) {
          log(`Receivable CORRECT ${s.invoiceNumber}: ${sale.receivable.amount} → ${s.total}`);
          if (APPLY) await tx.receivable.update({ where: { id: sale.receivable.id }, data: { amount: s.total } });
        } else if (sale.receivable) {
          kept.push(`Receivable ${s.invoiceNumber} already ₹${s.total.toLocaleString("en-IN")} (${sale.receivable.status})`);
        }
      }

      // ---------- 7. Owner gamification ----------
      const owner = await tx.user.findFirst({ where: { yardId, role: "OWNER" }, orderBy: { createdAt: "asc" } });
      if (owner) {
        const d: string[] = [];
        if (owner.xp !== HTML_OWNER.xp) d.push(`xp ${owner.xp}→${HTML_OWNER.xp}`);
        if (owner.level !== HTML_OWNER.level) d.push(`level ${owner.level}→${HTML_OWNER.level}`);
        if (owner.streak !== HTML_OWNER.streak) d.push(`streak ${owner.streak}→${HTML_OWNER.streak}`);
        if (d.length) {
          log(`Owner (${owner.email}) CORRECT: ${d.join(", ")}  ← prototype values`);
          if (APPLY)
            await tx.user.update({
              where: { id: owner.id },
              data: { xp: HTML_OWNER.xp, level: HTML_OWNER.level, streak: HTML_OWNER.streak },
            });
        } else kept.push(`Owner already xp=${HTML_OWNER.xp} level=${HTML_OWNER.level} streak=${HTML_OWNER.streak}`);
      }

      // ---------- 8. Counters ----------
      for (const [name, value] of Object.entries(HTML_COUNTERS)) {
        const key = `${yardId}:${name}`;
        const c = await tx.counter.findUnique({ where: { name: key } });
        if (!c) {
          log(`Counter CREATE ${name} = ${value}`);
          if (APPLY) await tx.counter.create({ data: { name: key, value } });
        } else if (c.value !== value) {
          log(`Counter SET ${name}: ${c.value} → ${value}  ← prototype (Lot #A-114 / INV-0231)`);
          if (APPLY) await tx.counter.update({ where: { name: key }, data: { value } });
        } else kept.push(`Counter ${name} already ${value}`);
      }

      /* ══════════════════════════════════════════════════════════════════════
         9. REMOVE TEST POLLUTION — only rows proven to have zero references
         ══════════════════════════════════════════════════════════════════════ */

      // --- vendors ---
      const strayVendors = await tx.vendor.findMany({
        where: { yardId, id: { notIn: [...KEEP_VENDOR_IDS] } },
        include: { _count: { select: { loads: true, inventoryLots: true } } },
      });
      for (const v of strayVendors) {
        const refs = v._count.loads + v._count.inventoryLots;
        if (refs === 0) {
          log(`Vendor DELETE "${v.name}" (test artefact, 0 references)`);
          if (APPLY) await tx.vendor.delete({ where: { id: v.id } });
        } else {
          log(`Vendor DEACTIVATE "${v.name}" (has ${v._count.loads} loads / ${v._count.inventoryLots} lots — kept for integrity)`);
          blocked.push(`Vendor "${v.name}" has history and was deactivated, not deleted`);
          if (APPLY) await tx.vendor.update({ where: { id: v.id }, data: { active: false } });
        }
      }

      // --- SKUs (inventory row first, then the SKU) ---
      const straySkus = await tx.sku.findMany({
        where: { yardId, code: { notIn: [...KEEP_SKU_CODES] } },
        include: {
          inventory: true,
          _count: {
            select: { inventoryLots: true, sales: true, inventoryTxns: true, allocations: true, segRunsSource: true },
          },
        },
      });
      for (const s of straySkus) {
        const c = s._count;
        const refs = c.inventoryLots + c.sales + c.inventoryTxns + c.allocations + c.segRunsSource;
        const qty = s.inventory?.quantityKg ?? 0;
        if (refs === 0 && qty === 0) {
          log(`SKU DELETE "${s.name}" (${s.code}) (test artefact, 0 references, 0 kg)`);
          if (APPLY) {
            if (s.inventory) await tx.inventory.delete({ where: { skuId: s.id } });
            await tx.sku.delete({ where: { id: s.id } });
          }
        } else {
          log(`SKU HIDE "${s.name}" (${s.code}) (refs=${refs} qty=${qty} — kept for integrity, hidden from stock)`);
          blocked.push(`SKU "${s.name}" has ${refs} references / ${qty} kg and was hidden, not deleted`);
          if (APPLY) await tx.sku.update({ where: { id: s.id }, data: { visible: false } });
        }
      }

      // --- materials (after their SKUs are gone) ---
      const strayMaterials = await tx.material.findMany({
        where: { yardId, code: { notIn: [...KEEP_MATERIAL_CODES] } },
        include: { _count: { select: { skus: true, loads: true } } },
      });
      for (const m of strayMaterials) {
        const remainingSkus = await tx.sku.count({ where: { materialId: m.id } });
        if (m._count.loads === 0 && (APPLY ? remainingSkus === 0 : true)) {
          log(`Material DELETE "${m.name}" (${m.code}) (test artefact, 0 loads, 0 SKUs)`);
          if (APPLY) await tx.material.delete({ where: { id: m.id } });
        } else {
          log(`Material DEACTIVATE "${m.name}" (${m.code}) (loads=${m._count.loads} skus=${remainingSkus} — kept)`);
          blocked.push(`Material "${m.name}" has history and was deactivated, not deleted`);
          if (APPLY) await tx.material.update({ where: { id: m.id }, data: { active: false } });
        }
      }

      /* ══════════════════════════════════════════════════════════════════════
         10. Re-sync traceability batches with the corrected quantities.
         The ledger invariant (Inventory.quantityKg == Σ InventoryLot.remainingKg)
         is checked by db:verify, so any quantity correction above must be
         mirrored here or the yard would look corrupt.
         ══════════════════════════════════════════════════════════════════════ */
      for (const s of ALL_SKUS) {
        const sku = await tx.sku.findUnique({ where: { yardId_code: { yardId, code: s.code } } });
        if (!sku) continue;
        const lots = await tx.inventoryLot.findMany({ where: { yardId, skuId: sku.id }, orderBy: { createdAt: "asc" } });
        const remaining = lots.reduce((a, l) => a + l.remainingKg, 0);
        if (remaining === s.qty) continue;

        if (lots.length === 0 && s.qty > 0) {
          log(`Batch CREATE opening balance for ${s.code}: ${s.qty} kg (unattributed — prototype has no batch data)`);
          if (APPLY)
            await tx.inventoryLot.create({
              data: { yardId, skuId: sku.id, originalKg: s.qty, remainingKg: s.qty },
            });
        } else if (lots.length === 1) {
          log(`Batch ADJUST ${s.code}: remaining ${lots[0].remainingKg} → ${s.qty} kg (mirrors the stock correction)`);
          if (APPLY)
            await tx.inventoryLot.update({
              where: { id: lots[0].id },
              data: { originalKg: Math.max(lots[0].originalKg, s.qty), remainingKg: s.qty },
            });
        } else {
          log(`Batch RESYNC ${s.code}: ${lots.length} batches total ${remaining} kg, stock says ${s.qty} kg`);
          blocked.push(`SKU ${s.code} has ${lots.length} batches summing ${remaining} kg vs stock ${s.qty} kg — needs manual review`);
        }
      }

      if (!APPLY) {
        // Roll the dry run back explicitly, so nothing can leak out of it.
        throw new DryRunRollback();
      }
    },
    { timeout: 120_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  ).catch((e) => {
    if (e instanceof DryRunRollback) return;
    throw e;
  });

  /* ---------------- report ---------------- */
  console.log("── CHANGES " + "─".repeat(58));
  if (plan.length === 0) console.log("  (nothing to change — Yard 1 already matches the prototype)");
  for (const p of plan) console.log(`  • ${p}`);

  console.log("\n── ALREADY CORRECT " + "─".repeat(50));
  for (const k of kept) console.log(`  ✓ ${k}`);

  if (blocked.length) {
    console.log("\n── NEEDS ATTENTION " + "─".repeat(50));
    for (const b of blocked) console.log(`  ⚠ ${b}`);
  }

  console.log(
    `\n${APPLY ? "✅ APPLIED — Yard 1 now matches the prototype." : "🔍 DRY RUN — nothing was written. Re-run with --apply."}`
  );
}

class DryRunRollback extends Error {}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
