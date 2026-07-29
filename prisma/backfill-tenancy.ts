/**
 * ⚠️ HISTORICAL — ALREADY APPLIED. Kept for the record only.
 *
 * This ran once against the pre-tenancy schema, when `yardId` was still
 * nullable, and moved every existing row into the default yard (SFDY001, since
 * renamed "Yard 1"). `yardId` is now NOT NULL, so `where: { yardId: null }` no
 * longer type-checks and this file is excluded from tsconfig. Do not run it
 * again: use prisma/seed.ts for new yards and prisma/verify-tenancy.ts to check
 * integrity.
 *
 * Phase 1 tenancy backfill (run once, additive, non-destructive).
 * - Creates the Default Yard (Scrap Flow Demo Yard / SFDY001).
 * - Assigns every existing operational row + existing users to that yard.
 * - Namespaces Counter keys to "{yardId}:{name}" so sequences continue.
 * - Seeds the platform ADMIN account (yardId = null).
 */
import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("🏭 Backfilling into Default Yard…");

  const yard = await prisma.yard.upsert({
    where: { yardCode: "SFDY001" },
    update: {},
    create: {
      yardCode: "SFDY001",
      yardName: "Scrap Flow Demo Yard",
      city: "Bengaluru",
      state: "Karnataka",
      country: "India",
      timezone: "Asia/Kolkata",
      gstNumber: null, // "Pending"
      active: true,
    },
  });
  const yardId = yard.id;

  // Assign every existing row with a null yardId to the Default Yard.
  const setYard = { where: { yardId: null }, data: { yardId } } as const;
  const r = {
    users: await prisma.user.updateMany({ where: { yardId: null, role: { not: Role.ADMIN } }, data: { yardId } }),
    vendors: await prisma.vendor.updateMany(setYard),
    buyers: await prisma.buyer.updateMany(setYard),
    materials: await prisma.material.updateMany(setYard),
    skus: await prisma.sku.updateMany(setYard),
    inventory: await prisma.inventory.updateMany(setYard),
    inventoryLots: await prisma.inventoryLot.updateMany(setYard),
    inwardLoads: await prisma.inwardLoad.updateMany(setYard),
    weightEntries: await prisma.weightEntry.updateMany(setYard),
    materialImages: await prisma.materialImage.updateMany(setYard),
    segregationRuns: await prisma.segregationRun.updateMany(setYard),
    segregationAllocs: await prisma.segregationAllocation.updateMany(setYard),
    sales: await prisma.sale.updateMany(setYard),
    receivables: await prisma.receivable.updateMany(setYard),
    inventoryTxns: await prisma.inventoryTransaction.updateMany(setYard),
  };
  console.table(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.count])));

  // Namespace counters: "lot" -> "{yardId}:lot", "invoice" -> "{yardId}:invoice".
  for (const name of ["lot", "invoice"]) {
    const legacy = await prisma.counter.findUnique({ where: { name } });
    if (legacy) {
      const key = `${yardId}:${name}`;
      await prisma.counter.upsert({
        where: { name: key },
        create: { name: key, value: legacy.value },
        update: { value: legacy.value },
      });
      await prisma.counter.delete({ where: { name } });
      console.log(`  counter ${name} (${legacy.value}) -> ${key}`);
    }
  }

  // Platform ADMIN (cross-tenant; yardId null).
  const adminHash = await bcrypt.hash("ScrapFlow@2026", 10);
  await prisma.user.upsert({
    where: { email: "admin@scrapflow.in" },
    update: { role: Role.ADMIN, yardId: null },
    create: {
      email: "admin@scrapflow.in",
      name: "Platform Admin",
      passwordHash: adminHash,
      role: Role.ADMIN,
      yardId: null,
    },
  });

  console.log(`✅ Backfill complete. Default Yard: ${yard.yardName} (${yard.yardCode}) · id=${yardId}`);
  console.log("   Admin: admin@scrapflow.in / ScrapFlow@2026");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
