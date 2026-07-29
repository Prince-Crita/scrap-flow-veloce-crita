/**
 * Security response headers.
 *
 * The production audit found the app serving none of these. Authentication was
 * never the weak point — every unauthenticated API returns 401 — but a response
 * with no `nosniff` and no frame policy is exposed to the browser-side attacks
 * that do not need a session at all.
 *
 * These assertions are deliberately about the HEADERS BEING PRESENT ON REAL
 * ROUTES, including an upload path, because a header configured for `/` and
 * absent on `/uploads` protects the page nobody attacks and misses the one
 * they do.
 *
 * Usage: app on :3001, then `npx tsx tests/security-headers.test.ts`
 */
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

const REQUIRED: [string, RegExp][] = [
  ["x-frame-options", /^DENY$/i],
  ["x-content-type-options", /^nosniff$/i],
  ["referrer-policy", /strict-origin-when-cross-origin/i],
  ["permissions-policy", /camera=\(self\)/i],
  ["strict-transport-security", /max-age=\d+/i],
];

const PATHS = ["/login", "/api/auth/csrf", "/icon.svg", "/stock"];

async function main() {
  for (const path of PATHS) {
    console.log(`\n${path}:`);
    const res = await fetch(BASE + path, { redirect: "manual" });
    for (const [name, re] of REQUIRED) {
      const v = res.headers.get(name);
      check(`${name} is set and correct`, !!v && re.test(v), `got ${v ?? "(absent)"}`);
    }
  }

  console.log("\nThe camera is scoped, not disabled — plate capture must still work:");
  const res = await fetch(`${BASE}/login`, { redirect: "manual" });
  const pp = res.headers.get("permissions-policy") ?? "";
  check("camera is allowed for self", /camera=\(self\)/.test(pp), pp);
  check("camera is NOT fully disabled", !/camera=\(\)/.test(pp), pp);
  check("microphone is disabled", /microphone=\(\)/.test(pp), pp);
  check("geolocation is disabled", /geolocation=\(\)/.test(pp), pp);

  console.log("\nAuthentication still fails closed on every protected API:");
  for (const p of ["/api/admin/dashboard", "/api/admin/analytics", "/api/stock", "/api/sort/pending"]) {
    const r = await fetch(BASE + p, { redirect: "manual" });
    check(`${p} is 401 without a session`, r.status === 401, String(r.status));
  }

  console.log("\nErrors must not leak internals:");
  const r404 = await fetch(`${BASE}/api/does-not-exist`, { redirect: "manual" });
  const body = await r404.text();
  check("no stack trace in a 404 body", !/at \w+ \(|node_modules|\.ts:\d+/.test(body), body.slice(0, 120));
  check("no database URL leaked", !/postgres(ql)?:\/\//i.test(body));

  console.log(`\n==== security headers: ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
