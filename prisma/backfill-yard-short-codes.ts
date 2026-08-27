/**
 * One-time back-fill of `Yard.shortCode`.
 *
 * The short code leads every load's business reference ("TY1-0005"), so yards
 * that existed before the column did need one. Codes are derived from the yard's
 * own name and assigned in a stable order (oldest yard first), which makes this
 * script deterministic: running it twice produces the same codes, and yards that
 * already have one are skipped rather than rewritten.
 *
 *   npx tsx prisma/backfill-yard-short-codes.ts          # report only
 *   npx tsx prisma/backfill-yard-short-codes.ts --apply  # write
 */
import { PrismaClient } from "@prisma/client";
import { ensureShortCode, shortCodeCandidates } from "../src/backend/services/yard-short-code";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  const yards = await prisma.yard.findMany({
    select: { id: true, yardCode: true, yardName: true, shortCode: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`${yards.length} yard(s)${APPLY ? "" : " — dry run, pass --apply to write"}\n`);

  for (const y of yards) {
    if (y.shortCode) {
      console.log(`  = ${y.yardCode.padEnd(12)} ${y.yardName.padEnd(26)} already ${y.shortCode}`);
      continue;
    }
    if (!APPLY) {
      // Same first candidate the assignment would pick; collisions with yards
      // written earlier in this same run only show up under --apply.
      console.log(`  + ${y.yardCode.padEnd(12)} ${y.yardName.padEnd(26)} → ${shortCodeCandidates(y.yardName, y.yardCode, 1)[0]}`);
      continue;
    }
    const code = await ensureShortCode(prisma, y.id);
    console.log(`  + ${y.yardCode.padEnd(12)} ${y.yardName.padEnd(26)} → ${code ?? "FAILED"}`);
  }

  await prisma.$disconnect();
}

void main();
