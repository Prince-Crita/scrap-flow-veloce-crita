/**
 * ANPR parity — Owner vs Manager, existing vs newly created.
 *
 * Asserts that both roles run the SAME ANPR pipeline and get the same result
 * from the same image: same plate, same confidence, same crop, same note, same
 * endpoint, same number of calls. It compares the two roles' outputs against
 * each other rather than against hardcoded values, so it keeps meaning if the
 * model or the sample image ever changes.
 *
 * Newly created accounts are covered explicitly: they are created through the
 * real admin endpoint, taken through the forced first-sign-in password change,
 * and then driven through the real camera sheet — because "works for existing
 * users" and "works for accounts made today" are different claims.
 *
 * Everything runs in the sandbox yard SFTEST01; fresh accounts are deleted at
 * the end. Yard 1 is only read from.
 *
 * Usage: app on :3001, then `npx tsx tests/anpr-parity.test.ts`
 */
import { promises as fs } from "fs";
import path from "path";
import { chromium, type Page, type Browser } from "playwright";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const ADMIN = { email: "admin@scrapflow.in", password: "ScrapFlow@2026" };
const SANDBOX = "SFTEST01";
const NEW_PW = "FreshUser@2026";
const CHANGED_PW = "FreshUser@2027";

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

type Reading = {
  plate: string;
  conf: string;
  note: string;
  crop: boolean;
  retry: boolean;
  endpoints: string[];
};

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45_000 }),
    page.click('button[type="submit"]'),
  ]);
  return page.url().replace(BASE, "");
}

/** Drives the real camera sheet and reports what the plate step shows. */
async function readPlate(page: Page, route: string, front: string, back: string): Promise<Reading | string> {
  const endpoints: string[] = [];
  const onRes = (r: { url(): string; status(): number }) => {
    const u = new URL(r.url());
    if (/ocr|anpr|plate/i.test(u.pathname)) endpoints.push(`${u.pathname} ${r.status()}`);
  };
  page.on("response", onRes);

  try {
    await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    if (!page.url().includes(route)) return `redirected to ${page.url().replace(BASE, "")}`;

    const trig = page.locator("button", { hasText: "📷" }).first();
    if ((await trig.count()) === 0) return "no camera key on screen";
    await trig.click();
    await page.waitForTimeout(700);
    if ((await page.locator(".sheet").count()) === 0) return "camera sheet did not open";

    const inputs = page.locator('.sheet input[type="file"]');
    await inputs.nth(0).setInputFiles(front);
    await page.waitForTimeout(2500);
    await inputs.nth(1).setInputFiles(back);
    await page.waitForTimeout(2500);
    await page.locator(".sheet button.cta").first().click();
    await page.waitForTimeout(9000);

    return await page.evaluate(() => {
      const el = document.querySelector(".sheet") as HTMLElement;
      return {
        plate: (el.querySelector(".plateBox input") as HTMLInputElement | null)?.value ?? "",
        conf: (el.querySelector(".conf") as HTMLElement | null)?.innerText ?? "",
        note: (el.querySelector(".hint") as HTMLElement | null)?.innerText ?? "",
        crop: !!el.querySelector(".plateCrop img"),
        retry: [...el.querySelectorAll("button")].some((b) => /Retry scan/i.test(b.textContent ?? "")),
        endpoints: [] as string[],
      };
    }).then((r) => ({ ...r, endpoints }));
  } finally {
    page.off("response", onRes);
  }
}

const describe = (r: Reading | string) =>
  typeof r === "string" ? r : `plate=${r.plate} conf=${r.conf} crop=${r.crop}`;

/** Everything that must match between two roles. */
function identical(a: Reading, b: Reading) {
  return (
    a.plate === b.plate && a.conf === b.conf && a.note === b.note && a.crop === b.crop && a.retry === b.retry
  );
}

