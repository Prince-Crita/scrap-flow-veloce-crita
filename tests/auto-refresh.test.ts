/**
 * Phase 12 — pages must show new data on arrival, with no manual refresh.
 *
 * The cause was `refetchOnMount: false`. `invalidateQueries` refetches at once
 * only for queries that have a MOUNTED observer; Inward, Sort, Stock and Sell
 * are separate routes, so the query a write invalidates is inactive at that
 * moment and is merely marked. Arriving at the page then mounted it with cached
 * data, and `refetchOnMount: false` skipped the refetch — hence "requires a
 * manual refresh". It is now `(query) => query.state.isInvalidated`.
 *
 * These assertions are about behaviour, not wiring: navigate the way a person
 * does, count the network calls, and require NO reload and NO polling.
 *
 * Navigation here goes through the bottom tab bar (next/link), NOT page.goto().
 * That matters: a goto is a full page load, which throws away the React Query
 * cache and refetches unconditionally — it would pass whether or not the bug was
 * fixed. Only a client-side route change exercises the cached-and-invalidated
 * path this phase repaired.
 *
 * Runs entirely in the sandbox yard SFTEST01. Yard 1 is never touched.
 *
 * Usage: app on :3001, then `npx tsx tests/auto-refresh.test.ts`
 */
import { chromium, type Page } from "playwright";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const OWNER = { email: "test-owner@veloce.test", password: "testowner123" };
const MANAGER = { email: "test-manager@veloce.test", password: "testmanager123" };
const SANDBOX = "SFTEST01";

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

/** Client-side navigation via the tab bar — the only kind that tests the cache. */
async function tab(page: Page, label: string) {
  await page.click(`nav.tabbar a[href="/${label}"]`);
  await page.waitForFunction((l) => location.pathname.startsWith(`/${l}`), label, { timeout: 15_000 });
  await page.waitForTimeout(1200);
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', OWNER.email);
  await page.fill('input[type="password"]', OWNER.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45_000 }),
    page.click('button[type="submit"]'),
  ]);
}

/**
 * Removes this suite's own materials from the SANDBOX. Runs at startup as well as
 * at the end: a run that dies mid-way otherwise leaves `Refresh …` rows behind,
 * and other suites look SKUs up by name in a catalogue they expect to be the
 * baseline — that is exactly how a crashed run once broke an unrelated suite.
 *
 * Sandbox-only by assertion, and it never touches anything it did not name.
 */
async function cleanup(db: PrismaClient) {
  const yard = await db.yard.findFirst({ where: { yardCode: SANDBOX }, select: { id: true, yardCode: true } });
  if (!yard) return 0;
  if (yard.yardCode !== SANDBOX) throw new Error("refusing to clean anything but the sandbox");

  const mine = { yardId: yard.id, OR: [{ name: { startsWith: "Refresh " } }, { name: { startsWith: "Live " } }] };
  const mats = await db.material.findMany({ where: mine, select: { id: true, name: true } });
  const skus = await db.sku.findMany({
    where: { yardId: yard.id, OR: [{ name: { startsWith: "Mixed Refresh " } }, { name: { startsWith: "Mixed Live " } }] },
    select: { id: true },
  });
  if (!mats.length && !skus.length) return 0;

  await db.$transaction(
    async (tx) => {
      const ids = skus.map((s) => s.id);
      if (ids.length) {
        await tx.inventoryTransaction.deleteMany({ where: { skuId: { in: ids } } });
        await tx.inventoryLot.deleteMany({ where: { skuId: { in: ids } } });
        await tx.inventory.deleteMany({ where: { skuId: { in: ids } } });
        await tx.sku.deleteMany({ where: { id: { in: ids } } });
      }
      if (mats.length) await tx.material.deleteMany({ where: { id: { in: mats.map((m) => m.id) } } });
    },
    { maxWait: 15_000, timeout: 60_000 }
  );
  return mats.length + skus.length;
}

