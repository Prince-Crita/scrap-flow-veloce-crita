/**
 * Exit gate: Phase 3 Module 3 — gamification.
 *
 * Driven through a real browser because the two defects this module fixes are
 * both invisible to a static check:
 *   • the level ring carried a HARDCODED stroke-dashoffset, so it drew the same
 *     arc at every XP total — only the rendered attribute proves it now tracks
 *     progress;
 *   • tapping the level badge signed the operator out. Only a real click can
 *     show that it opens the profile popup and keeps the session alive.
 *
 * NOTE: everything inside `page.evaluate` must avoid named inner functions.
 * tsx/esbuild compiles `const f = () => {}` with a `__name(f, "f")` helper that
 * exists in Node but NOT in the browser context, so the callback throws
 * `ReferenceError: __name is not defined`. Inline loops only.
 *
 * Read-only against Yard 1: it signs in as the demo Owner and never writes.
 *
 * Usage: start the app, then `npx tsx tests/gamification.test.ts`.
 */
import { chromium, type Browser, type Page } from "playwright";
import { levelProgress, levelForXp } from "../src/components/ui-provider";

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

const RING_R = 19;
const RING_C = 2 * Math.PI * RING_R;

async function login(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 25_000 });
}

async function main() {
  console.log("Pure level maths:");
  // The curve is anchored to the prototype: level 7 at 1240 XP, level 8 at 2000.
  check("1240 XP is level 7", levelForXp(1240) === 7, String(levelForXp(1240)));
  check("level 7 targets 2000 XP", levelProgress(1240).nextXp === 2000, String(levelProgress(1240).nextXp));
  check("progress is absolute (xp/nextXp)", Math.round(levelProgress(1240).pct) === 62, String(levelProgress(1240).pct));
  check("zero XP is level 1", levelForXp(0) === 1);
  check("progress never exceeds 100", levelProgress(999_999).pct <= 100);
  check("progress is never negative", levelProgress(0).pct >= 0);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();

    await login(page, "owner@veloce.in", "owner123");
    await page.waitForSelector(".avatar", { timeout: 20_000 });

    // ── The ring actually reflects XP ────────────────────────────────────────
    console.log("\nLevel ring:");
    const ring = await page.evaluate(() => {
      const el = document.querySelector(".avatar .ringFill");
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        dashArray: el.getAttribute("stroke-dasharray"),
        dashOffset: el.getAttribute("stroke-dashoffset"),
        r: el.getAttribute("r"),
        transition: cs.transitionProperty + " " + cs.transitionDuration,
      };
    });
    check("the progress ring is rendered", ring !== null);

    const xpText = await page.textContent(".xplabel span");
    const xp = Number((xpText || "").replace(/[^0-9]/g, ""));
    check("XP is readable from the header", xp > 0, String(xpText));

    const expectedPct = levelProgress(xp).pct;
    const expectedOffset = RING_C * (1 - expectedPct / 100);

    check("dasharray is the real circumference", Math.abs(Number(ring!.dashArray) - RING_C) < 0.01, `${ring!.dashArray} vs ${RING_C}`);
    check("radius matches the geometry constant", Number(ring!.r) === RING_R, String(ring!.r));
    check(
      "dashoffset is derived from XP, not hardcoded",
      Math.abs(Number(ring!.dashOffset) - expectedOffset) < 0.5,
      `${ring!.dashOffset} vs ${expectedOffset.toFixed(2)}`
    );
    // The old bug, asserted directly so it cannot come back.
    check("dashoffset is not the old hardcoded 45", Number(ring!.dashOffset) !== 45, String(ring!.dashOffset));
    check("dasharray is not the old hardcoded 120", Number(ring!.dashArray) !== 120, String(ring!.dashArray));
    check("the ring animates rather than jumping", /stroke-dashoffset/.test(ring!.transition), ring!.transition);
    check("the ring is partially filled at 62%", Number(ring!.dashOffset) > 0 && Number(ring!.dashOffset) < RING_C);

    // ── The badge opens a profile, and does NOT sign out ─────────────────────
    console.log("\nLevel badge opens the profile:");
    await page.click(".avatar");
    await page.waitForSelector(".sheet", { timeout: 10_000 });
    check("a sheet opened", (await page.locator(".sheet").count()) > 0);
    check("the session survived the tap", !page.url().includes("/login"), page.url());

    const sheet = await page.evaluate(() => {
      const el = document.querySelector(".sheet");
      return el ? (el.textContent || "") : "";
    });

    check("shows the user name", /Veloce Owner|Owner/i.test(sheet), sheet.slice(0, 120));
    check("shows the role", /Owner|Manager|Admin/i.test(sheet));
    check("shows the yard name", /Yard 1/.test(sheet));
    check("shows the yard code", /SFDY001/.test(sheet));
    check("shows the current level", /LEVEL/i.test(sheet));
    check("shows the current XP", /XP/.test(sheet));
    check("shows XP needed for the next level", /to level \d+|Level \d+ unlocked/i.test(sheet), sheet.slice(-300));
    check("shows the streak", /STREAK/i.test(sheet));
    check("shows an achievements placeholder", /Achievements/i.test(sheet));
    // Yard.ownerName is unset for Yard 1, so this must fall back to the real
    // OWNER user rather than rendering an em dash.
    check("shows a resolved owner name, not a blank", !/Owner\s*—/.test(sheet), sheet.slice(-400));
    check("shows a Sign Out button", /Sign Out/i.test(sheet));

    const bar = await page.evaluate(() => {
      const el = document.querySelector(".sheet .xpbar i");
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { width: (el as HTMLElement).style.width, transition: cs.transitionProperty };
    });
    check("the popup has its own progress bar", bar !== null);
    check("the bar is animated", /width/.test(bar?.transition ?? ""), String(bar?.transition));
    check("the bar reflects real progress", parseFloat(bar?.width ?? "0") > 0);

    // Owner-visible values must still match the prototype exactly.
    console.log("\nPrototype fidelity (unchanged by this module):");
    const header = await page.evaluate(() => {
      const s = document.querySelector(".streak");
      const a = document.querySelector(".avatar b");
      const x = document.querySelector(".xplabel");
      return {
        streak: s ? (s.textContent || "") : "",
        level: a ? (a.textContent || "") : "",
        xp: x ? (x.textContent || "") : "",
      };
    });
    check("streak is rendered as a number", /\d/.test(header.streak), header.streak);
    check("the level badge matches the XP curve", header.level.trim() === String(levelForXp(xp)), `${header.level} vs ${levelForXp(xp)}`);
    check(
      "the XP label matches the header XP",
      header.xp.replace(/,/g, "").includes(String(xp)),
      header.xp
    );
    check(
      "the next-level target matches the curve",
      header.xp.replace(/,/g, "").includes(`${levelProgress(xp).nextXp} XP`) &&
        header.xp.includes(`Level ${levelForXp(xp) + 1}`),
      header.xp
    );

    // ── Only Sign Out signs out ──────────────────────────────────────────────
    console.log("\nOnly Sign Out ends the session:");
    await page.evaluate(() => {
      const els = document.querySelectorAll(".sheet .cta");
      for (let i = 0; i < els.length; i++) {
        if ((els[i].textContent || "").trim().toLowerCase() === "close") {
          (els[i] as HTMLElement).click();
          return;
        }
      }
    });
    await page.waitForTimeout(400);
    check("Close dismisses without signing out", (await page.locator(".sheet").count()) === 0 && !page.url().includes("/login"));

    await page.click(".avatar");
    await page.waitForSelector(".sheet", { timeout: 10_000 });
    await page.evaluate(() => {
      const els = document.querySelectorAll(".sheet .cta");
      for (let i = 0; i < els.length; i++) {
        if ((els[i].textContent || "").trim().toLowerCase() === "sign out") {
          (els[i] as HTMLElement).click();
          return;
        }
      }
    });
    // Sign out is confirmed first — the confirm host renders its own dialog.
    await page.waitForTimeout(600);
    const confirmText = await page.evaluate(() => document.body.textContent || "");
    check("Sign Out asks for confirmation first", /Sign out of Scrap Flow/i.test(confirmText), confirmText.slice(0, 200));

    // `.confirmGo` is the confirm dialog's affirmative button — matching on the
    // label alone is ambiguous here, because the sheet behind it says the same.
    await page.click(".confirmGo");
    await page.waitForURL((u) => u.pathname.startsWith("/login"), { timeout: 20_000 }).catch(() => {});
    check("confirming Sign Out really ends the session", page.url().includes("/login"), page.url());

    // ── Manager sees their own numbers, not the Owner's ──────────────────────
    console.log("\nPer-user gamification:");
    // A fresh context: sharing the owner's cookie jar would redirect straight
    // past /login and silently test the wrong user.
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page2 = await ctx2.newPage();
    await login(page2, "manager@veloce.in", "manager123");
    await page2.waitForSelector(".avatar", { timeout: 20_000 });
    const mgr = await page2.evaluate(() => {
      const el = document.querySelector(".avatar .ringFill");
      const b = document.querySelector(".avatar b");
      const x = document.querySelector(".xplabel");
      return {
        offset: el ? el.getAttribute("stroke-dashoffset") : null,
        level: b ? (b.textContent || "") : "",
        xp: x ? (x.textContent || "") : "",
      };
    });
    const mgrXp = Number((mgr.xp.match(/^[\d,]+/) || ["0"])[0].replace(/,/g, ""));
    check("manager has their own XP", mgrXp > 0 && mgrXp !== xp, `${mgrXp} vs owner ${xp}`);
    check("manager ring reflects THEIR progress", Math.abs(Number(mgr.offset) - RING_C * (1 - levelProgress(mgrXp).pct / 100)) < 0.5, String(mgr.offset));
    check("manager level matches their XP", mgr.level.trim() === String(levelForXp(mgrXp)), `${mgr.level} vs ${levelForXp(mgrXp)}`);

    await page2.click(".avatar");
    await page2.waitForSelector(".sheet", { timeout: 10_000 });
    const mgrSheet = await page2.evaluate(() => {
      const el = document.querySelector(".sheet");
      return el ? (el.textContent || "") : "";
    });
    check("manager profile names the manager, not the owner", /Manager/i.test(mgrSheet), mgrSheet.slice(0, 120));
    check("manager profile shows the same yard", /Yard 1/.test(mgrSheet));
    check("manager profile still offers Sign Out", /Sign Out/i.test(mgrSheet));
  } finally {
    if (browser) await browser.close();
  }

  console.log(`\n==== gamification: ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
