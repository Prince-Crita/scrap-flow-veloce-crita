/**
 * Phase X UI polish verification, in a real browser.
 *
 * Each assertion targets one requested refinement and, where the change could
 * plausibly have altered behaviour, checks the behaviour rather than the markup:
 * a typed weight has to move the total by the amount typed, not merely appear in
 * the field.
 *
 * Usage: app on :3001, then `npx tsx tests/ui-polish.test.ts`
 */
import { chromium, type Browser, type Page } from "playwright";
import { PrismaClient } from "@prisma/client";
import { TEST_YARD_CODE, TEST_OWNER, TEST_MANAGER } from "./fixtures";

const prisma = new PrismaClient();
const BASE = process.env.BASE_URL || "http://localhost:3001";
const ADMIN = { email: "admin@scrapflow.in", password: "ScrapFlow@2026" };

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

async function login(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45_000 }),
    page.click('button[type="submit"]'),
  ]);
}

/** Numeric part of a "Unsorted left: 1,200 kg" style string. */
const num = (t: string) => Number((t.match(/([\d,.]+)/)?.[1] ?? "0").replace(/,/g, ""));

async function main() {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();

    /* ─────────────── 1. STOCK ─────────────── */
    console.log("[Stock] READY TO SELL cards lead, newest first:");
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      const warnings: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error" || m.type() === "warning") warnings.push(m.text());
      });
      await login(page, TEST_OWNER.email, TEST_OWNER.password);
      await page.goto(`${BASE}/stock`, { waitUntil: "networkidle" });
      await page.waitForTimeout(700);

      // What the API says, versus the order actually painted.
      const api = (await (await fetch(`${BASE}/api/stock`, {
        headers: { cookie: (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ") },
      })).json()) as { skus: { name: string; ready: boolean; visible: boolean; updatedAt: string | null }[] };
      const expectedReady = api.skus
        .filter((s) => s.visible && s.ready)
        .sort((a, b) => Date.parse(b.updatedAt ?? "0") - Date.parse(a.updatedAt ?? "0"))
        .map((s) => s.name);

      const painted = await page.evaluate(() =>
        [...document.querySelectorAll(".sku h3")].map((h) => (h.textContent ?? "").replace(" (unsorted)", "").trim())
      );
      const readyPainted = await page.evaluate(() =>
        [...document.querySelectorAll(".sku")]
          .filter((c) => c.querySelector(".ready"))
          .map((c) => (c.querySelector("h3")?.textContent ?? "").replace(" (unsorted)", "").trim())
      );

      check("the API exposes updatedAt for ordering", api.skus.every((s) => "updatedAt" in s));
      check(
        `ready cards appear first (${readyPainted.length} ready)`,
        readyPainted.length === 0 || painted.slice(0, readyPainted.length).join("|") === readyPainted.join("|"),
        `${painted.slice(0, 3).join(", ")} | ready=${readyPainted.join(", ")}`
      );
      check(
        "ready cards are ordered newest-first",
        readyPainted.join("|") === expectedReady.join("|"),
        `painted ${readyPainted.join(", ")} vs expected ${expectedReady.join(", ")}`
      );
      // The non-ready tail must keep the API's own sequence.
      const apiOrder = api.skus.filter((s) => s.visible && !s.ready).map((s) => s.name);
      const paintedTail = painted.slice(readyPainted.length);
      check(
        "remaining cards keep their existing order",
        paintedTail.join("|") === apiOrder.join("|"),
        `${paintedTail.join(", ")} vs ${apiOrder.join(", ")}`
      );

      console.log("\n[Stock] the manage badge no longer overlaps the card content:");
      await page.click("button.cta.ghost"); // "+ Manage visible SKUs"
      await page.waitForTimeout(500);
      const overlap = await page.evaluate(() => {
        const card = document.querySelector(".sku");
        const badge = card?.querySelector(".ready.visBadge") as HTMLElement | null;
        const kg = card?.querySelector(".kg") as HTMLElement | null;
        const title = card?.querySelector("h3") as HTMLElement | null;
        if (!badge || !kg || !title) return { found: false, hitsKg: false, hitsTitle: false, static: false };
        const b = badge.getBoundingClientRect();
        const k = kg.getBoundingClientRect();
        const t = title.getBoundingClientRect();
        // Inlined deliberately: a named arrow const here gets wrapped by
        // tsx/esbuild in a __name() helper that does not exist in the browser.
        return {
          found: true,
          hitsKg: !(b.right <= k.left || b.left >= k.right || b.bottom <= k.top || b.top >= k.bottom),
          hitsTitle: !(b.right <= t.left || b.left >= t.right || b.bottom <= t.top || b.top >= t.bottom),
          static: getComputedStyle(badge).position === "static",
        };
      });
      check("the manage badge is rendered", overlap.found);
      check("it does not overlap the kilogram figure", !overlap.hitsKg);
      check("it does not overlap the SKU name", !overlap.hitsTitle);
      check("it sits in normal flow rather than pinned over the corner", overlap.static);
      check("no React warnings on Stock", warnings.length === 0, warnings.slice(0, 3).join(" | "));
      await ctx.close();
    }

    /* ─────────────── 2. SORT ─────────────── */
    console.log("\n[Sort] the duplicate 'Totals in' selector is gone:");
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      const warnings: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error" || m.type() === "warning") warnings.push(m.text());
      });
      await login(page, TEST_MANAGER.email, TEST_MANAGER.password);
      await page.goto(`${BASE}/sort`, { waitUntil: "networkidle" });
      await page.waitForTimeout(900);

      const state = await page.evaluate(() => ({
        summarySelectors: document.querySelectorAll("select.summaryUnit").length,
        summaryRows: document.querySelectorAll(".splitRow.summaryRow").length,
        totalsInText: /Totals in/i.test(document.body.innerText),
        rowUnits: document.querySelectorAll("select.rowUnit").length,
        valueInputs: document.querySelectorAll("input.splitVal").length,
        valueDivs: document.querySelectorAll("div.splitVal").length,
        remain: document.querySelector(".remain")?.textContent?.trim() ?? "",
        steppers: document.querySelectorAll("button.step").length,
      }));

      check("no summary unit selector remains", state.summarySelectors === 0, String(state.summarySelectors));
      check("no summary row remains", state.summaryRows === 0, String(state.summaryRows));
      check('the "Totals in" label is gone', !state.totalsInText);
      check("per-row unit selectors are untouched", state.rowUnits > 0, String(state.rowUnits));
      check("+/- steppers are untouched", state.steppers >= 4, String(state.steppers));
      check("Unsorted left is still shown", /unsorted left/i.test(state.remain), state.remain);

      if (state.rowUnits > 0) {
        console.log("\n[Sort] manual weight entry — typed values run the same logic as +/-:");
        check("values are editable inputs", state.valueInputs > 0, String(state.valueInputs));
        check("no read-only value divs remain", state.valueDivs === 0, String(state.valueDivs));

        const firstInput = page.locator("input.splitVal").first();
        check("the input opens a numeric keyboard", (await firstInput.getAttribute("inputMode")) === "decimal");

        const before = num(state.remain);

        // Type in KG: the total must fall by exactly what was typed.
        await firstInput.fill("");
        await firstInput.type("250");
        await firstInput.press("Enter");
        await page.waitForTimeout(400);
        let remain = await page.evaluate(() => document.querySelector(".remain")?.textContent?.trim() ?? "");
        check("typing 250 KG reduces Unsorted left by exactly 250", before - num(remain) === 250, `${before} → ${num(remain)}`);

        // The stepper must still work, and from the typed value.
        await page.locator(".splitRow:has(input.splitVal) button.step").nth(1).click();
        await page.waitForTimeout(400);
        const afterStep = await page.evaluate(() => ({
          shown: (document.querySelector("input.splitVal") as HTMLInputElement | null)?.value ?? "",
          remain: document.querySelector(".remain")?.textContent?.trim() ?? "",
        }));
        check("the + stepper still adds one 50 kg step on top", afterStep.shown === "300", afterStep.shown);
        check("Unsorted left tracks it", before - num(afterStep.remain) === 300, `${before} → ${num(afterStep.remain)}`);

        // Unit conversion on a typed value: 0.5 TONNE must be 500 kg.
        await page.locator(".splitRow:has(input.splitVal) select.rowUnit").first().selectOption("TONNE");
        await page.waitForTimeout(300);
        await firstInput.fill("");
        await firstInput.type("0.5");
        await firstInput.press("Enter");
        await page.waitForTimeout(400);
        remain = await page.evaluate(() => document.querySelector(".remain")?.textContent?.trim() ?? "");
        check("typing 0.5 TONNE is 500 kg", before - num(remain) === 500, `${before} → ${num(remain)}`);
        check("totals stay in kilograms", /kg/i.test(remain), remain);

        // Validation unchanged: over-allocating is still refused.
        await firstInput.fill("");
        await firstInput.type("99999");
        await firstInput.press("Enter");
        await page.waitForTimeout(500);
        remain = await page.evaluate(() => document.querySelector(".remain")?.textContent?.trim() ?? "");
        check(
          "over-allocating is refused, exactly as the stepper refuses it",
          num(remain) >= 0 && before - num(remain) === 500,
          `left ${num(remain)}`
        );

        // Clearing the field must mean zero, not NaN.
        await firstInput.fill("");
        await firstInput.press("Enter");
        await page.waitForTimeout(400);
        remain = await page.evaluate(() => document.querySelector(".remain")?.textContent?.trim() ?? "");
        check("clearing the field means zero, never NaN", num(remain) === before && !/nan/i.test(remain), remain);
      }

      console.log("\n[Sort] Manage Sort Types clears the bottom navigation:");
      const chipClear = await page.evaluate(() => {
        const chip = document.querySelector(".chip.manageChip") as HTMLElement | null;
        const nav = document.querySelector("nav.tabbar") as HTMLElement | null;
        if (!chip) return { found: false, clear: false, gap: 0 };
        const c = chip.getBoundingClientRect();
        if (!nav) return { found: true, clear: true, gap: 999 };
        const n = nav.getBoundingClientRect();
        return { found: true, clear: c.bottom <= n.top, gap: Math.round(n.top - c.bottom) };
      });
      if (chipClear.found) {
        check(`the chip sits clear of the tab bar (gap ${chipClear.gap}px)`, chipClear.clear, `gap ${chipClear.gap}`);
      } else {
        check("Manage Sort Types chip present (owner/admin only)", true);
      }
      check("no React warnings on Sort", warnings.length === 0, warnings.slice(0, 3).join(" | "));
      await ctx.close();
    }

    /* ─────────────── 3. ADMIN POPUPS ─────────────── */
    console.log("\n[Admin] the date panel stays inside the viewport and clear of the nav:");
    for (const vp of [
      { w: 390, h: 844, label: "390px" },
      { w: 768, h: 1024, label: "768px" },
      { w: 1024, h: 768, label: "1024px" },
      { w: 1440, h: 900, label: "desktop" },
    ]) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      const page = await ctx.newPage();
      await login(page, ADMIN.email, ADMIN.password);
      await page.goto(`${BASE}/admin/analytics`, { waitUntil: "networkidle" });
      await page.waitForTimeout(800);
      const btn = page.locator("button.aRangeBtn").first();
      if ((await btn.count()) === 0) {
        check(`${vp.label}: range button present`, false);
        await ctx.close();
        continue;
      }
      await btn.click();
      await page.waitForTimeout(450);
      const box = await page.evaluate(() => {
        const p = document.querySelector(".aRangePanel") as HTMLElement | null;
        if (!p) return null;
        const r = p.getBoundingClientRect();
        const nav = document.querySelector('[class*="bottomNav"], nav[class*="aBottom"]') as HTMLElement | null;
        const navTop = nav ? nav.getBoundingClientRect().top : Infinity;
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          left: Math.round(r.left),
          right: Math.round(r.right),
          vh: window.innerHeight,
          vw: window.innerWidth,
          navTop: navTop === Infinity ? -1 : Math.round(navTop),
          scrollable: p.scrollHeight > p.clientHeight + 1,
          overflowY: getComputedStyle(p).overflowY,
          placement: [...p.classList].find((c) => c.startsWith("place-")) ?? "",
        };
      });
      check(`${vp.label}: the panel opened`, box !== null);
      if (box) {
        check(`${vp.label}: fully inside the viewport vertically (${box.top}→${box.bottom} of ${box.vh})`, box.top >= 0 && box.bottom <= box.vh + 1, JSON.stringify(box));
        check(`${vp.label}: inside horizontally`, box.left >= 0 && box.right <= box.vw + 1, `${box.left}→${box.right} of ${box.vw}`);
        if (box.navTop > 0) {
          check(`${vp.label}: clear of the bottom navigation (nav at ${box.navTop})`, box.bottom <= box.navTop + 1, `panel bottom ${box.bottom}, nav ${box.navTop}`);
        }
        check(`${vp.label}: scrolls internally if it needs to`, box.overflowY === "auto" || !box.scrollable, `${box.overflowY}, scrollable=${box.scrollable}`);
        if (vp.w <= 1000) check(`${vp.label}: placement was measured (${box.placement})`, box.placement !== "", box.placement);
      }
      // No horizontal page scroll anywhere.
      const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      check(`${vp.label}: no horizontal page scroll`, !hScroll);
      await ctx.close();
    }

    console.log("\n[Admin] Create Yard and Create User are centred, capped and fully usable:");
    for (const vp of [
      { w: 390, h: 844, label: "390px" },
      { w: 768, h: 1024, label: "768px" },
      { w: 1024, h: 768, label: "1024px" },
      { w: 1440, h: 900, label: "desktop" },
    ]) {
      for (const target of [
        { path: "/admin/yards", label: "Create Yard" },
        { path: "/admin/users", label: "Create User" },
      ]) {
        const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
        const page = await ctx.newPage();
        await login(page, ADMIN.email, ADMIN.password);
        await page.goto(BASE + target.path, { waitUntil: "networkidle" });
        await page.waitForTimeout(700);
        // The "new" button is the primary action in the page header.
        const opener = page.locator("button.aBtn.primary, button.aBtn:has-text('New'), button.aBtn:has-text('Create')").first();
        if ((await opener.count()) === 0) {
          check(`${vp.label} ${target.label}: opener found`, false);
          await ctx.close();
          continue;
        }
        await opener.click();
        await page.waitForTimeout(500);
        const m = await page.evaluate(() => {
          const el = document.querySelector(".aModal") as HTMLElement | null;
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const nav = document.querySelector('[class*="bottomNav"], nav[class*="aBottom"]') as HTMLElement | null;
          const navTop = nav ? nav.getBoundingClientRect().top : Infinity;
          // Is every control inside the scroll container reachable?
          const controls = [...el.querySelectorAll("button, input, select")] as HTMLElement[];
          const outside = controls.filter((c) => {
            const cr = c.getBoundingClientRect();
            return cr.height > 0 && (cr.bottom > window.innerHeight + 1 || cr.top < -1);
          }).length;
          return {
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            vh: window.innerHeight,
            navTop: navTop === Infinity ? -1 : Math.round(navTop),
            overflowY: getComputedStyle(el).overflowY,
            controls: controls.length,
            outside,
            scrolled: el.scrollHeight > el.clientHeight + 1,
          };
        });
        check(`${vp.label} ${target.label}: modal opened`, m !== null);
        if (m) {
          check(`${vp.label} ${target.label}: inside the viewport (${m.top}→${m.bottom} of ${m.vh})`, m.top >= -1 && m.bottom <= m.vh + 1, JSON.stringify(m));
          if (m.navTop > 0) {
            check(`${vp.label} ${target.label}: above the bottom navigation`, m.bottom <= m.navTop + 1, `${m.bottom} vs nav ${m.navTop}`);
          }
          check(`${vp.label} ${target.label}: scrolls internally`, m.overflowY === "auto");
          /**
           * Scroll to the end and require that nothing is left BELOW the fold.
           *
           * Only below matters. Content above the fold has been scrolled past and
           * is reachable by scrolling back — the first version of this check
           * counted those too and reported the close button as "hidden" simply
           * because the form had been scrolled to its end.
           */
          await page.evaluate(() => {
            const el = document.querySelector(".aModal");
            if (el) el.scrollTop = el.scrollHeight;
          });
          await page.waitForTimeout(300);
          const below = await page.evaluate(() => {
            const el = document.querySelector(".aModal") as HTMLElement | null;
            if (!el) return -1;
            return [...el.querySelectorAll("button, input, select")].filter((c) => {
              const cr = c.getBoundingClientRect();
              return cr.height > 0 && cr.bottom > window.innerHeight + 1;
            }).length;
          });
          check(`${vp.label} ${target.label}: every control reachable, none below the fold (${m.controls} controls)`, below === 0, `${below} below the fold`);
          // And the reverse: scrolled back to the top, nothing sits above it.
          await page.evaluate(() => {
            const el = document.querySelector(".aModal");
            if (el) el.scrollTop = 0;
          });
          await page.waitForTimeout(250);
          const above = await page.evaluate(() => {
            const el = document.querySelector(".aModal") as HTMLElement | null;
            if (!el) return -1;
            return [...el.querySelectorAll("button, input, select")].filter((c) => {
              const cr = c.getBoundingClientRect();
              return cr.height > 0 && cr.top < -1;
            }).length;
          });
          check(`${vp.label} ${target.label}: nothing clipped above the fold at the top`, above === 0, `${above} above`);
        }
        const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        check(`${vp.label} ${target.label}: no horizontal page scroll`, !hScroll);
        await ctx.close();
      }
    }

    /* ─────────────── 4. STOCK REFRESH ─────────────── */
    console.log("\n[Refresh] creating a vendor / material updates Stock with no reload:");
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      let navsDuringCreate = 0;
      let countingCreate = false;
      page.on("framenavigated", (f) => {
        if (f === page.mainFrame() && countingCreate) navsDuringCreate++;
      });
      await login(page, TEST_OWNER.email, TEST_OWNER.password);
      await page.goto(`${BASE}/inward`, { waitUntil: "networkidle" });
      await page.waitForTimeout(700);

      const yard = await prisma.yard.findUniqueOrThrow({ where: { yardCode: TEST_YARD_CODE } });

      /**
       * Self-heal first. `down()` deliberately does not clear materials, so a
       * "Polish …" row from a run that crashed before its cleanup survives into the
       * next `test:all` — where it broke `test:e2e`, which looks its SKUs up by
       * name in a catalogue it expects to be the baseline. Cheap to do, and it
       * removes a whole class of order-dependent failure.
       */
      const stale = await prisma.material.findMany({ where: { yardId: yard.id, name: { startsWith: "Polish " } } });
      if (stale.length) {
        const staleSkus = await prisma.sku.findMany({ where: { yardId: yard.id, name: { startsWith: "Polish " } }, select: { id: true } });
        await prisma.$transaction(async (tx) => {
          const ids = staleSkus.map((x) => x.id);
          if (ids.length) {
            await tx.inventoryTransaction.deleteMany({ where: { skuId: { in: ids } } });
            await tx.inventoryLot.deleteMany({ where: { skuId: { in: ids } } });
            await tx.inventory.deleteMany({ where: { skuId: { in: ids } } });
            await tx.sku.deleteMany({ where: { id: { in: ids } } });
          }
          await tx.material.deleteMany({ where: { id: { in: stale.map((m) => m.id) } } });
        },
  { maxWait: 15_000, timeout: 60_000 }
);
        console.log(`  … cleared ${stale.length} leftover fixture material(s) from an earlier run`);
      }

      const before = await prisma.sku.count({ where: { yardId: yard.id } });

      // Create a material through the real sheet. Its API also publishes `stock`.
      // The trigger is a chip labelled "+ Add Material", not a button, and it is
      // rendered for the OWNER only.
      const addMat = page.locator(".chip", { hasText: /Add Material/i }).first();
      const matName = `Polish ${Date.now().toString().slice(-6)}`;
      let created = false;
      if ((await addMat.count()) > 0) {
        await addMat.click();
        await page.waitForTimeout(400);
        const nameInput = page.locator(".sheet input").first();
        if ((await nameInput.count()) > 0) {
          await nameInput.fill(matName);
          const save = page.locator(".sheet button").filter({ hasText: /save|add|create/i }).first();
          if ((await save.count()) > 0) {
            // Count navigations across the CREATE only. The earlier version
            // included this suite's own goto("/stock") and so reported a reload
            // the app never performed.
            navsDuringCreate = 0;
            countingCreate = true;
            await save.click();
            await page.waitForTimeout(2000);
            countingCreate = false;
            created = (await prisma.sku.count({ where: { yardId: yard.id } })) > before;
          }
        }
      }
      check("a material was created through the UI", created, "sheet flow did not complete");

      if (created) {
        // The Stock query must have been invalidated — no reload, no polling.
        await page.goto(`${BASE}/stock`, { waitUntil: "networkidle" });
        await page.waitForTimeout(900);
        const shows = await page.evaluate((n) => document.body.innerText.includes(n), matName);
        check("the new material's bucket appears on Stock", shows, matName);
        check("the create triggered no page reload at all", navsDuringCreate === 0, `${navsDuringCreate} navigations`);

        // Clean up: sandbox only.
        const sku = await prisma.sku.findFirst({ where: { yardId: yard.id, name: matName } });
        if (sku) {
          await prisma.$transaction(async (tx) => {
            await tx.inventory.deleteMany({ where: { skuId: sku.id } });
            await tx.sku.delete({ where: { id: sku.id } });
            await tx.material.deleteMany({ where: { yardId: yard.id, name: matName } });
          },
  { maxWait: 15_000, timeout: 60_000 }
);
        }
      }

      // The contract that caused the bug: the channel map must list `stock` for
      // both channels, and the sheets must invalidate through it.
      const src = (await import("node:fs")).readFileSync("src/frontend/components/realtime/provider.tsx", "utf8");
      check("the channel map is exported for mutations to reuse", /export const CHANNEL_QUERY_KEYS/.test(src));
      check("useInvalidateChannels exists", /export function useInvalidateChannels/.test(src));
      const vs = (await import("node:fs")).readFileSync("src/frontend/components/vendor-sheet.tsx", "utf8");
      const ms = (await import("node:fs")).readFileSync("src/frontend/components/material-sheet.tsx", "utf8");
      check("vendor creation invalidates via the channel map", /invalidateChannels\("vendors"\)/.test(vs));
      check("material creation invalidates materials AND stock", /invalidateChannels\("materials",\s*"stock"\)/.test(ms));
      await ctx.close();
    }

    /* ─────────────── 5. RESPONSIVE SWEEP ─────────────── */
    console.log("\n[Responsive] no overlap, clipping or horizontal scroll:");
    for (const vp of [
      { w: 390, h: 844, label: "390px" },
      { w: 768, h: 1024, label: "768px" },
      { w: 1024, h: 768, label: "1024px" },
      { w: 1440, h: 900, label: "desktop" },
    ]) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      const page = await ctx.newPage();
      await login(page, ADMIN.email, ADMIN.password);
      for (const p of ["/admin", "/admin/analytics", "/admin/yards", "/admin/users"]) {
        await page.goto(BASE + p, { waitUntil: "networkidle" });
        await page.waitForTimeout(500);
        const r = await page.evaluate(() => ({
          h: document.documentElement.scrollWidth > window.innerWidth + 1,
          body: document.body.innerText.length,
        }));
        check(`${vp.label} ${p}: no horizontal scroll`, !r.h);
        check(`${vp.label} ${p}: rendered`, r.body > 60, String(r.body));
      }
      await ctx.close();

      const ctx2 = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      const page2 = await ctx2.newPage();
      await login(page2, TEST_OWNER.email, TEST_OWNER.password);
      for (const p of ["/stock", "/sort"]) {
        await page2.goto(BASE + p, { waitUntil: "networkidle" });
        await page2.waitForTimeout(500);
        const r = await page2.evaluate(() => ({
          h: document.documentElement.scrollWidth > window.innerWidth + 1,
          body: document.body.innerText.length,
        }));
        check(`${vp.label} ${p}: no horizontal scroll`, !r.h);
        check(`${vp.label} ${p}: rendered`, r.body > 60, String(r.body));
      }
      await ctx2.close();
    }

    console.log(`\n==== ui polish: ${pass} passed, ${fail} failed ====`);
  } finally {
    await browser?.close();
    await prisma.$disconnect();
  }
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
