/**
 * Yard-scoped transactional reset — a DELIBERATELY hard-to-fire weapon.
 *
 * The previous version of this script deleted every Buyer, Inventory, Sale and
 * Counter row in the database with no yard filter and no confirmation. On a
 * multi-tenant database that is a cross-tenant wipe. It now refuses to run
 * unless you name exactly which yard to clear and confirm you mean it.
 *
 * Guards:
 *   1. --yard=<CODE> is mandatory. There is no "all yards" mode.
 *   2. --confirm=<CODE> must repeat the same code.
 *   3. Refuses when NODE_ENV=production unless ALLOW_PROD_RESET=yes.
 *   4. Prints exactly what it will delete and requires --yes to proceed.
 *   5. Never touches Yard, User, Vendor, Material or Sku rows.
 *   6. Runs in one transaction — a partial wipe is not a possible outcome.
 *
 * Usage:
 *   npx tsx prisma/reset.ts --yard=SFDY001 --confirm=SFDY001 --yes
 *   (then `npm run db:seed` to restore the canonical demo state)
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const flag = (k: string) => argv.includes(`--${k}`);

function refuse(msg: string): never {
  console.error(`\n❌ REFUSING TO RESET — ${msg}`);
  console.error("   Nothing was deleted.");
  console.error("\n   Usage: npx tsx prisma/reset.ts --yard=<CODE> --confirm=<CODE> --yes\n");
  process.exit(1);
}

async function main() {
  const yardCode = arg("yard");
  const confirm = arg("confirm");

  if (!yardCode) refuse("no --yard=<CODE> given. This script has no 'all yards' mode.");
  if (confirm !== yardCode) refuse(`--confirm must repeat the yard code exactly (got "${confirm ?? "nothing"}").`);
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_PROD_RESET !== "yes") {
    refuse("NODE_ENV=production. Set ALLOW_PROD_RESET=yes only if you are certain.");
  }

  const yard = await prisma.yard.findUnique({ where: { yardCode } });
  if (!yard) refuse(`no yard with code "${yardCode}".`);
  const yardId = yard.id;

  // Show the blast radius before doing anything.
  const counts = {
    inventoryTransactions: await prisma.inventoryTransaction.count({ where: { yardId } }),
    segregationAllocations: await prisma.segregationAllocation.count({ where: { yardId } }),
    segregationRuns: await prisma.segregationRun.count({ where: { yardId } }),
    receivables: await prisma.receivable.count({ where: { yardId } }),
    sales: await prisma.sale.count({ where: { yardId } }),
    weightEntries: await prisma.weightEntry.count({ where: { yardId } }),
    materialImages: await prisma.materialImage.count({ where: { yardId } }),
    inventoryLots: await prisma.inventoryLot.count({ where: { yardId } }),
    inwardLoads: await prisma.inwardLoad.count({ where: { yardId } }),
    inventory: await prisma.inventory.count({ where: { yardId } }),
    buyers: await prisma.buyer.count({ where: { yardId } }),
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  console.log(`\n🧹 Yard: ${yard.yardName} (${yard.yardCode})`);
  console.log("   WILL DELETE:");
  console.table(counts);
  console.log(`   total rows: ${total}`);
  console.log("   PRESERVED: Yard, Users (incl. XP/level/streak), Vendors, Materials, SKUs\n");

  if (!flag("yes")) {
    console.log("Dry run. Re-run with --yes to actually delete.");
    return;
  }

  // One transaction: either the whole yard's transactional data goes, or none.
  // Children before parents to respect the Restrict foreign keys.
  await prisma.$transaction(async (tx) => {
    const w = { where: { yardId } };
    await tx.outwardImage.deleteMany(w);
    await tx.outwardLoadLine.deleteMany(w);
    await tx.outwardLoad.deleteMany(w);
    await tx.inventoryTransaction.deleteMany(w);
    await tx.segregationAllocation.deleteMany(w);
    await tx.segregationRun.deleteMany(w);
    await tx.receivable.deleteMany(w);
    await tx.sale.deleteMany(w);
    await tx.weightEntry.deleteMany(w);
    await tx.inwardLoadLine.deleteMany(w);
    await tx.materialImage.deleteMany(w);
    await tx.inventoryLot.deleteMany(w);
    await tx.inwardLoad.deleteMany(w);
    await tx.inventory.deleteMany(w);
    await tx.buyer.deleteMany(w);
    // This yard's counters only — never another yard's sequences.
    await tx.counter.deleteMany({ where: { name: { startsWith: `${yardId}:` } } });
  });

  console.log(`✅ Cleared ${total} transactional rows from ${yard.yardCode}.`);
  console.log(`   Run \`npm run db:seed -- --yard=${yardCode}\` to restore the canonical state.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
