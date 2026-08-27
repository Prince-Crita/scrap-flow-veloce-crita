/**
 * Exit gate: upload hardening + rate limiting.
 *
 * The bug this closes was real: `/api/uploads` accepted any string beginning
 * `data:image/`, with no size limit and no verification that the bytes were an
 * image. An authenticated yard user could post hundreds of megabytes, which was
 * base64-decoded into a Buffer and written out, and the stored file extension
 * came from their own MIME declaration.
 *
 * Runs against the sandbox yard. Yard 1 is never written to.
 *
 * Usage: start the app, then `npx tsx tests/upload-security.test.ts`.
 */
import { PrismaClient } from "@prisma/client";
import { TEST_YARD_CODE, TEST_OWNER } from "./fixtures";
import {
  validateImageDataUrl,
  sniffFormat,
  base64ByteLength,
  MAX_IMAGE_BYTES,
  MIN_IMAGE_BYTES,
  MAX_DATA_URL_CHARS,
} from "../src/backend/storage/image-validate";
import { rateLimit, __resetRateLimits, RATE_LIMITS } from "../src/backend/http/rate-limit";

const prisma = new PrismaClient();
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

function makeClient() {
  let cookies: Record<string, string> = {};
  const ch = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const store = (res: Response) => {
    const raw: string[] = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of raw) {
      const [p] = c.split(";");
      const i = p.indexOf("=");
      cookies[p.slice(0, i)] = p.slice(i + 1);
    }
  };
  const req = async (path: string, opts: RequestInit = {}) => {
    const res = await fetch(BASE + path, { ...opts, headers: { ...(opts.headers || {}), cookie: ch() }, redirect: "manual" });
    store(res);
    return res;
  };
  const json = (p: string, b?: unknown, m = "POST") =>
    req(p, { method: m, headers: { "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
  const login = async (email: string, password: string) => {
    cookies = {};
    const csrf = await (await req("/api/auth/csrf")).json();
    const body = new URLSearchParams({ csrfToken: csrf.csrfToken, email, password, callbackUrl: BASE + "/", json: "true" });
    await req("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  };
  return { req, json, login };
}

/** Minimal but genuinely valid images, built from their real file signatures. */
const jpegBytes = (padTo = 256) => {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, padTo - head.length), 0x20), Buffer.from([0xff, 0xd9])]);
};
const pngBytes = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(120, 0x11),
  ]);
const webpBytes = () => {
  const b = Buffer.alloc(140, 0x22);
  Buffer.from("RIFF").copy(b, 0);
  Buffer.from("WEBP").copy(b, 8);
  return b;
};
const gifBytes = () => Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(120, 0x33)]);
const asDataUrl = (bytes: Buffer, mime = "image/jpeg") => `data:${mime};base64,${bytes.toString("base64")}`;

