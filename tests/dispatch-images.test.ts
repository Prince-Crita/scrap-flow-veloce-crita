/**
 * Phase 12 — dispatch images must open from Owner → Sell → Dispatch Status.
 *
 * The bug was NOT yard-specific. `next start` serves /public from a snapshot
 * taken at BUILD time, so any photo uploaded afterwards 404s until the next
 * build. The old yard's photos happened to predate a build and the new yard's
 * did not, which is the only reason it looked like a new-yard problem.
 *
 * So the decisive case here is the third one: bytes written AFTER the running
 * build. That returned Next's 404 page before the fix and must return the image
 * now, for any yard id — including one that did not exist at build time.
 *
 * Usage: app on :3001, then `npx tsx tests/dispatch-images.test.ts`
 */
import { promises as fs } from "fs";
import path from "path";
import { chromium, type APIRequestContext } from "playwright";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const OWNER = { email: "owner@veloce.in", password: "owner123" };

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

/** A 1x1 JPEG — real bytes with a real signature, not a placeholder string. */
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

async function head(req: APIRequestContext, url: string) {
  const res = await req.get(`${BASE}${url}`);
  const body = await res.body();
  return { status: res.status(), type: res.headers()["content-type"] ?? "", bytes: body.byteLength };
}

async function main() {
  const db = new PrismaClient();
  const browser = await chromium.launch();
  const created: string[] = [];

  try {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="email"]', OWNER.email);
    await page.fill('input[type="password"]', OWNER.password);
    await Promise.all([
      page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45_000 }),
      page.click('button[type="submit"]'),
    ]);

    /* ── 1. Every dispatch image already in the database resolves ── */
    console.log("[1] stored dispatch images resolve, for every yard:");
    const yards = await db.yard.findMany({ select: { id: true, yardCode: true, createdAt: true } });
    const byId = new Map(yards.map((y) => [y.id, y]));
    const loads = await db.outwardLoad.findMany({
      select: {
        yardId: true,
        dispatchNumber: true,
        frontImageUrl: true,
        backImageUrl: true,
        images: { select: { url: true } },
      },
    });

    const local = loads.flatMap((l) =>
      [l.frontImageUrl, l.backImageUrl, ...l.images.map((i) => i.url)]
        .filter((u): u is string => !!u && u.startsWith("/uploads/"))
        .map((u) => ({ url: u, yard: byId.get(l.yardId)?.yardCode ?? l.yardId, d: l.dispatchNumber }))
    );
    check("there are stored dispatch images to test", local.length > 0, String(local.length));

    const yardsCovered = new Set<string>();
    for (const item of local) {
      const r = await head(ctx.request, item.url);
      yardsCovered.add(item.yard);
      check(
        `${item.yard} ${item.d} → ${item.url.split("/").pop()}`,
        r.status === 200 && r.type.startsWith("image/") && r.bytes > 0,
        `${r.status} ${r.type}`
      );
    }
    // The reported failure was one yard working and another not, so covering
    // more than one yard is what makes this test meaningful at all.
    check("more than one yard is covered", yardsCovered.size >= 2, [...yardsCovered].join(", "));

    /* ── 2. The decisive case: bytes written AFTER the running build ── */
    console.log("\n[2] an image uploaded after the build (the actual failure):");
    const stamp = Date.now();
    // A yard id that did not exist when the build ran, to also prove nothing is
    // special-cased to the yards that happen to exist today.
    for (const yardId of [yards[0]!.id, `newyard${stamp}`]) {
      const rel = `uploads/${yardId}/9999-12-31/misc/vehicle-front-${stamp}.jpg`;
      const abs = path.join(process.cwd(), "public", rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, JPEG);
      created.push(path.join(process.cwd(), "public", "uploads", yardId));

      const r = await head(ctx.request, `/${rel}`);
      check(
        `post-build upload under ${yardId.startsWith("newyard") ? "a brand-new yard id" : "an existing yard"} serves`,
        r.status === 200 && r.type === "image/jpeg" && r.bytes === JPEG.byteLength,
        `${r.status} ${r.type} ${r.bytes}b`
      );
    }

    /* ── 3. It serves images, not the filesystem ── */
    console.log("\n[3] the route stays a picture route:");
    for (const bad of [
      "/uploads/../../package.json",
      "/uploads/x/..%2f..%2fpackage.json",
      "/uploads/nope/missing.jpg",
      `/uploads/${yards[0]!.id}/9999-12-31/misc/vehicle-front-${stamp}.txt`,
    ]) {
      const r = await head(ctx.request, bad);
      check(`refused: ${bad}`, r.status === 404 || r.status === 400, String(r.status));
    }

    /* ── 4. The Owner's own screen renders them ── */
    console.log("\n[4] Owner → Sell → Dispatch Status:");
    await page.goto(`${BASE}/sell`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    const opened = await page.evaluate(async () => {
      const heads = [...document.querySelectorAll<HTMLButtonElement>(".rlHead")];
      for (const h of heads) {
        h.click();
        await new Promise((r) => setTimeout(r, 250));
        if (document.querySelector(".dispShots img")) return true;
      }
      return heads.length > 0;
    });
    check("a dispatch row could be expanded", opened);

    const shots = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLImageElement>(".dispShots img")].map((i) => ({
        src: i.getAttribute("src") ?? "",
        loaded: i.complete && i.naturalWidth > 0,
        href: (i.closest("a") as HTMLAnchorElement | null)?.getAttribute("href") ?? "",
      }))
    );
    if (shots.length === 0) {
      console.log("    (no dispatch photos on this yard's visible rows — covered by [1])");
    } else {
      check("every thumbnail actually decoded", shots.every((s) => s.loaded), JSON.stringify(shots.filter((s) => !s.loaded)));
      check("each thumbnail links at its own bytes", shots.every((s) => s.href === s.src));
      // Following the link is what produced "This page could not be found".
      for (const s of shots) {
        const r = await head(ctx.request, s.href);
        check(`clicking through returns an image: ${s.href.split("/").pop()}`, r.status === 200 && r.type.startsWith("image/"), String(r.status));
      }
    }

    console.log(`\n==== dispatch images: ${pass} passed, ${fail} failed ====`);
    await ctx.close();
  } finally {
    // Only the directories this test made; nothing pre-existing is touched.
    for (const dir of created) {
      if (/[/\\]uploads[/\\]newyard\d+$/.test(dir)) await fs.rm(dir, { recursive: true, force: true });
    }
    const stray = created.filter((d) => !/newyard\d+$/.test(d));
    for (const d of stray) await fs.rm(path.join(d, "9999-12-31"), { recursive: true, force: true });
    await browser.close();
    await db.$disconnect();
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
