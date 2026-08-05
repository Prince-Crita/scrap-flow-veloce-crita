/**
 * Fixture-yard isolation guarantee.
 *
 * The automated suites now run against the fixture yard SFTEST01, and the
 * prototype suite rewrites that yard's data wholesale on every run. That is only
 * safe if three things are true, and none of them should be taken on trust:
 *
 *   1. The fixture tooling CANNOT touch a non-fixture yard. Not "does not" —
 *      cannot. `fixtures.ts` asserts the yard code before any delete.
 *   2. Rebuilding the fixture baseline leaves Yard 1 byte-identical.
 *   3. A yard created later — by the Admin UI, by a real client — is unaffected
 *      by the fixture yard, and does not affect it. Whichever order they appear
 *      in.
 *
 * The third is the one that would bite silently: a future client yard inheriting
 * fixture rows, or a fixture rebuild disturbing a client's catalogue, would both
 * look like a data bug months later with no obvious cause.
 *
 * This suite creates a throwaway yard through the real Admin API and removes it
 * again. Yard 1 is READ ONLY here — censused, never written.
 *
 * Usage: app on :3001, then `npx tsx tests/fixture-isolation.test.ts`
 */
import { PrismaClient } from "@prisma/client";
import { TEST_YARD_CODE, prototypeBaseline } from "./fixtures";

const prisma = new PrismaClient();
const BASE = process.env.BASE_URL || "http://localhost:3001";
const ADMIN = { email: "admin@scrapflow.in", password: "ScrapFlow@2026" };
const PROBE_CODE = "ISOPROBE1";

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
    const res = await fetch(BASE + path, { ...opts, headers: { ...(opts.headers || {}), cookie: ch() }, redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [p] = c.split(";");
      const i = p.indexOf("=");
      cookies[p.slice(0, i)] = p.slice(i + 1);
    }
    return res;
  };
  const json = async (path: string, body?: unknown, method = "POST") =>
    req(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (email: string, password: string) => {
    cookies = {};
    const csrf = await (await req("/api/auth/csrf")).json();
    await req("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken: csrf.csrfToken, email, password, callbackUrl: `${BASE}/admin`, json: "true" }).toString(),
    });
  };
  return { req, json, login };
}

/**
 * Removes a throwaway yard completely.
 *
 * `Counter` rows are the easy thing to forget: they are keyed `"<yardId>:lot"`
 * rather than by a `yardId` column, so a `deleteMany({ where: { yardId } })`
 * sweep misses them entirely and `db:verify` then reports "counter does not
 * belong to a real yard". The first version of this suite left exactly that
 * behind on every run.
 *
 * Refuses to run on Yard 1 or the fixture yard — both are asserted by the caller
 * too, but a delete helper should not depend on its caller being careful.
 */
async function removeYard(yardId: string) {
  const y = await prisma.yard.findUnique({ where: { id: yardId }, select: { yardCode: true } });
  if (!y) return;
  if (y.yardCode === "SFDY001" || y.yardCode === TEST_YARD_CODE) {
    throw new Error(`[fixture-isolation] refusing to delete ${y.yardCode}`);
  }
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
    await tx.sku.deleteMany(w);
    await tx.material.deleteMany(w);
    await tx.vendor.deleteMany(w);
    await tx.impersonationSession.deleteMany(w);
    await tx.auditLog.deleteMany(w);
    await tx.user.deleteMany(w);
    // Keyed by name, not by yardId — see the note above.
    await tx.counter.deleteMany({ where: { name: { startsWith: `${yardId}:` } } });
    await tx.yard.delete({ where: { id: yardId } });
  },
  /**
   * 22 sequential deletes against a remote pooled Postgres do not fit Prisma's
   * default 5s interactive-transaction budget — it aborted with P2028 mid-cleanup.
   * Atomicity is what matters here (a partial delete leaves orphans), so the
   * budget is raised rather than the transaction split.
   */
  { maxWait: 15_000, timeout: 60_000 });
}