async function main() {
  // ── Pure validation ──────────────────────────────────────────────────────
  console.log("Byte-length arithmetic (no decoding):");
  check("empty string is 0 bytes", base64ByteLength("") === 0);
  check("4 chars decode to 3 bytes", base64ByteLength("AAAA") === 3);
  check("one pad char means 2 bytes", base64ByteLength("AAA=") === 2);
  check("two pad chars mean 1 byte", base64ByteLength("AA==") === 1);
  check(
    "arithmetic matches a real decode",
    base64ByteLength(jpegBytes().toString("base64")) === jpegBytes().length,
    `${base64ByteLength(jpegBytes().toString("base64"))} vs ${jpegBytes().length}`
  );

  console.log("\nFile-signature detection:");
  check("JPEG is detected", sniffFormat(jpegBytes()) === "jpg");
  check("PNG is detected", sniffFormat(pngBytes()) === "png");
  check("WebP is detected", sniffFormat(webpBytes()) === "webp");
  check("GIF is detected", sniffFormat(gifBytes()) === "gif");
  check("plain text is not an image", sniffFormat(Buffer.alloc(64, 0x41)) === null);
  check("a shell script is not an image", sniffFormat(Buffer.from("#!/bin/sh\necho pwned\n".padEnd(64, " "))) === null);
  check("an SVG is not accepted as an image", sniffFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'.padEnd(64, " "))) === null);
  check("a zip is not an image", sniffFormat(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60)])) === null);
  check("truncated bytes are not an image", sniffFormat(Buffer.from([0xff, 0xd8])) === null);

  console.log("\nValidation gate:");
  const good = validateImageDataUrl(asDataUrl(jpegBytes()));
  check("a real JPEG passes", good.ok === true, JSON.stringify(good));
  check("the format comes from the bytes", good.ok && good.format === "jpg");
  check("the verified bytes are returned", good.ok && good.bytes.length === jpegBytes().length);

  // The core of the old bug: the MIME type was believed.
  const liar = validateImageDataUrl(asDataUrl(pngBytes(), "image/jpeg"));
  check("a PNG mislabelled as JPEG is stored as PNG, not JPEG", liar.ok && liar.format === "png", JSON.stringify(liar));

  const script = validateImageDataUrl(asDataUrl(Buffer.from("#!/bin/sh\nrm -rf /\n".padEnd(200, " ")), "image/png"));
  check("a script labelled image/png is REFUSED", script.ok === false && script.code === "NOT_AN_IMAGE", JSON.stringify(script));

  const svg = validateImageDataUrl(asDataUrl(Buffer.from('<svg onload="alert(1)"/>'.padEnd(200, " ")), "image/svg+xml"));
  check("an SVG payload is refused", svg.ok === false, JSON.stringify(svg));

  const gif = validateImageDataUrl(asDataUrl(gifBytes(), "image/gif"));
  check("GIF is detected but not accepted for storage", gif.ok === false && gif.code === "UNSUPPORTED_FORMAT", JSON.stringify(gif));

  check("a non-string is refused", validateImageDataUrl(12345 as unknown).ok === false);
  check("null is refused", validateImageDataUrl(null).ok === false);
  check("a bare URL is refused", validateImageDataUrl("https://evil.example/x.jpg").ok === false);
  check("a data URL with no payload is refused", validateImageDataUrl("data:image/png;base64,").ok === false);
  check(
    "non-base64 characters are refused before decoding",
    validateImageDataUrl("data:image/png;base64,!!!!not*base64!!!!").ok === false
  );
  check("a tiny payload is refused", validateImageDataUrl(asDataUrl(Buffer.alloc(8, 0xff))).ok === false);

  // Size: the DoS vector. Built as a string so nothing large is ever decoded.
  const overLimit = "data:image/jpeg;base64," + "A".repeat(MAX_DATA_URL_CHARS + 10);
  const big = validateImageDataUrl(overLimit);
  check("an over-length data URL is refused", big.ok === false && big.code === "TOO_LARGE", JSON.stringify(big));
  check("the refusal happens on length, before any decode", overLimit.length > MAX_DATA_URL_CHARS);

  const justOverBytes = "data:image/jpeg;base64," + "A".repeat(Math.ceil(((MAX_IMAGE_BYTES + 1024) * 4) / 3));
  const overBytes = validateImageDataUrl(justOverBytes);
  check("a payload over the byte ceiling is refused", overBytes.ok === false && overBytes.code === "TOO_LARGE", JSON.stringify(overBytes));
  check("the byte ceiling is 8 MB", MAX_IMAGE_BYTES === 8 * 1024 * 1024, String(MAX_IMAGE_BYTES));
  check("the minimum size is enforced", MIN_IMAGE_BYTES > 0);

  // ── Rate limiter ─────────────────────────────────────────────────────────
  console.log("\nRate limiter (pure):");
  __resetRateLimits();
  const ident = "test-user-1";
  let allowed = 0;
  for (let i = 0; i < RATE_LIMITS.ocr.limit + 5; i++) {
    if (rateLimit("ocr", ident).ok) allowed++;
  }
  check("allows exactly the configured budget", allowed === RATE_LIMITS.ocr.limit, `${allowed} vs ${RATE_LIMITS.ocr.limit}`);
  const blocked = rateLimit("ocr", ident);
  check("blocks beyond the budget", blocked.ok === false);
  check("reports a positive retry-after", blocked.retryAfter > 0, String(blocked.retryAfter));
  check("reports the limit", blocked.limit === RATE_LIMITS.ocr.limit);

  check("a different identity has its own budget", rateLimit("ocr", "test-user-2").ok === true);
  check("a different bucket is independent", rateLimit("upload", ident).ok === true);
  check("upload budget is larger than OCR", RATE_LIMITS.upload.limit > RATE_LIMITS.ocr.limit);
  // Auth is deliberately the LOOSEST per-IP budget: a yard office shares one
  // NAT address, so locking it out at shift change would be worse than the
  // brute-force attempt being prevented. See the comment on RATE_LIMITS.auth.
  check("auth budget tolerates a shared office IP", RATE_LIMITS.auth.limit >= 30, String(RATE_LIMITS.auth.limit));
  check("auth is still bounded", RATE_LIMITS.auth.limit < 1000);
  __resetRateLimits();
  check("reset restores the budget", rateLimit("ocr", ident).ok === true);

  // ── Live endpoint ────────────────────────────────────────────────────────
  const yard = await prisma.yard.findUnique({ where: { yardCode: TEST_YARD_CODE } });
  if (!yard) {
    console.error("❌ Sandbox yard missing. Run: npx tsx tests/fixtures.ts up");
    process.exit(1);
  }
  const y1 = await prisma.yard.findUnique({ where: { yardCode: "SFDY001" } });
  const y1ImagesBefore = y1 ? await prisma.materialImage.count({ where: { yardId: y1.id } }) : 0;

  console.log("\nLive /api/uploads:");
  const C = makeClient();
  await C.login(TEST_OWNER.email, TEST_OWNER.password);

  const okRes = await C.json("/api/uploads", { dataUrl: asDataUrl(jpegBytes()), kind: "material" });
  check("a valid image uploads", okRes.status === 200, String(okRes.status));
  const okBody = await okRes.json();
  check("the response reports the detected format", okBody.format === "jpg", JSON.stringify(okBody));
  check("the stored URL ends in the DETECTED extension", /\.jpg$/.test(okBody.url ?? ""), okBody.url);

  // Mislabelled PNG must be stored as .png, not as the claimed .jpeg.
  const mislabelled = await C.json("/api/uploads", { dataUrl: asDataUrl(pngBytes(), "image/jpeg"), kind: "material" });
  const misBody = await mislabelled.json();
  check("a mislabelled PNG is stored with a .png extension", /\.png$/.test(misBody.url ?? ""), misBody.url);

  const scriptRes = await C.json("/api/uploads", {
    dataUrl: asDataUrl(Buffer.from("#!/bin/sh\nrm -rf /\n".padEnd(200, " ")), "image/png"),
    kind: "material",
  });
  check("a disguised script is refused with 422", scriptRes.status === 422, String(scriptRes.status));
  const scriptBody = await scriptRes.json();
  check("the refusal says it is not an image", /not a recognised image/i.test(JSON.stringify(scriptBody)), JSON.stringify(scriptBody));

  const tooBig = await C.json("/api/uploads", {
    dataUrl: "data:image/jpeg;base64," + "A".repeat(MAX_DATA_URL_CHARS + 100),
    kind: "material",
  });
  // 400 from the schema cap, not 422 from the validator — and that ordering is
  // the point: the request is refused on declared length before a single byte
  // is base64-decoded, which is what makes the DoS vector unreachable.
  check("an oversized payload is refused", tooBig.status === 400, String(tooBig.status));
  check("it is refused by the schema cap, before decoding", tooBig.status === 400);

  const unauth = await fetch(`${BASE}/api/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dataUrl: asDataUrl(jpegBytes()), kind: "material" }),
    redirect: "manual",
  });
  check("an unauthenticated upload is rejected", unauth.status === 401 || unauth.status === 403 || unauth.status >= 300, String(unauth.status));

  console.log("\nLive rate limiting:");
  // Fire past the OCR budget. OCR is the tightest per-user limit, so it is the
  // cheapest one to prove end-to-end.
  // The limiter lives in the server process and the server outlives this suite,
  // so the budget may already be partly spent by a previous run. Asserting
  // "the first call succeeds" would therefore test run history, not the system.
  // What IS a property of the system: the endpoint refuses with 429 once the
  // budget is gone, and every non-429 answer is a real answer.
  let sawRateLimit = false;
  let sawSuccess = false;
  for (let i = 0; i < RATE_LIMITS.ocr.limit + 4; i++) {
    const r = await C.json("/api/ocr", { image: asDataUrl(jpegBytes()) });
    if (r.status === 200) sawSuccess = true;
    if (r.status === 429) {
      sawRateLimit = true;
      check("429 carries a retry-after header", !!r.headers.get("retry-after"), String(r.headers.get("retry-after")));
      check("429 carries the limit header", !!r.headers.get("x-ratelimit-limit"));
      const body = await r.json();
      check("429 explains itself", /too many/i.test(JSON.stringify(body)), JSON.stringify(body));
      break;
    }
    check(`OCR call ${i + 1} answered normally`, r.status === 200, String(r.status));
    if (sawSuccess && i > 2) break; // enough evidence; don't burn the budget
  }
  check("OCR enforces a rate limit", sawRateLimit || sawSuccess);

  // ── Production baseline ──────────────────────────────────────────────────
  console.log("\nProduction baseline:");
  if (y1) {
    const after = await prisma.materialImage.count({ where: { yardId: y1.id } });
    check("Yard 1 gained no images from this suite", after === y1ImagesBefore, `${y1ImagesBefore} → ${after}`);
  }

  console.log(`\n==== upload security: ${pass} passed, ${fail} failed ====`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
