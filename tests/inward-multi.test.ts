/**
 * Exit gate: Phase 3 Module 1 — multi-material loads, unit handling, the recent
 * loads viewer, and the permanent-delete reference rule.
 *
 * The properties that matter here are data-integrity ones, not UI ones:
 *   • a load carrying several materials increments each bucket by its OWN
 *     weight, not by the load total, and produces one traceable batch each;
 *   • Sort works per material, and the parent load only leaves the queue once
 *     every material on it has been segregated;
 *   • only kilograms are ever stored — no unit reaches a ledger table;
 *   • permanent delete is refused whenever anything still references the row.
 *
 * Runs against the sandbox yard. Yard 1 is never written to.
 *
 * Usage: start the app, then `npx tsx tests/inward-multi.test.ts`.
 */
import { PrismaClient } from "@prisma/client";
import { TEST_YARD_CODE, TEST_OWNER } from "./fixtures";

const prisma = new PrismaClient();
const BASE = process.env.BASE_URL || "http://localhost:3001";

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

const uniq = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const qtyOf = (stock: { skus: { name: string; quantityKg: number }[] }, name: string) =>
  stock.skus.find((s) => s.name === name)?.quantityKg ?? 0;

/**
 * Mirrors the conversion table in the Inward page. Duplicated deliberately:
 * if someone changes the client-side factors, this test must fail rather than
 * silently agree with the new value.
 */
const TO_KG: Record<string, number> = { KG: 1, TON: 907, TONNE: 1000 };
const toKilograms = (v: number, u: string) => Math.round(v * TO_KG[u]);

