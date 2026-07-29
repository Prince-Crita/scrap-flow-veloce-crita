/**
 * Test-yard fixtures.
 *
 * The regression suites create inward loads, run segregations and raise
 * invoices. Pointing them at Yard 1 would permanently pollute the production
 * baseline with test rows, and cleaning up would mean deleting data — which this
 * project forbids. So the suites run against a disposable sandbox yard instead.
 *
 *   npx tsx tests/fixtures.ts up     → create/verify SFTEST01 "Test Yard"
 *   npx tsx tests/fixtures.ts down   → delete the sandbox yard's data ONLY
 *   npx tsx tests/fixtures.ts status → report what the sandbox holds
 *
 * `down` is scoped by yardId to the sandbox and refuses to touch anything else.
 * It can never reach Yard 1: the yard code is hard-coded here and asserted
 * before any delete runs.
 */
import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

export const TEST_YARD_CODE = "SFTEST01";
export const TEST_YARD_NAME = "Test Yard (automated)";
export const TEST_OWNER = { email: "test-owner@veloce.test", password: "testowner123", name: "Test Owner" };
export const TEST_MANAGER = { email: "test-manager@veloce.test", password: "testmanager123", name: "Test Manager" };

/** Guard: nothing in this file may ever operate on a non-sandbox yard. */
function assertSandbox(code: string) {
  if (code !== TEST_YARD_CODE) {
    throw new Error(`[fixtures] refusing to operate on "${code}" — sandbox only`);
  }
}

const MATERIALS = [
  {
    code: "MS",
    name: "MS Scrap",
    skus: [
      { code: "MSB", name: "MS Bazar", icon: "🔩", threshold: 2000, mixed: false, order: 1, qty: 1850 },
      { code: "MSC", name: "MS Commercial", icon: "🏗️", threshold: 2000, mixed: false, order: 2, qty: 2400 },
      { code: "MSS", name: "MS Super", icon: "⭐", threshold: 2000, mixed: false, order: 3, qty: 0 },
      { code: "MIXMS", name: "Mixed MS", icon: "🧺", threshold: 99999, mixed: true, order: 7, qty: 1200 },
    ],
  },
  {
    code: "PET",
    name: "PET Plastic",
    skus: [
      { code: "PETW", name: "PET White", icon: "🥛", threshold: 1500, mixed: false, order: 4, qty: 620 },
      { code: "PETG", name: "PET Green", icon: "🧪", threshold: 1500, mixed: false, order: 5, qty: 1480 },
      { code: "MIXPET", name: "PET Mixed", icon: "🧴", threshold: 99999, mixed: true, order: 8, qty: 0 },
    ],
  },
  {
    code: "ALU",
    name: "Aluminum",
    skus: [
      { code: "ALUC", name: "Alu Castings", icon: "⚙️", threshold: 800, mixed: false, order: 6, qty: 310 },
      { code: "MIXALU", name: "Aluminum Mixed", icon: "🪨", threshold: 99999, mixed: true, order: 9, qty: 0 },
    ],
  },
];

/**
 * The prototype's two opening receivables (`scrapflow_veloce_v2-1.html`).
 *
 * These are *historical* sales: `dispatchedKg: null` means the row predates the
 * Outward workflow, so its stock was deducted at sale time and it never enters
 * the Manager's dispatch queue. That is also why seeding them does not disturb
 * the prototype's SKU quantities.
 *
 * The prototype quotes a single rupee figure per row, so subtotal and GST are
 * derived from it to keep `subtotal + gstAmount === total` exactly rather than
 * inventing a rate that does not reconcile.
 */
const PROTOTYPE_SALES = [
  { invoice: "INV-0231", buyer: "Shree Steels", skuCode: "MSC", qty: 2400, total: 84000 },
  { invoice: "INV-0228", buyer: "GreenCycle", skuCode: "PETG", qty: 1000, total: 41500 },
] as const;

