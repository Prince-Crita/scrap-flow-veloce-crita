/**
 * Exit gate: the admin record editor, entity by entity.
 *
 * Written because a gap in coverage let a defect through: `outwardLoad` was
 * added to the editable-entity allowlist and nothing exercised it, so the only
 * signal was a hand-run script — which then reported a misleading 404 because
 * the server was serving a stale build. Two lessons are encoded here:
 *
 *   1. Every entity in EDITABLE_ENTITIES is asserted to be reachable. Adding an
 *      entity without adding it to all four maps now fails a test rather than
 *      404-ing in production.
 *   2. The assertions distinguish BAD_ENTITY from NOT_FOUND. Both answer 404,
 *      so status alone cannot tell "this entity is not wired up" apart from
 *      "no such row" — which is exactly what made the stale build look like a
 *      lookup failure.
 *
 * Runs against the sandbox yard. Yard 1 is never written to.
 *
 * Usage: start the app, then `npx tsx tests/admin-records.test.ts`.
 */
import { PrismaClient } from "@prisma/client";
import { TEST_YARD_CODE, TEST_OWNER, TEST_MANAGER } from "./fixtures";
import {
  EDITABLE_ENTITIES,
  ENTITY_MODEL,
  ENTITY_CHANNEL,
  RECORD_SCHEMAS,
  LEDGER_FIELDS,
} from "../src/lib/admin-records";

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
    for (const c of res.headers.getSetCookie?.() ?? []) {
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
    await req("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrfToken: csrf.csrfToken,
        email,
        password,
        callbackUrl: BASE + "/",
        json: "true",
      }).toString(),
    });
  };
  return { req, json, login };
}

/** Reads the error code, not just the status — see the header. */
async function errCode(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body?.error?.code ?? "";
  } catch {
    return "";
  }
}

