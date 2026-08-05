/**
 * Exit gate: real-browser responsive verification.
 *
 * Every other suite in this project asserts structure — markup, payloads,
 * CSS scoping. None of them can tell you whether a table overflows at 768px or
 * whether a chart collapses on a phone, because that is a question about
 * *rendered layout*. This one drives headless Chromium and measures the real
 * thing.
 *
 * What it checks, per page × viewport:
 *   • no horizontal overflow (document AND every element)
 *   • no clipped content (scrollWidth > clientWidth on a non-scroll container)
 *   • charts actually laid out with a sane aspect ratio
 *   • touch targets and typography above legibility floors
 *   • navigation reachable without horizontal scrolling
 *   • Owner/Manager phone UI byte-identical in structure, no admin CSS applied
 *
 * Screenshots are written to `screenshots/` for the record.
 *
 * READ-ONLY: navigates and measures, never writes.
 *
 * Usage: start the app, then `npm run test:responsive`.
 */
import { chromium, type Browser, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const SHOTS = process.env.SHOT_DIR || join(process.cwd(), "screenshots");

const ADMIN = {
  email: process.env.ADMIN_EMAIL || "admin@scrapflow.in",
  password: process.env.ADMIN_PASSWORD || "ScrapFlow@2026",
};
const OWNER = { email: "test-owner@veloce.test", password: "testowner123" };
const MANAGER = { email: "test-manager@veloce.test", password: "testmanager123" };

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1024, height: 768 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const ADMIN_PAGES = ["/admin", "/admin/analytics", "/admin/yards", "/admin/users", "/admin/audit"];
const YARD_PAGES = ["/stock", "/inward", "/sort", "/sell"];

/**
 * The yard-detail tabs. Each is a different table, so each is its own layout
 * risk — checking only the default tab would leave the widest ones unmeasured.
 * Outward is the widest of all: ten columns plus an expandable detail row.
 */
const YARD_DETAIL_TABS = ["stock", "loads", "outward", "sales", "vendors", "materials", "users"] as const;

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
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 }),
    page.click('button[type="submit"]'),
  ]);
}

/** Settle: network idle plus a beat for chart geometry to lay out. */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(350);
}

type Overflow = { tag: string; cls: string; right: number; width: number };

/**
 * Find elements that extend past the viewport's right edge.
 *
 * Measured from bounding rects rather than scrollWidth, because an element can
 * overflow visually while its parent reports a clean scrollWidth (absolutely
 * positioned children, negative margins). Elements inside a legitimate
 * horizontal-scroll container are excluded — that is a deliberate pattern here.
 */
async function findOverflow(page: Page, viewportWidth: number): Promise<Overflow[]> {
  // NOTE: everything inside `page.evaluate` must avoid named inner functions.
  // tsx/esbuild compiles `const f = () => {}` with a `__name(f, "f")` helper
  // that exists in Node but NOT in the browser context, so the callback throws
  // `ReferenceError: __name is not defined`. Inline loops only.
  return page.evaluate((vw) => {
    const bad: { tag: string; cls: string; right: number; width: number }[] = [];
    document.querySelectorAll("*").forEach((el) => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || s.position === "fixed") return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      // 1px tolerance for sub-pixel rounding.
      if (r.right <= vw + 1) return;

      // Walk up looking for a deliberate horizontal-scroll container; content
      // inside one is allowed to be wider than the viewport.
      let inScroller = false;
      let p: Element | null = el.parentElement;
      while (p && p !== document.body) {
        const ps = getComputedStyle(p);
        if (ps.overflowX === "auto" || ps.overflowX === "scroll") {
          inScroller = true;
          break;
        }
        p = p.parentElement;
      }
      if (inScroller) return;

      bad.push({
        tag: el.tagName.toLowerCase(),
        cls: typeof el.className === "string" ? el.className.slice(0, 70) : "",
        right: Math.round(r.right),
        width: Math.round(r.width),
      });
    });
    return bad.slice(0, 8);
  }, viewportWidth);
}

async function docScroll(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
}