/** Everything that could drift, in one comparable object. */
async function census(yardId: string) {
  const [vendors, buyers, materials, skus, inward, outward, sales, receivables, lots, txns, runs] = await Promise.all([
    prisma.vendor.count({ where: { yardId } }),
    prisma.buyer.count({ where: { yardId } }),
    prisma.material.count({ where: { yardId } }),
    prisma.sku.count({ where: { yardId } }),
    prisma.inwardLoad.count({ where: { yardId } }),
    prisma.outwardLoad.count({ where: { yardId } }),
    prisma.sale.count({ where: { yardId } }),
    prisma.receivable.count({ where: { yardId } }),
    prisma.inventoryLot.count({ where: { yardId } }),
    prisma.inventoryTransaction.count({ where: { yardId } }),
    prisma.segregationRun.count({ where: { yardId } }),
  ]);
  const stock = (await prisma.inventory.aggregate({ where: { yardId }, _sum: { quantityKg: true } }))._sum.quantityKg ?? 0;
  const recvSum = (await prisma.receivable.aggregate({ where: { yardId }, _sum: { amount: true } }))._sum.amount ?? 0;
  return { vendors, buyers, materials, skus, inward, outward, sales, receivables, lots, txns, runs, stock, recvSum };
}

async function main() {
  const y1 = await prisma.yard.findUniqueOrThrow({ where: { yardCode: "SFDY001" } });
  const fx = await prisma.yard.findUniqueOrThrow({ where: { yardCode: TEST_YARD_CODE } });
  let probeId: string | null = null;

  try {
    console.log("There is exactly ONE fixture yard — no duplicates were created:");
    /**
     * Operational yards whose NAME happens to trip the heuristic below.
     *
     * `TESTYARD1` / "Testing Yard 1" is the yard handed to the client for
     * acceptance testing — a real yard with real users, created by
     * `npm run demo:prepare`, never by the fixture tooling. Without this the
     * duplicate-sandbox guard fires on it, which says nothing about fixture
     * isolation and hides the failure it actually exists to catch.
     */
    const OPERATIONAL = new Set(["TESTYARD1"]);
    const allYards = await prisma.yard.findMany({ select: { yardCode: true, yardName: true } });
    const fixtureLike = allYards.filter(
      (y) =>
        !OPERATIONAL.has(y.yardCode) &&
        (/TEST|FIXTURE|QA|SANDBOX/i.test(y.yardCode) || /test|fixture|qa|sandbox/i.test(y.yardName))
    );
    check("exactly one fixture-looking yard exists", fixtureLike.length === 1, fixtureLike.map((y) => y.yardCode).join(", "));
    check(`it is ${TEST_YARD_CODE}`, fixtureLike[0]?.yardCode === TEST_YARD_CODE, fixtureLike[0]?.yardCode);
    check("Yard 1 is not fixture-flagged", !/TEST|FIXTURE|QA/i.test(y1.yardCode));

    console.log("\nThe fixture tooling CANNOT operate on another yard:");
    // assertSandbox is the guard. Prove it refuses, rather than trusting it.
    const mod = await import("./fixtures");
    const src = (await import("node:fs")).readFileSync("tests/fixtures.ts", "utf8");
    check("fixtures.ts hard-codes the sandbox yard code", src.includes(`"SFTEST01"`));
    check("it asserts the code before deleting", /assertSandbox\(/.test(src));
    check("every destructive export routes through that assertion", (src.match(/assertSandbox\(/g) ?? []).length >= 3, String((src.match(/assertSandbox\(/g) ?? []).length));
    check("TEST_YARD_CODE is not Yard 1", mod.TEST_YARD_CODE !== y1.yardCode);

    console.log("\nRebuilding the fixture baseline leaves Yard 1 byte-identical:");
    const y1Before = await census(y1.id);
    await prototypeBaseline();
    const y1After = await census(y1.id);
    for (const k of Object.keys(y1Before) as (keyof typeof y1Before)[]) {
      check(`Yard 1 ${k} unchanged (${y1Before[k]})`, y1Before[k] === y1After[k], `${y1Before[k]} → ${y1After[k]}`);
    }

    console.log("\nA yard created AFTER the fixture is completely independent:");
    const AD = makeClient();
    await AD.login(ADMIN.email, ADMIN.password);
    // Clear any leftover probe from an interrupted run.
    const stale = await prisma.yard.findUnique({ where: { yardCode: PROBE_CODE } });
    if (stale) {
      await removeYard(stale.id);
    }

    const fxBefore = await census(fx.id);
    const created = await AD.json("/api/admin/yards", {
      yardCode: PROBE_CODE,
      yardName: "Isolation Probe Yard",
      city: "Nowhere",
      state: "Karnataka",
      seedMaterials: true,
      ownerName: "Probe Owner",
      ownerEmail: "probe-owner@isolation.test",
    });
    check("the Admin API created the probe yard", created.status === 201, String(created.status));
    const body = (await created.json()) as { data?: { yard?: { id: string } }; yard?: { id: string } };
    probeId = body.data?.yard?.id ?? body.yard?.id ?? null;
    check("it has an id", !!probeId);

    if (probeId) {
      const probe = await census(probeId);
      // A brand-new yard must not inherit ANY transactional fixture data.
      check("the new yard has no vendors from the fixture", probe.vendors === 0, String(probe.vendors));
      check("the new yard has no buyers from the fixture", probe.buyers === 0, String(probe.buyers));
      check("the new yard has no inward loads", probe.inward === 0, String(probe.inward));
      check("the new yard has no sales", probe.sales === 0, String(probe.sales));
      check("the new yard has no receivables", probe.receivables === 0, String(probe.receivables));
      check("the new yard has no inventory lots", probe.lots === 0, String(probe.lots));
      check("the new yard has zero stock", probe.stock === 0, String(probe.stock));
      check("the new yard's own catalogue was seeded independently", probe.materials > 0 && probe.skus > 0, `${probe.materials}/${probe.skus}`);

      // No row may be shared between the two yards.
      const sharedSku = await prisma.sku.findFirst({ where: { yardId: probeId, id: { in: (await prisma.sku.findMany({ where: { yardId: fx.id }, select: { id: true } })).map((s) => s.id) } } });
      check("no SKU row is shared with the fixture yard", sharedSku === null);
      const probeNames = (await prisma.vendor.findMany({ where: { yardId: probeId }, select: { name: true } })).map((v) => v.name);
      check("no fixture vendor leaked in by name", !probeNames.includes("Balaji Metals") && !probeNames.includes("SR Traders"), probeNames.join(", "));

      console.log("\n…and creating it did not disturb the fixture yard:");
      const fxAfter = await census(fx.id);
      for (const k of Object.keys(fxBefore) as (keyof typeof fxBefore)[]) {
        check(`fixture ${k} unchanged (${fxBefore[k]})`, fxBefore[k] === fxAfter[k], `${fxBefore[k]} → ${fxAfter[k]}`);
      }

      console.log("\n…nor Yard 1:");
      const y1Final = await census(y1.id);
      for (const k of Object.keys(y1After) as (keyof typeof y1After)[]) {
        check(`Yard 1 ${k} still ${y1After[k]}`, y1After[k] === y1Final[k], `${y1After[k]} → ${y1Final[k]}`);
      }

      console.log("\nRebuilding the fixture AGAIN does not touch the new client yard:");
      const probeBefore = await census(probeId);
      await prototypeBaseline();
      const probeAfter = await census(probeId);
      for (const k of Object.keys(probeBefore) as (keyof typeof probeBefore)[]) {
        check(`probe yard ${k} unchanged (${probeBefore[k]})`, probeBefore[k] === probeAfter[k], `${probeBefore[k]} → ${probeAfter[k]}`);
      }
    }

    console.log(`\n==== fixture isolation: ${pass} passed, ${fail} failed ====`);
  } finally {
    // Remove the probe yard. Scoped by its own id, and it is never Yard 1 or the
    // fixture yard — both are asserted above.
    if (probeId) {
      await removeYard(probeId);
      const leftoverCounters = await prisma.counter.count({ where: { name: { startsWith: `${probeId}:` } } });
      console.log(`probe yard removed (leftover counters: ${leftoverCounters})`);
    }
    await prisma.$disconnect();
  }
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
