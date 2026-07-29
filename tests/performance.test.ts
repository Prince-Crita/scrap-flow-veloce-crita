/**
 * Performance measurement across every page the operator and the admin use.
 *
 * Measures WARM medians, not cold first-hits. A cold Next.js route compiles and
 * fills caches; quoting that number would be measuring the framework's startup,
 * not the page. The median of N warm requests is what a user actually waits for
 * on the second and subsequent visits, which is nearly every visit.
 *
 * Reports p50 and p95. p95 matters because a page whose median is fine but
 * whose tail is 2s still feels broken at the weighbridge.
 *
 * Usage: app on :3001, then `npx tsx tests/performance.test.ts`
 */
import { TEST_MANAGER } from "./fixtures";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const ADMIN = { email: "admin@scrapflow.in", password: "ScrapFlow@2026" };
const WARMUP = 2;
const SAMPLES = 7;

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
      body: new URLSearchParams({ csrfToken: csrf.csrfToken, email, password, callbackUrl: `${BASE}/stock`, json: "true" }).toString(),
    });
  };
  return { req, login };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function measure(req: ReturnType<typeof makeClient>["req"], path: string) {
  for (let i = 0; i < WARMUP; i++) await req(path);
  const times: number[] = [];
  let status = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const t = Date.now();
    const res = await req(path);
    times.push(Date.now() - t);
    status = res.status;
  }
  return { p50: pct(times, 50), p95: pct(times, 95), status, times };
}

/** path, human name, p50 budget in ms */
const ADMIN_TARGETS: [string, string, number][] = [
  ["/api/admin/dashboard", "admin dashboard API", 500],
  ["/api/admin/analytics", "admin analytics API", 300],
  ["/admin", "admin overview page", 600],
  ["/admin/analytics", "admin analytics page", 600],
  ["/admin/audit", "admin audit page", 600],
];

const APP_TARGETS: [string, string, number][] = [
  ["/stock", "stock page", 600],
  ["/inward", "inward page", 600],
  ["/outward", "outward page", 600],
  ["/sort", "sort page", 600],
  ["/api/stock", "stock API", 500],
  ["/api/sort/pending", "sort pending API", 500],
];

async function main() {
  const rows: { name: string; p50: number; p95: number; budget: number; status: number }[] = [];

  const A = makeClient();
  await A.login(ADMIN.email, ADMIN.password);
  console.log("Admin surfaces:");
  for (const [path, name, budget] of ADMIN_TARGETS) {
    const r = await measure(A.req, path);
    rows.push({ name, ...r, budget });
    console.log(`  ${name.padEnd(24)} p50 ${String(r.p50).padStart(5)}ms  p95 ${String(r.p95).padStart(5)}ms  (budget ${budget}ms, http ${r.status})`);
  }

  const M = makeClient();
  await M.login(TEST_MANAGER.email, TEST_MANAGER.password);
  console.log("\nOperator surfaces:");
  for (const [path, name, budget] of APP_TARGETS) {
    const r = await measure(M.req, path);
    rows.push({ name, ...r, budget });
    console.log(`  ${name.padEnd(24)} p50 ${String(r.p50).padStart(5)}ms  p95 ${String(r.p95).padStart(5)}ms  (budget ${budget}ms, http ${r.status})`);
  }

  console.log("\nBudgets:");
  for (const r of rows) {
    check(`${r.name} responds`, r.status > 0 && r.status < 400, String(r.status));
    check(`${r.name} p50 ${r.p50}ms within ${r.budget}ms`, r.p50 <= r.budget, `${r.p50}ms`);
  }
  // A tail far above the median means an unstable query, not a slow one.
  console.log("\nTail stability (p95 must not be more than 3× p50 + 150ms):");
  for (const r of rows) {
    check(`${r.name} tail is stable`, r.p95 <= r.p50 * 3 + 150, `p50 ${r.p50} p95 ${r.p95}`);
  }

  console.log(`\n==== performance: ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
