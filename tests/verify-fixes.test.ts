/**
 * Behavioural verification of the fix & optimisation session.
 *
 * Every other suite asserts structure or payloads. This one drives a real
 * browser and asserts what a user actually gets: that clicking Weekly on one
 * chart leaves the others alone, that the yard dropdown is readable, that the
 * More sheet opens, that the favicon resolves. Passing TypeScript, passing unit
 * tests and "the code exists" are all explicitly NOT evidence here.
 *
 * READ-ONLY with respect to yard data. It navigates, clicks and measures; the
 * only write is a Sort unit selection, which never leaves the browser.
 *
 * Usage: app running on :3001, then `npx tsx tests/verify-fixes.test.ts`
 */
import { chromium, type Browser, type Page } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const ADMIN = { email: "admin@scrapflow.in", password: "ScrapFlow@2026" };
const OWNER = { email: "owner@veloce.in", password: "owner123" };
const MANAGER = { email: "manager@veloce.in", password: "manager123" };

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
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 25_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(400);
}

/** Collects console errors and React key warnings for the life of a page. */
function watchConsole(page: Page) {
  const messages: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") messages.push(m.text());
  });
  page.on("pageerror", (e) => messages.push(`pageerror: ${e.message}`));
  return messages;
}

async function main() {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();

    /* ══════════════ 1. ADMIN ICONS + NAVIGATION ══════════════ */
    console.log("\n[1] Admin icons and navigation");
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      const logs = watchConsole(page);
      await login(page, ADMIN.email, ADMIN.password);
      await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
      await settle(page);

      const icons = await page.evaluate(() => {
        const links = [...document.querySelectorAll(".aNav a")];
        const svgs = links.map((l) => l.querySelector(".aIco svg"));
        const strokes = svgs.map((s) => (s ? getComputedStyle(s).strokeWidth : ""));
        const sizes = svgs.map((s) => (s ? `${(s as SVGElement).getAttribute("width")}` : ""));
        return {
          linkCount: links.length,
          allSvg: svgs.every((s) => !!s),
          // Emoji would leave a text node in .aIco; line icons must not.
          anyEmojiText: links.some((l) => (l.querySelector(".aIco")?.textContent ?? "").trim().length > 0),
          uniqueStrokes: [...new Set(strokes)],
          uniqueSizes: [...new Set(sizes)],
          activeIconColor: getComputedStyle(document.querySelector(".aNav a.on .aIco")!).color,
        };
      });
      check(`admin sidebar renders ${icons.linkCount} links`, icons.linkCount === 5, String(icons.linkCount));
      check("every admin nav icon is an inline SVG, not an emoji", icons.allSvg && !icons.anyEmojiText);
      check("one consistent stroke width", icons.uniqueStrokes.length === 1, icons.uniqueStrokes.join("|"));
      check("one consistent icon size", icons.uniqueSizes.length === 1, icons.uniqueSizes.join("|"));
      check("the active icon takes the theme colour", icons.activeIconColor !== "rgb(0, 0, 0)", icons.activeIconColor);

      // Desktop must NOT show the mobile bar.
      const desktopBar = await page.evaluate(() => {
        const el = document.querySelector(".aTabbar");
        return el ? getComputedStyle(el).display : "absent";
      });
      check("desktop shows no bottom bar", desktopBar === "none", desktopBar);

      const sidebarVisible = await page.evaluate(() => {
        const el = document.querySelector(".aNav");
        return !!el && getComputedStyle(el).display !== "none";
      });
      check("desktop still uses the sidebar nav", sidebarVisible);
      check("no console errors on the admin dashboard", logs.length === 0, logs.slice(0, 3).join(" | "));
      await ctx.close();
    }

    /* ══════════════ 1b. TABLET + MOBILE BOTTOM NAV AND "MORE" ══════════════ */
    for (const vp of [
      { name: "tablet", width: 768, height: 1024 },
      { name: "mobile", width: 390, height: 844 },
    ]) {
      console.log(`\n[1b] Admin bottom navigation · ${vp.name} ${vp.width}px`);
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await login(page, ADMIN.email, ADMIN.password);
      await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
      await settle(page);

      const bar = await page.evaluate(() => {
        const el = document.querySelector(".aTabbar");
        if (!el) return null;
        const s = getComputedStyle(el);
        const items = [...el.querySelectorAll("a, button")];
        const r = el.getBoundingClientRect();
        return {
          display: s.display,
          position: s.position,
          bottom: Math.round(r.bottom),
          viewportH: window.innerHeight,
          labels: items.map((i) => i.textContent?.trim() ?? ""),
          count: items.length,
          sidebarNavHidden: getComputedStyle(document.querySelector(".aNav")!).display === "none",
        };
      });
      check(`${vp.name}: bottom bar is rendered`, !!bar);
      if (bar) {
        check(`${vp.name}: bar is fixed to the bottom`, bar.position === "fixed" && Math.abs(bar.bottom - bar.viewportH) <= 2, `${bar.bottom} vs ${bar.viewportH}`);
        check(`${vp.name}: 4 primary tabs + More`, bar.count === 5, bar.labels.join(","));
        check(`${vp.name}: More is the last item`, bar.labels[4] === "More", bar.labels[4]);
        check(`${vp.name}: Audit Log is NOT on the bar`, !bar.labels.some((l) => /audit/i.test(l)), bar.labels.join(","));
        check(`${vp.name}: sidebar nav is hidden`, bar.sidebarNavHidden);
      }

      // The More sheet must open, contain Audit Log, and navigate.
      await page.click(".aTabMore");
      await page.waitForTimeout(250);
      const sheet = await page.evaluate(() => {
        const el = document.querySelector(".aMoreSheet");
        if (!el) return null;
        const items = [...el.querySelectorAll(".aMoreItem")];
        return { items: items.map((i) => i.textContent?.trim() ?? ""), visible: el.getBoundingClientRect().height > 0 };
      });
      check(`${vp.name}: More sheet opens`, !!sheet && sheet.visible);
      check(`${vp.name}: More sheet holds Audit Log`, !!sheet?.items.some((i) => /audit/i.test(i)), sheet?.items.join(","));
      check(`${vp.name}: More sheet holds Sign out`, !!sheet?.items.some((i) => /sign out/i.test(i)), sheet?.items.join(","));

      // Escape closes it.
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      const closed = await page.evaluate(() => !document.querySelector(".aMoreSheet"));
      check(`${vp.name}: Escape closes the More sheet`, closed);

      // And it actually navigates.
      await page.click(".aTabMore");
      await page.waitForTimeout(200);
      await Promise.all([page.waitForURL(/\/admin\/audit/, { timeout: 15_000 }), page.click('.aMoreItem:has-text("Audit")')]);
      await settle(page);
      const afterNav = await page.evaluate(() => ({
        url: location.pathname,
        sheetGone: !document.querySelector(".aMoreSheet"),
        moreActive: !!document.querySelector(".aTabMore.on"),
      }));
      check(`${vp.name}: More → Audit Log navigates`, afterNav.url === "/admin/audit", afterNav.url);
      check(`${vp.name}: the sheet closes after navigating`, afterNav.sheetGone);
      check(`${vp.name}: More stays highlighted for its section`, afterNav.moreActive);

      // A primary tab navigates too.
      await Promise.all([page.waitForURL(/\/admin\/yards/, { timeout: 15_000 }), page.click('.aTabbar a:has-text("Yards")')]);
      check(`${vp.name}: a primary tab navigates`, page.url().includes("/admin/yards"));
      await ctx.close();
    }

    /* ══════════════ 1c. OWNER / MANAGER UNCHANGED ══════════════ */
    console.log("\n[1c] Owner and Manager icons unchanged");
    for (const [role, creds] of [["owner", OWNER], ["manager", MANAGER]] as const) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      await login(page, creds.email, creds.password);
      await settle(page);
      const tabs = await page.evaluate(() => {
        const bar = document.querySelector(".tabbar");
        if (!bar) return null;
        const links = [...bar.querySelectorAll("a")];
        return {
          count: links.length,
          // The yard app keeps EMOJI: .ico must hold text, not an <svg>.
          allEmoji: links.every((l) => {
            const ico = l.querySelector(".ico");
            return !!ico && (ico.textContent ?? "").trim().length > 0 && !ico.querySelector("svg");
          }),
          labels: links.map((l) => l.textContent?.replace(/\s+/g, " ").trim() ?? ""),
          adminCss: !!document.querySelector(".aTabbar, .aShell"),
        };
      });
      check(`${role}: yard tab bar present`, !!tabs);
      check(`${role}: icons are still emoji, not the admin SVG set`, !!tabs?.allEmoji, tabs?.labels.join(","));
      check(`${role}: no admin chrome leaked in`, tabs?.adminCss === false);
      await ctx.close();
    }

    /* ══════════════ 2. FAVICON ══════════════ */
    console.log("\n[2] Favicon");
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
      const links = await page.evaluate(() =>
        [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="shortcut icon"]')].map((l) => ({
          rel: l.getAttribute("rel"),
          href: l.getAttribute("href"),
        }))
      );
      check("the document declares an icon", links.length > 0, JSON.stringify(links));
      check("it points at this project's own icon.svg", links.some((l) => (l.href ?? "").includes("/icon.svg")), JSON.stringify(links));
      check("no link falls back to /favicon.ico", !links.some((l) => (l.href ?? "").includes("favicon.ico")), JSON.stringify(links));

      // Anonymous fetch — the browser requests the favicon without a session.
      const anon = await ctx.request.get(`${BASE}/icon.svg`);
      check("icon.svg is served anonymously (no auth redirect)", anon.status() === 200, String(anon.status()));
      const body = await anon.text();
      check("icon.svg is the Veloce chevron mark", body.includes("<svg") && body.includes("#2E8B4F"), body.slice(0, 60));
      // Apple touch icons must be raster; this one is served from public/.
      const apple = await ctx.request.get(`${BASE}/apple-touch-icon.png`);
      check("apple-touch-icon.png is served anonymously", apple.status() === 200, String(apple.status()));
      check("it is a real PNG", (apple.headers()["content-type"] ?? "").includes("image/png"), apple.headers()["content-type"] ?? "");
      const appleLink = links.find((l) => l.rel === "apple-touch-icon");
      check("an apple-touch-icon is declared", !!appleLink, JSON.stringify(links));
      if (appleLink) {
        const resolved = await ctx.request.get(new URL(appleLink.href!, BASE).toString());
        check("the DECLARED apple-touch-icon URL actually resolves", resolved.status() === 200, `${appleLink.href} → ${resolved.status()}`);
      }
      // Every declared icon must resolve — the whole point of this section.
      for (const l of links) {
        const r = await ctx.request.get(new URL(l.href!, BASE).toString());
        check(`declared ${l.rel} resolves (${l.href})`, r.status() === 200, String(r.status()));
      }

      // No /favicon.ico in this project — that is what stops the host-level
      // fallback bleeding into another localhost project.
      const ico = await ctx.request.get(`${BASE}/favicon.ico`);
      check("this project serves NO /favicon.ico (host-level fallback not claimed)", ico.status() === 404, String(ico.status()));
      await ctx.close();
    }

    /* ══════════════ 3. ANALYTICS ══════════════ */
    console.log("\n[3] Analytics");
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      const logs = watchConsole(page);
      await login(page, ADMIN.email, ADMIN.password);
      await page.goto(`${BASE}/admin/analytics`, { waitUntil: "domcontentloaded" });
      await settle(page);

      // Independent granularity: read every card's active button, change ONE.
      // Cards are indexed by POSITION, not by title text: the title element
      // varies between card types and came back empty, which made every card
      // look like the same one and defeated the comparison.
      const readGrans = () =>
        page.evaluate(() => {
          const out: { idx: number; title: string; gran: string }[] = [];
          const cards = [...document.querySelectorAll(".aCard")];
          for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            const btns = [...card.querySelectorAll(".aBtn.sm")];
            const hasGranControl = btns.some((b) => (b.textContent ?? "").trim() === "Daily");
            if (!hasGranControl) continue;
            const active = btns.find((b) => b.classList.contains("primary"));
            if (!active) continue;
            const heading = card.querySelector(".aCardTitle, .cTitle, h3, h4");
            out.push({
              idx: i,
              title: (heading?.textContent ?? "").trim() || `card#${i}`,
              gran: (active.textContent ?? "").trim(),
            });
          }
          return out;
        });

      const before = await readGrans();
      check("more than one chart exposes a granularity control", before.length >= 2, JSON.stringify(before));

      // Click "Weekly" on the FIRST chart that has one.
      const clickedIdx = await page.evaluate(() => {
        const cards = [...document.querySelectorAll(".aCard")];
        for (let i = 0; i < cards.length; i++) {
          const btns = [...cards[i].querySelectorAll(".aBtn.sm")];
          const weekly = btns.find((b) => (b.textContent ?? "").trim() === "Weekly");
          const daily = btns.find((b) => (b.textContent ?? "").trim() === "Daily");
          if (weekly && daily) {
            (weekly as HTMLButtonElement).click();
            return i;
          }
        }
        return -1;
      });
      await page.waitForTimeout(600);
      const after = await readGrans();
      check(
        "clicking Weekly on one chart is registered",
        clickedIdx >= 0 && after.find((c) => c.idx === clickedIdx)?.gran === "Weekly",
        `card#${clickedIdx}: ${JSON.stringify(after)}`
      );

      const others = after.filter((c) => c.idx !== clickedIdx);
      const othersUnchanged =
        others.length > 0 &&
        others.every((c) => {
          const was = before.find((b) => b.idx === c.idx);
          return was && was.gran === c.gran;
        });
      check("EVERY other chart keeps its own granularity", othersUnchanged, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

      // Yard dropdown contrast.
      const sel = await page.evaluate(() => {
        const s = document.querySelector(".aHeadActions select");
        if (!s) return null;
        const cs = getComputedStyle(s);
        const opt = s.querySelector("option");
        const os = opt ? getComputedStyle(opt) : null;
        // Rough luminance so "white on white" is measurable, not a matter of
        // opinion. Computed inline — a named arrow const inside page.evaluate
        // makes esbuild emit a `__name` helper that does not exist in the
        // browser, which is a trap this repo has hit three times now.
        const mb = cs.backgroundColor.match(/\d+(\.\d+)?/g) ?? [];
        const mf = cs.color.match(/\d+(\.\d+)?/g) ?? [];
        const bgLum = mb.length >= 3 ? 0.2126 * Number(mb[0]) + 0.7152 * Number(mb[1]) + 0.0722 * Number(mb[2]) : -1;
        const fgLum = mf.length >= 3 ? 0.2126 * Number(mf[0]) + 0.7152 * Number(mf[1]) + 0.0722 * Number(mf[2]) : -1;
        return {
          bg: cs.backgroundColor,
          fg: cs.color,
          bgLum,
          fgLum,
          colorScheme: cs.colorScheme,
          optBg: os?.backgroundColor ?? "",
          optFg: os?.color ?? "",
        };
      });
      check("the yard filter exists in the page header", !!sel);
      if (sel) {
        check("yard filter is not white-on-white", Math.abs(sel.fgLum - sel.bgLum) > 60, `bg ${sel.bg} (${sel.bgLum.toFixed(0)}) / fg ${sel.fg} (${sel.fgLum.toFixed(0)})`);
        check("yard filter uses a dark background", sel.bgLum < 90, `${sel.bg}`);
        check("native controls render dark", sel.colorScheme.includes("dark"), sel.colorScheme);
        check("the open option list is themed too", sel.optBg !== "" && sel.optBg !== "rgba(0, 0, 0, 0)", `${sel.optBg} / ${sel.optFg}`);
      }

      // Date range picker.
      const noPresetButtons = await page.evaluate(() =>
        ![...document.querySelectorAll(".aHeadActions .aBtn")].some((b) => /^(7d|30d|90d)$/i.test(b.textContent?.trim() ?? ""))
      );
      check("7D / 30D / 90D buttons are gone", noPresetButtons);
      check("a date range control is present", (await page.locator(".aRangeBtn").count()) === 1);

      await page.click(".aRangeBtn");
      await page.waitForTimeout(250);
      const panel = await page.evaluate(() => {
        const p = document.querySelector(".aRangePanel");
        if (!p) return null;
        return {
          tabs: [...p.querySelectorAll(".aRangeTabs button")].map((b) => b.textContent?.trim() ?? ""),
          presets: [...p.querySelectorAll(".aRangeList button")].map((b) => b.textContent?.trim() ?? ""),
        };
      });
      check("the picker opens", !!panel);
      check("it offers Quick / Day / Month / Year / Custom", JSON.stringify(panel?.tabs) === JSON.stringify(["Quick", "Day", "Month", "Year", "Custom"]), JSON.stringify(panel?.tabs));
      check("quick presets include Today and a month", !!panel?.presets.includes("Today") && panel.presets.length >= 6, JSON.stringify(panel?.presets));

      // Apply "Today" and confirm the request actually carried from/to.
      const reqUrls: string[] = [];
      page.on("request", (r) => {
        if (r.url().includes("/api/admin/analytics")) reqUrls.push(r.url());
      });
      await page.click('.aRangeList button:has-text("Today")');
      await page.waitForTimeout(1200);
      check("selecting a range refetches with from/to", reqUrls.some((u) => u.includes("from=") && u.includes("to=")), reqUrls.slice(-2).join(" | "));
      const subtitle = await page.evaluate(() => document.querySelector(".aSub")?.textContent ?? "");
      check("the header reflects the chosen range", /Today|\d{4}/.test(subtitle), subtitle);

      // Custom range still works.
      await page.click(".aRangeBtn");
      await page.waitForTimeout(200);
      await page.click('.aRangeTabs button:has-text("Custom")');
      await page.waitForTimeout(150);
      const customInputs = await page.locator(".aRangeForm input[type=date]").count();
      check("custom mode offers From and To", customInputs === 2, String(customInputs));
      await page.keyboard.press("Escape");

      check("no console errors on analytics", logs.filter((l) => !/favicon/i.test(l)).length === 0, logs.slice(0, 3).join(" | "));
      await ctx.close();
    }

    /* ══════════════ 3b. ANALYTICS ON TABLET / MOBILE ══════════════ */
    for (const vp of [
      { name: "tablet", width: 768, height: 1024 },
      { name: "mobile", width: 390, height: 844 },
    ]) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await login(page, ADMIN.email, ADMIN.password);
      await page.goto(`${BASE}/admin/analytics`, { waitUntil: "domcontentloaded" });
      await settle(page);
      await page.click(".aRangeBtn");
      await page.waitForTimeout(250);
      const fits = await page.evaluate(() => {
        const p = document.querySelector(".aRangePanel");
        if (!p) return null;
        const r = p.getBoundingClientRect();
        return { left: r.left, right: r.right, vw: document.documentElement.clientWidth, docScroll: document.documentElement.scrollWidth };
      });
      check(`${vp.name}: the picker panel fits the viewport`, !!fits && fits.left >= -1 && fits.right <= fits.vw + 1, JSON.stringify(fits));
      check(`${vp.name}: opening it causes no horizontal scroll`, !!fits && fits.docScroll <= fits.vw + 1, JSON.stringify(fits));
      await ctx.close();
    }

    /* ══════════════ 3c. OVERVIEW USES THE PICKER ══════════════ */
    console.log("\n[3c] Overview page");
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await login(page, ADMIN.email, ADMIN.password);
      await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
      await settle(page);
      const head = await page.evaluate(() => ({
        hasPicker: !!document.querySelector(".aHeadActions .aRangeBtn"),
        buttons: [...document.querySelectorAll(".aHeadActions a")].map((a) => a.textContent?.trim() ?? ""),
      }));
      check("overview header carries the date picker", head.hasPicker);
      check("the Analytics / Manage yards buttons are gone", head.buttons.length === 0, head.buttons.join(","));
      await ctx.close();
    }

    /* ══════════════ 4. SORT — PER-ROW UNITS ══════════════ */
    console.log("\n[4] Sort page");
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      const logs = watchConsole(page);
      await login(page, MANAGER.email, MANAGER.password);
      await page.goto(`${BASE}/sort`, { waitUntil: "domcontentloaded" });
      await settle(page);

      const rows = await page.evaluate(() => {
        // Every stepper row is a material row now. The "Totals in" summary row was
        // removed in Phase X — it duplicated the per-row selectors and was routinely
        // mistaken for one; totals render in kilograms, the ledger unit.
        const material = [...document.querySelectorAll(".splitRow")].filter((r) => r.querySelector(".splitVal"));
        return {
          materialRows: material.length,
          eachHasUnit: material.every((r) => !!r.querySelector("select.rowUnit")),
          rowUnitSelectors: document.querySelectorAll("select.rowUnit").length,
          summarySelectors: document.querySelectorAll("select.summaryUnit").length,
          summaryRows: document.querySelectorAll(".splitRow.summaryRow").length,
          hasWasteRow: !!document.querySelector(".splitRow.waste select.rowUnit"),
          remainText: document.querySelector(".remain")?.textContent?.trim() ?? "",
          valueInputs: document.querySelectorAll("input.splitVal").length,
        };
      });
      if (rows.materialRows === 0) {
        console.log("  … no mixed lot waiting in this yard; per-row units verified structurally only");
      }
      check("every sortable row has its own unit selector", rows.materialRows === 0 || rows.eachHasUnit, `${rows.materialRows} rows`);
      check("the wastage row has one too", rows.materialRows === 0 || rows.hasWasteRow);
      // `materialRows` counts every stepper row, and the wastage row is one of
      // them — it has a `.splitVal` too. So the expected count is 1:1, not +1.
      check(
        "exactly one row selector per stepper row (materials + wastage)",
        rows.materialRows === 0 || rows.rowUnitSelectors === rows.materialRows,
        `${rows.rowUnitSelectors} selectors for ${rows.materialRows} rows`
      );
      check("the duplicate summary selector is gone", rows.summarySelectors === 0, String(rows.summarySelectors));
      check("the summary row is gone", rows.summaryRows === 0, String(rows.summaryRows));
      check("values are editable inputs", rows.materialRows === 0 || rows.valueInputs === rows.materialRows, `${rows.valueInputs}`);

      if (rows.materialRows > 0) {
        // Change ONE row's unit and prove the others do not follow, and that the
        // kilogram value behind it is unchanged.
        const beforeVals = await page.evaluate(() =>
          [...document.querySelectorAll("input.splitVal")].map((v) => (v as HTMLInputElement).value.trim())
        );
        const matRow = page.locator(".splitRow:has(input.splitVal)").first();
        await matRow.locator("select.rowUnit").selectOption("TONNE");
        await page.waitForTimeout(300);
        const afterState = await page.evaluate(() => ({
          rowUnits: [...document.querySelectorAll("select.rowUnit")].map((s) => (s as HTMLSelectElement).value),
          vals: [...document.querySelectorAll("input.splitVal")].map((v) => (v as HTMLInputElement).value.trim()),
          remain: document.querySelector(".remain")?.textContent?.trim() ?? "",
        }));
        check(
          "only the changed row switched unit",
          afterState.rowUnits[0] === "TONNE" && afterState.rowUnits.slice(1).every((u) => u === "KG"),
          afterState.rowUnits.join(",")
        );
        check(
          "other rows' displayed values are untouched",
          JSON.stringify(afterState.vals.slice(1)) === JSON.stringify(beforeVals.slice(1)),
          `${beforeVals} -> ${afterState.vals}`
        );
        check(
          "the Unsorted Left total is unaffected by a ROW's display unit",
          afterState.remain === rows.remainText,
          `${rows.remainText} -> ${afterState.remain}`
        );

        // Stepping in TONNE must move the underlying kilogram value by 500 kg.
        await matRow.locator(".step").nth(1).click();
        await page.waitForTimeout(300);
        const stepped = await page.evaluate(() => ({
          shown: (document.querySelector("input.splitVal") as HTMLInputElement | null)?.value.trim() ?? "",
          remain: document.querySelector(".remain")?.textContent?.trim() ?? "",
        }));
        check("a TONNE step shows 0.5", stepped.shown === "0.5", stepped.shown);
        const leftKg = (t: string) => Number((t.match(/([\d,.]+)/)?.[1] ?? "0").replace(/,/g, ""));
        check(
          "Unsorted Left dropped by exactly 500 kg",
          leftKg(rows.remainText) - leftKg(stepped.remain) === 500,
          `${rows.remainText} -> ${stepped.remain}`
        );
        // Totals stay in kilograms whatever a row is set to — that is the point of
        // removing the separate summary unit.
        check("the total still reads in kilograms", /kg/i.test(stepped.remain), stepped.remain);
      }
      check("no console errors on Sort", logs.filter((l) => !/favicon/i.test(l)).length === 0, logs.slice(0, 3).join(" | "));
      await ctx.close();
    }

    /* ══════════════ 8. REACT KEY WARNINGS ══════════════ */
    console.log("\n[8] React key warnings across every admin page");
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      const logs = watchConsole(page);
      await login(page, ADMIN.email, ADMIN.password);
      for (const p of ["/admin", "/admin/analytics", "/admin/yards", "/admin/users", "/admin/audit"]) {
        await page.goto(BASE + p, { waitUntil: "domcontentloaded" });
        await settle(page);
      }
      const keyWarnings = logs.filter((l) => /same key|unique "key"|duplicate key/i.test(l));
      check("no duplicate-key warnings anywhere in the console", keyWarnings.length === 0, keyWarnings.slice(0, 3).join(" | "));
      const anyReactWarning = logs.filter((l) => /Warning:/i.test(l));
      check("no React warnings at all", anyReactWarning.length === 0, anyReactWarning.slice(0, 3).join(" | "));
      await ctx.close();
    }

    /* ══════════════ 10. PORT / SESSION / COOKIES ══════════════ */
    console.log("\n[10] Port, session and cookies");
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await login(page, ADMIN.email, ADMIN.password);
      await settle(page);
      const cookies = await ctx.cookies();
      const session = cookies.find((c) => c.name.includes("session-token"));
      check("a session cookie is set", !!session, cookies.map((c) => c.name).join(","));
      check("the cookie is scoped to localhost", session?.domain === "localhost", session?.domain);
      check("the page is served from :3001", page.url().includes(":3001"), page.url());

      const sess = await ctx.request.get(`${BASE}/api/auth/session`);
      const sj = (await sess.json()) as { user?: { email?: string } };
      check("the session endpoint returns the signed-in user", sj.user?.email === ADMIN.email, JSON.stringify(sj).slice(0, 80));

      // No 3000 anywhere in the served HTML (callback URLs, metadata, assets).
      const html = await (await ctx.request.get(`${BASE}/login`)).text();
      check("no localhost:3000 reference in the served page", !html.includes("localhost:3000"), "found a :3000 reference");

      // A protected page survives a reload — cookies really work.
      await page.goto(`${BASE}/admin/users`, { waitUntil: "domcontentloaded" });
      await settle(page);
      check("a protected page loads with the session cookie", page.url().includes("/admin/users"), page.url());
      await ctx.close();
    }

    console.log(`\n==== fix verification: ${pass} passed, ${fail} failed ====`);
  } finally {
    await browser?.close();
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
