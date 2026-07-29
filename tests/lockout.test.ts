/**
 * Per-account login lockout.
 *
 * Drives real sign-ins over HTTP so the Auth.js `authorize()` path is exercised
 * end to end — a unit test of the helper would not catch the lockout being wired
 * in the wrong order relative to the bcrypt check, which is the thing that
 * actually matters.
 *
 * Operates on a DISPOSABLE user it creates in the sandbox yard, never on the
 * shared sandbox owner/manager: locking those would fail every later suite.
 * Yard 1 accounts are never touched.
 *
 * Requires the app running on :3001 and a build containing the lockout wiring.
 * Usage: `npx tsx tests/lockout.test.ts`
 */
import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { TEST_YARD_CODE } from "./fixtures";

const prisma = new PrismaClient();
const BASE = process.env.BASE_URL || "http://localhost:3001";
const ADMIN = { email: "admin@scrapflow.in", password: "ScrapFlow@2026" };

const VICTIM_EMAIL = `lockout-probe@veloce.test`;
const VICTIM_PASSWORD = "lockoutprobe123";

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
  /** Returns true when the session cookie was actually issued. */
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
    const session = await (await req("/api/auth/session")).json().catch(() => null);
    return !!session?.user?.email;
  };
  return { req, login };
}

async function attemptState() {
  return prisma.loginAttempt.findUnique({ where: { email: VICTIM_EMAIL } });
}

