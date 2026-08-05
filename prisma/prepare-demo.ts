/**
 * Hand-over preparation: archive the development yards, provision a clean one.
 *
 * The database accumulated three yards during development (Yard 1, Yard 2 and
 * the automated test sandbox). None of them may be deleted — this project treats
 * existing rows as a production baseline — so they are DEACTIVATED instead:
 * every row stays, `/admin/yards` still lists them, their users can no longer
 * sign in (src/auth.ts refuses a login whose yard is inactive), and platform
 * analytics exclude them (src/lib/active-yards.ts).
 *
 * Then one fresh yard is created for client testing, provisioned exactly the way
 * the admin console provisions a yard (shared `provisionYard`), with an Owner and
 * a Supervisor who can sign straight in.
 *
 * Idempotent: run it twice and the second run reports "already prepared".
 *
 *   npx tsx prisma/prepare-demo.ts            → prepare
 *   npx tsx prisma/prepare-demo.ts --status   → report only, change nothing
 */
import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { provisionYard } from "../src/lib/yard-provisioning";

const prisma = new PrismaClient();

/**
 * Passwords come from the environment, never from this file.
 *
 * They are real sign-in credentials for a real yard, so committing them would
 * put working logins in the repository. Set them when you run the script:
 *
 *   DEMO_OWNER_PASSWORD=… DEMO_SUPERVISOR_PASSWORD=… npm run demo:prepare
 *
 * Re-running with different values rotates the passwords; everything else about
 * the yard is left alone.
 */
function requirePassword(name: string): string {
  const v = process.env[name];
  if (!v || v.length < 8) {
    throw new Error(
      `${name} must be set to a password of at least 8 characters. ` +
        `Example: ${name}=… npm run demo:prepare`
    );
  }
  return v;
}

const DEMO = {
  yardCode: "TESTYARD1",
  yardName: "Testing Yard 1",
  city: "Bengaluru",
  state: "Karnataka",
  owner: {
    name: "Testing Yard Owner",
    email: process.env.DEMO_OWNER_EMAIL || "owner@testingyard1.in",
    get password() {
      return requirePassword("DEMO_OWNER_PASSWORD");
    },
  },
  supervisor: {
    name: "Testing Yard Supervisor",
    email: process.env.DEMO_SUPERVISOR_EMAIL || "supervisor@testingyard1.in",
    get password() {
      return requirePassword("DEMO_SUPERVISOR_PASSWORD");
    },
  },
} as const;

async function status() {
  const yards = await prisma.yard.findMany({
    orderBy: { yardCode: "asc" },
    select: { yardCode: true, yardName: true, active: true },
  });
  for (const y of yards) {
    console.log(`  ${y.yardCode.padEnd(12)} ${y.active ? "ACTIVE  " : "archived"}  ${y.yardName}`);
  }
}

async function main() {
  if (process.argv.includes("--status")) {
    await status();
    return;
  }

  /* ---------- 1. archive every yard that is not the demo yard ---------- */
  const archived = await prisma.yard.updateMany({
    where: { active: true, yardCode: { not: DEMO.yardCode } },
    data: { active: false, deactivatedAt: new Date() },
  });
  console.log(`Archived ${archived.count} yard(s).`);

  /* ---------- 2. the fresh client yard ---------- */
  let yard = await prisma.yard.findUnique({ where: { yardCode: DEMO.yardCode } });
  if (yard) {
    // Re-running must not wipe anything the client has already entered.
    if (!yard.active) {
      yard = await prisma.yard.update({
        where: { id: yard.id },
        data: { active: true, deactivatedAt: null },
      });
    }
    console.log(`Yard ${DEMO.yardCode} already exists — left as it is.`);
  } else {
    yard = await prisma.$transaction(
      async (tx) => {
        const created = await tx.yard.create({
          data: {
            yardCode: DEMO.yardCode,
            yardName: DEMO.yardName,
            ownerName: DEMO.owner.name,
            city: DEMO.city,
            state: DEMO.state,
            country: "India",
            timezone: "Asia/Kolkata",
            active: true,
          },
        });
        await provisionYard(tx, created.id);
        return created;
      },
      // The starter tree is ~25 writes over a pooled Neon connection, which can
      // exceed Prisma's default 5 s interactive budget from a laptop.
      { timeout: 30_000 }
    );
    console.log(`Created yard ${yard.yardCode} — ${yard.yardName}`);
  }

  /* ---------- 3. Owner + Supervisor ---------- */
  for (const [role, who] of [
    [Role.OWNER, DEMO.owner],
    [Role.MANAGER, DEMO.supervisor], // MANAGER is the stored role; "Supervisor" is its display name
  ] as const) {
    await prisma.user.upsert({
      where: { email: who.email },
      update: {
        name: who.name,
        yardId: yard.id,
        role,
        active: true,
        // The client must be able to sign in with the credentials they are given,
        // with no interstitial password change on a demo account.
        mustChangePassword: false,
        passwordHash: await bcrypt.hash(who.password, 10),
      },
      create: {
        name: who.name,
        email: who.email,
        passwordHash: await bcrypt.hash(who.password, 10),
        role,
        yardId: yard.id,
        active: true,
        mustChangePassword: false,
      },
    });
    console.log(`  ${role === Role.OWNER ? "Owner     " : "Supervisor"} ${who.email}`);
  }

  console.log("\nFinal yard state:");
  await status();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
