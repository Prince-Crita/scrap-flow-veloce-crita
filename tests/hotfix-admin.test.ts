/**
 * Targeted verification of three admin hotfixes. Deliberately narrow — it checks
 * these fixes and nothing else.
 *
 *   1. Create Yard keeps focus while typing (the bug: a Modal effect keyed on an
 *      inline `onClose` re-ran per keystroke and re-focused the first field).
 *   2. The Overview range picker actually refetches and its labels follow it.
 *   3. Users: no standalone Reset password button; the password lives in Edit.
 *
 * Usage: app on :3001, then `npx tsx tests/hotfix-admin.test.ts`
 */
import { chromium, type Browser, type Page } from "playwright";

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

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', ADMIN.email);
  await page.fill('input[type="password"]', ADMIN.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function main() {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page);

    /* ── 1. Create Yard typing ── */
    console.log("[1] Create Yard keeps focus and accepts full words:");
    await page.goto(`${BASE}/admin/yards`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await page.locator("button.aBtn.primary").first().click();
    await page.waitForTimeout(500);
    check("the Create Yard dialog opened", (await page.locator(".aModal").count()) === 1);

    // Type into the SECOND field. The bug moved focus to the first field after the
    // first keystroke, so this is where it showed most clearly.
    const nameField = page.locator('.aModal input').nth(1);
    await nameField.click();
    await nameField.type("Yard Seventeen", { delay: 40 });
    await page.waitForTimeout(250);

    const state = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll(".aModal input")] as HTMLInputElement[];
      const active = document.activeElement as HTMLElement | null;
      return {
        secondValue: inputs[1]?.value ?? "",
        firstValue: inputs[0]?.value ?? "",
        focusIsSecond: active === inputs[1],
        modals: document.querySelectorAll(".aModal").length,
      };
    });
    check("the whole string landed in the field", state.secondValue === "Yard Seventeen", `got "${state.secondValue}"`);
    check("focus stayed in the field being typed into", state.focusIsSecond);
    check("focus did NOT jump to the first field", state.firstValue === "", `first field got "${state.firstValue}"`);
    check("the dialog did not close or remount", state.modals === 1, String(state.modals));

    // A second field, to be sure it is not a one-off.
    const codeField = page.locator(".aModal input").first();
    await codeField.click();
    await codeField.type("SFDY777", { delay: 40 });
    await page.waitForTimeout(200);
    const codeVal = await page.evaluate(() => (document.querySelectorAll(".aModal input")[0] as HTMLInputElement).value);
    check("a second field also accepts a full value", codeVal === "SFDY777", codeVal);

    // Escape must still close it — the listener was rewired, so prove it works.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    check("Escape still closes the dialog", (await page.locator(".aModal").count()) === 0);

    /* ── 2. Overview: the calendar is gone and the header is balanced ── */
    console.log("\n[2] the Overview calendar is removed and the header is aligned:");
    const analyticsCalls: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/admin/analytics")) analyticsCalls.push(r.url());
    });
    await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1300);

    const head = await page.evaluate(() => {
      const h = document.querySelector(".aHead") as HTMLElement | null;
      const actions = h?.querySelector(".aHeadActions") as HTMLElement | null;
      const live = actions?.querySelector(".aLive") as HTMLElement | null;
      const title = h?.querySelector(".aTitle") as HTMLElement | null;
      if (!h || !title) return null;
      const hr = h.getBoundingClientRect();
      const ar = actions?.getBoundingClientRect();
      return {
        pickers: document.querySelectorAll("button.aRangeBtn, .aRangePanel").length,
        scopeCaptions: document.querySelectorAll(".aRangeScope").length,
        hasLive: !!live,
        actionChildren: actions ? actions.children.length : 0,
        // No dead space: the actions block must still reach the header's right edge.
        gapToRight: ar ? Math.round(hr.right - ar.right) : -1,
        headText: h.innerText,
        trendsText: document.body.innerText,
      };
    });
    check("the header rendered", head !== null);
    if (head) {
      check("no date/calendar control anywhere on Overview", head.pickers === 0, String(head.pickers));
      check("the scope caption is gone too", head.scopeCaptions === 0, String(head.scopeCaptions));
      check("the Live indicator is still present", head.hasLive);
      check("it is the only header action left", head.actionChildren === 1, String(head.actionChildren));
      check("no empty space left at the header's right edge", head.gapToRight >= 0 && head.gapToRight <= 2, `${head.gapToRight}px`);
      check("Trends still renders with its fixed 30-day window", /Trends · /i.test(head.trendsText));
      check("the trends section still loaded its data", analyticsCalls.some((u) => /from=.*to=/.test(u)), analyticsCalls[0] ?? "none");
    }
    const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check("no horizontal scroll introduced", !hScroll);

    /* ── 3. Users: password inside Edit ── */
    console.log("\n[3] Users: the password lives in Edit, not its own button:");
    await page.goto(`${BASE}/admin/users`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const rowText = await page.evaluate(() => document.body.innerText);
    check("no standalone Reset password button remains", !/Reset password/i.test(rowText), "still present");

    const editBtn = page.locator("table.aTable button", { hasText: /^Edit$/ }).first();
    check("an Edit button is available", (await editBtn.count()) > 0);
    if ((await editBtn.count()) > 0) {
      await editBtn.click();
      await page.waitForTimeout(600);
      const modal = await page.evaluate(() => {
        const m = document.querySelector(".aModal") as HTMLElement | null;
        if (!m) return null;
        const pw = m.querySelector('input[type="password"]') as HTMLInputElement | null;
        const disabled = [...m.querySelectorAll("input[disabled]")] as HTMLInputElement[];
        return {
          text: m.innerText,
          hasNewPassword: !!pw,
          newPasswordBlank: (pw?.value ?? "x") === "",
          currentShown: disabled.some((d) => /hashed/i.test(d.value)),
        };
      });
      check("the Edit dialog opened", modal !== null);
      if (modal) {
        check("it offers a New password field", modal.hasNewPassword);
        check("the new-password field starts blank (blank = unchanged)", modal.newPasswordBlank);
        check("the '(hashed — not recoverable)' row is gone", !modal.currentShown);
        check("no leftover hash explanation text", !/hashed|bcrypt|not recoverable/i.test(modal.text), modal.text.slice(0, 120));
        check("saving is still a single Save changes action", /Save changes/i.test(modal.text));

        // Typing in the password field must also keep focus — same Modal fix.
        const pwField = page.locator('.aModal input[type="password"]');
        await pwField.click();
        await pwField.type("TempPass123", { delay: 35 });
        await page.waitForTimeout(200);
        const pwVal = await page.evaluate(() => (document.querySelector('.aModal input[type="password"]') as HTMLInputElement).value);
        check("the password field accepts a full value (focus fix holds here too)", pwVal === "TempPass123", pwVal);

        // The force-change toggle appears only once a password is entered.
        const toggle = await page.evaluate(() => /Require the user to choose/i.test((document.querySelector(".aModal") as HTMLElement).innerText));
        check("the force-change option appears once a password is typed", toggle);

        // Close without saving — this suite must not change a real user.
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
        check("closed without saving", (await page.locator(".aModal").count()) === 0);
      }
    }

    console.log(`\n==== admin hotfixes: ${pass} passed, ${fail} failed ====`);
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