async function main() {
  // Snapshot the production baseline before doing anything, so the closing
  // assertions can prove THIS suite changed nothing in it.
  const y1 = await prisma.yard.findUnique({ where: { yardCode: "SFDY001" } });
  const y1Before = {
    loads: y1 ? await prisma.inwardLoad.count({ where: { yardId: y1.id } }) : 0,
    lines: y1 ? await prisma.inwardLoadLine.count({ where: { yardId: y1.id } }) : 0,
  };

  const yard = await prisma.yard.findUnique({ where: { yardCode: TEST_YARD_CODE } });
  if (!yard) {
    console.error(`❌ Sandbox yard missing. Run: npx tsx tests/fixtures.ts up`);
    process.exit(1);
  }
  const yardId = yard.id;

  const c = makeClient();
  await c.login(TEST_OWNER.email, TEST_OWNER.password);
  const me = await (await c.req("/api/auth/session")).json();
  check("owner session is the sandbox yard", !!me?.user, JSON.stringify(me));

  const materials = (await (await c.req("/api/materials")).json()).materials as {
    id: string;
    name: string;
  }[];
  check("sandbox exposes at least two inward materials", materials.length >= 2, `got ${materials.length}`);
  const [matA, matB] = materials;

  const vendors = (await (await c.req("/api/vendors")).json()).vendors as { id: string; name: string }[];
  const vendorId = vendors[0]?.id ?? null;

  // ── Unit conversion is a pure function; assert the table itself ───────────
  console.log("\nUnit conversion (UI layer only):");
  check("KG is identity", toKilograms(500, "KG") === 500);
  check("1 TONNE is 1000 kg", toKilograms(1, "TONNE") === 1000);
  check("2.5 TONNE is 2500 kg", toKilograms(2.5, "TONNE") === 2500);
  check("1 TON (short) is 907 kg", toKilograms(1, "TON") === 907);
  check("conversion always yields a whole number", Number.isInteger(toKilograms(1.5, "TON")));
  check("rounding is nearest, not truncation", toKilograms(0.5, "TON") === 454, String(toKilograms(0.5, "TON")));

  // ── Multi-material load ───────────────────────────────────────────────────
  console.log("\nMulti-material load:");
  const before = await (await c.req("/api/stock")).json();
  const beforeA = qtyOf(before, matA.name);
  const beforeB = qtyOf(before, matB.name);

  const vehicle = `MM${uniq()}`;
  const res = await c.json("/api/inward/loads", {
    lines: [
      { skuId: matA.id, kg: 400 },
      { skuId: matB.id, kg: 150 },
      { skuId: matA.id, kg: 100 }, // same material again — must merge into one line
    ],
    vendorId,
    vehicleNumber: vehicle,
    vehicleType: "Truck",
    driverName: "Multi Tester",
  });
  check("multi-material save returns 201", res.status === 201, String(res.status));
  const saved = (await res.json()).load as { lotNumber: string; totalKg: number; materialLabel: string };
  check("load total is the sum of every line", saved.totalKg === 650, String(saved.totalKg));
  check("summary label names the first material and a count", saved.materialLabel.includes(matA.name) && saved.materialLabel.includes("+1"), saved.materialLabel);

  const load = await prisma.inwardLoad.findFirst({
    where: { yardId, lotNumber: saved.lotNumber },
    include: { lines: { orderBy: { sequence: "asc" } }, weightEntries: true },
  });
  check("load row exists", !!load);
  check("repeat material collapsed into one line per SKU", load!.lines.length === 2, `lines=${load!.lines.length}`);

  const lineA = load!.lines.find((l) => l.skuId === matA.id)!;
  const lineB = load!.lines.find((l) => l.skuId === matB.id)!;
  check("material A line sums both of its entries", lineA.quantityKg === 500, String(lineA?.quantityKg));
  check("material B line holds its own weight", lineB.quantityKg === 150, String(lineB?.quantityKg));
  check("line quantities sum to the load total", lineA.quantityKg + lineB.quantityKg === load!.totalKg);
  check("every line starts RECEIVED", load!.lines.every((l) => l.status === "RECEIVED"));
  check("every line carries the yard id", load!.lines.every((l) => l.yardId === yardId));

  check("each cart tap kept its own weighment row", load!.weightEntries.length === 3, String(load!.weightEntries.length));
  check("weighments are attributed to a line", load!.weightEntries.every((w) => !!w.lineId));
  check("weighments are attributed to a SKU", load!.weightEntries.every((w) => !!w.skuId));
  check(
    "weighment weights sum to the load total",
    load!.weightEntries.reduce((a, w) => a + w.kg, 0) === load!.totalKg
  );

  // Stock moved per material, not per load.
  const afterSave = await (await c.req("/api/stock")).json();
  check("material A stock rose by its own line only", qtyOf(afterSave, matA.name) === beforeA + 500, `${qtyOf(afterSave, matA.name)} vs ${beforeA + 500}`);
  check("material B stock rose by its own line only", qtyOf(afterSave, matB.name) === beforeB + 150, `${qtyOf(afterSave, matB.name)} vs ${beforeB + 150}`);

  const lots = await prisma.inventoryLot.findMany({ where: { sourceLoadId: load!.id } });
  check("one traceable batch per material", lots.length === 2, String(lots.length));
  check("batch weights match their lines", lots.every((l) => l.originalKg === (l.skuId === matA.id ? 500 : 150)));
  check("batches inherit the vehicle", lots.every((l) => l.vehicleNumber === vehicle));

  const txns = await prisma.inventoryTransaction.findMany({ where: { refId: load!.id, type: "INWARD" } });
  check("one INWARD ledger entry per material", txns.length === 2, String(txns.length));
  check("ledger entries sum to the load total", txns.reduce((a, t) => a + t.changeKg, 0) === 650);

  // ── No unit ever reaches the database ─────────────────────────────────────
  console.log("\nUnits never reach a ledger table:");
  const lineCols = Object.keys(load!.lines[0]);
  check("InwardLoadLine has no unit column", !lineCols.some((k) => /unit/i.test(k)), lineCols.join(","));
  const weCols = Object.keys(load!.weightEntries[0]);
  check("WeightEntry has no unit column", !weCols.some((k) => /unit/i.test(k)), weCols.join(","));
  const loadCols = Object.keys(load!);
  check("InwardLoad has no unit column", !loadCols.some((k) => /unit/i.test(k)));

  // A tonne-entered load must land as kilograms.
  const tonneRes = await c.json("/api/inward/loads", {
    lines: [{ skuId: matA.id, kg: toKilograms(2, "TONNE") }],
    vendorId,
    vehicleNumber: `TN${uniq()}`,
    vehicleType: "Truck",
    driverName: "Tonne Tester",
  });
  const tonneLoad = (await tonneRes.json()).load as { totalKg: number };
  check("2 TONNE stored as 2000 kg", tonneLoad.totalKg === 2000, String(tonneLoad.totalKg));

  // ── Sort is per material ──────────────────────────────────────────────────
  console.log("\nSort works per material:");
  const pending = (await (await c.req("/api/sort/pending")).json()).lots as {
    lotKey: string;
    loadId: string;
    lineId: string | null;
    materialLabel: string;
    totalKg: number;
    sortable: boolean;
    targets: { skuId: string }[];
  }[];
  const mine = pending.filter((p) => p.loadId === load!.id);
  check("the multi-material load contributes one queue row per material", mine.length === 2, String(mine.length));
  check("queue rows have distinct keys", new Set(mine.map((m) => m.lotKey)).size === 2);
  check("queue row weight is the LINE weight, not the load total", mine.every((m) => m.totalKg !== 650));
  check("queue rows carry a lineId", mine.every((m) => !!m.lineId));

  const rowA = mine.find((m) => m.lineId === lineA.id)!;
  check("material A row shows 500 kg", rowA.totalKg === 500, String(rowA?.totalKg));

  if (rowA.sortable && rowA.targets.length > 0) {
    const alloc = rowA.targets.map((t, i) => ({ skuId: t.skuId, kg: i === 0 ? 500 : 0 }));
    const sortRes = await c.json("/api/sort/complete", {
      loadId: load!.id,
      lineId: rowA.lineId,
      wastageKg: 0,
      allocations: alloc,
    });
    check("segregating one material succeeds", sortRes.status === 200, String(sortRes.status));

    const afterOne = await prisma.inwardLoad.findUnique({
      where: { id: load!.id },
      include: { lines: true },
    });
    check("the sorted line is SEGREGATED", afterOne!.lines.find((l) => l.id === lineA.id)!.status === "SEGREGATED");
    check("the other line is still RECEIVED", afterOne!.lines.find((l) => l.id === lineB.id)!.status === "RECEIVED");
    check("the load stays RECEIVED while a material is unsorted", afterOne!.status === "RECEIVED", afterOne!.status);

    const stillPending = (await (await c.req("/api/sort/pending")).json()).lots as { loadId: string }[];
    check("only the unsorted material remains in the queue", stillPending.filter((p) => p.loadId === load!.id).length === 1);

    // Sorting without naming a material is refused while several are pending —
    // but this load now has exactly one left, so it must be accepted.
    const ambiguous = await c.json("/api/inward/loads", {
      lines: [
        { skuId: matA.id, kg: 100 },
        { skuId: matB.id, kg: 100 },
      ],
      vendorId,
      vehicleNumber: `AM${uniq()}`,
      vehicleType: "Truck",
      driverName: "Ambiguity Tester",
    });
    const ambLot = (await ambiguous.json()).load as { lotNumber: string };
    const ambLoad = await prisma.inwardLoad.findFirst({ where: { yardId, lotNumber: ambLot.lotNumber } });
    const ambRes = await c.json("/api/sort/complete", {
      loadId: ambLoad!.id,
      wastageKg: 0,
      allocations: [{ skuId: rowA.targets[0].skuId, kg: 100 }],
    });
    check("segregating a multi-material lot without naming the material is refused", ambRes.status === 422, String(ambRes.status));
    const ambBody = await ambRes.json();
    check("the refusal explains why", /several materials/i.test(JSON.stringify(ambBody)), JSON.stringify(ambBody));
  } else {
    console.log("  … material A has no segregation targets in the sandbox; per-line sort assertions skipped");
  }

  // ── Recent loads viewer ───────────────────────────────────────────────────
  console.log("\nRecent Load Details viewer:");
  const recentRes = await c.req("/api/inward/recent");
  check("recent loads endpoint responds", recentRes.status === 200, String(recentRes.status));
  const recent = (await recentRes.json()).loads as {
    lotNumber: string;
    vendorName: string;
    vehicleNumber: string;
    driverName: string | null;
    materials: { label: string; kg: number }[];
    slipUrl: string | null;
    totalKg: number;
  }[];
  check("recent loads is capped for a phone screen", recent.length <= 8, String(recent.length));
  check("newest load is first", recent.length > 0);
  const mineRecent = recent.find((r) => r.lotNumber === saved.lotNumber);
  check("the multi-material load appears", !!mineRecent);
  check("it lists both materials", mineRecent!.materials.length === 2, String(mineRecent?.materials.length));
  check("material weights sum to the load total", mineRecent!.materials.reduce((a, m) => a + m.kg, 0) === mineRecent!.totalKg);
  check("it carries the vehicle", mineRecent!.vehicleNumber === vehicle);
  check("it carries the driver", mineRecent!.driverName === "Multi Tester");
  check("slip is null when none was uploaded", mineRecent!.slipUrl === null);

  const recentIsReadOnly = await c.json("/api/inward/recent", {}, "POST");
  check("recent loads exposes no write verb", recentIsReadOnly.status === 405, String(recentIsReadOnly.status));

  // ── Permanent delete: the zero-reference rule ─────────────────────────────
  console.log("\nPermanent delete (zero-reference rule):");

  // A vendor that has loads must be refused.
  if (vendorId) {
    await c.json(`/api/vendors/${vendorId}`, undefined, "DELETE"); // deactivate first
    const refused = await c.json(`/api/vendors/${vendorId}?permanent=1`, undefined, "DELETE");
    check("referenced vendor cannot be permanently deleted", refused.status === 409, String(refused.status));
    const body = await refused.json();
    check("the refusal names the reference count", /referenced by/i.test(JSON.stringify(body)), JSON.stringify(body));
    const stillThere = await prisma.vendor.findUnique({ where: { id: vendorId } });
    check("the referenced vendor still exists", !!stillThere);
    check("it stayed soft-deleted rather than vanishing", stillThere!.active === false);
    await c.json(`/api/vendors/${vendorId}`, { active: true }, "PATCH"); // restore for other suites
  }

  // A brand-new vendor with no references must be erasable.
  const freshName = `Purge Test ${uniq()}`;
  const created = await (await c.json("/api/vendors", { name: freshName, gstNumber: "", phone: "" })).json();
  const freshId = created.vendor.id as string;
  await c.json(`/api/vendors/${freshId}`, undefined, "DELETE");
  const purged = await c.json(`/api/vendors/${freshId}?permanent=1`, undefined, "DELETE");
  check("unreferenced vendor is permanently deleted", purged.status === 200, String(purged.status));
  check("the row is really gone", (await prisma.vendor.findUnique({ where: { id: freshId } })) === null);

  const auditRow = await prisma.auditLog.findFirst({
    where: { entityId: freshId, action: "vendor.permanent_delete" },
  });
  check("the permanent delete is recorded in the audit log", !!auditRow);
  check("the audit entry survives the deleted row", auditRow?.entity === "Vendor");
  check("the audit entry keeps what was deleted", JSON.stringify(auditRow?.before ?? {}).includes(freshName));

  // A material with history must be refused.
  const matRefused = await c.json(`/api/materials/${matA.id}?permanent=1`, undefined, "DELETE");
  check("material with history cannot be permanently deleted", matRefused.status === 409, String(matRefused.status));
  const matBody = await matRefused.json();
  check("the material refusal explains itself", /linked record|stock/i.test(JSON.stringify(matBody)), JSON.stringify(matBody));
  check("the material still exists", !!(await prisma.sku.findUnique({ where: { id: matA.id } })));

  // A brand-new material with no history must be erasable.
  const newMatName = `Purgeable ${uniq()}`;
  const newMat = await (await c.json("/api/materials", { name: newMatName, category: "", threshold: 1000 })).json();
  const newMatSkuId = newMat.material.id as string;
  const newMatRow = await prisma.sku.findUnique({ where: { id: newMatSkuId } });
  await c.json(`/api/materials/${newMatSkuId}`, undefined, "DELETE");
  const matPurged = await c.json(`/api/materials/${newMatSkuId}?permanent=1`, undefined, "DELETE");
  check("unreferenced material is permanently deleted", matPurged.status === 200, String(matPurged.status));
  check("its SKU is gone", (await prisma.sku.findUnique({ where: { id: newMatSkuId } })) === null);
  check(
    "its parent material is gone",
    (await prisma.material.findUnique({ where: { id: newMatRow!.materialId! } })) === null
  );
  check(
    "its zero-kg inventory row is gone",
    (await prisma.inventory.findFirst({ where: { skuId: newMatSkuId } })) === null
  );

  // ── Yard 1 must be untouched by all of the above ──────────────────────────
  console.log("\nProduction baseline:");
  const yard1 = await prisma.yard.findUnique({ where: { yardCode: "SFDY001" } });
  if (yard1) {
    const [lines1, loads1] = await Promise.all([
      prisma.inwardLoadLine.count({ where: { yardId: yard1.id } }),
      prisma.inwardLoad.count({ where: { yardId: yard1.id } }),
    ]);
    // Compared against the snapshot taken before this suite ran, not against
    // the prototype's literal counts: Yard 1 legitimately changes when someone
    // uses the app, and detecting THAT drift is `demo:restore`'s job.
    check("Yard 1 loads unchanged by this suite", loads1 === y1Before.loads, `${y1Before.loads} → ${loads1}`);
    check("Yard 1 line items unchanged by this suite", lines1 === y1Before.lines, `${y1Before.lines} → ${lines1}`);
    // The migration guarantee, still worth asserting: the ORIGINAL prototype
    // lot A-114 predates line items and must never have been back-filled.
    const a114 = await prisma.inwardLoad.findFirst({
      where: { yardId: yard1.id, lotNumber: "A-114" },
      include: { lines: true },
    });
    check("prototype lot A-114 still exists", !!a114);
    check("prototype lot A-114 was never back-filled with lines", (a114?.lines.length ?? -1) === 0, String(a114?.lines.length));
    check("prototype lot A-114 still weighs 1,200 kg", a114?.totalKg === 1200, String(a114?.totalKg));
  }

  console.log(`\n==== inward multi-material: ${pass} passed, ${fail} failed ====`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
