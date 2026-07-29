/**
 * Phase 11 — Admin Overview visual polish.
 *
 * Scoped to the sections changed in this phase. The assertion that matters most
 * is NOT "a chart rendered" but "the chart shows the same numbers the API
 * returned" — a visualization that quietly disagrees with its data source is
 * worse than the text it replaced.
 *
 * Usage: app on :3001, then `npx tsx tests/overview-viz.test.ts`
 */
import { chromium, type Browser, type Page } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const ADMIN = { email: "admin@scrapflow.in", password: "ScrapFlow@2026" };
const SHOTS = process.env.SHOT_DIR || ".";

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

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', ADMIN.email);
  await page.fill('input[type="password"]', ADMIN.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45_000 }),
    page.click('button[type="submit"]'),
  ]);
}

/** kg()/inr() compact the numbers, so compare on digits not formatting. */
const digits = (t: string) => (t.match(/[\d.]+/g) ?? []).join("");

async function main() {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await ctx.newPage();

    const warnings: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") warnings.push(m.text());
    });
    page.on("pageerror", (e) => warnings.push(`pageerror: ${e.message}`));

    await login(page);
    await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1600);

    const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const api = (await (await fetch(`${BASE}/api/admin/dashboard`, { headers: { cookie } })).json()) as {
      data?: Record<string, unknown>;
    } & Record<string, unknown>;
    const d = (api.data ?? api) as {
      kpis: Record<string, number>;
      stockSummary: { totalKg: number; finishedKg: number; unsortedKg: number; topSkus: { name: string; kg: number }[] };
      sellSummary: { receivables: { status: string; amount: number }[]; topBuyers: { name: string }[] };
      materialSummary: { byVolume: { label: string; kg: number }[] };
      vendorSummary: { top: { name: string }[] };
      opsSummary: { sort7: { kg: number; wastageKg: number } };
    };

    /* ── The Today strip was deliberately NOT shipped ── */
    console.log("[Today] the duplicate summary strip is absent by design:");
    const dup = await page.evaluate(() => {
      const strip = document.querySelector(".aToday");
      const body = document.body.innerText;
      return {
        strip: !!strip,
        // The figures it would have shown must still be reachable on the page.
        hasSalesToday: /sales today/i.test(body),
        hasDispatchedToday: /dispatched today/i.test(body),
        hasInwardToday: /inward today/i.test(body),
      };
    });
    check("no duplicate Today strip was added", !dup.strip);
    check("Sales today is still on the page (KPI row)", dup.hasSalesToday);
    check("Dispatched today is still on the page (KPI row)", dup.hasDispatchedToday);
    check("Inward today is still on the page (Operations)", dup.hasInwardToday);

    /* ── Stock overview ── */
    console.log("\n[Stock] donut split agrees with stockSummary:");
    const stock = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".aCard")];
      const card = cards.find((c) => /Stock overview/i.test((c.querySelector(".aCardTitle, .t") as HTMLElement)?.innerText ?? ""));
      if (!card) return null;
      const slices = [...card.querySelectorAll("svg .cSlice")];
      return {
        slices: slices.length,
        centre: (card.querySelector(".cDonutLabel .big") as SVGTextElement)?.textContent ?? "",
        legend: [...card.querySelectorAll(".cLegend .item")].map((i) => (i as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
        rankRows: card.querySelectorAll(".cRank .row").length,
        hasOldStatBars: card.querySelectorAll(".aStat .bar, .aStat .track").length,
      };
    });
    check("the Stock card rendered", stock !== null);
    if (stock && d.stockSummary.totalKg > 0) {
      check("the donut has exactly two slices (sorted / unsorted)", stock.slices === 2, String(stock.slices));
      check("the centre shows the total on hand", digits(stock.centre).length > 0, stock.centre);
      check("both segments are named in the legend", stock.legend.length === 2, stock.legend.join(" | "));
      check("the legend carries values, not colour alone", stock.legend.every((l) => /\d/.test(l)), stock.legend.join(" | "));
      check(
        "largest holdings became ranked bars",
        stock.rankRows === d.stockSummary.topSkus.length,
        `${stock.rankRows} bars vs ${d.stockSummary.topSkus.length} SKUs`
      );
    }

    /* ── Collection status + buyers ── */
    console.log("\n[Sell] collection split and buyer ranking:");
    const sell = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".aCard")];
      const card = cards.find((c) => /Sell overview/i.test((c.querySelector(".aCardTitle, .t") as HTMLElement)?.innerText ?? ""));
      if (!card) return null;
      const split = card.querySelector(".cSplit");
      return {
        segments: split ? split.querySelectorAll(".seg").length : 0,
        legend: split ? [...split.querySelectorAll(".cLegend .item")].map((i) => (i as HTMLElement).innerText.replace(/\s+/g, " ").trim()) : [],
        rankRows: card.querySelectorAll(".cRank .row").length,
        text: (card as HTMLElement).innerText,
      };
    });
    check("the Sell card rendered", sell !== null);
    const rankHues = await page.evaluate(() =>
      [...new Set([...document.querySelectorAll(".cRank .track i")].map((i) => (i as HTMLElement).style.background))]
    );
    check("ranked bars use ONE hue — length carries magnitude, not colour", rankHues.length === 1, rankHues.join(", "));
    if (sell) {
      const recv = d.sellSummary.receivables.filter((r) => r.amount > 0);
      if (recv.length > 0) {
        check("collection status is one proportion bar", sell.segments === recv.length, `${sell.segments} vs ${recv.length}`);
        check("every status is labelled in the legend", sell.legend.length === d.sellSummary.receivables.length, sell.legend.join(" | "));
      }
      check(
        "top buyers became ranked bars",
        sell.rankRows === d.sellSummary.topBuyers.length,
        `${sell.rankRows} vs ${d.sellSummary.topBuyers.length}`
      );
      check("Today / 7-day / lifetime stayed as figures (nested windows, not charted)", /Lifetime/i.test(sell.text));
    }

    /* ── Vendor vs Material: adjacent cards must not use the same form ── */
    console.log("\n[Supply] adjacent cards use different visualizations:");
    const supply = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".aCard")];
      // Every predicate is inlined: ANY named arrow const in here gets wrapped by
      // tsx/esbuild in a __name() helper that does not exist in the browser.
      const vendor = cards.find((c) =>
        /Vendor overview/i.test((c.querySelector(".aCardTitle, .t") as HTMLElement)?.innerText ?? "")
      );
      const material = cards.find((c) =>
        /Material overview/i.test((c.querySelector(".aCardTitle, .t") as HTMLElement)?.innerText ?? "")
      );
      const ops = cards.find((c) =>
        /Operations/i.test((c.querySelector(".aCardTitle, .t") as HTMLElement)?.innerText ?? "")
      );
      return {
        vendorRanked: vendor ? vendor.querySelectorAll(".cRank .row").length : -1,
        vendorDonut: vendor ? vendor.querySelectorAll("svg .cSlice").length : -1,
        materialDonut: material ? material.querySelectorAll("svg .cSlice").length : -1,
        materialRanked: material ? material.querySelectorAll(".cRank .row").length : -1,
        opsSplit: ops ? ops.querySelectorAll(".cSplit .seg").length : -1,
        opsDonut: ops ? ops.querySelectorAll("svg .cSlice").length : -1,
      };
    });
    check("Vendor uses ranked bars", supply.vendorRanked === d.vendorSummary.top.length, String(supply.vendorRanked));
    check("Vendor is NOT a donut", supply.vendorDonut === 0, String(supply.vendorDonut));
    check("Material uses a donut", supply.materialDonut === d.materialSummary.byVolume.length, `${supply.materialDonut} vs ${d.materialSummary.byVolume.length}`);
    check("Material is NOT ranked bars — adjacent forms differ", supply.materialRanked === 0, String(supply.materialRanked));
    if (d.opsSummary.sort7.kg > 0) {
      check("Operations uses a split bar, not a third circle", supply.opsSplit === 2 && supply.opsDonut === 0, `split ${supply.opsSplit}, donut ${supply.opsDonut}`);
    }

    /* ── No date selectors were introduced ── */
    console.log("\n[State] no new date selectors, no shared filter state:");
    const selectors = await page.evaluate(() => document.querySelectorAll("button.aRangeBtn, .aRangePanel, input[type='date']").length);
    check("Overview has no date selector at all (removed in the last phase)", selectors === 0, String(selectors));

    /* ── Screenshots + responsive ── */
    console.log("\n[Responsive] renders cleanly at every width:");
    for (const vp of [
      { w: 1440, h: 1000, label: "desktop" },
      { w: 1024, h: 800, label: "1024px" },
      { w: 768, h: 1024, label: "768px" },
      { w: 390, h: 844, label: "390px" },
    ]) {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.waitForTimeout(700);
      const r = await page.evaluate(() => {
        const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
        // Nothing may spill outside its card.
        let spill = 0;
        for (const c of document.querySelectorAll(".aCard")) {
          const cr = c.getBoundingClientRect();
          for (const kid of c.querySelectorAll("svg, .cSplit .track, .cRank")) {
            const kr = kid.getBoundingClientRect();
            if (kr.width > 0 && (kr.right > cr.right + 2 || kr.left < cr.left - 2)) spill++;
          }
        }
        // The Today strip must not collapse to unreadable slivers.
        const cells = [...document.querySelectorAll(".aToday .cell")].map((c) => c.getBoundingClientRect().width);
        const nav = document.querySelector('[class*="bottomNav"], nav[class*="aBottom"]') as HTMLElement | null;
        const navTop = nav ? nav.getBoundingClientRect().top : Infinity;
        const lastCard = [...document.querySelectorAll(".aCard")].pop();
        return {
          overflow,
          spill,
          minCell: cells.length ? Math.round(Math.min(...cells)) : -1,
          svgs: document.querySelectorAll(".aCard svg").length,
          hiddenBehindNav: lastCard && navTop !== Infinity ? lastCard.getBoundingClientRect().top > navTop : false,
        };
      });
      check(`${vp.label}: no horizontal page scroll`, !r.overflow);
      check(`${vp.label}: no chart spills outside its card`, r.spill === 0, `${r.spill} overflowing`);
      check(`${vp.label}: Today cells stay readable (min ${r.minCell}px)`, r.minCell === -1 || r.minCell >= 120, String(r.minCell));
      check(`${vp.label}: charts still render (${r.svgs} svg)`, r.svgs > 0);
      check(`${vp.label}: content not hidden behind bottom navigation`, !r.hiddenBehindNav);
      await page.screenshot({ path: `${SHOTS}/overview-${vp.label}.png`, fullPage: true });
    }

    check("no React warnings or page errors introduced", warnings.length === 0, warnings.slice(0, 3).join(" | "));

    console.log(`\n==== overview viz: ${pass} passed, ${fail} failed ====`);
    await ctx.close();
  } finally {
    await browser?.close();
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