async function chartMetrics(page: Page) {
  return page.evaluate(() => {
    const svgs = [...document.querySelectorAll(".cWrap svg, .cSpark svg")];
    return svgs.map((s) => {
      const r = s.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
  });
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch();

    /* ══════════════════ ADMIN CONSOLE ══════════════════ */
    for (const vp of VIEWPORTS) {
      console.log(`\n[Admin · ${vp.name} ${vp.width}×${vp.height}]`);
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await login(page, ADMIN.email, ADMIN.password);

      for (const path of ADMIN_PAGES) {
        await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
        await settle(page);

        const name = path.replace(/\//g, "_") || "_root";
        await page.screenshot({ path: join(SHOTS, `admin${name}-${vp.name}.png`), fullPage: true });

        // --- horizontal overflow ---
        const doc = await docScroll(page);
        check(
          `${path}: document does not scroll horizontally`,
          doc.scrollWidth <= doc.clientWidth + 1,
          `scrollWidth ${doc.scrollWidth} > clientWidth ${doc.clientWidth}`
        );
        const of = await findOverflow(page, vp.width);
        check(
          `${path}: no element extends past the viewport`,
          of.length === 0,
          of.map((o) => `${o.tag}.${o.cls} right=${o.right}`).join(" | ")
        );

        // --- shell correctness ---
        const shell = await page.evaluate(() => ({
          isAdmin: document.body.dataset.shell === "admin",
          hasSide: !!document.querySelector(".aSide"),
          hasPhone: !!document.querySelector("#phoneFrame"),
        }));
        check(`${path}: admin shell active`, shell.isAdmin && shell.hasSide);
        check(`${path}: no phone frame`, !shell.hasPhone);

        // --- navigation reachable ---
        // Which nav is live depends on the viewport: the sidebar list on
        // desktop, the fixed bottom bar below 1000px. Asserting against
        // `.aNav` unconditionally would fail the moment the bottom bar took
        // over, for a reason that is a design decision rather than a defect —
        // so the suite asks the page which one is showing and holds THAT to the
        // same three properties.
        const nav = await page.evaluate(() => {
          // NOTE: no named arrow consts in here — tsx/esbuild wraps them with a
          // `__name()` helper that does not exist in the browser context. This
          // file's header documents the trap; it bit again while adding the
          // bottom-bar branch. Inline only.
          let navEl: Element | null = document.querySelector(".aTabbar");
          if (navEl && getComputedStyle(navEl).display === "none") navEl = null;
          if (!navEl) {
            navEl = document.querySelector(".aNav");
            if (navEl && getComputedStyle(navEl).display === "none") navEl = null;
          }
          if (!navEl) return null;
          const links = [...navEl.querySelectorAll("a, button")];
          if (links.length === 0) return null;
          const rects = links.map((l) => l.getBoundingClientRect());
          const navRect = navEl.getBoundingClientRect();
          const navStyle = getComputedStyle(navEl);
          return {
            kind: navEl.className,
            count: links.length,
            allVisible: rects.every((r) => r.width > 0 && r.height > 0),
            minHeight: Math.min(...rects.map((r) => r.height)),
            navScrollable: navStyle.overflowX === "auto" || navStyle.overflowX === "scroll",
            navOverflows: navEl.scrollWidth > navRect.width + 1,
          };
        });
        if (nav) {
          check(`${path}: all ${nav.count} nav links render (${nav.kind})`, nav.allVisible);
          check(`${path}: nav touch targets ≥ 28px tall`, nav.minHeight >= 28, `min ${nav.minHeight}px`);
          check(
            `${path}: nav is reachable (fits, or scrolls on purpose)`,
            !nav.navOverflows || nav.navScrollable,
            `overflows=${nav.navOverflows} scrollable=${nav.navScrollable}`
          );
          // Below 1000px the bottom bar must be the one in play, and every
          // destination must still be reachable — four tabs plus More.
          if (vp.width <= 1000) {
            check(`${path}: admin uses the bottom bar below 1000px`, nav.kind.includes("aTabbar"), nav.kind);
            check(`${path}: bottom bar has 4 tabs + More`, nav.count === 5, `${nav.count}`);
          } else {
            check(`${path}: admin uses the sidebar nav above 1000px`, nav.kind.includes("aNav"), nav.kind);
          }
        }

        // --- tables wrapped, never widening the page ---
        const tables = await page.evaluate(() => {
          const out: { wrapped: boolean; overflowsPage: boolean }[] = [];
          document.querySelectorAll("table.aTable").forEach((t) => {
            const wrap = t.closest(".aTableWrap");
            const wrapStyle = wrap ? getComputedStyle(wrap) : null;
            out.push({
              wrapped: !!wrap && (wrapStyle!.overflowX === "auto" || wrapStyle!.overflowX === "scroll"),
              overflowsPage: t.getBoundingClientRect().right > document.documentElement.clientWidth + 1,
            });
          });
          return out;
        });
        check(
          `${path}: all ${tables.length} table(s) inside a scroll container`,
          tables.every((t) => t.wrapped),
          `${tables.filter((t) => !t.wrapped).length} unwrapped`
        );

        // --- typography floor ---
        const type = await page.evaluate(() => {
          const sizes: number[] = [];
          document.querySelectorAll("p, td, th, span, div, b, a, button, label").forEach((el) => {
            if (!el.textContent?.trim()) return;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return;
            const fs = parseFloat(getComputedStyle(el).fontSize);
            if (Number.isFinite(fs)) sizes.push(fs);
          });
          return { min: sizes.length ? Math.min(...sizes) : 99, count: sizes.length };
        });
        check(`${path}: smallest rendered text ≥ 9px`, type.min >= 9, `${type.min}px`);

        // --- card alignment: cards in a row share a left edge / width ---
        const align = await page.evaluate(() => {
          const kpis = [...document.querySelectorAll(".aKpi")].map((e) => e.getBoundingClientRect());
          if (kpis.length < 2) return { ok: true, note: "fewer than 2 KPIs" };
          // Group by row (same top within 2px), then every card in a row must
          // share a width — a ragged row is a broken grid.
          const rows = new Map<number, DOMRect[]>();
          kpis.forEach((r) => {
            const key = Math.round(r.top / 2) * 2;
            rows.set(key, [...(rows.get(key) ?? []), r]);
          });
          for (const [, group] of rows) {
            if (group.length < 2) continue;
            const w = group.map((g) => Math.round(g.width));
            if (Math.max(...w) - Math.min(...w) > 2) return { ok: false, note: `widths ${w.join(",")}` };
          }
          return { ok: true, note: "" };
        });
        check(`${path}: KPI cards in a row share a width`, align.ok, align.note);
      }

      // --- charts on the analytics page ---
      await page.goto(BASE + "/admin/analytics", { waitUntil: "domcontentloaded" });
      await settle(page);
      const charts = await chartMetrics(page);
      check(`analytics: charts rendered (${charts.length} svg)`, charts.length > 0);
      check(
        `analytics: every chart has positive size`,
        charts.every((c) => c.w > 0 && c.h > 0),
        JSON.stringify(charts.slice(0, 3))
      );
      check(
        `analytics: no chart exceeds the viewport width`,
        charts.every((c) => c.w <= vp.width),
        JSON.stringify(charts.filter((c) => c.w > vp.width).slice(0, 3))
      );
      check(
        `analytics: charts are tall enough to read (≥ 90px)`,
        charts.every((c) => c.h >= 90),
        JSON.stringify(charts.filter((c) => c.h < 90).slice(0, 3))
      );

      // Exercise the section tabs so every chart type is laid out at least once.
      for (const label of ["Yard comparison", "Materials", "Vendors", "Dispatch"]) {
        const tab = page.locator(`.aSubNav button:has-text("${label}")`).first();
        if ((await tab.count()) > 0) {
          await tab.click();
          await page.waitForTimeout(300);
          const doc2 = await docScroll(page);
          check(
            `analytics/${label}: no horizontal scroll`,
            doc2.scrollWidth <= doc2.clientWidth + 1,
            `${doc2.scrollWidth} > ${doc2.clientWidth}`
          );
          const of2 = await findOverflow(page, vp.width);
          check(
            `analytics/${label}: nothing past the viewport`,
            of2.length === 0,
            of2.map((o) => `${o.tag}.${o.cls}`).join(" | ")
          );
          await page.screenshot({
            path: join(SHOTS, `admin_analytics-${label.split(" ")[0].toLowerCase()}-${vp.name}.png`),
            fullPage: true,
          });
        }
      }

      /* ---------- yard detail: the widest tables in the console ---------- */
      // Resolved through the authenticated page so no database access is needed.
      // The sandbox yard is preferred: it carries the most rows, which is what
      // actually stresses a table. Read-only throughout — this only navigates.
      const yardId: string | null = await page.evaluate(async () => {
        const r = await fetch("/api/admin/yards");
        if (!r.ok) return null;
        const d = await r.json();
        const list: { id: string; yardCode: string }[] = d.yards ?? [];
        const sandbox = list.find((y) => y.yardCode === "SFTEST01");
        return (sandbox ?? list[0])?.id ?? null;
      });

      check(`yard detail: a yard is resolvable`, !!yardId, "no yards returned");

      if (yardId) {
        const detailPath = `/admin/yards/${yardId}`;
        await page.goto(BASE + detailPath, { waitUntil: "domcontentloaded" });
        await settle(page);

        const dDoc = await docScroll(page);
        check(
          `yard detail: document does not scroll horizontally`,
          dDoc.scrollWidth <= dDoc.clientWidth + 1,
          `scrollWidth ${dDoc.scrollWidth} > clientWidth ${dDoc.clientWidth}`
        );
        const dOf = await findOverflow(page, vp.width);
        check(
          `yard detail: no element extends past the viewport`,
          dOf.length === 0,
          dOf.map((o) => `${o.tag}.${o.cls} right=${o.right}`).join(" | ")
        );

        const dShell = await page.evaluate(() => ({
          isAdmin: document.body.dataset.shell === "admin",
          hasSide: !!document.querySelector(".aSide"),
          hasPhone: !!document.querySelector("#phoneFrame"),
        }));
        check(`yard detail: admin shell active`, dShell.isAdmin && dShell.hasSide);
        check(`yard detail: no phone frame leaked in`, !dShell.hasPhone);

        // Every tab, because each one is a different table.
        for (const tabKey of YARD_DETAIL_TABS) {
          const label =
            tabKey === "loads" ? "Inward" : tabKey.charAt(0).toUpperCase() + tabKey.slice(1);
          const tab = page.locator(`.aSubNav button:has-text("${label}")`).first();
          if ((await tab.count()) === 0) {
            check(`yard detail/${label}: tab is present`, false, "tab not found");
            continue;
          }
          await tab.click();
          await page.waitForTimeout(250);

          const tDoc = await docScroll(page);
          check(
            `yard detail/${label}: no horizontal scroll`,
            tDoc.scrollWidth <= tDoc.clientWidth + 1,
            `${tDoc.scrollWidth} > ${tDoc.clientWidth}`
          );
          const tOf = await findOverflow(page, vp.width);
          check(
            `yard detail/${label}: nothing past the viewport`,
            tOf.length === 0,
            tOf.map((o) => `${o.tag}.${o.cls}`).join(" | ")
          );

          // A wide table must live in a scroll container rather than being
          // clipped: losing the right-hand columns loses the data.
          const tables = await page.evaluate(() => {
            const out: { cols: number; clipped: boolean; inScroller: boolean }[] = [];
            document.querySelectorAll("table.aTable").forEach((t) => {
              const head = t.querySelector("thead tr");
              const r = t.getBoundingClientRect();
              let p: Element | null = t.parentElement;
              let inScroller = false;
              while (p && p !== document.body) {
                const ox = getComputedStyle(p).overflowX;
                if (ox === "auto" || ox === "scroll") {
                  inScroller = true;
                  break;
                }
                p = p.parentElement;
              }
              out.push({
                cols: head ? head.children.length : 0,
                clipped: t.scrollWidth > Math.ceil(r.width) + 1,
                inScroller,
              });
            });
            return out;
          });
          check(
            `yard detail/${label}: every table is in a scroll container`,
            tables.every((t) => t.inScroller),
            `${tables.filter((t) => !t.inScroller).length} unscrollable`
          );
          check(
            `yard detail/${label}: no table is clipped outside a scroller`,
            tables.every((t) => t.inScroller || !t.clipped)
          );

          // Row actions have to stay tappable on a phone.
          const btns = await page.evaluate(() => {
            const rects = [...document.querySelectorAll("table.aTable .actions button")].map((b) =>
              b.getBoundingClientRect()
            );
            return {
              count: rects.length,
              minH: rects.length ? Math.min(...rects.map((r) => r.height)) : 99,
              allVisible: rects.every((r) => r.width > 0 && r.height > 0),
            };
          });
          if (btns.count > 0) {
            check(`yard detail/${label}: ${btns.count} row actions render`, btns.allVisible);
            check(`yard detail/${label}: row actions ≥ 24px tall`, btns.minH >= 24, `min ${btns.minH}px`);
          }

          await page.screenshot({
            path: join(SHOTS, `admin_yard_${tabKey}-${vp.name}.png`),
            fullPage: true,
          });
        }

        // The Outward tab's expandable detail row is the deepest nesting on the
        // page — a table inside a table cell — so it gets measured expanded too.
        const outwardTab = page.locator('.aSubNav button:has-text("Outward")').first();
        if ((await outwardTab.count()) > 0) {
          await outwardTab.click();
          await page.waitForTimeout(200);
          const detailBtn = page.locator('table.aTable .actions button:has-text("Detail")').first();
          if ((await detailBtn.count()) > 0) {
            await detailBtn.click();
            await page.waitForTimeout(300);
            const eDoc = await docScroll(page);
            check(
              `yard detail/Outward expanded: no horizontal scroll`,
              eDoc.scrollWidth <= eDoc.clientWidth + 1,
              `${eDoc.scrollWidth} > ${eDoc.clientWidth}`
            );
            const eOf = await findOverflow(page, vp.width);
            check(
              `yard detail/Outward expanded: nothing past the viewport`,
              eOf.length === 0,
              eOf.map((o) => `${o.tag}.${o.cls}`).join(" | ")
            );
            const nested = await page.evaluate(() => document.querySelectorAll("table.aTable table.aTable").length);
            check(`yard detail/Outward expanded: nested detail tables render`, nested > 0, `${nested} found`);
            await page.screenshot({
              path: join(SHOTS, `admin_yard_outward_expanded-${vp.name}.png`),
              fullPage: true,
            });
          }
        }
      }

      await ctx.close();
    }

    /* ══════════════════ OWNER / MANAGER PHONE UI ══════════════════ */
    for (const vp of VIEWPORTS) {
      console.log(`\n[Owner · ${vp.name} ${vp.width}×${vp.height}]`);
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await login(page, OWNER.email, OWNER.password);

      for (const path of YARD_PAGES) {
        await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
        await settle(page);
        await page.screenshot({ path: join(SHOTS, `owner${path.replace(/\//g, "_")}-${vp.name}.png`), fullPage: true });

        const doc = await docScroll(page);
        check(
          `${path}: document does not scroll horizontally`,
          doc.scrollWidth <= doc.clientWidth + 1,
          `${doc.scrollWidth} > ${doc.clientWidth}`
        );

        const phone = await page.evaluate(() => {
          const frame = document.querySelector("#phoneFrame");
          const r = frame?.getBoundingClientRect();
          const body = getComputedStyle(document.body);
          return {
            hasFrame: !!frame,
            shell: document.body.dataset.shell ?? null,
            display: body.display,
            frameWidth: r ? Math.round(r.width) : 0,
            frameRight: r ? Math.round(r.right) : 0,
            hasTabbar: !!document.querySelector(".tabbar"),
            hasAdminCss: !!document.querySelector(".aShell, .aSide, .cWrap"),
            tabCount: document.querySelectorAll(".tabbar a").length,
          };
        });

        check(`${path}: phone frame present`, phone.hasFrame);
        check(`${path}: body has NO admin shell attribute`, phone.shell === null, String(phone.shell));
        check(`${path}: body is still flex-centred (admin CSS not applied)`, phone.display === "flex", phone.display);
        check(`${path}: no admin markup`, !phone.hasAdminCss);
        check(`${path}: tab bar present`, phone.hasTabbar);
        check(
          `${path}: phone frame fits the viewport`,
          phone.frameRight <= vp.width + 1,
          `right ${phone.frameRight} vs ${vp.width}`
        );
        // The Owner keeps the prototype's four tabs; dispatch state is shown on
        // the Sell page rather than as a fifth tab.
        check(`${path}: owner sees 4 tabs`, phone.tabCount === 4, `got ${phone.tabCount}`);
      }
      await ctx.close();
    }

    // Manager: one representative viewport per breakpoint class is enough, the
    // difference from Owner is the tab count, not the layout.
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await login(page, MANAGER.email, MANAGER.password);
      await page.goto(BASE + "/stock", { waitUntil: "domcontentloaded" });
      await settle(page);
      await page.screenshot({ path: join(SHOTS, `manager_stock-${vp.name}.png`), fullPage: true });

      const m = await page.evaluate(() => ({
        shell: document.body.dataset.shell ?? null,
        tabCount: document.querySelectorAll(".tabbar a").length,
        labels: [...document.querySelectorAll(".tabbar a")].map((a) => a.textContent?.trim() ?? ""),
        hasFrame: !!document.querySelector("#phoneFrame"),
      }));
      const doc = await docScroll(page);
      console.log(`\n[Manager · ${vp.name}]`);
      check(`manager /stock: no horizontal scroll`, doc.scrollWidth <= doc.clientWidth + 1, `${doc.scrollWidth} > ${doc.clientWidth}`);
      check(`manager /stock: phone frame present`, m.hasFrame);
      check(`manager /stock: no admin shell`, m.shell === null);
      // Phase 4 gave the Manager an OUTWARD tab: STOCK, INWARD, SORT, OUTWARD.
      // SELL stays absent — selling is the Owner's job, dispatching is theirs.
      check(`manager /stock: exactly 4 tabs (no SELL)`, m.tabCount === 4, `got ${m.tabCount}: ${m.labels.join(",")}`);
      check(`manager /stock: SELL absent`, !m.labels.some((l) => l.includes("SELL")), m.labels.join(","));
      check(`manager /stock: OUTWARD present`, m.labels.some((l) => l.includes("OUTWARD")), m.labels.join(","));
      await ctx.close();
    }
  } finally {
    await browser?.close();
  }

  console.log(`\nScreenshots → ${SHOTS}`);
  console.log(`\n==== responsive: ${pass} passed, ${fail} failed ====`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
