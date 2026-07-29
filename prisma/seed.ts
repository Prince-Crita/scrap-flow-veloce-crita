/**
 * Yard-aware, non-destructive seed.
 *
 * Contract (this project treats the existing data as a production baseline):
 *   • Idempotent. Running it twice changes nothing the second time.
 *   • It NEVER overwrites live quantities, XP, levels or streaks. Inventory
 *     quantities are set on creation only — pass `--force-quantities` to restore
 *     the canonical demo numbers deliberately.
 *   • Everything it creates belongs to a yard. Default target: SFDY001 "Yard 1".
 *
 * Usage:
 *   npm run db:seed                       → seed/verify SFDY001 (Yard 1)
 *   npm run db:seed -- --yard=SFDY002     → seed a different yard
 *   npm run db:seed -- --force-quantities → also reset demo stock levels
 */
import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const flag = (k: string) => argv.includes(`--${k}`);

const YARD_CODE = arg("yard") ?? "SFDY001";
const YARD_NAME = arg("yard-name") ?? (YARD_CODE === "SFDY001" ? "Yard 1" : YARD_CODE);
const FORCE_QUANTITIES = flag("force-quantities");

async function main() {
  console.log(`🌱 Seeding Scrap Flow (Veloce) → yard ${YARD_CODE}…`);
  if (FORCE_QUANTITIES) console.log("   ⚠ --force-quantities: demo stock levels WILL be overwritten");

  // ---- Yard (tenant root) ----
  const yard = await prisma.yard.upsert({
    where: { yardCode: YARD_CODE },
    update: {}, // never clobber a live yard's details
    create: {
      yardCode: YARD_CODE,
      yardName: YARD_NAME,
      city: "Bengaluru",
      state: "Karnataka",
      country: "India",
      timezone: "Asia/Kolkata",
      active: true,
    },
  });
  const yardId = yard.id;
  console.log(`   yard: ${yard.yardName} (${yard.yardCode}) id=${yardId}`);

  // ---- Platform ADMIN (cross-tenant, yardId null) ----
  const adminHash = await bcrypt.hash("ScrapFlow@2026", 10);
  await prisma.user.upsert({
    where: { email: "admin@scrapflow.in" },
    update: { role: Role.ADMIN, yardId: null, active: true },
    create: {
      email: "admin@scrapflow.in",
      name: "Platform Admin",
      passwordHash: adminHash,
      role: Role.ADMIN,
      yardId: null,
    },
  });

  // ---- Yard users ----
  const ownerHash = await bcrypt.hash("owner123", 10);
  const managerHash = await bcrypt.hash("manager123", 10);

  const owner = await prisma.user.upsert({
    where: { email: "owner@veloce.in" },
    update: {}, // preserve live xp / level / streak
    create: {
      email: "owner@veloce.in",
      name: "Yard Owner",
      passwordHash: ownerHash,
      role: Role.OWNER,
      yardId,
      // Prototype: `let xp = 1240`, `<b id="lvl">7</b>`, `<b>🔥 12</b>`.
      xp: 1240,
      level: 7,
      streak: 12,
    },
  });

  await prisma.user.upsert({
    where: { email: "manager@veloce.in" },
    update: {},
    create: {
      email: "manager@veloce.in",
      name: "Yard Manager",
      passwordHash: managerHash,
      role: Role.MANAGER,
      yardId,
      xp: 640,
      level: 4,
      streak: 5,
    },
  });

  // ---- Parent materials (unique per yard) ----
  const upsertMaterial = (code: string, name: string) =>
    prisma.material.upsert({
      where: { yardId_code: { yardId, code } },
      update: {},
      create: { yardId, name, code },
    });

  const ms = await upsertMaterial("MS", "MS Scrap");
  const pet = await upsertMaterial("PET", "PET Plastic");
  const alu = await upsertMaterial("ALU", "Aluminum");

  // ---- SKUs (finished + mixed buckets) ----
  // qty mirrors the prototype's initial state; applied on create only.
  const skuDefs = [
    { code: "MSB", name: "MS Bazar", icon: "🔩", materialId: ms.id, threshold: 2000, mixed: false, qty: 1850, order: 1 },
    { code: "MSC", name: "MS Commercial", icon: "🏗️", materialId: ms.id, threshold: 2000, mixed: false, qty: 2400, order: 2 },
    { code: "MSS", name: "MS Super", icon: "⭐", materialId: ms.id, threshold: 2000, mixed: false, qty: 0, order: 3 },
    { code: "PETW", name: "PET White", icon: "🥛", materialId: pet.id, threshold: 1500, mixed: false, qty: 620, order: 4 },
    { code: "PETG", name: "PET Green", icon: "🧪", materialId: pet.id, threshold: 1500, mixed: false, qty: 1480, order: 5 },
    { code: "ALUC", name: "Alu Castings", icon: "⚙️", materialId: alu.id, threshold: 800, mixed: false, qty: 310, order: 6 },
    { code: "MIXMS", name: "Mixed MS", icon: "🧺", materialId: ms.id, threshold: 99999, mixed: true, qty: 1200, order: 7 },
    { code: "MIXPET", name: "PET Mixed", icon: "🧴", materialId: pet.id, threshold: 99999, mixed: true, qty: 0, order: 8 },
    { code: "MIXALU", name: "Aluminum Mixed", icon: "🪨", materialId: alu.id, threshold: 99999, mixed: true, qty: 0, order: 9 },
  ];

  const skuByCode: Record<string, string> = {};
  for (const s of skuDefs) {
    const sku = await prisma.sku.upsert({
      where: { yardId_code: { yardId, code: s.code } },
      update: {
        name: s.name,
        icon: s.icon,
        materialId: s.materialId,
        saleThresholdKg: s.threshold,
        isMixedBucket: s.mixed,
        sortOrder: s.order,
      },
      create: {
        yardId,
        code: s.code,
        name: s.name,
        icon: s.icon,
        materialId: s.materialId,
        saleThresholdKg: s.threshold,
        isMixedBucket: s.mixed,
        sortOrder: s.order,
      },
    });
    skuByCode[s.code] = sku.id;

    await prisma.inventory.upsert({
      where: { skuId: sku.id },
      // Live stock is authoritative unless explicitly asked to reset it.
      update: FORCE_QUANTITIES ? { quantityKg: s.qty } : {},
      create: { yardId, skuId: sku.id, quantityKg: s.qty },
    });
  }

  // ---- Vendors ----
  const seedVendorId = (slug: string) => (YARD_CODE === "SFDY001" ? `seed-vendor-${slug}` : `seed-vendor-${slug}-${yardId.slice(-6)}`);

  const balaji = await prisma.vendor.upsert({
    where: { id: seedVendorId("balaji") },
    update: {},
    create: {
      id: seedVendorId("balaji"),
      yardId,
      name: "Balaji Metals",
      gstNumber: "27ABCDE1234F1Z5",
      phone: "9876543210",
      createdById: owner.id,
    },
  });
  await prisma.vendor.upsert({
    where: { id: seedVendorId("sr") },
    update: {},
    create: {
      id: seedVendorId("sr"),
      yardId,
      name: "SR Traders",
      gstNumber: "27FGHIJ5678K1Z2",
      phone: "9812345678",
      createdById: owner.id,
    },
  });

  // ---- Buyers ----
  const seedBuyerId = (slug: string) => (YARD_CODE === "SFDY001" ? `seed-buyer-${slug}` : `seed-buyer-${slug}-${yardId.slice(-6)}`);

  const shree = await prisma.buyer.upsert({
    where: { id: seedBuyerId("shree") },
    update: {},
    create: { id: seedBuyerId("shree"), yardId, name: "Shree Steels", gstNumber: "27SHREE1111S1Z0", phone: "9900112233" },
  });
  const green = await prisma.buyer.upsert({
    where: { id: seedBuyerId("green") },
    update: {},
    create: { id: seedBuyerId("green"), yardId, name: "GreenCycle", gstNumber: "27GREEN2222G1Z1", phone: "9900445566" },
  });

  // ---- Seed mixed lot A-114 pending segregation (matches Sort screen) ----
  const lotA114 = await prisma.inwardLoad.upsert({
    where: { yardId_lotNumber: { yardId, lotNumber: "A-114" } },
    update: {},
    create: {
      yardId,
      lotNumber: "A-114",
      vendorId: balaji.id,
      materialId: ms.id,
      materialLabel: "Mixed MS",
      totalKg: 1200,
      vehicleNumber: "MH12AB1234",
      vehicleType: "6-Wheel Truck",
      driverName: "Ramesh Kumar",
      status: "RECEIVED",
      capturedById: owner.id,
      weightEntries: {
        create: [
          { yardId, sequence: 1, kg: 700 },
          { yardId, sequence: 2, kg: 500 },
        ],
      },
    },
  });

  // ---- Traceable opening batches (InventoryLot) ----
  if ((await prisma.inventoryLot.count({ where: { yardId } })) === 0) {
    // Mixed MS 1200 kg attributed to Balaji via load A-114.
    await prisma.inventoryLot.create({
      data: {
        yardId,
        skuId: skuByCode["MIXMS"],
        vendorId: balaji.id,
        vehicleNumber: "MH12AB1234",
        sourceLoadId: lotA114.id,
        originalKg: 1200,
        remainingKg: 1200,
      },
    });
    // Pre-existing finished stock as unattributed opening balances.
    const opening: [string, number][] = [
      ["MSB", 1850],
      ["MSC", 2400],
      ["PETW", 620],
      ["PETG", 1480],
      ["ALUC", 310],
    ];
    for (const [code, qty] of opening) {
      await prisma.inventoryLot.create({
        data: { yardId, skuId: skuByCode[code], originalKg: qty, remainingKg: qty },
      });
    }
  }

  // ---- Historical sales + receivables (matches Sell screen) ----
  const histSales = [
    { inv: "INV-0231", buyerId: shree.id, sku: "MSB", qty: 2000, rate: 33.5, amount: 84000 },
    { inv: "INV-0228", buyerId: green.id, sku: "PETW", qty: 1500, rate: 25, amount: 41500 },
  ];
  for (const h of histSales) {
    const existing = await prisma.sale.findUnique({
      where: { yardId_invoiceNumber: { yardId, invoiceNumber: h.inv } },
    });
    if (!existing) {
      const subtotal = h.amount / 1.18;
      const gst = h.amount - subtotal;
      const sale = await prisma.sale.create({
        data: {
          yardId,
          invoiceNumber: h.inv,
          buyerId: h.buyerId,
          skuId: skuByCode[h.sku],
          quantityKg: h.qty,
          ratePerKg: h.rate,
          subtotal: Math.round(subtotal),
          gstRate: 18,
          gstAmount: Math.round(gst),
          total: h.amount,
          status: "DISPATCHED",
          createdById: owner.id,
        },
      });
      await prisma.receivable.create({
        data: { yardId, saleId: sale.id, buyerId: h.buyerId, amount: h.amount, status: "PENDING" },
      });
    }
  }

  // ---- Sequence counters, namespaced per yard ----
  for (const [name, start] of [
    ["lot", 114],
    ["invoice", 231],
  ] as const) {
    await prisma.counter.upsert({
      where: { name: `${yardId}:${name}` },
      update: {}, // never rewind a live sequence
      create: { name: `${yardId}:${name}`, value: start },
    });
  }

  console.log("✅ Seed complete.");
  console.log("   admin@scrapflow.in / ScrapFlow@2026  (platform admin)");
  console.log("   owner@veloce.in / owner123 · manager@veloce.in / manager123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
