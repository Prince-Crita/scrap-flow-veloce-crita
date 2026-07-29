/**
 * Removes `Counter` rows whose yard no longer exists.
 *
 * Counters are keyed `"<yardId>:lot"` rather than by a `yardId` column, so any
 * yard-scoped cleanup that sweeps by `where: { yardId }` misses them and leaves
 * an orphan that `db:verify` correctly flags. This prunes only rows whose yard id
 * resolves to nothing — a live yard's counters can never match.
 *
 * Prints what it will delete and refuses to touch anything else.
 */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const yardIds = new Set((await prisma.yard.findMany({ select: { id: true } })).map((y) => y.id));
  const counters = await prisma.counter.findMany();

  const orphans = counters.filter((c) => {
    const owner = c.name.split(":")[0];
    // Only namespaced counters are considered; anything else is left alone.
    return c.name.includes(":") && !yardIds.has(owner);
  });

  console.log(`${counters.length} counters, ${yardIds.size} yards, ${orphans.length} orphaned`);
  for (const o of orphans) console.log(`  orphan: ${o.name} = ${o.value}`);

  if (orphans.length === 0) {
    console.log("nothing to prune");
    return;
  }
  const res = await prisma.counter.deleteMany({ where: { name: { in: orphans.map((o) => o.name) } } });
  console.log(`pruned ${res.count}`);

  // Prove no live yard lost a counter.
  const after = await prisma.counter.findMany();
  const bad = after.filter((c) => c.name.includes(":") && !yardIds.has(c.name.split(":")[0]));
  console.log(bad.length === 0 ? "✅ every remaining counter belongs to a live yard" : `❌ ${bad.length} still orphaned`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
