/**
 * Rasterise the company logo into every Android mipmap density.
 *
 *   npm run android:icons && npm run cap:sync
 *
 * Kept as a script rather than hand-placed PNGs so the launcher icons are
 * reproducible from the logo: if the mark ever changes, re-run this instead of
 * editing eighteen bitmaps by hand.
 *
 * Source of truth is `public/icon.svg` — the same mark the web app, the PWA
 * manifest and `public/apple-touch-icon.png` already use. It is rendered at
 * each size and nothing else: no crop, no pad, no recolour, no added
 * background, no corner rounding. The logo's own rounded-rect edge and its own
 * dark fill are part of the artwork and are reproduced as-is.
 */
import { promises as fs } from "fs";
import path from "path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const SVG = path.join(ROOT, "public", "icon.svg");
const RES = path.join(ROOT, "android", "app", "src", "main", "res");

/** dp sizes per density bucket, as Android defines them. */
const DENSITY: [string, number][] = [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
];

/** Legacy launcher icon is 48dp; the adaptive foreground layer is 108dp. */
const TARGETS: { name: string; dp: number }[] = [
  { name: "ic_launcher", dp: 48 },
  { name: "ic_launcher_round", dp: 48 },
  { name: "ic_launcher_foreground", dp: 108 },
];

async function main() {
  const svg = await fs.readFile(SVG, "utf8");
  const browser = await chromium.launch();
  const page = await browser.newPage();

  for (const [bucket, scale] of DENSITY) {
    for (const t of TARGETS) {
      const px = Math.round(t.dp * scale);
      await page.setViewportSize({ width: px, height: px });
      // Transparent page: the logo's own corners must stay transparent rather
      // than being filled with a colour this script invented.
      await page.setContent(
        `<!doctype html><meta charset="utf-8">
         <style>
           html,body{margin:0;padding:0;background:transparent;}
           svg{display:block;width:${px}px;height:${px}px;}
         </style>${svg}`,
        { waitUntil: "load" }
      );
      const buf = await page.screenshot({ omitBackground: true, type: "png" });
      const out = path.join(RES, `mipmap-${bucket}`, `${t.name}.png`);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, buf);
      console.log(`${path.relative(ROOT, out)}  ${px}x${px}`);
    }
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
