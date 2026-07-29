/**
 * OCR accuracy benchmark.
 *
 * ── Why this is not a test ────────────────────────────────────────────────────
 * Accuracy cannot be asserted without ground truth, and the image corpus on disk
 * is unlabelled. Inventing a number would be worse than having none: it would be
 * quoted in a report and believed. So this is a *tool*, not a suite — it
 * detects whether labels exist, generates the labelling workflow if they do not,
 * and computes real statistics the moment they do.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   npm run ocr:benchmark                 measure (or scaffold labels if absent)
 *   npm run ocr:benchmark -- --init       (re)write the label template only
 *   npm run ocr:benchmark -- --read-rate  COVERAGE only — needs no labels
 *
 * ── --read-rate: what it is, and what it is NOT ───────────────────────────────
 * It reports how often the pipeline produces a *structurally valid* plate at all,
 * plus the confidence and latency distributions. That is **coverage, not
 * accuracy**: a confidently wrong plate counts as a read. It cannot tell you the
 * system is right — only whether a pipeline change made it produce more or fewer
 * usable answers, which is the one thing that IS comparable without ground truth.
 * Every figure is written to `read-rate.json` so two runs can be diffed.
 *
 * Labels live in `ocr-service/benchmark/labels.json`:
 *
 *   {
 *     "vehicle-front-1784718022549.jpg": "MH12AB1234",
 *     "vehicle-front-1784719446275.jpg": null      // no plate legible: a
 *   }                                              // NEGATIVE case, not a skip
 *
 * `null` is meaningful — it is how false positives are measured. A file left as
 * the placeholder string is treated as unlabelled and excluded.
 *
 * Read-only against the app and the database. It only POSTs images to /api/ocr.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { TEST_OWNER } from "./fixtures";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const UPLOADS = join(process.cwd(), "public", "uploads");
const BENCH_DIR = join(process.cwd(), "ocr-service", "benchmark");
const LABELS = join(BENCH_DIR, "labels.json");
const REPORT = join(BENCH_DIR, "last-report.json");
const READ_RATE_REPORT = join(BENCH_DIR, "read-rate.json");
const PLACEHOLDER = "<UNLABELLED — set the plate, or null if none is legible>";

/** OCR is rate-limited to 20/min per user; stay under it deliberately. */
const REQUESTS_PER_MINUTE = 18;

function findImages(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findImages(p, out);
    else if (/vehicle-(front|back).*\.(jpe?g|png|webp)$/i.test(e.name)) out.push(p);
  }
  return out;
}

const nameOf = (p: string) => p.split(/[\\/]/).pop()!;

function toDataUrl(path: string): string {
  const mime = /\.png$/i.test(path) ? "image/png" : /\.webp$/i.test(path) ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}

/** Levenshtein, for character-level accuracy alongside exact-match. */
function editDistance(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i, ...Array(n).fill(0)];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function makeClient() {
  let cookies: Record<string, string> = {};
  const ch = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const req = async (path: string, opts: RequestInit = {}) => {
    const res = await fetch(BASE + path, {
      ...opts,
      headers: { ...(opts.headers || {}), cookie: ch() },
      redirect: "manual",
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [p] = c.split(";");
      const i = p.indexOf("=");
      cookies[p.slice(0, i)] = p.slice(i + 1);
    }
    return res;
  };
  const login = async (email: string, password: string) => {
    cookies = {};
    const csrf = await (await req("/api/auth/csrf")).json();
    await req("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrfToken: csrf.csrfToken,
        email,
        password,
        callbackUrl: BASE + "/stock",
        json: "true",
      }).toString(),
    });
  };
  return { req, login };
}

type Labels = Record<string, string | null>;

/** Write a template covering every image, preserving anything already labelled. */
function scaffold(images: string[]): Labels {
  mkdirSync(BENCH_DIR, { recursive: true });
  const existing: Labels = existsSync(LABELS) ? JSON.parse(readFileSync(LABELS, "utf8")) : {};
  const out: Labels = {};
  for (const p of images) {
    const n = nameOf(p);
    out[n] = n in existing ? existing[n] : (PLACEHOLDER as unknown as string);
  }
  writeFileSync(LABELS, JSON.stringify(out, null, 2) + "\n", "utf8");
  return out;
}