export async function up() {
  const yard = await prisma.yard.upsert({
    where: { yardCode: TEST_YARD_CODE },
    update: { active: true },
    create: {
      yardCode: TEST_YARD_CODE,
      yardName: TEST_YARD_NAME,
      city: "Sandbox",
      state: "Karnataka",
      country: "India",
      timezone: "Asia/Kolkata",
      active: true,
    },
  });
  const yardId = yard.id;

  const owner = await prisma.user.upsert({
    where: { email: TEST_OWNER.email },
    update: { yardId, role: Role.OWNER, active: true, mustChangePassword: false },
    create: {
      email: TEST_OWNER.email,
      name: TEST_OWNER.name,
      passwordHash: await bcrypt.hash(TEST_OWNER.password, 10),
      role: Role.OWNER,
      yardId,
      xp: 1240, // matches the prototype, so gamification assertions are stable
      level: 7,
      streak: 12,
    },
  });

  await prisma.user.upsert({
    where: { email: TEST_MANAGER.email },
    update: { yardId, role: Role.MANAGER, active: true, mustChangePassword: false },
    create: {
      email: TEST_MANAGER.email,
      name: TEST_MANAGER.name,
      passwordHash: await bcrypt.hash(TEST_MANAGER.password, 10),
      role: Role.MANAGER,
      yardId,
      xp: 640,
      level: 4,
      streak: 5,
    },
  });

  const skuByCode: Record<string, string> = {};
  for (const m of MATERIALS) {
    const material = await prisma.material.upsert({
      where: { yardId_code: { yardId, code: m.code } },
      update: { active: true },
      create: { yardId, name: m.name, code: m.code },
    });
    for (const s of m.skus) {
      const sku = await prisma.sku.upsert({
        where: { yardId_code: { yardId, code: s.code } },
        update: {
          name: s.name,
          icon: s.icon,
          materialId: material.id,
          saleThresholdKg: s.threshold,
          isMixedBucket: s.mixed,
          sortOrder: s.order,
          visible: true,
        },
        create: {
          yardId,
          materialId: material.id,
          name: s.name,
          code: s.code,
          icon: s.icon,
          saleThresholdKg: s.threshold,
          isMixedBucket: s.mixed,
          sortOrder: s.order,
        },
      });
      skuByCode[s.code] = sku.id;
      // Test yard: quantities ARE reset to a known baseline, which is the point.
      await prisma.inventory.upsert({
        where: { skuId: sku.id },
        update: { quantityKg: s.qty },
        create: { yardId, skuId: sku.id, quantityKg: s.qty },
      });
    }
  }

  const vendor = await prisma.vendor.upsert({
    where: { id: `test-vendor-${yardId.slice(-8)}` },
    update: { active: true },
    create: {
      id: `test-vendor-${yardId.slice(-8)}`,
      yardId,
      name: "Balaji Metals",
      gstNumber: "27ABCDE1234F1Z5",
      phone: "9876543210",
      createdById: owner.id,
    },
  });

  // Opening lots to match inventory, so the arithmetic invariant holds.
  if ((await prisma.inventoryLot.count({ where: { yardId } })) === 0) {
    const lot = await prisma.inwardLoad.upsert({
      where: { yardId_lotNumber: { yardId, lotNumber: "A-114" } },
      update: {},
      create: {
        yardId,
        lotNumber: "A-114",
        vendorId: vendor.id,
        materialId: (await prisma.material.findUniqueOrThrow({ where: { yardId_code: { yardId, code: "MS" } } })).id,
        materialLabel: "Mixed MS",
        totalKg: 1200,
        vehicleNumber: "MH12AB1234",
        vehicleType: "6-Wheel Truck",
        driverName: "Ramesh Kumar",
        status: "RECEIVED",
        capturedById: owner.id,
        weightEntries: { create: [{ yardId, sequence: 1, kg: 700 }, { yardId, sequence: 2, kg: 500 }] },
      },
    });
    await prisma.inventoryLot.create({
      data: {
        yardId,
        skuId: skuByCode["MIXMS"],
        vendorId: vendor.id,
        vehicleNumber: "MH12AB1234",
        sourceLoadId: lot.id,
        originalKg: 1200,
        remainingKg: 1200,
      },
    });
    for (const [code, qty] of [["MSB", 1850], ["MSC", 2400], ["PETW", 620], ["PETG", 1480], ["ALUC", 310]] as [string, number][]) {
      await prisma.inventoryLot.create({
        data: { yardId, skuId: skuByCode[code], originalKg: qty, remainingKg: qty },
      });
    }
  }

  // NEVER rewind a live sequence. `up` is idempotent and may run against a
  // sandbox that already holds lots A-115+; resetting the counter to 114 would
  // hand out a number that already exists and blow up on the composite unique.
  // A clean sequence comes from `down` (which clears the counters) then `up`.
  // This mirrors the same rule in prisma/seed.ts.
  await prisma.counter.upsert({
    where: { name: `${yardId}:lot` },
    update: {},
    create: { name: `${yardId}:lot`, value: 114 },
  });
  await prisma.counter.upsert({
    where: { name: `${yardId}:invoice` },
    update: {},
    create: { name: `${yardId}:invoice`, value: 231 },
  });

  console.log(`✅ Sandbox ready: ${TEST_YARD_NAME} (${TEST_YARD_CODE}) id=${yardId}`);
  console.log(`   ${TEST_OWNER.email} / ${TEST_OWNER.password}`);
  console.log(`   ${TEST_MANAGER.email} / ${TEST_MANAGER.password}`);
  return yardId;
}

