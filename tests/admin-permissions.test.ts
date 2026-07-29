/**
 * Exit gate: admin capabilities and their limits.
 *
 * Exercises the platform console over HTTP: yard lifecycle, user management,
 * password reset + forced change, record editing, ledger protection, audit
 * coverage, and the guardrails that stop an admin from breaking a yard.
 *
 * Everything is created and removed inside a throwaway yard. Yard 1 (the
 * production baseline) and the sandbox yard are only ever read.
 *
 * Usage: start the app, then `npm run test:admin`.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BASE = process.env.BASE_URL || "http://localhost:3001";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@scrapflow.in";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ScrapFlow@2026";

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
      callbackUrl: BASE + "/",
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

const YARD_CODE = "SFADMINT";
const OWNER_EMAIL = "admin-test-owner@veloce.test";
const MANAGER_EMAIL = "admin-test-manager@veloce.test";
const OWNER2_EMAIL = "admin-test-owner2@veloce.test";

async function cleanup() {
  const yard = await prisma.yard.findUnique({ where: { yardCode: YARD_CODE } });
  await prisma.user.deleteMany({ where: { email: { in: [OWNER_EMAIL, MANAGER_EMAIL, OWNER2_EMAIL] } } });
  if (!yard) return;
  await prisma.$transaction(async (tx) => {
    const w = { where: { yardId: yard.id } };
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
    await tx.counter.deleteMany({ where: { name: { startsWith: `${yard.id}:` } } });
    await tx.yard.delete({ where: { id: yard.id } });
  },
  { maxWait: 15_000, timeout: 60_000 }
);
}

async function main() {
  await cleanup(); // start from a known state even after a failed run

  const AD = makeClient();
  await AD.login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const sess = await (await AD.req("/api/auth/session")).json();
  check("admin logged in", sess?.user?.role === "ADMIN", JSON.stringify(sess?.user));

  // ---------- overview ----------
  console.log("\n[Overview] cross-yard aggregates");
  const ov = await (await AD.req("/api/admin/overview")).json();
  check("overview returns kpis", typeof ov?.kpis?.yardsActive === "number");
  check("overview lists yards", Array.isArray(ov?.yards) && ov.yards.length >= 1);
  check("overview includes Yard 1", ov.yards.some((y: { yardCode: string }) => y.yardCode === "SFDY001"));
  check("stock total is a number", typeof ov.kpis.stockKg === "number");

  // ---------- yard lifecycle ----------
  console.log("\n[Yards] create → edit → deactivate → reactivate");
  const createRes = await AD.json("/api/admin/yards", {
    yardCode: YARD_CODE,
    yardName: "Admin Test Yard",
    city: "Pune",
    state: "Maharashtra",
    seedMaterials: true,
  });
  check("yard created", createRes.status === 201, `got ${createRes.status}`);
  const created = await createRes.json();
  const yardId: string = created.yard.id;

  const skuCount = await prisma.sku.count({ where: { yardId } });
  check("new yard seeded with the starter SKU tree", skuCount === 9, `got ${skuCount}`);
  const invCount = await prisma.inventory.count({ where: { yardId } });
  check("new yard has zeroed inventory rows for every SKU", invCount === 9, `got ${invCount}`);
  const ctrs = await prisma.counter.count({ where: { name: { startsWith: `${yardId}:` } } });
  check("new yard has its own namespaced counters", ctrs === 2, `got ${ctrs}`);

  const dupRes = await AD.json("/api/admin/yards", { yardCode: YARD_CODE, yardName: "Clash" });
  check("duplicate yard code rejected → 409", dupRes.status === 409, `got ${dupRes.status}`);

  const editRes = await AD.json(`/api/admin/yards/${yardId}`, { yardName: "Admin Test Yard R2", ownerName: "Test Person" }, "PATCH");
  check("yard edited", editRes.status === 200, `got ${editRes.status}`);
  const editedYard = await prisma.yard.findUnique({ where: { id: yardId } });
  check("yard name persisted", editedYard?.yardName === "Admin Test Yard R2");
  check("yard code unchanged by an edit", editedYard?.yardCode === YARD_CODE);

  // ---------- users ----------
  console.log("\n[Users] create owner + manager, guardrails, reset");
  const mkOwner = await AD.json("/api/admin/users", {
    name: "Test Owner",
    email: OWNER_EMAIL,
    password: "ownerpass123",
    role: "OWNER",
    yardId,
  });
  check("owner created", mkOwner.status === 201, `got ${mkOwner.status}`);
  const ownerId: string = (await mkOwner.json()).user.id;

  const mkManager = await AD.json("/api/admin/users", {
    name: "Test Manager",
    email: MANAGER_EMAIL,
    password: "managerpass123",
    role: "MANAGER",
    yardId,
  });
  check("manager created", mkManager.status === 201, `got ${mkManager.status}`);
  const managerId: string = (await mkManager.json()).user.id;

  const dupUser = await AD.json("/api/admin/users", {
    name: "Dup",
    email: OWNER_EMAIL,
    password: "whatever123",
    role: "MANAGER",
    yardId,
  });
  check("duplicate email rejected → 409", dupUser.status === 409, `got ${dupUser.status}`);

  const shortPw = await AD.json("/api/admin/users", {
    name: "Short",
    email: "short@veloce.test",
    password: "abc",
    role: "MANAGER",
    yardId,
  });
  check("short password rejected → 422", shortPw.status === 422, `got ${shortPw.status}`);

  const escalate = await AD.json("/api/admin/users", {
    name: "Sneaky",
    email: "sneaky@veloce.test",
    password: "sneaky12345",
    role: "ADMIN",
    yardId,
  });
  check("cannot create another ADMIN through the API → 422", escalate.status === 422, `got ${escalate.status}`);

  // last-owner guardrail
  const demote = await AD.json(`/api/admin/users/${ownerId}`, { role: "MANAGER" }, "PATCH");
  check("cannot demote a yard's only owner → 409", demote.status === 409, `got ${demote.status}`);
  const disable = await AD.json(`/api/admin/users/${ownerId}`, { active: false }, "PATCH");
  check("cannot disable a yard's only owner → 409", disable.status === 409, `got ${disable.status}`);

  const mkOwner2 = await AD.json("/api/admin/users", {
    name: "Second Owner",
    email: OWNER2_EMAIL,
    password: "owner2pass123",
    role: "OWNER",
    yardId,
  });
  check("second owner created", mkOwner2.status === 201, `got ${mkOwner2.status}`);
  const demote2 = await AD.json(`/api/admin/users/${ownerId}`, { role: "MANAGER" }, "PATCH");
  check("with a second owner, demotion is allowed", demote2.status === 200, `got ${demote2.status}`);
  await AD.json(`/api/admin/users/${ownerId}`, { role: "OWNER" }, "PATCH"); // restore

  // admin self-protection
  const adminRow = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  const selfDisable = await AD.json(`/api/admin/users/${adminRow!.id}`, { active: false }, "PATCH");
  check("admin cannot disable their own account → 409", selfDisable.status === 409, `got ${selfDisable.status}`);
  const adminReassign = await AD.json(`/api/admin/users/${adminRow!.id}`, { yardId }, "PATCH");
  check("admin cannot be given a yard → 409", adminReassign.status === 409, `got ${adminReassign.status}`);

  // password reset + forced change
  console.log("\n[Password reset] forces a change on next sign-in");
  const reset = await AD.json(`/api/admin/users/${managerId}/password`, { newPassword: "tempPass9876" });
  check("password reset accepted", reset.status === 200, `got ${reset.status}`);
  const mgrRow = await prisma.user.findUnique({ where: { id: managerId } });
  check("mustChangePassword flag set", mgrRow?.mustChangePassword === true);

  const MG = makeClient();
  await MG.login(MANAGER_EMAIL, "tempPass9876");
  const mgSess = await (await MG.req("/api/auth/session")).json();
  check("manager can sign in with the temporary password", mgSess?.user?.role === "MANAGER");
  const blockedWhilePending = await MG.req("/api/stock");
  check(
    "yard APIs blocked until the password is changed → 403",
    blockedWhilePending.status === 403,
    `got ${blockedWhilePending.status}`
  );
  const wrongCurrent = await MG.json("/api/account/password", {
    currentPassword: "notitatall",
    newPassword: "brandNew12345",
  });
  check("wrong current password rejected → 422", wrongCurrent.status === 422, `got ${wrongCurrent.status}`);
  const changed = await MG.json("/api/account/password", {
    currentPassword: "tempPass9876",
    newPassword: "brandNew12345",
  });
  check("password change accepted", changed.status === 200, `got ${changed.status}`);
  const mgrAfter = await prisma.user.findUnique({ where: { id: managerId } });
  check("mustChangePassword cleared", mgrAfter?.mustChangePassword === false);

  const MG2 = makeClient();
  await MG2.login(MANAGER_EMAIL, "brandNew12345");
  const mgStock = await MG2.req("/api/stock");
  check("after changing it, the manager can use the app", mgStock.status === 200, `got ${mgStock.status}`);
  const oldPw = makeClient();
  await oldPw.login(MANAGER_EMAIL, "tempPass9876");
  const oldSess = await (await oldPw.req("/api/auth/session")).json();
  check("the old temporary password no longer works", !oldSess?.user);

  // ---------- deactivation locks out ----------
  console.log("\n[Deactivation] locks users out without deleting anything");
  const vendorBefore = await prisma.vendor.create({
    data: { yardId, name: "Doomed Vendor Co", active: true },
  });
  const off = await AD.json(`/api/admin/yards/${yardId}`, undefined, "DELETE");
  check("yard deactivated", off.status === 200, `got ${off.status}`);
  const offYard = await prisma.yard.findUnique({ where: { id: yardId } });
  check("deactivatedAt stamped", offYard?.deactivatedAt !== null);
  const vendorStill = await prisma.vendor.findUnique({ where: { id: vendorBefore.id } });
  check("yard data survives deactivation", vendorStill?.name === "Doomed Vendor Co");
  const skusStill = await prisma.sku.count({ where: { yardId } });
  check("all 9 SKUs survive deactivation", skusStill === 9, `got ${skusStill}`);

  const lockedOut = makeClient();
  await lockedOut.login(OWNER_EMAIL, "ownerpass123");
  const loSess = await (await lockedOut.req("/api/auth/session")).json();
  check("owner of an inactive yard cannot sign in", !loSess?.user);

  const enterOff = await AD.json("/api/admin/impersonate", { yardId });
  check("admin cannot enter an inactive yard → 409", enterOff.status === 409, `got ${enterOff.status}`);

  const on = await AD.json(`/api/admin/yards/${yardId}`, { active: true }, "PATCH");
  check("yard reactivated", on.status === 200, `got ${on.status}`);
  const backIn = makeClient();
  await backIn.login(OWNER_EMAIL, "ownerpass123");
  const biSess = await (await backIn.req("/api/auth/session")).json();
  check("owner can sign in again after reactivation", biSess?.user?.role === "OWNER");

  // ---------- record editing ----------
  console.log("\n[Record editing] descriptive fields yes, ledger fields never");
  const editVendor = await AD.json(
    `/api/admin/records/vendor/${vendorBefore.id}`,
    { name: "Renamed By Admin", phone: "9000000000" },
    "PATCH"
  );
  check("admin can edit a vendor in any yard", editVendor.status === 200, `got ${editVendor.status}`);
  const vRenamed = await prisma.vendor.findUnique({ where: { id: vendorBefore.id } });
  check("vendor rename persisted", vRenamed?.name === "Renamed By Admin");

  const editAudit = await prisma.auditLog.findFirst({
    where: { action: "vendor.adminEdit", entityId: vendorBefore.id },
  });
  check("admin edit is audited with before/after", !!editAudit && !!editAudit.after);

  const sku = await prisma.sku.findFirstOrThrow({ where: { yardId, code: "MSB" } });
  const editSku = await AD.json(`/api/admin/records/sku/${sku.id}`, { saleThresholdKg: 3000, visible: false }, "PATCH");
  check("admin can edit SKU threshold + visibility", editSku.status === 200, `got ${editSku.status}`);
  const skuAfter = await prisma.sku.findUnique({ where: { id: sku.id } });
  check("threshold persisted", skuAfter?.saleThresholdKg === 3000);

  const ledgerAttempt = await AD.json(`/api/admin/records/sku/${sku.id}`, { quantityKg: 999999 }, "PATCH");
  check("ledger field rejected → 422", ledgerAttempt.status === 422, `got ${ledgerAttempt.status}`);
  const ledgerBody = await ledgerAttempt.json();
  check("rejection explains why", /ledger/i.test(ledgerBody?.error?.message ?? ""));

  const tenancyAttempt = await AD.json(`/api/admin/records/vendor/${vendorBefore.id}`, { yardId: "somewhere-else" }, "PATCH");
  check("yardId cannot be edited through the record editor → 422", tenancyAttempt.status === 422, `got ${tenancyAttempt.status}`);

  const badEntity = await AD.json(`/api/admin/records/user/${ownerId}`, { name: "x" }, "PATCH");
  check("non-whitelisted entity rejected → 404", badEntity.status === 404, `got ${badEntity.status}`);

  const unknownField = await AD.json(`/api/admin/records/vendor/${vendorBefore.id}`, { secretFlag: true }, "PATCH");
  check("unknown field rejected → 422", unknownField.status === 422, `got ${unknownField.status}`);

  // cross-yard vendor reassignment must be refused
  const yard1 = await prisma.yard.findUniqueOrThrow({ where: { yardCode: "SFDY001" } });
  /** Baseline for the teardown check. Compared to itself, never to a fixture count. */
  const y1VendorsBefore = await prisma.vendor.count({ where: { yardId: yard1.id } });
  const yard1Vendor = await prisma.vendor.findFirstOrThrow({ where: { yardId: yard1.id } });
  const load = await prisma.inwardLoad.create({
    data: {
      yardId,
      lotNumber: "ADM-1",
      materialLabel: "Mixed MS",
      totalKg: 100,
      status: "RECEIVED",
      weightEntries: { create: [{ yardId, sequence: 1, kg: 100 }] },
    },
  });
  const crossVendor = await AD.json(`/api/admin/records/inwardLoad/${load.id}`, { vendorId: yard1Vendor.id }, "PATCH");
  check("cannot attach another yard's vendor to a load → 422", crossVendor.status === 422, `got ${crossVendor.status}`);
  const sameYardVendor = await AD.json(`/api/admin/records/inwardLoad/${load.id}`, { vendorId: vendorBefore.id }, "PATCH");
  check("can attach a same-yard vendor", sameYardVendor.status === 200, `got ${sameYardVendor.status}`);

  // ---------- yard detail + audit ----------
  console.log("\n[Detail + audit] admin can see everything in a yard");
  const detail = await (await AD.req(`/api/admin/yards/${yardId}`)).json();
  check("yard detail returns stock", Array.isArray(detail?.stock) && detail.stock.length === 9);
  check("yard detail returns users", Array.isArray(detail?.users) && detail.users.length >= 2);
  check("yard detail returns vendors", detail.vendors.some((v: { name: string }) => v.name === "Renamed By Admin"));
  check("yard detail returns loads", detail.loads.some((l: { lotNumber: string }) => l.lotNumber === "ADM-1"));
  check("yard detail returns totals", typeof detail?.totals?.stockKg === "number");

  const auditPage = await (await AD.req(`/api/admin/audit?yardId=${yardId}`)).json();
  check("audit is filterable by yard", Array.isArray(auditPage?.entries) && auditPage.entries.length > 0);
  check("audit exposes filter options", Array.isArray(auditPage?.filters?.actions));
  const actions: string[] = auditPage.entries.map((e: { action: string }) => e.action);
  check("yard.create audited", actions.includes("yard.create"));
  check("user.create audited", actions.includes("user.create"));
  check("user.passwordReset audited", actions.includes("user.passwordReset"));
  check("yard.deactivate audited", actions.includes("yard.deactivate"));

  const pwAudit = auditPage.entries.find((e: { action: string }) => e.action === "user.passwordReset");
  const pwJson = JSON.stringify(pwAudit ?? {});
  check("audit never stores password material", !/tempPass9876|brandNew12345/.test(pwJson));

  // ---------- teardown ----------
  console.log("\n[Teardown] removing the admin test yard");
  await cleanup();
  const gone = await prisma.yard.findUnique({ where: { yardCode: YARD_CODE } });
  check("admin test yard removed", gone === null);

  /**
   * "Untouched" means THIS SUITE did not change it — not that Yard 1 still holds
   * the prototype's two vendor chips. Yard 1 is a live demo yard, so vendors
   * legitimately get added through the app; asserting the fixture count made
   * normal use look like a regression. Compared against the count taken before
   * the suite ran.
   */
  const y1VendorsAfter = await prisma.vendor.count({ where: { yardId: yard1.id } });
  check(
    "Yard 1 vendors unchanged by this suite",
    y1VendorsAfter === y1VendorsBefore,
    `${y1VendorsBefore} → ${y1VendorsAfter}`
  );

  console.log(`\n==== admin: ${pass} passed, ${fail} failed ====`);
  if (fail > 0) process.exit(1);
}

main()
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
