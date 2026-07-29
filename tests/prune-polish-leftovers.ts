/**
 * Clears "Polish <digits>" materials/SKUs that early `test:ui-polish` runs left in
 * the SANDBOX before that suite grew its own cleanup. Sandbox only, by assertion.
 */
import { PrismaClient } from "@prisma/client";
import { TEST_YARD_CODE } from "./fixtures";

const prisma = new PrismaClient();

async function main() {
  const yard = await prisma.yard.findUniqueOrThrow({ where: { yardCode: TEST_YARD_CODE } });
  if (yard.yardCode !== TEST_YARD_CODE) throw new Error("sandbox only");

  const skus = await prisma.sku.findMany({ where: { yardId: yard.id, name: { startsWith: "Polish " } } });
  const mats = await prisma.material.findMany({ where: { yardId: yard.id, name: { startsWith: "Polish " } } });
  console.log(`leftover SKUs: ${skus.length}, materials: ${mats.length}`);
  for (const s of skus) console.log(`  sku ${s.name}`);
  for (const m of mats) console.log(`  material ${m.name}`);

  if (skus.length || mats.length) {
    await prisma.$transaction(async (tx) => {
      const ids = skus.map((s) => s.id);
      if (ids.length) {
        await tx.inventoryTransaction.deleteMany({ where: { skuId: { in: ids } } });
        await tx.inventoryLot.deleteMany({ where: { skuId: { in: ids } } });
        await tx.inventory.deleteMany({ where: { skuId: { in: ids } } });
        await tx.sku.deleteMany({ where: { id: { in: ids } } });
      }
      if (mats.length) await tx.material.deleteMany({ where: { id: { in: mats.map((m) => m.id) } } });
    },
  { maxWait: 15_000, timeout: 60_000 }
);
    console.log("pruned");
  }

  console.log(
    `sandbox now: materials=${await prisma.material.count({ where: { yardId: yard.id } })} skus=${await prisma.sku.count({ where: { yardId: yard.id } })}`
  );
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