/** Clears the sandbox yard's transactional data. Sandbox only, by assertion. */
export async function down() {
  const yard = await prisma.yard.findUnique({ where: { yardCode: TEST_YARD_CODE } });
  if (!yard) {
    console.log("Sandbox yard does not exist — nothing to clear.");
    return;
  }
  assertSandbox(yard.yardCode);
  const yardId = yard.id;

  await prisma.$transaction(async (tx) => {
    const w = { where: { yardId } };
    await tx.outwardImage.deleteMany(w);
    await tx.outwardLoadLine.deleteMany(w);
    await tx.outwardLoad.deleteMany(w);
    await tx.inventoryTransaction.deleteMany(w);
    await tx.segregationAllocation.deleteMany(w);
    await tx.segregationRun.deleteMany(w);
    await tx.receivable.deleteMany(w);
    await tx.sale.deleteMany(w);
    await tx.weightEntry.deleteMany(w);
    await tx.inwardLoadLine.deleteMany(w);
    await tx.materialImage.deleteMany(w);
    await tx.inventoryLot.deleteMany(w);
    await tx.inwardLoad.deleteMany(w);
    await tx.inventory.deleteMany(w);
    await tx.buyer.deleteMany(w);
    // Clear the sandbox's sequences too, so `down` + `up` yields the canonical
    // A-114 / INV-0231 starting point rather than continuing from wherever the
    // last run left off.
    await tx.counter.deleteMany({ where: { name: { startsWith: `${yardId}:` } } });
  },
  { maxWait: 15_000, timeout: 60_000 }
);

  console.log(`🧹 Sandbox ${TEST_YARD_CODE} transactional data cleared.`);
}

/**
 * Removes the sandbox yard entirely, so the platform shows only real yards.
 * `up` (and therefore `npm run test:all`) recreates it on demand.
 */
export async function purge() {
  const yard = await prisma.yard.findUnique({ where: { yardCode: TEST_YARD_CODE } });
  if (!yard) {
    console.log("Sandbox yard already absent.");
    return;
  }
  assertSandbox(yard.yardCode);
  await down();
  await prisma.$transaction(async (tx) => {
    const w = { where: { yardId: yard.id } };
    await tx.sku.deleteMany(w);
    await tx.material.deleteMany(w);
    await tx.vendor.deleteMany(w);
    await tx.impersonationSession.deleteMany(w);
    await tx.auditLog.deleteMany(w);
    await tx.user.deleteMany({ where: { email: { in: [TEST_OWNER.email, TEST_MANAGER.email] } } });
    await tx.counter.deleteMany({ where: { name: { startsWith: `${yard.id}:` } } });
    await tx.yard.delete({ where: { id: yard.id } });
  },
  { maxWait: 15_000, timeout: 60_000 }
);
  console.log(`🗑️  Sandbox yard ${TEST_YARD_CODE} removed. Run \`npm run test:fixtures\` to recreate it.`);
}

