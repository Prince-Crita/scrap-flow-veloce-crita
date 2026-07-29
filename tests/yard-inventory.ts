/** Read-only: what yards exist, and which is the automation fixture? */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  for (const y of await prisma.yard.findMany({ orderBy: { createdAt: "asc" } })) {
    const users = await prisma.user.findMany({ where: { yardId: y.id }, select: { email: true, role: true } });
    const counts = {
      vendors: await prisma.vendor.count({ where: { yardId: y.id } }),
      buyers: await prisma.buyer.count({ where: { yardId: y.id } }),
      materials: await prisma.material.count({ where: { yardId: y.id } }),
      skus: await prisma.sku.count({ where: { yardId: y.id } }),
      inward: await prisma.inwardLoad.count({ where: { yardId: y.id } }),
      outward: await prisma.outwardLoad.count({ where: { yardId: y.id } }),
      sales: await prisma.sale.count({ where: { yardId: y.id } }),
      receivables: await prisma.receivable.count({ where: { yardId: y.id } }),
    };
    console.log(`\n${y.yardCode}  id=${y.id}  created=${y.createdAt.toISOString()}`);
    console.log(`  users: ${users.map((u) => `${u.email}(${u.role})`).join(", ") || "(none)"}`);
    console.log(`  ${JSON.stringify(counts)}`);
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
