/**
 * Yard 1 forensics — "did anything write to Yard 1, and if so, who?"
 *
 * This question keeps recurring, because Yard 1 is live production data that the
 * owner uses while engineering work is happening, and its fixture-based
 * assertions fail the moment it changes. Guessing from timestamps is how you get
 * it wrong: the CSV clock is local, `createdAt` is UTC, IST is +5:30, and a
 * five-and-a-half-hour error is the difference between "a test wrote to
 * production" and "the owner made a sale".
 *
 * So this reports the DB clock alongside every write, in minutes-ago, and names
 * the acting user. On 2026-07-27 it resolved exactly that: two failing dashboard
 * assertions looked like test contamination and were actually the owner selling
 * ₹8,850 of MS COPPER to a buyer created 0.3 s earlier, then dispatching it.
 *
 * STRICTLY READ-ONLY. Never add a write to this file.
 *
 * Usage: `npm run yard1:audit`
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const HOURS = Number(process.env.YARD1_AUDIT_HOURS || 6);

async function main() {
  const [{ now }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  const ago = (d: Date) => `${((now.getTime() - d.getTime()) / 60000).toFixed(1)} min ago`;
  const since = new Date(now.getTime() - HOURS * 3600_000);

  const y1 = await prisma.yard.findFirstOrThrow({ where: { yardCode: "SFDY001" } });
  console.log(`DB now(): ${now.toISOString()}  (local ${new Date().toString()})`);
  console.log(`Yard 1: ${y1.yardCode} id=${y1.id} — looking back ${HOURS}h\n`);

  const users = new Map(
    (await prisma.user.findMany({ select: { id: true, email: true } })).map((u) => [u.id, u.email])
  );

  console.log("Latest write of each kind:");
  const latest: [string, Date | undefined][] = [
    ["InwardLoad", (await prisma.inwardLoad.findFirst({ where: { yardId: y1.id }, orderBy: { createdAt: "desc" } }))?.createdAt],
    ["OutwardLoad", (await prisma.outwardLoad.findFirst({ where: { yardId: y1.id }, orderBy: { createdAt: "desc" } }))?.createdAt],
    ["Sale", (await prisma.sale.findFirst({ where: { yardId: y1.id }, orderBy: { createdAt: "desc" } }))?.createdAt],
    ["Receivable", (await prisma.receivable.findFirst({ where: { yardId: y1.id }, orderBy: { createdAt: "desc" } }))?.createdAt],
    ["InventoryTransaction", (await prisma.inventoryTransaction.findFirst({ where: { yardId: y1.id }, orderBy: { createdAt: "desc" } }))?.createdAt],
    ["SegregationRun", (await prisma.segregationRun.findFirst({ where: { yardId: y1.id }, orderBy: { createdAt: "desc" } }))?.createdAt],
    ["Vendor", (await prisma.vendor.findFirst({ where: { yardId: y1.id }, orderBy: { createdAt: "desc" } }))?.createdAt],
    ["Buyer", (await prisma.buyer.findFirst({ where: { yardId: y1.id }, orderBy: { createdAt: "desc" } }))?.createdAt],
    ["AuditLog", (await prisma.auditLog.findFirst({ where: { yardId: y1.id }, orderBy: { createdAt: "desc" } }))?.createdAt],
  ];
  latest.sort((a, b) => (b[1]?.getTime() ?? 0) - (a[1]?.getTime() ?? 0));
  for (const [t, d] of latest) {
    const recent = d && d >= since ? "  ← inside the window" : "";
    console.log(`  ${t.padEnd(22)} ${d ? `${d.toISOString()}  ${ago(d)}` : "(none)"}${recent}`);
  }

  const recv = await prisma.receivable.findMany({ where: { yardId: y1.id }, orderBy: { createdAt: "asc" } });
  console.log(
    `\nReceivables: ${recv.length}, total ₹${recv.reduce((a, r) => a + Number(r.amount ?? 0), 0).toLocaleString("en-IN")}`
  );
  for (const r of recv) console.log(`  ${r.createdAt.toISOString()}  ₹${r.amount}  ${r.status ?? "-"}`);

  console.log(`\nSales in the window:`);
  const sales = await prisma.sale.findMany({
    where: { yardId: y1.id, createdAt: { gte: since } },
    include: { buyer: { select: { name: true } }, sku: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  for (const s of sales) {
    console.log(`  ${s.createdAt.toISOString()}  ${s.invoiceNumber}  buyer=${s.buyer?.name ?? "-"}  sku=${s.sku?.name ?? "-"}  ${ago(s.createdAt)}`);
  }
  if (!sales.length) console.log("  (none)");

  console.log(`\nDispatches in the window:`);
  const outs = await prisma.outwardLoad.findMany({ where: { yardId: y1.id, createdAt: { gte: since } }, orderBy: { createdAt: "desc" } });
  for (const o of outs) console.log(`  ${o.createdAt.toISOString()}  vehicle=${o.vehicleNumber ?? "-"}  driver=${o.driverName ?? "-"}  ${ago(o.createdAt)}`);
  if (!outs.length) console.log("  (none)");

  console.log(`\nAudit log in the window — the actor is the answer to "who":`);
  const audits = await prisma.auditLog.findMany({ where: { yardId: y1.id, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 25 });
  for (const a of audits) {
    console.log(`  ${a.createdAt.toISOString()}  ${a.action.padEnd(24)} ${users.get(a.actorId ?? "") ?? a.actorId ?? "-"}  ${ago(a.createdAt)}`);
  }
  if (!audits.length) console.log("  (none)");

  const testActors = audits.filter((a) => /@veloce\.test$/.test(users.get(a.actorId ?? "") ?? ""));
  console.log(
    `\nVERDICT: ${testActors.length === 0 ? "no @veloce.test actor touched Yard 1 in the window — any drift is real app use." : `⚠ ${testActors.length} action(s) by a TEST account in Yard 1 — investigate, this must not happen.`}`
  );
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