async function main() {
  const yard = await prisma.yard.findUniqueOrThrow({ where: { yardCode: TEST_YARD_CODE } });

  // ── Disposable victim account, sandbox yard only ────────────────────────────
  await prisma.user.upsert({
    where: { email: VICTIM_EMAIL },
    update: { yardId: yard.id, role: Role.MANAGER, active: true, mustChangePassword: false },
    create: {
      email: VICTIM_EMAIL,
      name: "Lockout Probe",
      passwordHash: await bcrypt.hash(VICTIM_PASSWORD, 10),
      role: Role.MANAGER,
      yardId: yard.id,
    },
  });
  await prisma.loginAttempt.deleteMany({ where: { email: VICTIM_EMAIL } });

  try {
    const c = makeClient();

    console.log("Baseline:");
    check("the probe account can sign in before any failures", await c.login(VICTIM_EMAIL, VICTIM_PASSWORD));
    check("a successful sign-in records lastSuccessAt", !!(await attemptState())?.lastSuccessAt);

    console.log("\nFailed attempts accumulate:");
    for (let i = 1; i <= 4; i++) {
      const okLogin = await c.login(VICTIM_EMAIL, "definitely-wrong");
      check(`attempt ${i} with a wrong password is rejected`, okLogin === false);
    }
    const after4 = await attemptState();
    check("four consecutive failures are counted", after4?.failedCount === 4, JSON.stringify(after4));
    check("the account is not locked below the threshold", !after4?.lockedUntil, JSON.stringify(after4?.lockedUntil));

    console.log("\nThe threshold locks the account:");
    check("attempt 5 is rejected", (await c.login(VICTIM_EMAIL, "definitely-wrong")) === false);
    const locked = await attemptState();
    check("lockedUntil is set", !!locked?.lockedUntil, JSON.stringify(locked));
    check("lockedUntil is in the future", !!locked?.lockedUntil && locked.lockedUntil.getTime() > Date.now());
    check("lockCount incremented to 1", locked?.lockCount === 1, String(locked?.lockCount));
    check("the failure streak reset on lock", locked?.failedCount === 0, String(locked?.failedCount));

    console.log("\nA locked account is refused even with the CORRECT password:");
    check("correct credentials do not bypass the lock", (await c.login(VICTIM_EMAIL, VICTIM_PASSWORD)) === false);
    // The lock must not be extended by attempts made while already locked —
    // otherwise an attacker could keep a real operator locked out indefinitely.
    const during = await attemptState();
    check(
      "an attempt during the lock does not extend it",
      during?.lockedUntil?.getTime() === locked?.lockedUntil?.getTime(),
      `${during?.lockedUntil} vs ${locked?.lockedUntil}`
    );

    console.log("\nThe lock is audited:");
    const entry = await prisma.auditLog.findFirst({
      where: { action: "LOGIN_LOCKED", entityId: VICTIM_EMAIL },
      orderBy: { createdAt: "desc" },
    });
    check("a LOGIN_LOCKED audit entry exists", !!entry, JSON.stringify(entry));
    check("the audit entry records the lock duration", !!(entry?.after as any)?.lockSeconds);

    console.log("\nAutomatic unlock:");
    // Expiry is time-based and implicit — no sweeper to trigger — so rewinding
    // lockedUntil is exactly equivalent to waiting it out.
    await prisma.loginAttempt.update({
      where: { email: VICTIM_EMAIL },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    check("an expired lock lets the account sign in again", await c.login(VICTIM_EMAIL, VICTIM_PASSWORD));
    const recovered = await attemptState();
    check("a successful sign-in clears lockedUntil", recovered?.lockedUntil === null, JSON.stringify(recovered));
    check("a successful sign-in clears the failure count", recovered?.failedCount === 0);
    check(
      "lockCount is retained after recovery (drives the backoff)",
      recovered?.lockCount === 1,
      String(recovered?.lockCount)
    );

    console.log("\nExponential backoff on the second lock:");
    for (let i = 0; i < 5; i++) await c.login(VICTIM_EMAIL, "definitely-wrong");
    const second = await attemptState();
    const firstMs = locked!.lockedUntil!.getTime() - (locked!.lastFailedAt ?? new Date()).getTime();
    const secondMs = second!.lockedUntil!.getTime() - (second!.lastFailedAt ?? new Date()).getTime();
    check("the account locked a second time", !!second?.lockedUntil && second.lockedUntil.getTime() > Date.now());
    check("lockCount incremented to 2", second?.lockCount === 2, String(second?.lockCount));
    check("the second lock is longer than the first", secondMs > firstMs, `${secondMs}ms vs ${firstMs}ms`);

    console.log("\nAdmin visibility and manual unlock:");
    const admin = makeClient();
    check("admin can sign in (unaffected by another account's lock)", await admin.login(ADMIN.email, ADMIN.password));

    const listRes = await admin.req("/api/admin/login-locks");
    check("GET /api/admin/login-locks returns 200 for admin", listRes.status === 200, String(listRes.status));
    const list = await listRes.json();
    const row = (list.data?.attempts ?? list.attempts ?? []).find((a: any) => a.email === VICTIM_EMAIL);
    check("the locked account appears in the admin list", !!row, JSON.stringify(list).slice(0, 200));
    check("it is reported as locked with a retryAfter", row?.locked === true && row?.retryAfter > 0, JSON.stringify(row));
    check("the configured threshold is exposed", (list.data?.config ?? list.config)?.threshold >= 1);

    const unlock = await admin.req("/api/admin/login-locks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: VICTIM_EMAIL }),
    });
    check("admin can unlock the account", unlock.status === 200, String(unlock.status));
    check("the lock is released", (await attemptState())?.lockedUntil === null);
    check("the unlocked account can sign in", await c.login(VICTIM_EMAIL, VICTIM_PASSWORD));
    const unlockAudit = await prisma.auditLog.findFirst({
      where: { action: "LOGIN_UNLOCKED", entityId: VICTIM_EMAIL },
    });
    check("the manual unlock is audited", !!unlockAudit);

    console.log("\nNon-admins cannot read the lock table:");
    const nonAdmin = makeClient();
    await nonAdmin.login(VICTIM_EMAIL, VICTIM_PASSWORD);
    const forbidden = await nonAdmin.req("/api/admin/login-locks");
    check("a MANAGER gets 403", forbidden.status === 403, String(forbidden.status));

    console.log("\nUnknown emails are not recorded:");
    const ghost = `ghost-${Date.now()}@veloce.test`;
    const g = makeClient();
    for (let i = 0; i < 3; i++) await g.login(ghost, "whatever");
    check(
      "no LoginAttempt row is created for an address with no account",
      (await prisma.loginAttempt.count({ where: { email: ghost } })) === 0
    );

    console.log("\nThe shared sandbox accounts are untouched:");
    for (const email of ["test-owner@veloce.test", "test-manager@veloce.test", ADMIN.email]) {
      const r = await prisma.loginAttempt.findUnique({ where: { email } });
      check(`${email} is not locked`, !r?.lockedUntil || r.lockedUntil.getTime() <= Date.now());
    }

    console.log(`\n==== lockout: ${pass} passed, ${fail} failed ====`);
  } finally {
    // Remove everything this suite created. Sandbox-scoped by construction.
    await prisma.auditLog.deleteMany({ where: { entityId: VICTIM_EMAIL, entity: "LoginAttempt" } });
    await prisma.loginAttempt.deleteMany({ where: { email: VICTIM_EMAIL } });
    await prisma.user.deleteMany({ where: { email: VICTIM_EMAIL } });
    await prisma.$disconnect();
  }
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