const isLabelled = (v: unknown) => v === null || (typeof v === "string" && v !== PLACEHOLDER && v.trim() !== "");
const normalise = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Indian registration grammar, mirroring STANDARD_RE / BHARAT_RE in plate.py. */
const STRUCTURAL = /^([A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{3,4}|[0-9]{2}BH[0-9]{4}[A-Z]{1,2})$/;

/**
 * Coverage run: no labels required.
 *
 * Answers "how often does the pipeline produce a usable plate at all, and how hard
 * did it work?" — which is what tells you whether a pipeline change helped. It
 * deliberately does NOT claim accuracy; a confidently wrong plate counts as a read
 * here, and the output says so.
 */
async function readRate(images: string[], fileCount: number, duplicates: number) {
  const C = makeClient();
  await C.login(TEST_OWNER.email, TEST_OWNER.password);

  const gapMs = Math.ceil(60_000 / REQUESTS_PER_MINUTE);
  let read = 0,
    structural = 0,
    fallback = 0,
    snapped = 0,
    limited = 0,
    measured = 0;
  const confs: number[] = [];
  const times: number[] = [];
  const attempts: number[] = [];
  const perImage: { image: string; plate: string | null; confidence: number; attempts: number }[] = [];

  let i = 0;
  for (const path of images) {
    i++;
    process.stdout.write(`\r  measuring ${i}/${images.length}…   `);
    const t0 = Date.now();
    const res = await C.req("/api/ocr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: toDataUrl(path) }),
    });
    if (res.status === 429) {
      limited++;
      await new Promise((r) => setTimeout(r, gapMs));
      continue;
    }
    const elapsed = Date.now() - t0;
    const body = (await res.json()) as {
      data?: Record<string, unknown>;
      plate?: string | null;
      confidence?: number;
      attempts?: number;
      fallback?: boolean;
      snapped?: boolean;
    };
    const d = (body.data ?? body) as {
      plate?: string | null;
      confidence?: number;
      attempts?: number;
      fallback?: boolean;
      snapped?: boolean;
    };
    measured++;
    times.push(elapsed);
    attempts.push(d.attempts ?? 0);
    if (d.fallback) fallback++;
    if (d.snapped) snapped++;
    const plate = d.plate ? normalise(d.plate) : null;
    if (plate) {
      read++;
      confs.push(d.confidence ?? 0);
      if (STRUCTURAL.test(plate)) structural++;
    }
    perImage.push({ image: nameOf(path), plate, confidence: d.confidence ?? 0, attempts: d.attempts ?? 0 });
    await new Promise((r) => setTimeout(r, gapMs));
  }
  process.stdout.write("\r");

  const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);
  const report = {
    generatedAt: new Date().toISOString(),
    kind: "coverage",
    note: "COVERAGE, NOT ACCURACY — a confidently wrong plate counts as a read. Comparable between runs only.",
    uniquePhotographs: images.length,
    filesOnDisk: fileCount,
    duplicateFiles: duplicates,
    measured,
    rateLimitedSkips: limited,
    returnedAPlate: read,
    readRate: measured ? read / measured : 0,
    structurallyValid: structural,
    structuralRate: measured ? structural / measured : 0,
    degradedToManualEntry: fallback,
    correctedFromYardHistory: snapped,
    medianConfidence: median(confs),
    confidenceAtOrAbove080: confs.filter((c) => c >= 0.8).length,
    medianLatencyMs: median(times),
    medianPreprocessingAttempts: median(attempts),
    perImage,
  };
  mkdirSync(BENCH_DIR, { recursive: true });
  writeFileSync(READ_RATE_REPORT, JSON.stringify(report, null, 2));

  console.log("\n════════ OCR COVERAGE (not accuracy) ════════\n");
  console.log(`  distinct photographs      ${images.length}  (${fileCount} files on disk, ${duplicates} duplicates)`);
  console.log(`  measured                  ${measured}  (${limited} rate-limit skips)`);
  console.log(`  returned a plate          ${read}  (${pct(read, measured)})`);
  console.log(`  structurally valid plate  ${structural}  (${pct(structural, measured)})`);
  console.log(`  degraded to manual entry  ${fallback}  (${pct(fallback, measured)})`);
  console.log(`  corrected by yard history ${snapped}`);
  console.log(`  median confidence         ${report.medianConfidence.toFixed(3)}`);
  console.log(`  confidence ≥ 0.80         ${report.confidenceAtOrAbove080} of ${read} reads`);
  console.log(`  median latency            ${report.medianLatencyMs} ms`);
  console.log(`  median preprocessing passes ${report.medianPreprocessingAttempts}`);
  console.log(`\n  written to ${READ_RATE_REPORT}`);
  console.log(
    [
      "",
      "  This is COVERAGE, not accuracy. It cannot tell you the plates are right —",
      "  only whether a pipeline change made the service produce more or fewer usable",
      "  answers. For accuracy, label ocr-service/benchmark/labels.json and run",
      "  `npm run ocr:benchmark` without --read-rate.",
      "",
    ].join("\n")
  );
}

