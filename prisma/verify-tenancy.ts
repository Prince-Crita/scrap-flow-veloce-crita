/**
 * READ-ONLY tenancy integrity check. Writes nothing, deletes nothing.
 *
 * Run this before and after any schema or data operation. It is the standing
 * answer to "did anything get orphaned, cross-linked, or lost?".
 *
 * Usage: npm run db:verify
 * Exit code 1 if any invariant is violated, so it can gate a script chain.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  if (pass) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label} ${detail}`);
  }
}

/** Every operational table and its yard-scoped parent links to cross-check. */
const TENANT_TABLES = [
  "Vendor",
  "Buyer",
  "Material",
  "Sku",
  "Inventory",
  "InventoryLot",
  "InwardLoad",
  "InwardLoadLine",
  "WeightEntry",
  "OutwardLoad",
  "OutwardLoadLine",
  "OutwardImage",
  "MaterialImage",
  "SegregationRun",
  "SegregationAllocation",
  "Sale",
  "Receivable",
  "InventoryTransaction",
] as const;

/** Child → parent pairs that must never straddle two yards. */
const CROSS_YARD_LINKS: { child: string; fk: string; parent: string }[] = [
  { child: "Sku", fk: "materialId", parent: "Material" },
  { child: "Inventory", fk: "skuId", parent: "Sku" },
  { child: "InventoryLot", fk: "skuId", parent: "Sku" },
  { child: "InventoryLot", fk: "vendorId", parent: "Vendor" },
  { child: "InventoryLot", fk: "sourceLoadId", parent: "InwardLoad" },
  { child: "InwardLoad", fk: "vendorId", parent: "Vendor" },
  { child: "InwardLoad", fk: "materialId", parent: "Material" },
  { child: "InwardLoadLine", fk: "loadId", parent: "InwardLoad" },
  { child: "InwardLoadLine", fk: "skuId", parent: "Sku" },
  { child: "InwardLoadLine", fk: "materialId", parent: "Material" },
  { child: "OutwardLoadLine", fk: "loadId", parent: "OutwardLoad" },
  { child: "OutwardLoadLine", fk: "saleId", parent: "Sale" },
  { child: "OutwardLoadLine", fk: "skuId", parent: "Sku" },
  { child: "OutwardImage", fk: "loadId", parent: "OutwardLoad" },
  { child: "WeightEntry", fk: "loadId", parent: "InwardLoad" },
  { child: "WeightEntry", fk: "lineId", parent: "InwardLoadLine" },
  { child: "WeightEntry", fk: "skuId", parent: "Sku" },
  { child: "MaterialImage", fk: "loadId", parent: "InwardLoad" },
  { child: "SegregationRun", fk: "sourceLoadId", parent: "InwardLoad" },
  { child: "SegregationRun", fk: "sourceSkuId", parent: "Sku" },
  { child: "SegregationAllocation", fk: "runId", parent: "SegregationRun" },
  { child: "SegregationAllocation", fk: "skuId", parent: "Sku" },
  { child: "Sale", fk: "buyerId", parent: "Buyer" },
  { child: "Sale", fk: "skuId", parent: "Sku" },
  { child: "Receivable", fk: "saleId", parent: "Sale" },
  { child: "Receivable", fk: "buyerId", parent: "Buyer" },
  { child: "InventoryTransaction", fk: "skuId", parent: "Sku" },
];

async function count(sql: string): Promise<number> {
  const r = await prisma.$queryRawUnsafe<{ c: bigint }[]>(sql);
  return Number(r[0].c);
}

