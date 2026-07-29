/**
 * Dead-connection retry classification.
 *
 * The retry itself is easy; the danger is scope. If `isDeadConnection` returns
 * true for a real error, every genuine failure gets silently run twice — a
 * unique-constraint violation becomes two slow failures instead of one clear
 * one, and the cause gets harder to see, not easier. So the assertions that
 * matter here are the NEGATIVE ones.
 *
 * Also verifies the client still works at all after being wrapped in an
 * extension, because `$extends` returns a different object and the tenant
 * extension composes on top of it.
 *
 * Usage: `npx tsx tests/prisma-retry.test.ts`
 */
import { Prisma } from "@prisma/client";
import { isDeadConnection, prisma } from "../src/lib/prisma";

let pass = 0,
  fail = 0;
const check = (l: string, c: boolean, x = "") => {
  if (c) {
    pass++;
    console.log(`  ✓ ${l}`);
  } else {
    fail++;
    console.log(`  ✗ ${l} ${x}`);
  }
};

const known = (code: string, message = "boom") =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "6.19.3" });

async function main() {
  console.log("Retried — the connection was already dead, nothing ran:");
  check("P1017", isDeadConnection(known("P1017", "Server has closed the connection.")));
  check("'Server has closed the connection'", isDeadConnection(new Error("Server has closed the connection.")));
  check("engine 'kind: Closed'", isDeadConnection(new Error("Error in PostgreSQL connection: Error { kind: Closed, cause: None }")));
  check("Windows 10054 forcible close", isDeadConnection(new Error('Os { code: 10054, kind: ConnectionReset, message: "An existing connection was forcibly closed by the remote host." }')));
  check("connection reset by peer", isDeadConnection(new Error("Connection reset by peer")));
  check("ECONNRESET", isDeadConnection(new Error("read ECONNRESET")));

  console.log("\nNOT retried — these are real errors and must fail once, loudly:");
  check("P2002 unique constraint", !isDeadConnection(known("P2002", "Unique constraint failed on the fields: (`email`)")));
  check("P2025 record not found", !isDeadConnection(known("P2025", "An operation failed because it depends on one or more records that were required but not found.")));
  check("P2003 foreign key", !isDeadConnection(known("P2003", "Foreign key constraint failed")));
  check("P1008 pool timeout", !isDeadConnection(known("P1008", "Operations timed out")));
  check("a validation error", !isDeadConnection(new Prisma.PrismaClientValidationError("bad args", { clientVersion: "6.19.3" })));
  check("a plain business error", !isDeadConnection(new Error("Not enough stock to dispatch")));
  check("undefined", !isDeadConnection(undefined));
  check("null", !isDeadConnection(null));
  check("a string", !isDeadConnection("Server has closed the connection"));

  console.log("\nThe wrapped client still behaves like a Prisma client:");
  const yards = await prisma.yard.findMany({ select: { yardCode: true } });
  check("a model read works through the extension", Array.isArray(yards) && yards.length > 0, String(yards.length));
  const raw = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "Yard"`;
  check("a raw read works through the extension", Number(raw[0].n) === yards.length, `${Number(raw[0].n)} vs ${yards.length}`);
  const tx = await prisma.$transaction([prisma.yard.count()]);
  check("$transaction still works", tx[0] === yards.length, String(tx[0]));
  check("$extends did not drop $disconnect", typeof prisma.$disconnect === "function");

  console.log(`\n==== prisma retry: ${pass} passed, ${fail} failed ====`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