/**
 * Total wipe of the fixture yard's DATA, keeping the yard and its two users.
 *
 * Wider than `down()` on purpose. `down()` deliberately leaves vendors,
 * materials and SKUs in place because most suites only need transactional data
 * cleared and re-creating the catalogue on every run is slow. The consequence is
 * that catalogue rows accumulate — the sandbox had reached **115 vendors and 117
 * materials** — which is harmless for suites that look up what they need by
 * name, and fatal for the prototype suite, whose whole point is "exactly 2
 * vendors, exactly 3 materials, exactly 9 SKUs".
 *
 * So this exists for the prototype baseline only, and `down()` is left exactly
 * as it was. Sandbox-only, by assertion, in a single transaction.
 */
async function wipe(): Promise<string> {
  const yard = await prisma.yard.findUniqueOrThrow({ where: { yardCode: TEST_YARD_CODE } });
  assertSandbox(yard.yardCode);
  const yardId = yard.id;
  const w = { where: { yardId } };

  await prisma.$transaction(async (tx) => {
    // Order matters: children before parents, or the FKs refuse.
    await tx.outwardImage.deleteMany(w);
    await tx.outwardLoadLine.deleteMany(w);
    await tx.outwardLoad.deleteMany(w);
    await tx.inventoryTransaction.deleteMany(w);
    await tx.segregationAllocation.deleteMany(w);
    await tx.segregationRun.deleteMany(w);
    await tx.receivable.deleteMany(w);
    await tx.sale.deleteMany(w);
    await tx.weightEntry.deleteMany(w);
    await tx.inwardLoadLine.deleteMany(w);
    await tx.materialImage.deleteMany(w);
    await tx.inventoryLot.deleteMany(w);
    await tx.inwardLoad.deleteMany(w);
    await tx.inventory.deleteMany(w);
    await tx.buyer.deleteMany(w);
    await tx.sku.deleteMany(w);
    await tx.material.deleteMany(w);
    await tx.vendor.deleteMany(w);
    await tx.impersonationSession.deleteMany(w);
    await tx.auditLog.deleteMany(w);
    await tx.counter.deleteMany({ where: { name: { startsWith: `${yardId}:` } } });
  },
  // Same reason as `removeYard` in fixture-isolation: 21 sequential deletes over a
  // remote pooled connection exceed Prisma's default 5s interactive budget.
  { maxWait: 15_000, timeout: 60_000 });

  return yardId;
}

/**
 * Restores the fixture yard to the EXACT prototype snapshot, deterministically.
 *
 * Why this exists
 * ---------------
 * `test:prototype` used to assert against Yard 1. Yard 1 is now live: the owner
 * makes sales, dispatches vehicles and creates buyers, and every one of those
 * legitimate actions broke a fixture assertion (25 of them by 2026-07-27). The
 * suite was measuring "has anyone used the app today", not "does the app render
 * the prototype faithfully".
 *
 * Pointing it at the fixture yard and seeding that yard to the prototype makes
 * the question the right one and the answer stable. Yard 1 is never read or
 * written by the suite again.
 *
 * Idempotent: wipes first, so running it twice gives byte-identical state.
 */
