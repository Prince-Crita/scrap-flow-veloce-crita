/**
 * Stock adjustment (Phase 5 Module 5).
 *
 * The property that matters most is the one `db:verify` enforces:
 *
 *     Inventory.quantityKg === Σ InventoryLot.remainingKg   (per SKU)
 *
 * An adjustment changes a quantity, so it MUST reconcile both sides in one
 * transaction. Every case below re-derives that sum from the database after the
 * call rather than trusting the response.
 *
 * Runs against the sandbox yard only, and restores the SKU it adjusts. Yard 1 is
 * never written to — one assertion proves the endpoint refuses to be pointed at it
 * without an explicit yardId, and no test ever sends Yard 1's id.
 *
 * Usage: start the app, then `npx tsx tests/stock-adjustment.test.ts`.
 */
import { PrismaClient } from "@prisma/client";
import { TEST_YARD_CODE, TEST_OWNER, TEST_MANAGER } from "./fixtures";

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
  const req = async (path: string, opts: RequestInit = {}) => {
    const res = await fetch(BASE + path, {
      ...opts,
      headers: { ...(opts.headers || {}), cookie: ch() },
      redirect: "manual",
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [p] = c.split(";");
      const i = p.indexOf("=");
      cookies[p.slice(0, i)] = p.slice(i + 1);
    }
    return res;
  };
  const send = (path: string, body?: unknown, method = "POST") =>
    req(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = async (email: string, password: string) => {
    cookies = {};
    const csrf = await (await req("/api/auth/csrf")).json();
    await req("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrfToken: csrf.csrfToken,
        email,
        password,
        callbackUrl: BASE + "/stock",
        json: "true",
      }).toString(),
    });
  };
  return { req, send, login };
}

const errCode = async (r: Response) => {
  try {
    return (await r.clone().json())?.error?.code ?? null;
  } catch {
    return null;
  }
};

const ENDPOINT = "/api/admin/stock-adjustment";
const REASON = "Automated regression test: recount of the sandbox bay.";

