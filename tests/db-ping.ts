/**
 * Connectivity probe. Answers one question before the DB-backed suites run:
 * can Prisma's engine actually reach Neon right now? The engine resolves AAAA
 * first, so a successful TCP test on IPv4 does not imply this succeeds.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const t = Date.now();
  const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "Yard"`;
  const [{ conns }] = await prisma.$queryRaw<{ conns: bigint }[]>`
    SELECT count(*)::bigint AS conns FROM pg_stat_activity WHERE datname = current_database()`;
  console.log(`OK — ${Number(n)} yards, ${Number(conns)} backend connections, ${Date.now() - t} ms`);
}

main()
  .catch((e) => {
    console.error("FAIL —", e.message.split("\n")[0]);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