async function main() {
  const browser = await chromium.launch();
  const db = new PrismaClient();
  const suffix = String(Date.now()).slice(-6);
  const matName = `Refresh ${suffix}`;

  try {
    const swept = await cleanup(db);
    if (swept) console.log(`(swept ${swept} leftover rows from a previous run)\n`);

    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    const page = await ctx.newPage();

    /**
     * `framenavigated` fires for client-side History navigation too, so counting
     * it would just count the tab taps this test performs. A real page reload is
     * a NEW document — so stamp the document and see whether the stamp survives.
     */
    const stamp = async () => page.evaluate(() => ((window as unknown as { __sf?: number }).__sf = 1));
    const survived = async () =>
      page.evaluate(() => (window as unknown as { __sf?: number }).__sf === 1);
    const calls: { url: string; at: number }[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/api/") && !u.pathname.startsWith("/api/auth")) {
        calls.push({ url: u.pathname + u.search, at: Date.now() });
      }
    });

    await login(page);

    /* ── 1. A material created on Inward reaches Stock and Sort ── */
    console.log("[1] create a material on Inward, then walk to the other pages:");
    await page.goto(`${BASE}/inward`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);

    // Visit Stock and Sort FIRST, client-side, so both queries are cached and
    // would otherwise be served stale — the exact condition the bug needed.
    await tab(page, "stock");
    await tab(page, "sort");
    await tab(page, "inward");
    const cachedFirst = calls.filter((c) => c.url.startsWith("/api/stock")).length;
    check("Stock and Sort were visited first, so their data is cached", cachedFirst > 0);

    /**
     * Add Material lives inside the material picker now — the standalone chip row
     * was removed in the approved Inward redesign. Same sheet, same API call;
     * only the way it is reached changed.
     */
    await page.locator(".actCell").first().click();
    await page.waitForTimeout(600);
    const addBtn = page.locator(".sheet button", { hasText: /\+\s*Add Material/i }).first();
    check("the Add Material control is present", (await addBtn.count()) > 0);
    await addBtn.click();
    await page.waitForTimeout(600);

    await page.locator(".sheet input").first().fill(matName);
    await page.waitForTimeout(150);
    await page.locator(".sheet button.cta").first().click();
    await page.waitForTimeout(1800);

    const onInward = await page.evaluate((n) => document.body.innerText.includes(n), matName);
    check("the new material appears on Inward immediately", onInward);

    await stamp();

    // Now navigate the way a person does — a client-side route change, no reload.
    const before = calls.length;
    await tab(page, "stock");
    const onStock = await page.evaluate((n) => document.body.innerText.includes(n), matName);
    check("Stock shows it on arrival, with no manual refresh", onStock);
    check(
      "Stock actually refetched (the invalidation was honoured)",
      calls.slice(before).some((c) => c.url.startsWith("/api/stock")),
      calls.slice(before).map((c) => c.url).join(" | ")
    );

    // Deliberately NOT asserting that Sort refetches here: a new material with no
    // load against it changes nothing pending, and the `materials` channel does
    // not carry `sortPending`. Asserting it would be demanding a wasted fetch.
    // The real Inward → Sort flow is exercised in [3] with an actual load.
    await tab(page, "sort");
    check("Sort still renders after the change", (await page.locator("body").innerText()).length > 0);

    /* ── 2. No reloads, no polling, no duplicate fetches ── */
    console.log("\n[2] how it refreshed:");
    check("not one full page reload — the document was never replaced", await survived());

    // Sit still and confirm nothing fetches on a timer.
    const idleFrom = calls.length;
    await page.waitForTimeout(9000);
    const idleCalls = calls.slice(idleFrom).filter((c) => !c.url.startsWith("/api/realtime"));
    check("nothing polls while the page sits idle", idleCalls.length === 0, idleCalls.map((c) => c.url).join(" | "));

    // Revisiting an UNCHANGED page must not refetch — this is the optimisation
    // `refetchOnMount: false` existed for, and it has to survive the fix.
    const beforeRevisit = calls.length;
    await tab(page, "inward");
    await tab(page, "stock");
    const revisitStock = calls.slice(beforeRevisit).filter((c) => c.url.startsWith("/api/stock"));
    check(
      "revisiting an unchanged page does NOT refetch",
      revisitStock.length === 0,
      revisitStock.map((c) => c.url).join(" | ")
    );

    // And no key was fetched twice in one arrival.
    const beforeSell = calls.length;
    await tab(page, "sell");
    const arrival = calls.slice(beforeSell).map((c) => c.url.split("?")[0]);
    const dupes = arrival.filter((u, i) => arrival.indexOf(u) !== i);
    check("no endpoint was fetched twice on one arrival", dupes.length === 0, dupes.join(" | "));

    /* ── 3. The reported flow: Inward → Save Load → Sort shows it ── */
    console.log("\n[3] a load saved by the Manager reaches the Owner's screens:");

    // A DIFFERENT user. The provider deliberately ignores an event caused by the
    // current user, so two windows signed in as the same person prove nothing —
    // which is exactly what the first draft of this test got wrong.
    const ctxB = await browser.newContext({ viewport: { width: 420, height: 900 } });
    const pageB = await ctxB.newPage();
    await pageB.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await pageB.fill('input[type="email"]', MANAGER.email);
    await pageB.fill('input[type="password"]', MANAGER.password);
    await Promise.all([
      pageB.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45_000 }),
      pageB.click('button[type="submit"]'),
    ]);

    // The Owner sits on Inward, so Sort and Stock are cached AND unmounted —
    // precisely the state in which the update used to be dropped.
    await tab(page, "stock");
    await tab(page, "sort");
    // What Sort showed BEFORE the load — the comparison that makes "it updated"
    // mean something. A bare `/175/` matched unrelated digits already on screen
    // and so passed even against the unfixed build.
    const sortBefore = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
    await tab(page, "inward");
    await stamp();

    const mats = await ctxB.request.get(`${BASE}/api/materials`);
    const matList = (await mats.json()) as { materials: { id: string; name: string }[] };
    const skuId = matList.materials[0]?.id;
    check("the Manager has a material to book against", !!skuId, JSON.stringify(matList).slice(0, 140));

    const save = await ctxB.request.post(`${BASE}/api/inward/loads`, {
      data: { lines: [{ skuId, kg: 175 }], vehicleNumber: `RF${suffix}` },
    });
    check("the Manager's load saved", save.ok(), `${save.status()} ${(await save.text()).slice(0, 120)}`);

    // Let the SSE event reach the Owner's still-open Inward page.
    await page.waitForTimeout(2500);

    const beforeArrive = calls.length;
    await tab(page, "sort");
    const sortCalls = calls.slice(beforeArrive).filter((c) => c.url.startsWith("/api/sort/pending"));
    check("Sort refetched once on arrival — not zero, not twice", sortCalls.length === 1, `${sortCalls.length} calls`);

    const sortAfter = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
    check(
      "the Sort screen actually changed — new content, no manual refresh",
      sortAfter !== sortBefore && /175/.test(sortAfter),
      sortAfter === sortBefore ? "identical to before the load" : sortAfter.slice(0, 140)
    );
    check("still no full page reload", await survived());

    // Stock was cached and unmounted throughout too.
    const beforeStock = calls.length;
    await tab(page, "stock");
    const stockCalls = calls.slice(beforeStock).filter((c) => c.url.startsWith("/api/stock"));
    check("Stock refetched once on arrival too", stockCalls.length === 1, `${stockCalls.length} calls`);

    console.log(`\n==== auto refresh: ${pass} passed, ${fail} failed ====`);
    await ctxB.close();
    await ctx.close();
  } finally {
    await cleanup(db).catch((e) => console.error("cleanup failed:", e.message));
    await db.$disconnect();
    await browser.close();
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
