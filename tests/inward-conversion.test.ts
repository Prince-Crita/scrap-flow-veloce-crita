/**
 * Inward conversion audit.
 *
 * Verifies the exact values requested — 1 KG, 100 KG, 0.5 / 1 / 5 / 12 / 25 TON
 * — through the WHOLE path, not just the helper: the reading is converted once
 * at add-to-cart, the cart total is the sum of kilograms, and what reaches the
 * server is kilograms with no second conversion.
 *
 * The last part is what a unit test of `toKilograms` cannot tell you. A double
 * conversion compiles, type-checks and passes every helper test; it only shows
 * up when you compare what was typed against what was stored.
 *
 * Writes ONE load to the SANDBOX yard and deletes it again. Yard 1 is never
 * touched. Usage: app on :3001, then `npx tsx tests/inward-conversion.test.ts`
 */
import { PrismaClient } from "@prisma/client";
import { toKilograms, fromKilograms, UNITS, type UnitCode } from "../src/shared/units";
import { TEST_YARD_CODE, TEST_MANAGER } from "./fixtures";

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

/** Reading → expected kilograms, worked out independently of the helper. */
const CASES: { reading: number; unit: UnitCode; expected: number }[] = [
  { reading: 1, unit: "KG", expected: 1 },
  { reading: 100, unit: "KG", expected: 100 },
  { reading: 0.5, unit: "TON", expected: 454 }, // 453.59237 → 454
  { reading: 1, unit: "TON", expected: 907 }, // 907.18474 → 907
  { reading: 5, unit: "TON", expected: 4536 }, // 4535.9237 → 4536
  { reading: 12, unit: "TON", expected: 10886 }, // 10886.21688 → 10886
  { reading: 25, unit: "TON", expected: 22680 }, // 22679.6185 → 22680
  { reading: 0.5, unit: "TONNE", expected: 500 },
  { reading: 1, unit: "TONNE", expected: 1000 },
  { reading: 12, unit: "TONNE", expected: 12000 },
];

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
  const login = async (email: string, password: string) => {
    cookies = {};
    const csrf = await (await req("/api/auth/csrf")).json();
    await req("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken: csrf.csrfToken, email, password, callbackUrl: `${BASE}/stock`, json: "true" }).toString(),
    });
  };
  return { req, login };
}