async function main() {
  const yard = await prisma.yard.findUniqueOrThrow({ where: { yardCode: TEST_YARD_CODE } });
  const yardId = yard.id;

  /** Inventory and the batch sum for one SKU, both read from the database. */
  async function state(skuId: string) {
    const inv = await prisma.inventory.findUnique({ where: { skuId } });
    const lots = await prisma.inventoryLot.aggregate({ where: { skuId }, _sum: { remainingKg: true } });
    return { quantityKg: inv?.quantityKg ?? 0, lotKg: lots._sum.remainingKg ?? 0 };
  }

  // MS Bazar has both stock and traceable batches in the sandbox baseline.
  const sku = await prisma.sku.findFirstOrThrow({
    where: { yardId, code: "MSB" },
    select: { id: true, name: true },
  });
  const original = await state(sku.id);
  console.log(`Target: ${sku.name} at ${original.quantityKg} kg (batches ${original.lotKg} kg)`);
  check("the sandbox baseline itself satisfies the invariant", original.quantityKg === original.lotKg, `${original.quantityKg} vs ${original.lotKg}`);

  const A = makeClient();
  await A.login(ADMIN_EMAIL, ADMIN_PASSWORD);

  // ── Access control comes first: nothing should be adjustable by anyone else ──
  console.log("\nAccess control:");
  const anon = await fetch(BASE + ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ yardId, skuId: sku.id, actualKg: 1, reason: REASON }),
    redirect: "manual",
  });
  check("an anonymous caller is rejected", anon.status >= 300, String(anon.status));

  const O = makeClient();
  await O.login(TEST_OWNER.email, TEST_OWNER.password);
  const ownerTry = await O.send(ENDPOINT, { yardId, skuId: sku.id, actualKg: 1, reason: REASON });
  check("an owner cannot adjust stock", ownerTry.status === 403 || ownerTry.status === 401, String(ownerTry.status));

  const M = makeClient();
  await M.login(TEST_MANAGER.email, TEST_MANAGER.password);
  const managerTry = await M.send(ENDPOINT, { yardId, skuId: sku.id, actualKg: 1, reason: REASON });
  check("a manager cannot adjust stock", managerTry.status === 403 || managerTry.status === 401, String(managerTry.status));

  const afterDenied = await state(sku.id);
  check("no denied attempt changed the quantity", afterDenied.quantityKg === original.quantityKg, `${afterDenied.quantityKg}`);

  // ── Validation ────────────────────────────────────────────────────────────
  console.log("\nA reason is mandatory:");
  const noReason = await A.send(ENDPOINT, { yardId, skuId: sku.id, actualKg: original.quantityKg + 5 });
  check("a missing reason is refused", noReason.status === 400 || noReason.status === 422, String(noReason.status));
  const shortReason = await A.send(ENDPOINT, { yardId, skuId: sku.id, actualKg: original.quantityKg + 5, reason: "fix" });
  check("a token reason is refused", shortReason.status === 400 || shortReason.status === 422, String(shortReason.status));
  const blankReason = await A.send(ENDPOINT, { yardId, skuId: sku.id, actualKg: original.quantityKg + 5, reason: "          " });
  check("whitespace is not a reason", blankReason.status === 400 || blankReason.status === 422, String(blankReason.status));
  check("no refused call changed anything", (await state(sku.id)).quantityKg === original.quantityKg);

  console.log("\nOther validation:");
  const negative = await A.send(ENDPOINT, { yardId, skuId: sku.id, actualKg: -5, reason: REASON });
  check("a negative quantity is refused", negative.status === 400 || negative.status === 422, String(negative.status));
  const fractional = await A.send(ENDPOINT, { yardId, skuId: sku.id, actualKg: 12.5, reason: REASON });
  check("a fractional quantity is refused", fractional.status === 400 || fractional.status === 422, String(fractional.status));
  const noop = await A.send(ENDPOINT, { yardId, skuId: sku.id, actualKg: original.quantityKg, reason: REASON });
  check("a no-op adjustment is refused", noop.status === 422 && (await errCode(noop)) === "NO_CHANGES", `${noop.status} / ${await errCode(noop)}`);
  const badSku = await A.send(ENDPOINT, { yardId, skuId: "cmxxxxxxxxxxxxxxxxxxxxxxx", reason: REASON, actualKg: 5 });
  check("an unknown SKU is refused", badSku.status === 404 && (await errCode(badSku)) === "NOT_FOUND", String(badSku.status));
  const badYard = await A.send(ENDPOINT, { yardId: "cmxxxxxxxxxxxxxxxxxxxxxxx", skuId: sku.id, reason: REASON, actualKg: 5 });
  check("an unknown yard is refused", badYard.status === 404, String(badYard.status));
  const noYard = await A.send(ENDPOINT, { skuId: sku.id, actualKg: 5, reason: REASON });
  check("an admin write must name its yard", noYard.status === 400 || noYard.status === 422, String(noYard.status));

  // A SKU id from another yard must not be adjustable under this yardId — that is
  // the check that stops a mistyped id reaching a different tenant.
  const foreign = await prisma.sku.findFirst({ where: { yardId: { not: yardId } }, select: { id: true, name: true } });
  if (foreign) {
    const before = await state(foreign.id);
    const cross = await A.send(ENDPOINT, { yardId, skuId: foreign.id, actualKg: 1, reason: REASON });
    check("a SKU from another yard is not found under this yard", cross.status === 404, String(cross.status));
    check("the other yard's stock is untouched", (await state(foreign.id)).quantityKg === before.quantityKg);
  }

  // ── Decrease ──────────────────────────────────────────────────────────────
  console.log("\nDecreasing stock:");
  const downTo = original.quantityKg - 120;
  const dec = await A.send(ENDPOINT, { yardId, skuId: sku.id, actualKg: downTo, reason: REASON });
  check("an admin can decrease", dec.status === 200, `${dec.status} / ${await errCode(dec)}`);
  const decBody = await dec.json();
  check("the response reports the previous value", decBody.adjustment?.previousKg === original.quantityKg);
  check("the response reports the new value", decBody.adjustment?.newKg === downTo);
  check("the response reports a negative change", decBody.adjustment?.changeKg === -120, String(decBody.adjustment?.changeKg));

  const afterDec = await state(sku.id);
  check("inventory reflects the new count", afterDec.quantityKg === downTo, `${afterDec.quantityKg} vs ${downTo}`);
  check("THE INVARIANT HOLDS after a decrease", afterDec.quantityKg === afterDec.lotKg, `inventory ${afterDec.quantityKg} vs batches ${afterDec.lotKg}`);
  check("batches were consumed, not created", afterDec.lotKg === original.lotKg - 120);

  const decTxn = await prisma.inventoryTransaction.findFirst({
    where: { skuId: sku.id, type: "STOCK_ADJUSTMENT" },
    orderBy: { createdAt: "desc" },
  });
  check("a STOCK_ADJUSTMENT ledger entry was written", !!decTxn);
  check("the ledger entry carries the signed change", decTxn?.changeKg === -120, String(decTxn?.changeKg));
  check("the ledger entry records the actor", !!decTxn?.byUserId);
  check("the ledger entry is in the right yard", decTxn?.yardId === yardId);
  // A correction must never be counted as trade in a report.
  check("it is NOT typed as a sale or dispatch", decTxn?.type === "STOCK_ADJUSTMENT");

  const decAudit = await prisma.auditLog.findFirst({
    where: { yardId, entity: "Inventory", entityId: sku.id, action: "stock.adjust" },
    orderBy: { createdAt: "desc" },
  });
  check("the adjustment is audited", !!decAudit);
  check("the audit records the actor", !!decAudit?.actorId);
  check("the audit keeps the previous quantity", JSON.stringify(decAudit?.before ?? {}).includes(String(original.quantityKg)));
  check("the audit stores the reason", JSON.stringify(decAudit?.after ?? {}).includes("recount of the sandbox bay"));
  check("the audit links the ledger entry", JSON.stringify(decAudit?.after ?? {}).includes(decTxn?.id ?? "—"));

  // ── Increase ──────────────────────────────────────────────────────────────
  console.log("\nIncreasing stock:");
  const lotsBefore = await prisma.inventoryLot.count({ where: { skuId: sku.id } });
  const upTo = downTo + 300;
  const inc = await A.send(ENDPOINT, { yardId, skuId: sku.id, actualKg: upTo, reason: REASON });
  check("an admin can increase", inc.status === 200, `${inc.status} / ${await errCode(inc)}`);
  const incBody = await inc.json();
  check("the response reports a positive change", incBody.adjustment?.changeKg === 300, String(incBody.adjustment?.changeKg));

  const afterInc = await state(sku.id);
  check("inventory reflects the increase", afterInc.quantityKg === upTo, `${afterInc.quantityKg} vs ${upTo}`);
  check("THE INVARIANT HOLDS after an increase", afterInc.quantityKg === afterInc.lotKg, `inventory ${afterInc.quantityKg} vs batches ${afterInc.lotKg}`);
  // Found stock needs a batch of its own, or the lot sum would fall short.
  check("a new batch carries the found stock", (await prisma.inventoryLot.count({ where: { skuId: sku.id } })) === lotsBefore + 1);

  const newLot = await prisma.inventoryLot.findFirst({ where: { skuId: sku.id }, orderBy: { createdAt: "desc" } });
  check("the new batch holds exactly the added kilograms", newLot?.remainingKg === 300 && newLot?.originalKg === 300, `${newLot?.remainingKg}`);
  // Its origin is genuinely unknown; inventing a vendor would be worse.
  check("the new batch claims no vendor", newLot?.vendorId === null);
  check("the new batch claims no source load", newLot?.sourceLoadId === null);
  const incTxn = await prisma.inventoryTransaction.findFirst({
    where: { skuId: sku.id, type: "STOCK_ADJUSTMENT" },
    orderBy: { createdAt: "desc" },
  });
  check("the increase links its ledger entry to the new batch", incTxn?.refId === newLot?.id && incTxn?.refType === "InventoryLot");

  // ── Adjusting to zero ─────────────────────────────────────────────────────
  console.log("\nAdjusting to zero:");
  const zero = await A.send(ENDPOINT, { yardId, skuId: sku.id, actualKg: 0, reason: REASON });
  check("zero is a legal count", zero.status === 200, `${zero.status} / ${await errCode(zero)}`);
  const afterZero = await state(sku.id);
  check("inventory is zero", afterZero.quantityKg === 0);
  check("THE INVARIANT HOLDS at zero", afterZero.lotKg === 0, `batches ${afterZero.lotKg}`);
  check("the batch rows still exist as history", (await prisma.inventoryLot.count({ where: { skuId: sku.id } })) > 0);

  // ── A SKU with no inventory row is still correctable ──────────────────────
  console.log("\nA SKU with no stock row:");
  const empty = await prisma.sku.findFirst({
    where: { yardId, inventory: null },
    select: { id: true, name: true },
  });
  if (empty) {
    const e1 = await A.send(ENDPOINT, { yardId, skuId: empty.id, actualKg: 40, reason: REASON });
    check("it can still be adjusted", e1.status === 200, `${e1.status} / ${await errCode(e1)}`);
    const es = await state(empty.id);
    check("an inventory row was created", es.quantityKg === 40);
    check("THE INVARIANT HOLDS for it too", es.quantityKg === es.lotKg, `${es.quantityKg} vs ${es.lotKg}`);
    // Restore.
    await A.send(ENDPOINT, { yardId, skuId: empty.id, actualKg: 0, reason: REASON });
  } else {
    console.log("  … every sandbox SKU already has an inventory row; case skipped");
  }

  // ── Restore the sandbox ───────────────────────────────────────────────────
  console.log("\nRestoring the sandbox baseline:");
  const restore = await A.send(ENDPOINT, { yardId, skuId: sku.id, actualKg: original.quantityKg, reason: REASON });
  check("the SKU can be restored", restore.status === 200, String(restore.status));
  const final = await state(sku.id);
  check("the quantity is back to the baseline", final.quantityKg === original.quantityKg, `${final.quantityKg} vs ${original.quantityKg}`);
  check("THE INVARIANT HOLDS after the round trip", final.quantityKg === final.lotKg, `${final.quantityKg} vs ${final.lotKg}`);

  // Every adjustment is a ledger entry, so the audit trail is complete.
  const txnCount = await prisma.inventoryTransaction.count({ where: { skuId: sku.id, type: "STOCK_ADJUSTMENT" } });
  const auditCount = await prisma.auditLog.count({ where: { entity: "Inventory", entityId: sku.id, action: "stock.adjust" } });
  check("every adjustment left a ledger entry", txnCount >= 4, String(txnCount));
  check("every adjustment left an audit row", auditCount >= txnCount, `${auditCount} audits vs ${txnCount} txns`);

  // ── Yard 1 is never a target ──────────────────────────────────────────────
  console.log("\nYard 1 safety:");
  const yard1 = await prisma.yard.findFirst({ where: { yardCode: { not: TEST_YARD_CODE } }, select: { id: true, yardCode: true } });
  if (yard1) {
    // Read-only assertion: this suite never sends yard1.id in a request body.
    const before = await prisma.inventoryTransaction.count({ where: { yardId: yard1.id, type: "STOCK_ADJUSTMENT" } });
    check(`no adjustment was written to ${yard1.yardCode}`, before === 0, `${before} found`);
  }

  console.log(`\n==== stock adjustment: ${pass} passed, ${fail} failed ====`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