/**
 * One entry per DISTINCT photograph.
 *
 * The corpus on disk is overwhelmingly duplicates — the prototype flow re-uploaded
 * the same captures under fresh timestamps. Scoring per file would weight each
 * photograph by how often it happened to be re-uploaded, so a single image
 * duplicated 134 times would dominate every statistic. Deduplicating by content
 * hash makes the sample size honest, which matters far more here than it would with
 * a real corpus: it is the difference between "97% over 158 images" and the truth.
 */
function dedupeByContent(paths: string[]): { unique: string[]; duplicates: number } {
  const byHash = new Map<string, string>();
  for (const p of paths) {
    const h = createHash("sha1").update(readFileSync(p)).digest("hex");
    if (!byHash.has(h)) byHash.set(h, p);
  }
  return { unique: [...byHash.values()], duplicates: paths.length - byHash.size };
}

async function main() {
  const allFiles = findImages(UPLOADS);
  const { unique: images, duplicates } = dedupeByContent(allFiles);
  console.log(`Corpus: ${allFiles.length} vehicle files under public/uploads/`);
  console.log(`Distinct photographs: ${images.length} (${duplicates} duplicates ignored)`);
  if (images.length > 0 && images.length < 20) {
    console.log(
      `\n⚠ SAMPLE SIZE ${images.length}. Far too small to characterise accuracy —` +
        ` treat every figure below as a smoke test, not a measurement.\n`
    );
  }
  if (images.length === 0) {
    console.log("No vehicle images found — nothing to benchmark.");
    return;
  }

  if (process.argv.includes("--read-rate")) {
    await readRate(images, allFiles.length, duplicates);
    return;
  }

  const initOnly = process.argv.includes("--init");
  const labels = scaffold(images);
  const labelled = Object.entries(labels).filter(([, v]) => isLabelled(v));

  console.log(`Labels file: ${LABELS}`);
  console.log(`Labelled: ${labelled.length} / ${images.length}`);

  if (initOnly || labelled.length === 0) {
    console.log(
      [
        "",
        "════════ ACCURACY CANNOT BE MEASURED YET ════════",
        "",
        "The corpus is unlabelled, so detection/recognition/precision/recall are",
        "undefined. No number is reported here, by design.",
        "",
        "To produce a real benchmark:",
        `  1. Open ${LABELS}`,
        "  2. For each image set the correct plate, e.g. \"MH12AB1234\"",
        "     — set null if no plate is legible (that is how false positives are",
        "       measured, so do NOT delete those entries)",
        "     — leave the placeholder on any image you have not judged",
        "  3. Re-run: npm run ocr:benchmark",
        "",
        "Partial labelling is fine: statistics are computed over labelled images",
        "only, and the sample size is reported alongside every figure.",
        "",
      ].join("\n")
    );
    return;
  }

  // ── Measure ───────────────────────────────────────────────────────────────
  const C = makeClient();
  await C.login(TEST_OWNER.email, TEST_OWNER.password);

  const byName = new Map(images.map((p) => [nameOf(p), p]));
  let detected = 0, // service returned some plate
    exact = 0, // returned plate === truth
    falsePos = 0, // truth is null but a plate was returned
    falseNeg = 0, // truth is a plate but none returned
    trueNeg = 0,
    charDist = 0,
    charLen = 0,
    confSum = 0,
    confN = 0,
    timeSum = 0,
    limited = 0;
  const failures: { image: string; expected: string | null; got: string | null; conf: number }[] = [];

  const gapMs = Math.ceil(60_000 / REQUESTS_PER_MINUTE);
  let i = 0;
  for (const [name, truth] of labelled) {
    const path = byName.get(name);
    if (!path) continue;
    i++;
    process.stdout.write(`\r  measuring ${i}/${labelled.length}…`);

    const t0 = Date.now();
    const res = await C.req("/api/ocr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: toDataUrl(path) }),
    });
    const elapsed = Date.now() - t0;

    if (res.status === 429) {
      limited++;
      await new Promise((r) => setTimeout(r, 60_000 / REQUESTS_PER_MINUTE));
      continue;
    }
    timeSum += elapsed;
    const body = (await res.json()) as { plate: string | null; confidence: number };
    const got = body.plate ? normalise(body.plate) : null;
    const want = typeof truth === "string" ? normalise(truth) : null;
    if (typeof body.confidence === "number" && got) {
      confSum += body.confidence;
      confN++;
    }

    if (got) detected++;
    if (want === null) {
      if (got) {
        falsePos++;
        failures.push({ image: name, expected: null, got, conf: body.confidence });
      } else trueNeg++;
    } else if (!got) {
      falseNeg++;
      failures.push({ image: name, expected: want, got: null, conf: body.confidence });
    } else {
      charDist += editDistance(got, want);
      charLen += want.length;
      if (got === want) exact++;
      else failures.push({ image: name, expected: want, got, conf: body.confidence });
    }

    await new Promise((r) => setTimeout(r, gapMs));
  }
  process.stdout.write("\r");

  const positives = labelled.filter(([, v]) => typeof v === "string").length;
  const negatives = labelled.length - positives;
  const measured = labelled.length - limited;
  const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);

  // Precision/recall over "did it produce a correct plate": a wrong read is not a
  // success, so exact matches are the only true positives.
  const precision = detected === 0 ? 0 : exact / detected;
  const recall = positives === 0 ? 0 : exact / positives;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const report = {
    generatedAt: new Date().toISOString(),
    corpusImages: images.length,
    labelled: labelled.length,
    measured,
    rateLimitedSkips: limited,
    positives,
    negatives,
    detectionRate: positives === 0 ? null : detected / positives,
    recognitionRateExact: positives === 0 ? null : exact / positives,
    characterAccuracy: charLen === 0 ? null : 1 - charDist / charLen,
    precision,
    recall,
    f1,
    falsePositives: falsePos,
    falseNegatives: falseNeg,
    trueNegatives: trueNeg,
    averageConfidence: confN === 0 ? null : confSum / confN,
    averageProcessingMs: measured === 0 ? null : Math.round(timeSum / measured),
    failures: failures.slice(0, 40),
  };

  mkdirSync(BENCH_DIR, { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("\n════════ OCR BENCHMARK ════════");
  console.log(`Sample: ${measured} measured of ${labelled.length} labelled (${positives} with a plate, ${negatives} without)`);
  if (limited > 0) console.log(`  ⚠ ${limited} skipped by the rate limiter — re-run to include them`);
  console.log(`Detection rate      ${pct(detected, positives)}   (a plate was returned)`);
  console.log(`Recognition (exact) ${pct(exact, positives)}   (returned plate is correct)`);
  console.log(`Character accuracy  ${charLen === 0 ? "n/a" : `${((1 - charDist / charLen) * 100).toFixed(1)}%`}`);
  console.log(`Precision           ${(precision * 100).toFixed(1)}%`);
  console.log(`Recall              ${(recall * 100).toFixed(1)}%`);
  console.log(`F1                  ${(f1 * 100).toFixed(1)}%`);
  console.log(`False positives     ${falsePos}`);
  console.log(`False negatives     ${falseNeg}`);
  console.log(`Avg confidence      ${confN === 0 ? "n/a" : confSum / confN < 1 ? (confSum / confN).toFixed(3) : "?"}`);
  console.log(`Avg processing       ${measured === 0 ? "n/a" : `${Math.round(timeSum / measured)}ms`}`);
  console.log(`\nFull report: ${REPORT}`);
  if (failures.length > 0) {
    console.log(`\nFirst mismatches (${Math.min(10, failures.length)} of ${failures.length}):`);
    for (const f of failures.slice(0, 10)) {
      console.log(`  ${f.image}  expected=${f.expected ?? "(none)"}  got=${f.got ?? "(none)"}  conf=${f.conf}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