export async function prototypeBaseline() {
  const yardId = await wipe();

  // xp/level/streak are on `create` in `up()`, so a user that already exists
  // keeps whatever a gamification test last awarded it. Force them.
  await prisma.user.update({
    where: { email: TEST_OWNER.email },
    data: { xp: 1240, level: 7, streak: 12 },
  });
  await prisma.user.update({
    where: { email: TEST_MANAGER.email },
    data: { xp: 640, level: 4, streak: 5 },
  });

  await up(); // materials, 9 SKUs with quantities, Balaji Metals, lot A-114, counters

  const owner = await prisma.user.findFirstOrThrow({ where: { email: TEST_OWNER.email } });

  // The prototype's vendor chips are Balaji Metals + SR Traders. `up()` seeds
  // only the first, because only it owns a lot.
  await prisma.vendor.upsert({
    where: { id: `test-vendor2-${yardId.slice(-8)}` },
    update: { active: true, name: "SR Traders" },
    create: {
      id: `test-vendor2-${yardId.slice(-8)}`,
      yardId,
      name: "SR Traders",
      gstNumber: "29ZYXWV9876G1A2",
      phone: "9812345670",
      createdById: owner.id,
    },
  });

  const skus = await prisma.sku.findMany({ where: { yardId }, select: { id: true, code: true } });
  const skuByCode = new Map(skus.map((s) => [s.code, s.id]));

  for (const s of PROTOTYPE_SALES) {
    const buyer = await prisma.buyer.create({
      data: { yardId, name: s.buyer, gstNumber: null, phone: null },
    });
    // subtotal + gstAmount === total, exactly, at the default 18%.
    const subtotal = Math.round((s.total / 1.18) * 100) / 100;
    const gstAmount = Math.round((s.total - subtotal) * 100) / 100;
    const sale = await prisma.sale.create({
      data: {
        yardId,
        invoiceNumber: s.invoice,
        buyerId: buyer.id,
        skuId: skuByCode.get(s.skuCode)!,
        quantityKg: s.qty,
        ratePerKg: Math.round((subtotal / s.qty) * 100) / 100,
        subtotal,
        gstAmount,
        total: s.total,
        // NULL = predates the Outward workflow. Keeps these out of the dispatch
        // queue and out of the prototype's stock arithmetic.
        dispatchedKg: null,
        createdById: owner.id,
      },
    });
    await prisma.receivable.create({
      data: { yardId, saleId: sale.id, buyerId: buyer.id, amount: s.total, status: "PENDING" },
    });
  }

  console.log(`✅ Prototype baseline restored in ${TEST_YARD_CODE} (Yard 1 untouched).`);
  return yardId;
}

export async function status() {
  const yard = await prisma.yard.findUnique({ where: { yardCode: TEST_YARD_CODE } });
  if (!yard) return console.log("Sandbox yard not created yet.");
  const counts = {
    vendors: await prisma.vendor.count({ where: { yardId: yard.id } }),
    skus: await prisma.sku.count({ where: { yardId: yard.id } }),
    loads: await prisma.inwardLoad.count({ where: { yardId: yard.id } }),
    sales: await prisma.sale.count({ where: { yardId: yard.id } }),
    lots: await prisma.inventoryLot.count({ where: { yardId: yard.id } }),
  };
  console.log(`${yard.yardName} (${yard.yardCode})`);
  console.table(counts);
}

/**
 * Restores the sandbox to its known baseline.
 *
 * The e2e suite is not idempotent by design — it sorts and then SELLS 2000 kg of
 * MS Bazar, which leaves that SKU below its sale threshold. Re-running without a
 * reset would fail the "ready to sell" assertion for a reason that has nothing to
 * do with the code. Run this before each full pass.
 */
export async function reset() {
  await down();
  await up();
}

/**
 * CLI only when this file is the entry point.
 *
 * It used to run whenever `process.argv[2]` was set — which meant any test that
 * *imported* a fixture constant while itself being passed a flag (e.g.
 * `ocr-benchmark --read-rate`) hit this block and exited with a usage message
 * before its own code ran.
 */
const invokedDirectly = /[\\/]fixtures\.ts$/.test(process.argv[1] ?? "");
const cmd = invokedDirectly ? process.argv[2] : undefined;
if (cmd) {
  const run =
    cmd === "up"
      ? up
      : cmd === "down"
        ? down
        : cmd === "reset"
          ? reset
          : cmd === "purge"
            ? purge
            : cmd === "prototype"
              ? prototypeBaseline
              : cmd === "status"
                ? status
                : null;
  if (!run) {
    console.error("Usage: npx tsx tests/fixtures.ts up|down|reset|prototype|purge|status");
    process.exit(1);
  }
  run()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
