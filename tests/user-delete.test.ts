/**
 * Phase 12 — Admin → Users → Delete.
 *
 * Deletion is deliberately narrow: it exists for the mistake case (wrong email,
 * duplicate, never onboarded). Every User relation is OPTIONAL, so Postgres
 * would happily delete someone who has loads and invoices against them and just
 * NULL the references — quietly rewriting who did what. So the refusal is the
 * feature, and most of this file tests the refusals.
 *
 * All fixtures live in the sandbox yard SFTEST01 and are cleaned up. Yard 1's
 * users are read for assertions but never modified.
 *
 * Usage: app on :3001, then `npx tsx tests/user-delete.test.ts`
 */
import { chromium, type Page } from "playwright";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const ADMIN = { email: "admin@scrapflow.in", password: "ScrapFlow@2026" };
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
  const db = new PrismaClient();
  const browser = await chromium.launch();
  const stamp = Date.now();
  const throwawayEmail = `phase12-delete-${stamp}@veloce.test`;
  let throwawayId: string | null = null;

  try {
    const yard = await db.yard.findFirst({ where: { yardCode: SANDBOX }, select: { id: true } });
    if (!yard) throw new Error(`sandbox yard ${SANDBOX} not found — run the fixture setup first`);

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page);

    /* ── 1. The action exists and is guarded ── */
    console.log("[1] the Delete action:");
    await page.goto(`${BASE}/admin/users?yardId=${yard.id}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);

    const shape = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("table.aTable tbody tr")];
      const admins = rows.filter((r) => /ADMIN/.test(r.textContent ?? ""));
      const nonAdmins = rows.filter((r) => !/ADMIN/.test(r.textContent ?? "") && r.querySelector(".actions"));
      // Every predicate is inlined: a named arrow const inside page.evaluate gets
      // wrapped by tsx/esbuild in a `__name()` helper that does not exist here.
      return {
        rows: rows.length,
        nonAdminsWithDelete: nonAdmins.filter((r) =>
          [...r.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Delete")
        ).length,
        nonAdminsTotal: nonAdmins.length,
        adminsWithDelete: admins.filter((r) =>
          [...r.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Delete")
        ).length,
        editStillThere: nonAdmins.every((r) =>
          [...r.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Edit")
        ),
        deleteIsDanger: nonAdmins.every((r) =>
          [...r.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Delete" && b.className.includes("danger"))
        ),
      };
    });
    check("the users table rendered", shape.rows > 0, String(shape.rows));
    check("every non-admin row offers Delete", shape.nonAdminsWithDelete === shape.nonAdminsTotal, `${shape.nonAdminsWithDelete}/${shape.nonAdminsTotal}`);
    check("no platform admin row offers Delete", shape.adminsWithDelete === 0, String(shape.adminsWithDelete));
    check("Edit is untouched", shape.editStillThere);
    check("Delete carries the existing danger styling", shape.deleteIsDanger);

    /* ── 2. Refusal: a user with history ── */
    console.log("\n[2] a user who has done work cannot be deleted:");
    const busy = await db.user.findFirst({
      where: { yard: { yardCode: SANDBOX }, role: "MANAGER" },
      select: { id: true, name: true },
    });
    check("found a sandbox user with activity to try", !!busy);

    if (busy) {
      const row = page.locator("table.aTable tbody tr", { hasText: busy.name }).first();
      await row.locator("button", { hasText: /^Delete$/ }).click();
      await page.waitForTimeout(500);

      const dialog = await page.evaluate(() => {
        const m = document.querySelector(".aModal") as HTMLElement | null;
        return m
          ? {
              text: m.innerText,
              hasCancel: [...m.querySelectorAll("button")].some((b) => /Cancel/.test(b.textContent ?? "")),
              confirmIsDanger: [...m.querySelectorAll("button")].some(
                (b) => /Delete user/i.test(b.textContent ?? "") && b.className.includes("danger")
              ),
            }
          : null;
      });
      check("a confirmation dialog appeared — nothing deleted on the first click", dialog !== null);
      if (dialog) {
        check("it names the user", dialog.text.includes(busy.name), dialog.text.slice(0, 80));
        check("it warns the action is permanent", /cannot be undone/i.test(dialog.text));
        check("it offers Cancel", dialog.hasCancel);
        check("the confirm button is the danger one", dialog.confirmIsDanger);
        check("it points at deactivation as the alternative", /Active/.test(dialog.text));
      }

      const stillThere = await db.user.count({ where: { id: busy.id } });
      check("still not deleted while the dialog is open", stillThere === 1);

      await page.locator(".aModal button", { hasText: /Delete user/i }).click();
      await page.waitForTimeout(1800);

      const afterAttempt = await page.evaluate(() => {
        const m = document.querySelector(".aModal") as HTMLElement | null;
        return { open: !!m, err: (m?.querySelector(".aErr") as HTMLElement | null)?.innerText ?? "" };
      });
      check("the dialog stayed open on refusal", afterAttempt.open);
      check("a validation message explains why", afterAttempt.err.length > 0, afterAttempt.err);
      check(
        "the message lists what is blocking and offers deactivation",
        /recorded against them/i.test(afterAttempt.err) && /[Dd]eactivate/.test(afterAttempt.err),
        afterAttempt.err
      );
      check("the user survived the refused delete", (await db.user.count({ where: { id: busy.id } })) === 1);

      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }

    /* ── 3. Refusal: the yard's last active owner ── */
    console.log("\n[3] the last active owner is protected:");
    const owner = await db.user.findFirst({
      where: { yard: { yardCode: SANDBOX }, role: "OWNER", active: true },
      select: { id: true, name: true },
    });
    if (owner) {
      const res = await ctx.request.delete(`${BASE}/api/admin/users/${owner.id}`);
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      check("refused with 409", res.status() === 409, String(res.status()));
      check(
        "and says which invariant stopped it",
        body.error?.code === "LAST_OWNER" || body.error?.code === "HAS_RECORDS",
        JSON.stringify(body.error)
      );
      check("the owner is still there", (await db.user.count({ where: { id: owner.id } })) === 1);
    }

    /* ── 4. The admin cannot delete themselves or another admin ── */
    console.log("\n[4] admins are protected:");
    const admin = await db.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
    if (admin) {
      const res = await ctx.request.delete(`${BASE}/api/admin/users/${admin.id}`);
      const body = (await res.json()) as { error?: { code?: string } };
      check("refused with 409", res.status() === 409, String(res.status()));
      check("marked PROTECTED", body.error?.code === "PROTECTED", JSON.stringify(body.error));
      check("the admin account survived", (await db.user.count({ where: { id: admin.id } })) === 1);
    }

    /* ── 5. The case delete is FOR: a clean, unused account ── */
    console.log("\n[5] a mistyped account with no history deletes cleanly:");
    const created = await ctx.request.post(`${BASE}/api/admin/users`, {
      data: {
        name: `Phase12 Throwaway ${stamp}`,
        email: throwawayEmail,
        password: "Throwaway@2026",
        role: "MANAGER",
        yardId: yard.id,
        mustChangePassword: true,
      },
    });
    check("a throwaway user was created in the sandbox yard", created.ok(), String(created.status()));
    const madeRow = await db.user.findUnique({ where: { email: throwawayEmail }, select: { id: true, name: true } });
    throwawayId = madeRow?.id ?? null;
    check("it exists in the database", !!throwawayId);

    if (madeRow) {
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(1200);
      const row = page.locator("table.aTable tbody tr", { hasText: madeRow.name }).first();
      check("it is listed", (await row.count()) > 0);

      await row.locator("button", { hasText: /^Delete$/ }).click();
      await page.waitForTimeout(500);
      check("the confirmation appeared", (await page.locator(".aModal").count()) === 1);

      // Cancel must genuinely cancel.
      await page.locator(".aModal button", { hasText: /^Cancel$/ }).click();
      await page.waitForTimeout(400);
      check("Cancel closes without deleting", (await page.locator(".aModal").count()) === 0);
      check("the user is still there after Cancel", (await db.user.count({ where: { id: madeRow.id } })) === 1);

      await row.locator("button", { hasText: /^Delete$/ }).click();
      await page.waitForTimeout(400);
      await page.locator(".aModal button", { hasText: /Delete user/i }).click();
      await page.waitForTimeout(2000);

      check("the dialog closed", (await page.locator(".aModal").count()) === 0);
      check("it is gone from the database", (await db.user.count({ where: { id: madeRow.id } })) === 0);
      throwawayId = null;

      // Scoped to the table: the success banner legitimately repeats the name
      // ("… was deleted"), so checking document.body would report a stale row
      // that is not there.
      const listed = await page.evaluate(
        (n) => (document.querySelector("table.aTable tbody") as HTMLElement | null)?.innerText.includes(n) ?? false,
        madeRow.name
      );
      check("the table no longer lists it — no manual refresh", !listed);
      const confirmed = await page.evaluate((n) => document.body.innerText.includes(`${n} was deleted`), madeRow.name);
      check("and it says so", confirmed);

      const audited = await db.auditLog.count({ where: { action: "user.delete", entityId: madeRow.id } });
      check("the deletion is recorded in the audit trail", audited === 1, String(audited));
    }

    /* ── 6. Nothing outside the sandbox moved ── */
    console.log("\n[6] blast radius:");
    const yard1Users = await db.user.count({ where: { yard: { yardCode: "SFDY001" } } });
    check("Yard 1 still has its users", yard1Users >= 2, String(yard1Users));

    console.log(`\n==== user delete: ${pass} passed, ${fail} failed ====`);
    await ctx.close();
  } finally {
    // Never leave a fixture behind, even on a failed run.
    if (throwawayId) await db.user.deleteMany({ where: { id: throwawayId } });
    await db.user.deleteMany({ where: { email: throwawayEmail } });
    await browser.close();
    await db.$disconnect();
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