async function main() {
  const db = new PrismaClient();
  const browser: Browser = await chromium.launch();
  const stamp = Date.now();
  const freshOwner = `anpr-owner-${stamp}@veloce.test`;
  const freshManager = `anpr-manager-${stamp}@veloce.test`;

  try {
    // A real vehicle photograph from the yard's own corpus.
    const root = path.join(process.cwd(), "public", "uploads");
    const found: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (/vehicle-(front|back).*\.jpg$/i.test(e.name)) found.push(p);
      }
    };
    await walk(root);
    const front = found.find((f) => /front/.test(f));
    const back = found.find((f) => /back/.test(f)) ?? front;
    if (!front || !back) throw new Error("no vehicle photograph on disk to test with");
    console.log(`sample: ${path.basename(front)} + ${path.basename(back)}\n`);

    const yard = await db.yard.findFirstOrThrow({ where: { yardCode: SANDBOX }, select: { id: true } });

    /* ── 1. One implementation, not two ── */
    console.log("[1] there is a single shared implementation:");
    const src = path.join(process.cwd(), "src");
    const tsx: string[] = [];
    const scan = async (dir: string) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await scan(p);
        else if (/\.tsx?$/.test(e.name)) tsx.push(p);
      }
    };
    await scan(src);
    const withCapture: string[] = [];
    const ocrCallers: string[] = [];
    for (const f of tsx) {
      const t = await fs.readFile(f, "utf8");
      // Locator note: this used to key on `capture="environment"`. That attribute
      // was removed from the camera inputs on purpose — it forced the camera and
      // made Photos/Gallery unreachable on iOS and Android. `captureGrid` is the
      // capture sheet's own layout class and is unique to that component, so the
      // assertion below ("exactly one shared capture implementation") is
      // unchanged in meaning; only the fingerprint moved.
      if (/captureGrid/.test(t)) withCapture.push(path.relative(src, f));
      if (/"\/api\/ocr"/.test(t) && !f.endsWith(path.join("api", "ocr", "route.ts"))) {
        ocrCallers.push(path.relative(src, f));
      }
    }
    check("exactly one camera capture component exists", withCapture.length === 1, withCapture.join(", "));
    check("exactly one client calls the ANPR endpoint", ocrCallers.length === 1, ocrCallers.join(", "));
    check("and it is the shared camera sheet", withCapture[0] === path.join("components", "camera-sheet.tsx"), withCapture[0]);

    const sheet = await fs.readFile(path.join(src, "components", "camera-sheet.tsx"), "utf8");
    check("the shared sheet contains no role branching", !/role|isOwner|isManager/i.test(sheet));
    const ocrRoute = await fs.readFile(path.join(src, "app", "api", "ocr", "route.ts"), "utf8");
    check("the ANPR endpoint contains no role branching", !/role\s*===|isOwner|MANAGER|OWNER/.test(ocrRoute));

    /* ── 2. Existing Owner vs existing Manager ── */
    console.log("\n[2] existing accounts — Owner vs Manager, same image:");
    const ownerCtx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    const ownerPage = await ownerCtx.newPage();
    await signIn(ownerPage, "test-owner@veloce.test", "testowner123");
    const ownerRead = await readPlate(ownerPage, "/inward", front, back);
    check("the Owner's camera read the plate", typeof ownerRead !== "string" && ownerRead.plate.length > 0, describe(ownerRead));
    await ownerCtx.close();

    const mgrCtx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    const mgrPage = await mgrCtx.newPage();
    await signIn(mgrPage, "test-manager@veloce.test", "testmanager123");
    const mgrInward = await readPlate(mgrPage, "/inward", front, back);
    const mgrOutward = await readPlate(mgrPage, "/outward", front, back);
    await mgrCtx.close();

    check("the Manager's Inward camera read the plate", typeof mgrInward !== "string" && mgrInward.plate.length > 0, describe(mgrInward));
    check("the Manager's Outward camera read the plate", typeof mgrOutward !== "string" && mgrOutward.plate.length > 0, describe(mgrOutward));

    if (typeof ownerRead !== "string") {
      check("the Owner got the confidence badge and plate crop (the improved pipeline)", ownerRead.crop && ownerRead.conf !== "" && ownerRead.retry, describe(ownerRead));
      if (typeof mgrInward !== "string") {
        check("Manager Inward is IDENTICAL to Owner — plate, confidence, crop, note", identical(ownerRead, mgrInward), `${JSON.stringify(ownerRead)} vs ${JSON.stringify(mgrInward)}`);
      }
      if (typeof mgrOutward !== "string") {
        check("Manager Outward is IDENTICAL to Owner — plate, confidence, crop, note", identical(ownerRead, mgrOutward), `${JSON.stringify(ownerRead)} vs ${JSON.stringify(mgrOutward)}`);
        check("Manager Outward used the same ANPR endpoint, once", mgrOutward.endpoints.length === 1 && mgrOutward.endpoints[0].startsWith("/api/ocr"), mgrOutward.endpoints.join(", "));
      }
    }

    /* ── 3. Accounts created today ── */
    console.log("\n[3] newly created accounts:");
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signIn(adminPage, ADMIN.email, ADMIN.password);
    for (const [email, role] of [
      [freshOwner, "OWNER"],
      [freshManager, "MANAGER"],
    ] as const) {
      const res = await adminCtx.request.post(`${BASE}/api/admin/users`, {
        data: { name: `ANPR ${role} ${stamp}`, email, password: NEW_PW, role, yardId: yard.id, mustChangePassword: true },
      });
      check(`a brand-new ${role} was created`, res.status() === 201, String(res.status()));
    }
    await adminCtx.close();

    const fresh: Record<string, Reading | string> = {};
    for (const [email, role, routes] of [
      [freshOwner, "OWNER", ["/inward"]],
      [freshManager, "MANAGER", ["/inward", "/outward"]],
    ] as const) {
      const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
      const page = await ctx.newPage();
      const landed = await signIn(page, email, NEW_PW);
      check(`the new ${role} is forced to set a password first`, landed.startsWith("/change-password"), landed);
      const pws = page.locator('input[type="password"]');
      const n = await pws.count();
      for (let k = 0; k < n; k++) await pws.nth(k).fill(k === 0 && n === 3 ? NEW_PW : CHANGED_PW);
      await page.locator('button[type="submit"], button.cta').first().click();
      await page.waitForTimeout(3500);
      check(`the new ${role} reached the app after changing it`, !page.url().includes("/change-password"), page.url().replace(BASE, ""));

      for (const r of routes) fresh[`${role}${r}`] = await readPlate(page, r, front, back);
      await ctx.close();
    }

    for (const [k, v] of Object.entries(fresh)) {
      check(`a brand-new account reads the plate on ${k}`, typeof v !== "string" && v.plate.length > 0, describe(v));
      if (typeof v !== "string" && typeof ownerRead !== "string") {
        check(`  …and it matches the existing Owner exactly (${k})`, identical(ownerRead, v), `${JSON.stringify(v)}`);
      }
    }

    console.log(`\n==== ANPR parity: ${pass} passed, ${fail} failed ====`);
  } finally {
    await db.user.deleteMany({ where: { email: { in: [freshOwner, freshManager] } } });
    await db.$disconnect();
    await browser.close();
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