async function main() {
  const yard = await prisma.yard.findUniqueOrThrow({ where: { yardCode: TEST_YARD_CODE } });
  let createdLoadId: string | null = null;

  try {
    console.log("Conversion table — every requested value:");
    for (const c of CASES) {
      const got = toKilograms(c.reading, c.unit);
      check(`${c.reading} ${c.unit} = ${c.expected} kg`, got === c.expected, `got ${got}`);
    }

    console.log("\nRounding happens once, on the product:");
    // If the factor were pre-rounded, N tons would be N × round(factor).
    for (const n of [5, 12, 25]) {
      const exact = Math.round(n * 907.18474);
      check(`${n} TON is not ${n} × 907 (${n * 907})`, toKilograms(n, "TON") === exact && exact !== n * 907, `${toKilograms(n, "TON")}`);
    }

    console.log("\nNo double conversion — kg in, kg out:");
    for (const c of CASES) {
      // Converting an already-converted value must be a visible error, which is
      // what makes a second conversion detectable rather than plausible.
      const once = toKilograms(c.reading, c.unit);
      const twice = toKilograms(once, c.unit);
      check(
        `${c.reading} ${c.unit}: a second conversion would be wrong (${once} vs ${twice})`,
        c.unit === "KG" ? once === twice : once !== twice
      );
    }

    console.log("\nCart totals are exact sums of kilograms:");
    const cartKg = CASES.map((c) => toKilograms(c.reading, c.unit));
    const total = cartKg.reduce((a, b) => a + b, 0);
    const expectedTotal = CASES.reduce((a, c) => a + c.expected, 0);
    check(`a mixed-unit cart totals ${expectedTotal} kg`, total === expectedTotal, String(total));
    check("the total is a whole number of kilograms", Number.isInteger(total));

    console.log("\nDisplay conversion never changes the stored value:");
    for (const c of CASES) {
      const kg = toKilograms(c.reading, c.unit);
      for (const u of UNITS) {
        const shown = fromKilograms(kg, u.code);
        check(
          `${kg} kg shown in ${u.code} still means ${kg} kg`,
          Math.abs(shown * u.toKg - kg) < 1e-6,
          `${shown} ${u.code}`
        );
      }
    }

    /* ── End to end: what the operator types vs what the database stores ── */
    console.log("\nEnd to end — a real load through the API:");
    const C = makeClient();
    await C.login(TEST_MANAGER.email, TEST_MANAGER.password);

    const skus = await prisma.sku.findMany({ where: { yardId: yard.id, isMixedBucket: true }, take: 1 });
    if (skus.length === 0) {
      console.log("  … no mixed SKU in the sandbox; end-to-end step skipped");
    } else {
      const skuId = skus[0].id;
      // Three readings in three different units, exactly as the keypad converts
      // them before anything is added to the cart.
      const entered = [
        { reading: 12, unit: "TON" as UnitCode },
        { reading: 0.5, unit: "TONNE" as UnitCode },
        { reading: 100, unit: "KG" as UnitCode },
      ];
      const lines = entered.map((e) => ({ skuId, kg: toKilograms(e.reading, e.unit) }));
      const expectedKg = 10886 + 500 + 100;
      check("the three readings convert to 11,486 kg", lines.reduce((a, l) => a + l.kg, 0) === expectedKg, String(lines.reduce((a, l) => a + l.kg, 0)));

      const res = await C.req("/api/inward/loads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientRequestId: `conv-audit-${Date.now()}`,
          lines,
          vehicleNumber: "KA01CV1234",
          vehicleType: "6-Wheel Truck",
          driverName: "Conversion Audit",
        }),
      });
      check("the load was accepted", res.status === 200 || res.status === 201, String(res.status));
      if (res.status < 300) {
        type LoadResp = { id?: string; lotNumber?: string; totalKg?: number };
        const body = (await res.json()) as { data?: { load?: LoadResp }; load?: LoadResp };
        const load = body.data?.load ?? body.load;
        check("the server reports the same kilograms it was sent", load?.totalKg === expectedKg, String(load?.totalKg));

        // The endpoint returns the lot NUMBER, not the row id.
        const stored = await prisma.inwardLoad.findFirstOrThrow({
          where: load?.id
            ? { id: load.id }
            : { yardId: yard.id, lotNumber: load?.lotNumber ?? "" },
          include: { lines: true },
        });
        createdLoadId = stored.id;
        check("the DATABASE stores 11,486 kg — no second conversion", stored.totalKg === expectedKg, String(stored.totalKg));
        // All three readings were for the SAME sku, and the endpoint aggregates
        // per SKU — so one line carrying the summed kilograms is correct.
        check(
          "lines are stored in kilograms, aggregated per SKU",
          stored.lines.reduce((a, l) => a + l.quantityKg, 0) === expectedKg,
          stored.lines.map((l) => l.quantityKg).join(",")
        );
        check("no line was silently scaled by 907 or 1000", stored.lines.every((l) => l.quantityKg < 100_000), stored.lines.map((l) => l.quantityKg).join(","));
      }
    }

    console.log(`\n==== inward conversion: ${pass} passed, ${fail} failed ====`);
  } finally {
    // Remove only what this suite created, in the sandbox yard.
    if (createdLoadId) {
      await prisma.$transaction(async (tx) => {
        await tx.inventoryTransaction.deleteMany({ where: { refId: createdLoadId! } });
        await tx.inventoryLot.deleteMany({ where: { sourceLoadId: createdLoadId! } });
        await tx.weightEntry.deleteMany({ where: { loadId: createdLoadId! } });
        await tx.inwardLoadLine.deleteMany({ where: { loadId: createdLoadId! } });
        await tx.inwardLoad.delete({ where: { id: createdLoadId! } });
      },
  { maxWait: 15_000, timeout: 60_000 }
);
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