async function main() {
  console.log("🔎 Tenancy integrity verification\n");

  // ---- 1. Yards ----
  const yards = await prisma.yard.findMany({ orderBy: { yardCode: "asc" } });
  console.log(`Yards (${yards.length}):`);
  for (const y of yards) {
    console.log(`  • ${y.yardCode} — "${y.yardName}" ${y.active ? "" : "(INACTIVE)"} id=${y.id}`);
  }
  check("at least one yard exists", yards.length >= 1);

  // ---- 2. No orphans: every operational row points at a real yard ----
  console.log("\nOrphan check (rows whose yardId has no Yard):");
  for (const t of TENANT_TABLES) {
    const n = await count(
      `select count(*)::bigint as c from "${t}" x
       where not exists (select 1 from "Yard" y where y.id = x."yardId")`
    );
    check(`${t} has no orphans`, n === 0, `→ ${n} orphaned rows`);
  }

  // ---- 3. No NULL yardId on operational tables ----
  console.log("\nNull-yardId check:");
  for (const t of TENANT_TABLES) {
    const n = await count(`select count(*)::bigint as c from "${t}" where "yardId" is null`);
    check(`${t}.yardId never null`, n === 0, `→ ${n} null rows`);
  }

  // ---- 4. No cross-yard references ----
  console.log("\nCross-yard reference check (a child must live in its parent's yard):");
  for (const { child, fk, parent } of CROSS_YARD_LINKS) {
    const n = await count(
      `select count(*)::bigint as c from "${child}" c
       join "${parent}" p on p.id = c."${fk}"
       where c."yardId" <> p."yardId"`
    );
    check(`${child}.${fk} → ${parent} stays in-yard`, n === 0, `→ ${n} cross-yard rows`);
  }

  // ---- 5. Users ----
  console.log("\nUser role/yard consistency:");
  const adminsWithYard = await prisma.user.count({ where: { role: "ADMIN", yardId: { not: null } } });
  const staffWithoutYard = await prisma.user.count({
    where: { role: { in: ["OWNER", "MANAGER"] }, yardId: null },
  });
  check("ADMIN users have no yardId", adminsWithYard === 0, `→ ${adminsWithYard}`);
  check("OWNER/MANAGER users all have a yardId", staffWithoutYard === 0, `→ ${staffWithoutYard}`);
  const admins = await prisma.user.count({ where: { role: "ADMIN" } });
  check("at least one ADMIN exists", admins >= 1);

  // ---- 6. Counters namespaced per yard ----
  console.log("\nCounter namespacing:");
  const counters = await prisma.counter.findMany({ orderBy: { name: "asc" } });
  const legacy = counters.filter((c) => !c.name.includes(":"));
  for (const c of counters) console.log(`  • ${c.name} = ${c.value}`);
  check("no un-namespaced counters", legacy.length === 0, `→ ${legacy.map((c) => c.name).join(", ")}`);
  for (const c of counters.filter((c) => c.name.includes(":"))) {
    const [yid] = c.name.split(":");
    check(`counter ${c.name} belongs to a real yard`, yards.some((y) => y.id === yid));
  }

  // ---- 7. Per-yard uniqueness that the app relies on ----
  console.log("\nPer-yard uniqueness:");
  for (const [t, col] of [
    ["InwardLoad", "lotNumber"],
    ["Sale", "invoiceNumber"],
    ["Material", "name"],
    ["Material", "code"],
    ["Sku", "name"],
    ["Sku", "code"],
  ] as const) {
    const n = await count(
      `select count(*)::bigint as c from (
         select "yardId", "${col}" from "${t}" group by 1,2 having count(*) > 1
       ) d`
    );
    check(`${t}.${col} unique within each yard`, n === 0, `→ ${n} duplicate groups`);
  }

  // ---- 8. Inventory vs. lot arithmetic (business integrity, per yard) ----
  console.log("\nInventory arithmetic (Inventory.quantityKg vs sum of remaining lots):");
  const drift = await prisma.$queryRawUnsafe<
    { yardId: string; skuName: string; inv: number; lots: number }[]
  >(
    `select i."yardId", s.name as "skuName", i."quantityKg"::int as inv,
            coalesce(sum(l."remainingKg"),0)::int as lots
     from "Inventory" i
     join "Sku" s on s.id = i."skuId"
     left join "InventoryLot" l on l."skuId" = i."skuId"
     group by i."yardId", s.name, i."quantityKg"
     having i."quantityKg" <> coalesce(sum(l."remainingKg"),0)`
  );
  if (drift.length === 0) {
    check("every SKU's running total matches its batch remainder", true);
  } else {
    // Informational, not fatal: opening balances predate batch tracking.
    console.log(`  ⚠ ${drift.length} SKU(s) where running total ≠ batch remainder (informational):`);
    for (const d of drift) console.log(`     ${d.skuName}: inventory=${d.inv} lots=${d.lots}`);
  }

  // ---- 9. Row census ----
  console.log("\nRow census per yard:");
  for (const y of yards) {
    const parts: string[] = [];
    for (const t of TENANT_TABLES) {
      const n = await count(`select count(*)::bigint as c from "${t}" where "yardId" = '${y.id}'`);
      if (n > 0) parts.push(`${t}=${n}`);
    }
    const users = await prisma.user.count({ where: { yardId: y.id } });
    console.log(`  ${y.yardCode}: users=${users} ${parts.join(" ")}`);
  }

  console.log(`\n${failures === 0 ? "✅ ALL INVARIANTS HOLD" : `❌ ${failures} INVARIANT(S) VIOLATED`}`);
  if (failures > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
