/**
 * READ-ONLY: compares Yard 1's current contents against a backup taken by
 * prisma/backup.ts, row by row, on the columns that matter operationally.
 *
 * This is the proof that a refactor changed no production data. It reads the
 * backup's data.json, filters it to Yard 1, and diffs against the live rows.
 *
 * Usage: npx tsx prisma/compare-baseline.ts <backupDir>
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient();

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: npx tsx prisma/compare-baseline.ts <backupDir>");
  process.exit(1);
}

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (pass) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label} ${detail}`);
  }
};

type Row = Record<string, unknown>;

async function main() {
  const dump = JSON.parse(readFileSync(join(dir, "data.json"), "utf8")) as Record<string, Row[]>;
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    takenAt: string;
    rowCounts: Record<string, number>;
  };

  console.log(`🔍 Comparing live Yard 1 against backup from ${manifest.takenAt}\n`);

  // The backup predates the rename, so identify the yard by its immutable code.
  const backupYard = dump.Yard.find((y) => y.yardCode === "SFDY001");
  if (!backupYard) {
    console.error("Backup has no SFDY001 yard — wrong backup directory?");
    process.exit(1);
  }
  const yardId = backupYard.id as string;

  const live = await prisma.yard.findUnique({ where: { yardCode: "SFDY001" } });
  check("Yard SFDY001 still exists", !!live);
  check("yard id is unchanged", live?.id === yardId, `${live?.id} vs ${yardId}`);
  check("yard is renamed to 'Yard 1'", live?.yardName === "Yard 1", live?.yardName);
  check("yard is still active", live?.active === true);
  check("city preserved", live?.city === backupYard.city);
  check("state preserved", live?.state === backupYard.state);

  // ---- row counts, scoped to Yard 1 ----
  console.log("\nRow counts (Yard 1 only):");
  const tables: { name: string; count: () => Promise<number> }[] = [
    { name: "Vendor", count: () => prisma.vendor.count({ where: { yardId } }) },
    { name: "Buyer", count: () => prisma.buyer.count({ where: { yardId } }) },
    { name: "Material", count: () => prisma.material.count({ where: { yardId } }) },
    { name: "Sku", count: () => prisma.sku.count({ where: { yardId } }) },
    { name: "Inventory", count: () => prisma.inventory.count({ where: { yardId } }) },
    { name: "InventoryLot", count: () => prisma.inventoryLot.count({ where: { yardId } }) },
    { name: "InwardLoad", count: () => prisma.inwardLoad.count({ where: { yardId } }) },
    { name: "WeightEntry", count: () => prisma.weightEntry.count({ where: { yardId } }) },
    { name: "InwardLoadLine", count: () => prisma.inwardLoadLine.count({ where: { yardId } }) },
    { name: "OutwardLoad", count: () => prisma.outwardLoad.count({ where: { yardId } }) },
    { name: "OutwardLoadLine", count: () => prisma.outwardLoadLine.count({ where: { yardId } }) },
    { name: "MaterialImage", count: () => prisma.materialImage.count({ where: { yardId } }) },
    { name: "SegregationRun", count: () => prisma.segregationRun.count({ where: { yardId } }) },
    { name: "SegregationAllocation", count: () => prisma.segregationAllocation.count({ where: { yardId } }) },
    { name: "Sale", count: () => prisma.sale.count({ where: { yardId } }) },
    { name: "Receivable", count: () => prisma.receivable.count({ where: { yardId } }) },
    { name: "InventoryTransaction", count: () => prisma.inventoryTransaction.count({ where: { yardId } }) },
  ];

  for (const t of tables) {
    const expected = (dump[t.name] ?? []).filter((r) => r.yardId === yardId).length;
    const actual = await t.count();
    check(`${t.name}: ${actual}`, actual === expected, `expected ${expected}`);
  }

  // ---- inventory quantities, SKU by SKU ----
  console.log("\nInventory quantities per SKU:");
  const liveInv = await prisma.inventory.findMany({
    where: { yardId },
    include: { sku: { select: { code: true, name: true } } },
  });
  const backupInvBySku = new Map(
    (dump.Inventory ?? []).filter((r) => r.yardId === yardId).map((r) => [r.skuId as string, r.quantityKg as number])
  );
  for (const inv of liveInv) {
    const expected = backupInvBySku.get(inv.skuId);
    check(`${inv.sku.name}: ${inv.quantityKg} kg`, inv.quantityKg === expected, `expected ${expected}`);
  }

  // ---- sales and receivables, value by value ----
  console.log("\nSales:");
  const liveSales = await prisma.sale.findMany({ where: { yardId }, orderBy: { invoiceNumber: "asc" } });
  const backupSales = (dump.Sale ?? [])
    .filter((r) => r.yardId === yardId)
    .sort((a, b) => String(a.invoiceNumber).localeCompare(String(b.invoiceNumber)));
  for (let i = 0; i < backupSales.length; i++) {
    const b = backupSales[i];
    const l = liveSales[i];
    check(
      `${b.invoiceNumber}: ${b.quantityKg} kg @ ₹${b.ratePerKg} = ₹${b.total}`,
      !!l && l.invoiceNumber === b.invoiceNumber && l.quantityKg === b.quantityKg && l.total === b.total,
      l ? `live ${l.invoiceNumber}/${l.quantityKg}/${l.total}` : "missing"
    );
  }

  console.log("\nInward loads:");
  const liveLoads = await prisma.inwardLoad.findMany({ where: { yardId }, orderBy: { lotNumber: "asc" } });
  const backupLoads = (dump.InwardLoad ?? [])
    .filter((r) => r.yardId === yardId)
    .sort((a, b) => String(a.lotNumber).localeCompare(String(b.lotNumber)));
  for (let i = 0; i < backupLoads.length; i++) {
    const b = backupLoads[i];
    const l = liveLoads[i];
    check(
      `${b.lotNumber}: ${b.materialLabel} ${b.totalKg} kg (${b.status})`,
      !!l && l.lotNumber === b.lotNumber && l.totalKg === b.totalKg && l.status === b.status,
      l ? `live ${l.lotNumber}/${l.totalKg}/${l.status}` : "missing"
    );
  }

  // ---- users: XP / level / streak ----
  console.log("\nUsers (gamification state):");
  const liveUsers = await prisma.user.findMany({ where: { yardId }, orderBy: { email: "asc" } });
  const backupUsers = (dump.User ?? [])
    .filter((r) => r.yardId === yardId)
    .sort((a, b) => String(a.email).localeCompare(String(b.email)));
  for (const b of backupUsers) {
    const l = liveUsers.find((u) => u.email === b.email);
    check(
      `${b.email}: xp=${b.xp} level=${b.level} streak=${b.streak}`,
      !!l && l.xp === b.xp && l.level === b.level && l.streak === b.streak,
      l ? `live xp=${l.xp} level=${l.level} streak=${l.streak}` : "missing"
    );
  }

  // ---- vendor names ----
  console.log("\nVendors:");
  const liveVendors = await prisma.vendor.findMany({ where: { yardId }, orderBy: { id: "asc" } });
  const backupVendors = (dump.Vendor ?? [])
    .filter((r) => r.yardId === yardId)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const nameMismatch = backupVendors.filter((b) => {
    const l = liveVendors.find((v) => v.id === b.id);
    return !l || l.name !== b.name || l.active !== b.active;
  });
  check(`all ${backupVendors.length} vendors identical (name + active)`, nameMismatch.length === 0,
    nameMismatch.map((v) => v.name).join(", "));

  // ---- counters ----
  console.log("\nCounters:");
  const liveCounters = await prisma.counter.findMany({ where: { name: { startsWith: `${yardId}:` } } });
  const backupCounters = (dump.Counter ?? []).filter((r) => String(r.name).startsWith(`${yardId}:`));
  for (const b of backupCounters) {
    const l = liveCounters.find((c) => c.name === b.name);
    const suffix = String(b.name).split(":")[1];
    // Sequences may only ever move forward, never backwards.
    check(
      `${suffix} counter ≥ ${b.value} (now ${l?.value})`,
      !!l && l.value >= (b.value as number),
      l ? `now ${l.value}` : "missing"
    );
  }

  console.log(
    `\n${failures === 0 ? "✅ YARD 1 IS INTACT — no production data was changed" : `❌ ${failures} DIFFERENCE(S) FOUND`}`
  );
  if (failures > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
