/**
 * Model bootstrap contract.
 *
 * The plate detector was missing in production for the whole of the previous
 * session and nothing caught it: the service started, `/health` returned 200,
 * every OCR test passed, and localisation had silently fallen back to classical
 * morphology. `status: ok` was never evidence that the strongest path was live.
 *
 * These assertions are the ones that would have caught it — they check the
 * detector is actually LOADED, and that the acquisition path stays non-fatal so
 * an offline machine still starts.
 *
 * Usage: app on :3001 (which supervises the service), then
 *   npx tsx tests/ocr-model-bootstrap.test.ts
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = process.cwd();
const SERVICE = join(ROOT, "ocr-service");
const MODEL = join(SERVICE, "models", "license_plate_detector.pt");
const EXPECTED_SHA = "2d95861825bb4184404344c9cf809f40fd31dba785fe54e8ba5b9a3583789822";
const OCR = process.env.OCR_SERVICE_URL || "http://127.0.0.1:8000";

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

const python = () =>
  existsSync(join(SERVICE, ".venv", "Scripts", "python.exe"))
    ? join(SERVICE, ".venv", "Scripts", "python.exe")
    : process.platform === "win32"
      ? "python"
      : "python3";

async function main() {
  console.log("The weight is present and is the weight we pinned:");
  check("license_plate_detector.pt exists", existsSync(MODEL));
  if (existsSync(MODEL)) {
    check("it is a real weight, not a stub", statSync(MODEL).size > 1_000_000, `${statSync(MODEL).size} bytes`);
    const sha = createHash("sha256").update(await readFile(MODEL)).digest("hex");
    check("its SHA-256 matches the pinned value", sha === EXPECTED_SHA, sha.slice(0, 16));
  }

  console.log("\nThe service reports the detector as LOADED, not merely present:");
  try {
    const res = await fetch(`${OCR}/health`, { signal: AbortSignal.timeout(30_000) });
    check("/health is 200", res.status === 200, String(res.status));
    const h = (await res.json()) as Record<string, unknown>;
    // This is the assertion whose absence let a missing model ship.
    check("detector is TRUE", h.detector === true, JSON.stringify(h.detector));
    check("plate_model_found is a real path", typeof h.plate_model_found === "string" && !!h.plate_model_found, String(h.plate_model_found));
    check("vehicle detector is loaded", h.vehicle_detector === true);
    check("the OCR engine is loaded", h.ocr === true);
  } catch (e) {
    check("/health reachable", false, (e as Error).message);
  }

  console.log("\nAcquisition is idempotent — a second start costs nothing:");
  const t = Date.now();
  const { stdout } = await run(python(), ["bootstrap_models.py"], { cwd: SERVICE });
  const ms = Date.now() - t;
  check("it exits 0 when the weight is already correct", true);
  check("it does not re-download", !/fetching/.test(stdout), stdout.trim());
  check("it returns quickly (< 15s)", ms < 15_000, `${ms}ms`);

  console.log("\nAcquisition is never fatal — an offline machine must still start:");
  try {
    await run(python(), ["bootstrap_models.py"], {
      cwd: SERVICE,
      env: { ...process.env, OCR_PLATE_MODEL_URL: "https://127.0.0.1:9/nope.pt", OCR_MODELS_DIR: join(SERVICE, "models", "__probe") },
    });
    check("an unreachable host does not raise", true);
  } catch (e) {
    // exit 1 means "no detector available", which is the documented signal;
    // what must NOT happen is a traceback.
    const err = e as { code?: number; stderr?: string; stdout?: string };
    check("an unreachable host exits cleanly, no traceback", err.code === 1 && !/Traceback/.test(err.stderr ?? ""), err.stderr ?? "");
    check("it says it is continuing without a detector", /continuing with classical/.test(err.stdout ?? ""), err.stdout ?? "");
  }

  console.log("\nThe skip switch is honoured:");
  try {
    await run(python(), ["bootstrap_models.py"], { cwd: SERVICE, env: { ...process.env, OCR_SKIP_MODEL_FETCH: "1" } });
    check("OCR_SKIP_MODEL_FETCH=1 returns without downloading", true);
  } catch (e) {
    const err = e as { code?: number; stdout?: string };
    check("OCR_SKIP_MODEL_FETCH=1 exits 1 and downloads nothing", err.code === 1 && !/fetching/.test(err.stdout ?? ""), err.stdout ?? "");
  }

  console.log(`\n==== ocr model bootstrap: ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
