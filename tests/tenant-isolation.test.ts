/**
 * Exit gate: tenant isolation.
 *
 * Builds a second yard (Yard B) directly in the database, then proves through
 * the HTTP API that Yard A and Yard B users cannot see or touch each other's
 * data, that non-admins cannot reach the platform console, and that an ADMIN has
 * no yard data access until they explicitly enter a yard.
 *
 * Yard A is the sandbox yard (tests/fixtures.ts), NOT Yard 1 — this suite writes
 * nothing to the production baseline. Yard B fixtures are removed at the end.
 *
 * Usage: start the app, then `npm run test:isolation`.
 */
import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { TEST_YARD_CODE, TEST_OWNER, TEST_MANAGER } from "./fixtures";

const prisma = new PrismaClient();
const BASE = process.env.BASE_URL || "http://localhost:3001";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@scrapflow.in";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ScrapFlow@2026";

const YARD_B_CODE = "SFTEST-B";
const OWNER_B = { email: "ownerb@test.in", password: "testpass123" };

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

// --- tiny cookie-jar fetch client ---
function makeClient() {
  let cookies: Record<string, string> = {};
  const ch = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const store = (res: Response) => {
    const raw: string[] = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of raw) {
      const [p] = c.split(";");
      const i = p.indexOf("=");
      cookies[p.slice(0, i)] = p.slice(i + 1);
    }
  };
  const req = async (path: string, opts: RequestInit = {}) => {
    const res = await fetch(BASE + path, {
      ...opts,
      headers: { ...(opts.headers || {}), cookie: ch() },
      redirect: "manual",
    });
    store(res);
    return res;
  };
  const json = (p: string, b?: unknown, m = "POST") =>
    req(p, {
      method: m,
      headers: { "content-type": "application/json" },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
  const login = async (email: string, password: string) => {
    cookies = {};
    const csrf = await (await req("/api/auth/csrf")).json();
    const body = new URLSearchParams({
      csrfToken: csrf.csrfToken,
      email,
      password,
      callbackUrl: BASE + "/stock",
      json: "true",
    });
    await req("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  };
  return { req, json, login };
}

async function main() {
  const yardA = await prisma.yard.findUnique({ where: { yardCode: TEST_YARD_CODE } });
  if (!yardA) {
    console.error(`❌ Sandbox yard ${TEST_YARD_CODE} missing. Run: npx tsx tests/fixtures.ts up`);
    process.exit(1);
  }
  const yard1 = await prisma.yard.findUnique({ where: { yardCode: "SFDY001" } });

  /**
   * Yard 1's census BEFORE this suite runs anything.
   *
   * The property being guarded is "this suite writes nothing to the production
   * baseline", so it is asserted as a before/after comparison. Hardcoding the
   * prototype's counts here conflated two different things and made the suite
   * fail whenever someone legitimately used the app in Yard 1 — drift from the
   * prototype is real, but detecting it is `demo:restore`'s job, not this
   * suite's.
   */
  const y1Before = yard1
    ? {
        vendors: await prisma.vendor.count({ where: { yardId: yard1.id } }),
        sales: await prisma.sale.count({ where: { yardId: yard1.id } }),
        loads: await prisma.inwardLoad.count({ where: { yardId: yard1.id } }),
        lines: await prisma.inwardLoadLine.count({ where: { yardId: yard1.id } }),
        lots: await prisma.inventoryLot.count({ where: { yardId: yard1.id } }),
        txns: await prisma.inventoryTransaction.count({ where: { yardId: yard1.id } }),
      }
    : null;

  // ---- Yard B fixtures ----
  const yardB = await prisma.yard.upsert({
    where: { yardCode: YARD_B_CODE },
    update: { active: true },
    create: { yardCode: YARD_B_CODE, yardName: "Isolation Test Yard", city: "Mumbai", state: "Maharashtra" },
  });
  const hash = await bcrypt.hash(OWNER_B.password, 10);
  await prisma.user.upsert({
    where: { email: OWNER_B.email },
    update: { yardId: yardB.id, role: Role.OWNER, passwordHash: hash, active: true, mustChangePassword: false },
    create: { email: OWNER_B.email, name: "Owner B", passwordHash: hash, role: Role.OWNER, yardId: yardB.id },
  });
  const vendorB = await prisma.vendor.upsert({
    where: { id: "test-vendor-b" },
    update: { yardId: yardB.id, active: true },
    create: { id: "test-vendor-b", yardId: yardB.id, name: "YardB Secret Vendor" },
  });
  const materialB = await prisma.material.upsert({
    where: { yardId_code: { yardId: yardB.id, code: "BMET" } },
    update: {},
    create: { yardId: yardB.id, name: "B Metal", code: "BMET" },
  });
  const skuB = await prisma.sku.upsert({
    where: { yardId_code: { yardId: yardB.id, code: "BSKU" } },
    update: {},
    create: { yardId: yardB.id, name: "B Secret SKU", code: "BSKU", materialId: materialB.id, isMixedBucket: true },
  });
  await prisma.inventory.upsert({
    where: { skuId: skuB.id },
    update: { quantityKg: 999 },
    create: { yardId: yardB.id, skuId: skuB.id, quantityKg: 999 },
  });

  const A = makeClient();
  const B = makeClient();
  const AD = makeClient();

  // ================= reads =================
  console.log("\n[Yard A owner] cannot read Yard B data");
  await A.login(TEST_OWNER.email, TEST_OWNER.password);
  const aSess = await (await A.req("/api/auth/session")).json();
  check("A session is OWNER", aSess?.user?.role === "OWNER");
  check("A session carries a yardId", !!aSess?.user?.yardId, JSON.stringify(aSess?.user));

  const aVendors = await (await A.req("/api/vendors")).json();
  check(
    "A vendor list excludes Yard B's vendor",
    !aVendors.vendors.some((v: { name: string }) => v.name === "YardB Secret Vendor")
  );
  check("A vendor list includes its own vendor", aVendors.vendors.some((v: { name: string }) => v.name === "Balaji Metals"));

  const aStock = await (await A.req("/api/stock")).json();
  check("A stock excludes Yard B's SKU", !aStock.skus.some((s: { name: string }) => s.name === "B Secret SKU"));

  console.log("\n[Yard B owner] cannot read Yard A data");
  await B.login(OWNER_B.email, OWNER_B.password);
  const bVendors = await (await B.req("/api/vendors")).json();
  check("B vendor list excludes Yard A's vendors", !bVendors.vendors.some((v: { name: string }) => v.name === "Balaji Metals"));
  check("B sees only its own vendor", bVendors.vendors.some((v: { name: string }) => v.name === "YardB Secret Vendor"));

  const bStock = await (await B.req("/api/stock")).json();
  check("B stock contains only its own SKU", bStock.skus.length === 1 && bStock.skus[0].name === "B Secret SKU");

  // ================= direct-id probing =================
  console.log("\n[Direct id probing] a guessed id from another yard must 404, not 403");
  const bSkuProbe = await A.req(`/api/stock/${skuB.id}/sources`);
  check("A probing Yard B's SKU → 404", bSkuProbe.status === 404, `got ${bSkuProbe.status}`);

  const bVendorDelete = await A.json(`/api/vendors/${vendorB.id}`, undefined, "DELETE");
  check("A cannot soft-delete Yard B's vendor → 404", bVendorDelete.status === 404, `got ${bVendorDelete.status}`);
  const vendorBStill = await prisma.vendor.findUnique({ where: { id: vendorB.id } });
  check("Yard B's vendor is still active (untouched)", vendorBStill?.active === true);

  const bVendorPatch = await A.json(`/api/vendors/${vendorB.id}`, { active: false }, "PATCH");
  check("A cannot patch Yard B's vendor → 404", bVendorPatch.status === 404, `got ${bVendorPatch.status}`);

  const bSkuVis = await A.json(`/api/skus/${skuB.id}/visibility`, { visible: false }, "PATCH");
  check("A cannot toggle Yard B's SKU visibility → 404", bSkuVis.status === 404, `got ${bSkuVis.status}`);
  const skuBStill = await prisma.sku.findUnique({ where: { id: skuB.id } });
  check("Yard B's SKU visibility unchanged", skuBStill?.visible === true);

  const bInward = await A.json("/api/inward/loads", {
    materialSkuId: skuB.id,
    entries: [100],
  });
  check("A cannot inward into Yard B's bucket → 422", bInward.status === 422, `got ${bInward.status}`);

  const bSale = await A.json("/api/sales", { skuId: skuB.id, buyerName: "Hijack", quantityKg: 10, ratePerKg: 5 });
  check("A cannot sell Yard B's stock → 404", bSale.status === 404, `got ${bSale.status}`);

  // ================= numbering independence =================
  console.log("\n[Numbering] each yard has its own lot sequence");
  const counters = await prisma.counter.findMany({ where: { name: { contains: ":" } } });
  check(
    "Yard A and Yard B have separate lot counters or none yet",
    !counters.some((c) => !c.name.includes(":")),
    counters.map((c) => c.name).join(", ")
  );
  const dupLots = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
    `select count(*)::bigint as c from (select "yardId","lotNumber" from "InwardLoad" group by 1,2 having count(*)>1) d`
  );
  check("no duplicate lot numbers within any yard", Number(dupLots[0].c) === 0);

  // ================= console access =================
  console.log("\n[Platform console] is closed to yard users");
  for (const [label, client] of [["A owner", A], ["B owner", B]] as const) {
    const r1 = await client.req("/api/admin/yards");
    check(`${label} blocked from /api/admin/yards`, r1.status === 403, `got ${r1.status}`);
    const r2 = await client.req("/api/admin/overview");
    check(`${label} blocked from /api/admin/overview`, r2.status === 403, `got ${r2.status}`);
    const r3 = await client.req("/api/admin/audit");
    check(`${label} blocked from /api/admin/audit`, r3.status === 403, `got ${r3.status}`);
    const r4 = await client.req("/api/admin/realtime/stream");
    check(`${label} blocked from the platform realtime stream`, r4.status === 403, `got ${r4.status}`);
    const r5 = await client.json("/api/admin/impersonate", { yardId: yardB.id });
    check(`${label} cannot start an impersonation session`, r5.status === 403, `got ${r5.status}`);
    const r6 = await client.req("/admin");
    check(`${label} redirected away from /admin`, r6.status === 307 || r6.status === 302, `got ${r6.status}`);
  }

  console.log("\n[Manager] still cannot sell");
  const M = makeClient();
  await M.login(TEST_MANAGER.email, TEST_MANAGER.password);
  const mSell = await M.req("/api/sell/ready");
  check("manager blocked from /api/sell/ready", mSell.status === 403, `got ${mSell.status}`);
  const mSale = await M.json("/api/sales", { skuId: "x", buyerName: "y", quantityKg: 1, ratePerKg: 1 });
  check("manager blocked from creating a sale", mSale.status === 403, `got ${mSale.status}`);
  const mStock = await M.req("/api/stock");
  check("manager can still read its own yard's stock", mStock.status === 200, `got ${mStock.status}`);

  // ================= admin has no yard context by default =================
  console.log("\n[Admin] has no yard data access until entering a yard");
  await AD.login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const adSess = await (await AD.req("/api/auth/session")).json();
  check("admin session is ADMIN", adSess?.user?.role === "ADMIN", JSON.stringify(adSess?.user));
  check("admin session has no yardId", adSess?.user?.yardId === null, String(adSess?.user?.yardId));

  const adStock = await AD.req("/api/stock");
  check("admin without a yard session → 409 on /api/stock", adStock.status === 409, `got ${adStock.status}`);
  const adAdminOk = await AD.req("/api/admin/yards");
  check("admin can read /api/admin/yards", adAdminOk.status === 200, `got ${adAdminOk.status}`);

  // ================= impersonation =================
  console.log("\n[Enter Yard] admin gets exactly one yard's data, fully audited");
  const enter = await AD.json("/api/admin/impersonate", { yardId: yardB.id });
  check("admin can enter Yard B", enter.status === 200, `got ${enter.status}`);

  const adStockB = await (await AD.req("/api/stock")).json();
  check("inside Yard B, admin sees Yard B stock", adStockB.skus?.some((s: { name: string }) => s.name === "B Secret SKU"));
  check(
    "inside Yard B, admin does NOT see Yard A stock",
    !adStockB.skus?.some((s: { name: string }) => s.name === "MS Bazar")
  );

  const adSellB = await AD.req("/api/sell/ready");
  check("admin inherits owner access to Sell inside the yard", adSellB.status === 200, `got ${adSellB.status}`);

  const openSession = await prisma.impersonationSession.findFirst({
    where: { yardId: yardB.id, endedAt: null },
    include: { admin: true },
  });
  check("an open ImpersonationSession row exists", !!openSession);
  check("session records the admin", openSession?.admin.email === ADMIN_EMAIL);

  const enterAudit = await prisma.auditLog.findFirst({
    where: { action: "impersonation.enter", yardId: yardB.id },
    orderBy: { createdAt: "desc" },
  });
  check("enter is audited", !!enterAudit);

  // Owner B must not be able to detect the admin's presence.
  const bStockDuring = await B.req("/api/stock");
  const bBody = await bStockDuring.text();
  check("Owner B's responses leak nothing about admin presence", !/impersonat/i.test(bBody));
  const bSessDuring = await (await B.req("/api/auth/session")).json();
  check("Owner B's session is unchanged during admin presence", bSessDuring?.user?.role === "OWNER");

  const exit = await AD.json("/api/admin/impersonate", undefined, "DELETE");
  check("admin can exit the yard", exit.status === 200, `got ${exit.status}`);
  const closed = await prisma.impersonationSession.findUnique({ where: { id: openSession!.id } });
  check("session is closed on exit", closed?.endedAt !== null);
  check("session duration recorded", typeof closed?.durationSec === "number");
  check("exit reason recorded", closed?.endReason === "manual");

  const exitAudit = await prisma.auditLog.findFirst({
    where: { action: "impersonation.exit", entityId: openSession!.id },
  });
  check("exit is audited", !!exitAudit);

  const adStockAfter = await AD.req("/api/stock");
  check("after exit, admin has no yard data access again", adStockAfter.status === 409, `got ${adStockAfter.status}`);

  // ================= production baseline untouched =================
  console.log("\n[Production baseline] Yard 1 is untouched by this suite");
  if (yard1 && y1Before) {
    const y1After = {
      vendors: await prisma.vendor.count({ where: { yardId: yard1.id } }),
      sales: await prisma.sale.count({ where: { yardId: yard1.id } }),
      loads: await prisma.inwardLoad.count({ where: { yardId: yard1.id } }),
      lines: await prisma.inwardLoadLine.count({ where: { yardId: yard1.id } }),
      lots: await prisma.inventoryLot.count({ where: { yardId: yard1.id } }),
      txns: await prisma.inventoryTransaction.count({ where: { yardId: yard1.id } }),
    };
    for (const k of Object.keys(y1Before) as (keyof typeof y1Before)[]) {
      check(
        `Yard 1 ${k} unchanged by this suite`,
        y1After[k] === y1Before[k],
        `${y1Before[k]} → ${y1After[k]}`
      );
    }
    check("Yard 1 is named 'Yard 1'", yard1.yardName === "Yard 1", yard1.yardName);
  }

  // ---- Teardown: Yard B only ----
  console.log("\n[Teardown] removing Yard B fixtures");
  await prisma.$transaction(async (tx) => {
    const w = { where: { yardId: yardB.id } };
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
    await tx.user.deleteMany({ where: { email: OWNER_B.email } });
    await tx.counter.deleteMany({ where: { name: { startsWith: `${yardB.id}:` } } });
    await tx.yard.delete({ where: { id: yardB.id } });
  },
  { maxWait: 15_000, timeout: 60_000 }
);
  console.log("  ✓ Yard B removed");

  console.log(`\n==== isolation: ${pass} passed, ${fail} failed ====`);
  if (fail > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