async function main() {
  const yard = await prisma.yard.findUnique({ where: { yardCode: TEST_YARD_CODE } });
  if (!yard) {
    console.error("❌ Sandbox yard missing. Run: npx tsx tests/fixtures.ts up");
    process.exit(1);
  }
  const yardId = yard.id;

  const y1 = await prisma.yard.findUnique({ where: { yardCode: "SFDY001" } });
  const y1Before = y1
    ? {
        vendors: await prisma.vendor.count({ where: { yardId: y1.id } }),
        loads: await prisma.inwardLoad.count({ where: { yardId: y1.id } }),
        outward: await prisma.outwardLoad.count({ where: { yardId: y1.id } }),
      }
    : null;

  // ── The maps must agree with each other ──────────────────────────────────
  console.log("Entity wiring (static):");
  for (const e of EDITABLE_ENTITIES) {
    check(`${e} has a field schema`, !!RECORD_SCHEMAS[e]);
    check(`${e} has a Prisma model name`, !!ENTITY_MODEL[e]);
    check(`${e} has a realtime channel`, !!ENTITY_CHANNEL[e]);
  }
  check("outwardLoad is editable", (EDITABLE_ENTITIES as readonly string[]).includes("outwardLoad"));
  check("dispatch quantities are ledger-protected", LEDGER_FIELDS.has("dispatchedKg") && LEDGER_FIELDS.has("totalKg"));

  const AD = makeClient();
  await AD.login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const sess = await (await AD.req("/api/auth/session")).json();
  check("admin session established", sess?.user?.role === "ADMIN", JSON.stringify(sess?.user));

  const patch = (entity: string, id: string, body: unknown) =>
    AD.json(`/api/admin/records/${entity}/${id}`, body, "PATCH");

  /**
   * Every entity must be REACHABLE: a real id must not answer BAD_ENTITY.
   * This is the assertion that would have caught the original defect — an
   * entity missing from a map answers BAD_ENTITY, which is a 404 that looks
   * identical to "no such row" unless the error code is read.
   */
  console.log("\nEvery editable entity is reachable:");
  const probeId = "definitely-not-a-real-id";
  for (const e of EDITABLE_ENTITIES) {
    const res = await patch(e, probeId, {});
    const code = await errCode(res);
    check(`${e} is wired up (not BAD_ENTITY)`, code !== "BAD_ENTITY", `got ${code} / ${res.status}`);
  }
  const bogus = await patch("notAnEntity", probeId, { name: "x" });
  check("an unknown entity IS rejected as BAD_ENTITY", (await errCode(bogus)) === "BAD_ENTITY", String(bogus.status));

  // ── outwardLoad, end to end ──────────────────────────────────────────────
  console.log("\nEditing a dispatch:");
  const load = await prisma.outwardLoad.findFirst({ where: { yardId }, orderBy: { createdAt: "desc" } });
  if (!load) {
    console.log("  … no dispatch in the sandbox; run tests/outward.test.ts first");
    fail++;
  } else {
    const before = { driver: load.driverName, totalKg: load.totalKg };
    /**
     * A fresh value every run. The editor audits only fields that actually
     * changed, so re-PATCHing a constant would be a no-op on the second run and
     * the audit assertion below would fail for reasons that have nothing to do
     * with the editor. The suite must not depend on its own run history.
     */
    const newDriver = `Corrected Driver ${Date.now()}`;

    const okRes = await patch("outwardLoad", load.id, { driverName: newDriver });
    check("an admin can correct the driver", okRes.status === 200, `${okRes.status} / ${await errCode(okRes)}`);
    const after = await prisma.outwardLoad.findFirstOrThrow({ where: { id: load.id } });
    check("the correction persisted", after.driverName === newDriver, String(after.driverName));
    check("the dispatched weight was not touched", after.totalKg === before.totalKg);

    const audited = await prisma.auditLog.findFirst({
      where: { entity: "OutwardLoad", entityId: load.id, action: "outwardLoad.adminEdit" },
      orderBy: { createdAt: "desc" },
    });
    check("the edit is audited", !!audited);
    check("the audit records the yard", audited?.yardId === yardId, String(audited?.yardId));
    check("the audit records the actor", !!audited?.actorId);
    check("the audit keeps the before value", JSON.stringify(audited?.before ?? {}).includes("driverName"));

    // Also varied per run, for the same no-op reason as the driver above.
    const newPlate = `MH01ZZ${String(Date.now() % 10000).padStart(4, "0")}`;
    const plate = await patch("outwardLoad", load.id, { vehicleNumber: newPlate, vehicleType: "Trailer" });
    check("plate and vehicle type are editable", plate.status === 200, String(plate.status));

    // Ledger protection: these move stock and must be refused.
    for (const field of ["totalKg", "dispatchedKg", "dispatchNumber"] as const) {
      const bad = await patch("outwardLoad", load.id, { [field]: 1 });
      check(`${field} is refused`, bad.status === 422 && (await errCode(bad)) === "LEDGER_PROTECTED", String(bad.status));
    }
    const unchanged = await prisma.outwardLoad.findFirstOrThrow({ where: { id: load.id } });
    check("the dispatch weight survived every refusal", unchanged.totalKg === before.totalKg, String(unchanged.totalKg));

    // A field outside the schema is dropped by zod, not silently written.
    const unknownField = await patch("outwardLoad", load.id, { nonsense: "x" });
    check("an unknown field yields NO_CHANGES", unknownField.status === 422 && (await errCode(unknownField)) === "NO_CHANGES", String(unknownField.status));

    console.log("\nInvalid ids:");
    const missing = await patch("outwardLoad", "cmxxxxxxxxxxxxxxxxxxxxxxx", { driverName: "Ghost" });
    check("an unknown id answers NOT_FOUND, not BAD_ENTITY", (await errCode(missing)) === "NOT_FOUND", String(missing.status));
    check("an unknown id answers 404", missing.status === 404, String(missing.status));

    console.log("\nRole boundaries:");
    const O = makeClient();
    await O.login(TEST_OWNER.email, TEST_OWNER.password);
    const ownerTry = await O.json(`/api/admin/records/outwardLoad/${load.id}`, { driverName: "Owner Edit" }, "PATCH");
    check("an Owner cannot use the admin editor", ownerTry.status === 403 || ownerTry.status === 401, String(ownerTry.status));

    const M = makeClient();
    await M.login(TEST_MANAGER.email, TEST_MANAGER.password);
    const mgrTry = await M.json(`/api/admin/records/outwardLoad/${load.id}`, { driverName: "Manager Edit" }, "PATCH");
    check("a Manager cannot use the admin editor", mgrTry.status === 403 || mgrTry.status === 401, String(mgrTry.status));

    const anon = await fetch(`${BASE}/api/admin/records/outwardLoad/${load.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ driverName: "Anon" }),
      redirect: "manual",
    });
    check("an anonymous caller is rejected", anon.status >= 300, String(anon.status));

    const stillCorrect = await prisma.outwardLoad.findFirstOrThrow({ where: { id: load.id } });
    check("no non-admin edit landed", stillCorrect.driverName === newDriver, String(stillCorrect.driverName));

    console.log("\nRealtime:");
    check("dispatch edits publish on the outward channel", ENTITY_CHANNEL.outwardLoad === "outward", ENTITY_CHANNEL.outwardLoad);
  }

  // ── An existing entity still works (no regression) ───────────────────────
  console.log("\nExisting entities unaffected:");
  const vendor = await prisma.vendor.findFirst({ where: { yardId } });
  if (vendor) {
    const vRes = await patch("vendor", vendor.id, { phone: "9999900000" });
    check("vendor editing still works", vRes.status === 200, String(vRes.status));
    const vAfter = await prisma.vendor.findFirstOrThrow({ where: { id: vendor.id } });
    check("the vendor change persisted", vAfter.phone === "9999900000", String(vAfter.phone));
  }
  const inward = await prisma.inwardLoad.findFirst({ where: { yardId } });
  if (inward) {
    const iRes = await patch("inwardLoad", inward.id, { driverName: "Inward Driver" });
    check("inward load editing still works", iRes.status === 200, String(iRes.status));
  }

  // ── Production baseline ──────────────────────────────────────────────────
  console.log("\nProduction baseline:");
  if (y1 && y1Before) {
    const after = {
      vendors: await prisma.vendor.count({ where: { yardId: y1.id } }),
      loads: await prisma.inwardLoad.count({ where: { yardId: y1.id } }),
      outward: await prisma.outwardLoad.count({ where: { yardId: y1.id } }),
    };
    check("Yard 1 vendors unchanged", after.vendors === y1Before.vendors, `${y1Before.vendors} → ${after.vendors}`);
    check("Yard 1 loads unchanged", after.loads === y1Before.loads, `${y1Before.loads} → ${after.loads}`);
    check("Yard 1 dispatches unchanged", after.outward === y1Before.outward, `${y1Before.outward} → ${after.outward}`);
  }

  console.log(`\n==== admin records: ${pass} passed, ${fail} failed ====`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
