/**
 * One-off, idempotent, non-destructive: the existing production baseline yard
 * becomes "Yard 1" while keeping its immutable business code SFDY001.
 *
 * Renames ONE field on ONE row. Touches no operational data — every vendor,
 * material, SKU, load, sale, receivable, lot, XP, level and streak already
 * belongs to this yard and is left exactly as it is.
 *
 * Usage: npx tsx prisma/rename-default-yard.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const YARD_CODE = "SFDY001";
const NEW_NAME = "Yard 1";

async function main() {
  const yard = await prisma.yard.findUnique({ where: { yardCode: YARD_CODE } });
  if (!yard) {
    console.error(`❌ No yard with code ${YARD_CODE}. Refusing to guess — nothing changed.`);
    process.exit(1);
  }

  if (yard.yardName === NEW_NAME) {
    console.log(`✓ Already named "${NEW_NAME}" (${YARD_CODE}). No change needed.`);
  } else {
    const updated = await prisma.yard.update({
      where: { id: yard.id },
      data: { yardName: NEW_NAME },
    });
    console.log(`✅ "${yard.yardName}" → "${updated.yardName}"  (code ${updated.yardCode} unchanged)`);
  }

  // Prove nothing moved: report what this yard still owns.
  const [vendors, materials, skus, loads, sales, receivables, lots, users] = await Promise.all([
    prisma.vendor.count({ where: { yardId: yard.id } }),
    prisma.material.count({ where: { yardId: yard.id } }),
    prisma.sku.count({ where: { yardId: yard.id } }),
    prisma.inwardLoad.count({ where: { yardId: yard.id } }),
    prisma.sale.count({ where: { yardId: yard.id } }),
    prisma.receivable.count({ where: { yardId: yard.id } }),
    prisma.inventoryLot.count({ where: { yardId: yard.id } }),
    prisma.user.findMany({
      where: { yardId: yard.id },
      select: { email: true, role: true, xp: true, level: true, streak: true },
      orderBy: { role: "asc" },
    }),
  ]);

  console.log(
    `   owns: vendors=${vendors} materials=${materials} skus=${skus} loads=${loads} ` +
      `sales=${sales} receivables=${receivables} lots=${lots}`
  );
  for (const u of users) {
    console.log(`   user: ${u.email} (${u.role}) xp=${u.xp} level=${u.level} streak=${u.streak}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
