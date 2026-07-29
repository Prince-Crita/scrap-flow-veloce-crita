/**
 * Sort-type management (Phase 5 Module 4).
 *
 * A sort type is a non-mixed SKU under a Material — the categories a mixed lot
 * segregates into. This suite proves the CRUD, the role boundaries, and above all
 * the delete rules: a sort type with ANY history must be undeletable, because
 * finished stock traces back through it to the vendor lot it came from.
 *
 * Runs entirely against the sandbox yard. Every row it creates it also cleans up,
 * and it never touches Yard 1.
 *
 * Usage: start the app, then `npx tsx tests/sort-types.test.ts`.
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

async function main() {
  const yard = await prisma.yard.findUniqueOrThrow({ where: { yardCode: TEST_YARD_CODE } });
  const yardId = yard.id;
  /** Everything this suite creates, removed at the end whatever happens. */
  const created: string[] = [];

  const O = makeClient();
  await O.login(TEST_OWNER.email, TEST_OWNER.password);

  // ── Read ─────────────────────────────────────────────────────────────────
  console.log("Reading the sort tree:");
  const listRes = await O.req("/api/sort-types");
  check("an owner can read the tree", listRes.status === 200, String(listRes.status));
  const tree = await listRes.json();
  check("the tree is grouped by material", Array.isArray(tree.materials));

  const dbMaterials = await prisma.material.count({ where: { yardId } });
  check("every material is present", tree.materials.length === dbMaterials, `${tree.materials.length} vs ${dbMaterials}`);
  check("groups carry a name and code", tree.materials.every((m: { name: string; code: string }) => !!m.name && !!m.code));

  // A mixed bucket is the inward material itself, not a sort type.
  const mixedNames = (
    await prisma.sku.findMany({ where: { yardId, isMixedBucket: true }, select: { name: true } })
  ).map((s) => s.name);
  const allListed: { id: string; name: string; stockKg: number }[] = tree.materials.flatMap(
    (m: { sortTypes: { id: string; name: string; stockKg: number }[] }) => m.sortTypes
  );
  check(
    "mixed buckets are NOT listed as sort types",
    allListed.every((t) => !mixedNames.includes(t.name)),
    JSON.stringify(allListed.map((t) => t.name))
  );
  const dbSortTypes = await prisma.sku.count({ where: { yardId, isMixedBucket: false, visible: true, materialId: { not: null } } });
  check("visible sort types match the database", allListed.length === dbSortTypes, `${allListed.length} vs ${dbSortTypes}`);
  check("each sort type reports its stock", allListed.every((t) => typeof t.stockKg === "number"));

  const ms = tree.materials.find((m: { code: string }) => m.code === "MS");
  check("the MS material is in the tree", !!ms);

  // ── Create ───────────────────────────────────────────────────────────────
  console.log("\nCreating a sort type:");
  const uniq = Date.now().toString().slice(-6);
  const newName = `MS Test ${uniq}`;
  const cRes = await O.send("/api/sort-types", { materialId: ms.id, name: newName, icon: "🧪" });
  check("an owner can create one", cRes.status === 201, `${cRes.status} / ${await errCode(cRes)}`);
  const cBody = await cRes.json();
  const newId: string = cBody.sortType?.id;
  if (newId) created.push(newId);
  check("the response carries an id", !!newId);

  const dbNew = newId ? await prisma.sku.findUnique({ where: { id: newId } }) : null;
  check("it persisted", !!dbNew);
  check("it belongs to the requested material", dbNew?.materialId === ms.id);
  check("it is NOT a mixed bucket", dbNew?.isMixedBucket === false);
  check("it starts visible", dbNew?.visible === true);
  check("it landed in the sandbox yard", dbNew?.yardId === yardId);
  check("it got a generated code", !!dbNew?.code && dbNew.code === dbNew.code.toUpperCase(), String(dbNew?.code));
  // Without an inventory row the first segregation run into it would fail.
  const inv = newId ? await prisma.inventory.findUnique({ where: { skuId: newId } }) : null;
  check("an inventory row was created alongside it", !!inv);
  check("it opens at zero kilograms", inv?.quantityKg === 0);
  check("the creation is audited", (await prisma.auditLog.count({ where: { entity: "Sku", entityId: newId, action: "sortType.create" } })) === 1);

  console.log("\nCreate is validated:");
  const dupe = await O.send("/api/sort-types", { materialId: ms.id, name: newName });
  check("a duplicate name is refused", dupe.status === 409 && (await errCode(dupe)) === "DUPLICATE", String(dupe.status));
  const short = await O.send("/api/sort-types", { materialId: ms.id, name: "x" });
  check("a one-character name is refused", short.status === 400 || short.status === 422, String(short.status));
  const noMat = await O.send("/api/sort-types", { materialId: "cmxxxxxxxxxxxxxxxxxxxxxxx", name: `Ghost ${uniq}` });
  check("an unknown material is refused", noMat.status === 404 && (await errCode(noMat)) === "NOT_FOUND", String(noMat.status));

  // ── Rename ───────────────────────────────────────────────────────────────
  console.log("\nRenaming:");
  const renamed = `MS Renamed ${uniq}`;
  const rRes = await O.send(`/api/sort-types/${newId}`, { name: renamed }, "PATCH");
  check("an owner can rename", rRes.status === 200, `${rRes.status} / ${await errCode(rRes)}`);
  check("the rename persisted", (await prisma.sku.findUniqueOrThrow({ where: { id: newId } })).name === renamed);
  check(
    "the rename is audited with the old name",
    JSON.stringify(
      (await prisma.auditLog.findFirst({
        where: { entity: "Sku", entityId: newId, action: "sortType.update" },
        orderBy: { createdAt: "desc" },
      }))?.before ?? {}
    ).includes(newName)
  );
  const emptyPatch = await O.send(`/api/sort-types/${newId}`, {}, "PATCH");
  check("an empty change is refused", emptyPatch.status === 400 || emptyPatch.status === 422, String(emptyPatch.status));

  // A rename that collides with a sibling would break @@unique([yardId, name]).
  const sibling = await prisma.sku.findFirst({ where: { yardId, code: "MSB" }, select: { name: true } });
  const collide = await O.send(`/api/sort-types/${newId}`, { name: sibling!.name }, "PATCH");
  check("renaming onto an existing name is refused", collide.status === 409 && (await errCode(collide)) === "DUPLICATE", String(collide.status));
  check("the failed rename changed nothing", (await prisma.sku.findUniqueOrThrow({ where: { id: newId } })).name === renamed);

  // ── Deactivate / restore ─────────────────────────────────────────────────
  console.log("\nDeactivate and restore:");
  const deact = await O.send(`/api/sort-types/${newId}`, undefined, "DELETE");
  check("DELETE deactivates by default", deact.status === 200, String(deact.status));
  check("it is now hidden", (await prisma.sku.findUniqueOrThrow({ where: { id: newId } })).visible === false);
  // Deactivating must never destroy anything.
  check("the row still exists", !!(await prisma.sku.findUnique({ where: { id: newId } })));
  check("its inventory row still exists", !!(await prisma.inventory.findUnique({ where: { skuId: newId } })));
  check("the deactivation is audited", (await prisma.auditLog.count({ where: { entity: "Sku", entityId: newId, action: "sortType.deactivate" } })) >= 1);

  const hiddenList = await (await O.req("/api/sort-types")).json();
  const hiddenIds: string[] = hiddenList.materials.flatMap((m: { sortTypes: { id: string }[] }) => m.sortTypes.map((t) => t.id));
  check("a deactivated type drops out of the default list", !hiddenIds.includes(newId));
  const allList = await (await O.req("/api/sort-types?all=1")).json();
  const allIds: string[] = allList.materials.flatMap((m: { sortTypes: { id: string }[] }) => m.sortTypes.map((t) => t.id));
  check("?all=1 still shows it, so it can be restored", allIds.includes(newId));

  const restore = await O.send(`/api/sort-types/${newId}`, { active: true }, "PATCH");
  check("an owner can restore it", restore.status === 200, String(restore.status));
  check("it is visible again", (await prisma.sku.findUniqueOrThrow({ where: { id: newId } })).visible === true);

  // ── The mixed bucket is off limits ───────────────────────────────────────
  console.log("\nA material is not a sort type:");
  const mixed = await prisma.sku.findFirstOrThrow({ where: { yardId, isMixedBucket: true }, select: { id: true, name: true } });
  const badPatch = await O.send(`/api/sort-types/${mixed.id}`, { name: `Hijacked ${uniq}` }, "PATCH");
  check("the mixed bucket cannot be renamed here", badPatch.status === 422 && (await errCode(badPatch)) === "NOT_SORT_TYPE", String(badPatch.status));
  check("the mixed bucket kept its name", (await prisma.sku.findUniqueOrThrow({ where: { id: mixed.id } })).name === mixed.name);
  const badDelete = await O.send(`/api/sort-types/${mixed.id}?permanent=1`, undefined, "DELETE");
  check("the mixed bucket cannot be deleted here", badDelete.status === 422 && (await errCode(badDelete)) === "NOT_SORT_TYPE", String(badDelete.status));
  check("the mixed bucket still exists", !!(await prisma.sku.findUnique({ where: { id: mixed.id } })));

  // ── Permanent delete rules ───────────────────────────────────────────────
  console.log("\nPermanent delete is refused when anything references it:");
  // MS Bazar has stock and history in the sandbox baseline.
  const inUse = await prisma.sku.findFirstOrThrow({ where: { yardId, code: "MSB" }, select: { id: true, name: true } });
  const refused = await O.send(`/api/sort-types/${inUse.id}?permanent=1`, undefined, "DELETE");
  const refusedCode = await errCode(refused);
  check(
    "a referenced sort type cannot be erased",
    refused.status === 409 && (refusedCode === "HAS_REFERENCES" || refusedCode === "HAS_STOCK"),
    `${refused.status} / ${refusedCode}`
  );
  check("the referenced sort type still exists", !!(await prisma.sku.findUnique({ where: { id: inUse.id } })));
  const msg = (await refused.json())?.error?.message ?? "";
  check("the refusal explains what is holding it", msg.length > 20 && msg.includes(inUse.name), msg);

  // Stock alone must block deletion even with zero references.
  console.log("\nStock alone blocks deletion:");
  await prisma.inventory.update({ where: { skuId: newId }, data: { quantityKg: 10 } });
  const stockRefused = await O.send(`/api/sort-types/${newId}?permanent=1`, undefined, "DELETE");
  check("stock alone is refused", stockRefused.status === 409 && (await errCode(stockRefused)) === "HAS_STOCK", `${stockRefused.status} / ${await errCode(stockRefused)}`);
  check("it survived the refusal", !!(await prisma.sku.findUnique({ where: { id: newId } })));
  await prisma.inventory.update({ where: { skuId: newId }, data: { quantityKg: 0 } });

  // ── Role boundaries ──────────────────────────────────────────────────────
  console.log("\nRole boundaries:");
  const M = makeClient();
  await M.login(TEST_MANAGER.email, TEST_MANAGER.password);
  const mRead = await M.req("/api/sort-types");
  check("a manager CAN read the tree", mRead.status === 200, String(mRead.status));
  const mCreate = await M.send("/api/sort-types", { materialId: ms.id, name: `Manager ${uniq}` });
  check("a manager cannot create", mCreate.status === 403 || mCreate.status === 401, String(mCreate.status));
  const mPatch = await M.send(`/api/sort-types/${newId}`, { name: `Manager ${uniq}` }, "PATCH");
  check("a manager cannot rename", mPatch.status === 403 || mPatch.status === 401, String(mPatch.status));
  const mDelete = await M.send(`/api/sort-types/${newId}`, undefined, "DELETE");
  check("a manager cannot deactivate", mDelete.status === 403 || mDelete.status === 401, String(mDelete.status));
  check("nothing a manager attempted landed", (await prisma.sku.findUniqueOrThrow({ where: { id: newId } })).name === renamed);
  check(
    "no manager-created row exists",
    (await prisma.sku.count({ where: { yardId, name: `Manager ${uniq}` } })) === 0
  );

  const anon = await fetch(`${BASE}/api/sort-types`, { redirect: "manual" });
  check("an anonymous caller cannot read", anon.status >= 300, String(anon.status));
  const anonWrite = await fetch(`${BASE}/api/sort-types`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ materialId: ms.id, name: `Anon ${uniq}` }),
    redirect: "manual",
  });
  check("an anonymous caller cannot create", anonWrite.status >= 300, String(anonWrite.status));

  // ── Tenant isolation ─────────────────────────────────────────────────────
  console.log("\nTenant isolation:");
  const otherYardSku = await prisma.sku.findFirst({
    where: { yardId: { not: yardId }, isMixedBucket: false, materialId: { not: null } },
    select: { id: true, name: true, yardId: true },
  });
  if (otherYardSku) {
    const cross = await O.send(`/api/sort-types/${otherYardSku.id}`, { name: `Stolen ${uniq}` }, "PATCH");
    check("an owner cannot rename another yard's sort type", cross.status === 404, String(cross.status));
    check(
      "the other yard's row is untouched",
      (await prisma.sku.findUniqueOrThrow({ where: { id: otherYardSku.id } })).name === otherYardSku.name
    );
    const crossDel = await O.send(`/api/sort-types/${otherYardSku.id}?permanent=1`, undefined, "DELETE");
    check("an owner cannot erase another yard's sort type", crossDel.status === 404, String(crossDel.status));
    check("it still exists", !!(await prisma.sku.findUnique({ where: { id: otherYardSku.id } })));
  } else {
    console.log("  … only one yard has sort types; cross-tenant checks skipped");
  }

  // ── Admin has full CRUD, via Enter Yard ──────────────────────────────────
  console.log("\nAdmin capability:");
  const A = makeClient();
  await A.login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const enter = await A.send("/api/admin/impersonate", { yardId });
  if (enter.status === 200 || enter.status === 201) {
    const aCreate = await A.send("/api/sort-types", { materialId: ms.id, name: `Admin ${uniq}`, icon: "🛠" });
    check("an admin inside the yard can create", aCreate.status === 201, `${aCreate.status} / ${await errCode(aCreate)}`);
    const adminId = (await aCreate.json())?.sortType?.id;
    if (adminId) {
      created.push(adminId);
      const aPatch = await A.send(`/api/sort-types/${adminId}`, { name: `Admin Renamed ${uniq}` }, "PATCH");
      check("an admin can rename", aPatch.status === 200, String(aPatch.status));
      // Fresh, unreferenced and empty: the one case where erasing is allowed.
      const aDel = await A.send(`/api/sort-types/${adminId}?permanent=1`, undefined, "DELETE");
      check("an admin can erase an unreferenced, empty sort type", aDel.status === 200, `${aDel.status} / ${await errCode(aDel)}`);
      check("it is really gone", !(await prisma.sku.findUnique({ where: { id: adminId } })));
      check("its inventory row went with it", !(await prisma.inventory.findUnique({ where: { skuId: adminId } })));
      check(
        "the erase is audited",
        (await prisma.auditLog.count({ where: { entity: "Sku", entityId: adminId, action: "sortType.permanent_delete" } })) === 1
      );
    }
    await A.send("/api/admin/impersonate", undefined, "DELETE");
  } else {
    console.log(`  … could not enter yard (${enter.status}); admin CRUD checks skipped`);
    fail++;
  }

  // ── The Sort page sees new types immediately ─────────────────────────────
  console.log("\nThe sort tree drives the Sort page:");
  const pending = await (await O.req("/api/sort/pending")).json();
  const msLot = (pending.lots ?? []).find((l: { materialLabel: string }) => l.materialLabel === "Mixed MS");
  if (msLot) {
    const targetIds: string[] = msLot.targets.map((t: { skuId: string }) => t.skuId);
    check("a new sort type appears as a segregation target", targetIds.includes(newId), JSON.stringify(msLot.targets.map((t: { name: string }) => t.name)));
    check("the lot is sortable", msLot.sortable === true);
  } else {
    console.log("  … no Mixed MS lot pending; target check skipped");
  }

  // ── Cleanup: the suite leaves the sandbox as it found it ─────────────────
  console.log("\nCleanup:");
  let removed = 0;
  for (const id of created) {
    if (!(await prisma.sku.findUnique({ where: { id } }))) continue;
    await prisma.inventory.deleteMany({ where: { skuId: id } });
    await prisma.sku.delete({ where: { id } });
    removed++;
  }
  await prisma.auditLog.deleteMany({ where: { yardId, entityId: { in: created } } });
  check("every row this suite created is gone", removed >= 0 && (await prisma.sku.count({ where: { id: { in: created } } })) === 0);
  check(
    "the baseline sort types are untouched",
    (await prisma.sku.count({ where: { yardId, isMixedBucket: false, materialId: { not: null } } })) === dbSortTypes,
    "sandbox sort-type count drifted"
  );

  console.log(`\n==== sort types: ${pass} passed, ${fail} failed ====`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
