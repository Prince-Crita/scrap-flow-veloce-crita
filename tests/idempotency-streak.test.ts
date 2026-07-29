/**
 * Exit gate: write idempotency + daily streak.
 *
 * Idempotency is the production bug this closes: a weighbridge operator on a
 * poor connection re-taps SAVE LOAD, and without a key the retry books a second
 * lot and double-counts the stock. Same for a re-tapped sale burning a second
 * invoice number. Both are exercised here, sequentially AND concurrently.
 *
 * Runs against the sandbox yard. Yard 1 is never written to.
 *
 * Usage: start the app, then `npx tsx tests/idempotency-streak.test.ts`.
 */
import { PrismaClient } from "@prisma/client";
import { TEST_YARD_CODE, TEST_OWNER } from "./fixtures";
import { nextStreak, dayKey, daysBetween } from "../src/lib/streak";

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
    const res = await fetch(BASE + path, { ...opts, headers: { ...(opts.headers || {}), cookie: ch() }, redirect: "manual" });
    store(res);
    return res;
  };
  const json = (p: string, b?: unknown, m = "POST") =>
    req(p, { method: m, headers: { "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
  const login = async (email: string, password: string) => {
    cookies = {};
    const csrf = await (await req("/api/auth/csrf")).json();
    const body = new URLSearchParams({ csrfToken: csrf.csrfToken, email, password, callbackUrl: BASE + "/", json: "true" });
    await req("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  };
  return { req, json, login };
}

const qtyOf = (stock: { skus: { name: string; quantityKg: number }[] }, name: string) =>
  stock.skus.find((s) => s.name === name)?.quantityKg ?? 0;

/**
 * Yard 1's state before the suite runs. The guarantee under test is that this
 * suite writes nothing to the production baseline, so it is checked as a
 * before/after comparison rather than against the prototype's literal values —
 * those drift the moment someone legitimately uses the app, and catching THAT
 * is `demo:restore`'s job.
 */
async function yard1Snapshot() {
  const y1 = await prisma.yard.findUnique({ where: { yardCode: "SFDY001" } });
  if (!y1) return null;
  const owner = await prisma.user.findFirst({ where: { yardId: y1.id, role: "OWNER" } });
  return {
    loads: await prisma.inwardLoad.count({ where: { yardId: y1.id } }),
    sales: await prisma.sale.count({ where: { yardId: y1.id } }),
    ownerXp: owner?.xp ?? -1,
    ownerStreak: owner?.streak ?? -1,
  };
}

async function main() {
  const y1Before = await yard1Snapshot();
  const yard = await prisma.yard.findUnique({ where: { yardCode: TEST_YARD_CODE } });
  if (!yard) {
    console.error(`❌ Sandbox yard missing. Run: npx tsx tests/fixtures.ts up`);
    process.exit(1);
  }
  const yardId = yard.id;

  /* ---------------- pure streak logic ---------------- */
  console.log("\n[Streak · pure logic] calendar days in the yard's timezone");
  const TZ = "Asia/Kolkata";
  check("dayKey formats YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(dayKey(new Date(), TZ)));
  // 2026-03-01T19:00Z is 2026-03-02 00:30 IST — the yard's day has already rolled.
  check(
    "a late-evening UTC instant maps to the next IST day",
    dayKey(new Date("2026-03-01T19:00:00Z"), TZ) === "2026-03-02",
    dayKey(new Date("2026-03-01T19:00:00Z"), TZ)
  );
  check("daysBetween consecutive days = 1", daysBetween("2026-03-01", "2026-03-02") === 1);
  check("daysBetween across a month end = 1", daysBetween("2026-02-28", "2026-03-01") === 1);

  const now = new Date("2026-03-10T06:00:00Z");
  const yesterday = new Date("2026-03-09T06:00:00Z");
  const sameDay = new Date("2026-03-10T02:00:00Z");
  const longAgo = new Date("2026-03-01T06:00:00Z");

  check("first ever activity → streak 1", nextStreak(0, null, now, TZ).streak === 1);
  check("yesterday → +1", nextStreak(5, yesterday, now, TZ).streak === 6);
  check("yesterday marks extended", nextStreak(5, yesterday, now, TZ).extended === true);
  const same = nextStreak(5, sameDay, now, TZ);
  check("same day → unchanged", same.streak === 5 && same.changed === false);
  check("same day is not celebrated twice", same.extended === false);
  const broke = nextStreak(12, longAgo, now, TZ);
  check("gap of 9 days → reset to 1", broke.streak === 1 && broke.reset === true);

  /* ---------------- live server ---------------- */
  const A = makeClient();
  await A.login(TEST_OWNER.email, TEST_OWNER.password);

  const bucket = await prisma.sku.findFirstOrThrow({ where: { yardId, code: "MIXMS" } });
  const before = await (await A.req("/api/stock")).json();
  const beforeKg = qtyOf(before, "Mixed MS");
  const beforeLoads = await prisma.inwardLoad.count({ where: { yardId } });

  console.log("\n[Inward idempotency · sequential replay]");
  const key = `test-idem-${Date.now()}`;
  const r1 = await A.json("/api/inward/loads", { clientRequestId: key, materialSkuId: bucket.id, entries: [250] });
  check("first save returns 201", r1.status === 201, `got ${r1.status}`);
  const b1 = await r1.json();

  const r2 = await A.json("/api/inward/loads", { clientRequestId: key, materialSkuId: bucket.id, entries: [250] });
  check("replay returns 200, not a new 201", r2.status === 200, `got ${r2.status}`);
  const b2 = await r2.json();
  check("replay is flagged", b2.replayed === true);
  check("replay returns the SAME lot number", b1.load.lotNumber === b2.load.lotNumber, `${b1.load.lotNumber} vs ${b2.load.lotNumber}`);

  const afterLoads = await prisma.inwardLoad.count({ where: { yardId } });
  check("exactly one load was created", afterLoads === beforeLoads + 1, `${beforeLoads} → ${afterLoads}`);
  const after = await (await A.req("/api/stock")).json();
  check("stock increased by 250 kg ONCE, not 500", qtyOf(after, "Mixed MS") === beforeKg + 250, `${beforeKg} → ${qtyOf(after, "Mixed MS")}`);

  console.log("\n[Inward idempotency · concurrent double-tap]");
  const key2 = `test-idem-race-${Date.now()}`;
  const kgBeforeRace = qtyOf(await (await A.req("/api/stock")).json(), "Mixed MS");
  const loadsBeforeRace = await prisma.inwardLoad.count({ where: { yardId } });
  const [c1, c2] = await Promise.all([
    A.json("/api/inward/loads", { clientRequestId: key2, materialSkuId: bucket.id, entries: [100] }),
    A.json("/api/inward/loads", { clientRequestId: key2, materialSkuId: bucket.id, entries: [100] }),
  ]);
  check("both concurrent requests succeed", c1.status < 400 && c2.status < 400, `${c1.status}/${c2.status}`);
  const j1 = await c1.json();
  const j2 = await c2.json();
  check("both report the same lot", j1.load.lotNumber === j2.load.lotNumber, `${j1.load.lotNumber} vs ${j2.load.lotNumber}`);
  check("only one load row exists", (await prisma.inwardLoad.count({ where: { yardId } })) === loadsBeforeRace + 1);
  check(
    "stock rose by 100 kg, not 200",
    qtyOf(await (await A.req("/api/stock")).json(), "Mixed MS") === kgBeforeRace + 100
  );

  console.log("\n[Inward] a different key still creates a new load");
  const loadsBeforeNew = await prisma.inwardLoad.count({ where: { yardId } });
  const fresh = await A.json("/api/inward/loads", { clientRequestId: `test-idem-other-${Date.now()}`, materialSkuId: bucket.id, entries: [60] });
  check("new key returns 201", fresh.status === 201, `got ${fresh.status}`);
  check("a second load exists", (await prisma.inwardLoad.count({ where: { yardId } })) === loadsBeforeNew + 1);

  console.log("\n[Inward] omitting the key preserves the old behaviour");
  const loadsBeforeNoKey = await prisma.inwardLoad.count({ where: { yardId } });
  const nk1 = await A.json("/api/inward/loads", { materialSkuId: bucket.id, entries: [10] });
  const nk2 = await A.json("/api/inward/loads", { materialSkuId: bucket.id, entries: [10] });
  check("both keyless saves return 201", nk1.status === 201 && nk2.status === 201, `${nk1.status}/${nk2.status}`);
  check("keyless saves create two loads (unchanged behaviour)", (await prisma.inwardLoad.count({ where: { yardId } })) === loadsBeforeNoKey + 2);

  console.log("\n[Sale idempotency · replay]");
  const msb = await prisma.sku.findFirstOrThrow({ where: { yardId, code: "MSB" }, include: { inventory: true } });
  const sellQty = 100;
  const stockBeforeSale = msb.inventory?.quantityKg ?? 0;
  const salesBefore = await prisma.sale.count({ where: { yardId } });
  const saleKey = `test-sale-idem-${Date.now()}`;
  const s1 = await A.json("/api/sales", {
    clientRequestId: saleKey,
    skuId: msb.id,
    buyerName: "Idempotency Buyer",
    quantityKg: sellQty,
    ratePerKg: 30,
  });
  check("first sale returns 201", s1.status === 201, `got ${s1.status}`);
  const sb1 = await s1.json();
  const s2 = await A.json("/api/sales", {
    clientRequestId: saleKey,
    skuId: msb.id,
    buyerName: "Idempotency Buyer",
    quantityKg: sellQty,
    ratePerKg: 30,
  });
  check("replayed sale returns 200", s2.status === 200, `got ${s2.status}`);
  const sb2 = await s2.json();
  check("replay is flagged", sb2.replayed === true);
  check("same invoice number returned", sb1.sale.invoiceNumber === sb2.sale.invoiceNumber, `${sb1.sale.invoiceNumber} vs ${sb2.sale.invoiceNumber}`);
  check("exactly one sale row", (await prisma.sale.count({ where: { yardId } })) === salesBefore + 1);
  const msbAfter = await prisma.inventory.findUniqueOrThrow({ where: { skuId: msb.id } });
  // Phase 4 changed what a sale does: it ALLOCATES rather than deducting, so
  // the idempotency guarantee moved with it. The replay must not double-book
  // the allocation — the stock itself only moves at dispatch.
  check(
    `physical stock untouched by the sale (${stockBeforeSale})`,
    msbAfter.quantityKg === stockBeforeSale,
    `got ${msbAfter.quantityKg}`
  );
  const soldRow = await prisma.sale.findFirstOrThrow({ where: { yardId, invoiceNumber: sb1.sale.invoiceNumber } });
  check("the allocation is booked exactly once", soldRow.quantityKg === sellQty, String(soldRow.quantityKg));
  check("the replay did not advance dispatch", soldRow.dispatchedKg === 0, String(soldRow.dispatchedKg));
  check("exactly one receivable", (await prisma.receivable.count({ where: { yardId } })) === salesBefore + 1);

  console.log("\n[Streak · live] an XP-earning action maintains the streak");
  const owner = await prisma.user.findFirstOrThrow({ where: { email: TEST_OWNER.email } });

  /**
   * Anchor fixtures to real IST calendar days, not to an hour offset.
   *
   * "26 hours ago" is NOT reliably yesterday: run this early in the IST day and
   * it lands two calendar days back, at which point the streak correctly resets
   * and the test fails for a reason that has nothing to do with the code. This
   * builds 11:30 IST on a given day offset instead — unambiguous, whatever time
   * the suite runs. (IST is UTC+5:30 with no DST, so 06:00 UTC is 11:30 IST on
   * the same calendar date.)
   */
  const istDaysAgo = (n: number): Date => {
    const today = dayKey(new Date(), TZ); // YYYY-MM-DD in Asia/Kolkata
    const [y, m, d] = today.split("-").map(Number);
    const anchor = new Date(Date.UTC(y, m - 1, d, 6, 0, 0));
    anchor.setUTCDate(anchor.getUTCDate() - n);
    return anchor;
  };

  // Sanity-check the helper before relying on it.
  check(
    "fixture helper: istDaysAgo(1) really is the previous IST day",
    daysBetween(dayKey(istDaysAgo(1), TZ), dayKey(new Date(), TZ)) === 1,
    `${dayKey(istDaysAgo(1), TZ)} → ${dayKey(new Date(), TZ)}`
  );

  // Put the user "one day behind" so the next action should extend the streak.
  await prisma.user.update({
    where: { id: owner.id },
    data: { streak: 4, lastActiveDate: istDaysAgo(1) },
  });
  const x1 = await (await A.json("/api/xp", { xp: owner.xp + 5, level: 7 })).json();
  check("streak extended 4 → 5", x1.streak === 5, `got ${x1.streak}`);
  check("streakExtended flag set", x1.streakExtended === true);

  const x2 = await (await A.json("/api/xp", { xp: owner.xp + 10, level: 7 })).json();
  check("second action the same day does NOT bump the streak", x2.streak === 5, `got ${x2.streak}`);
  check("streakExtended is false on the same day", x2.streakExtended === false);

  await prisma.user.update({
    where: { id: owner.id },
    data: { streak: 9, lastActiveDate: istDaysAgo(5) },
  });
  const x3 = await (await A.json("/api/xp", { xp: owner.xp + 15, level: 7 })).json();
  check("a 5-day gap resets the streak to 1", x3.streak === 1, `got ${x3.streak}`);
  check("streakReset flag set", x3.streakReset === true);

  console.log("\n[Streak] admin accrues nothing");
  const AD = makeClient();
  await AD.login(process.env.ADMIN_EMAIL || "admin@scrapflow.in", process.env.ADMIN_PASSWORD || "ScrapFlow@2026");
  const adminXp = await (await AD.json("/api/xp", { xp: 999, level: 9 })).json();
  check("admin XP is not persisted", adminXp.persisted === false);
  const adminRow = await prisma.user.findFirstOrThrow({ where: { email: process.env.ADMIN_EMAIL || "admin@scrapflow.in" } });
  check("admin xp still 0", adminRow.xp === 0, String(adminRow.xp));
  check("admin streak still 0", adminRow.streak === 0, String(adminRow.streak));

  console.log("\n[Yard 1] untouched by this suite");
  const y1After = await yard1Snapshot();
  if (y1Before && y1After) {
    for (const k of Object.keys(y1Before) as (keyof typeof y1Before)[]) {
      check(`Yard 1 ${k} unchanged by this suite`, y1After[k] === y1Before[k], `${y1Before[k]} → ${y1After[k]}`);
    }
  }

  console.log(`\n==== idempotency + streak: ${pass} passed, ${fail} failed ====`);
  if (fail > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
