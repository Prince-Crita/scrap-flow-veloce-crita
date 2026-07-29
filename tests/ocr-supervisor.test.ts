/**
 * OCR service supervision (auto-start, health, recovery).
 *
 * The requirement being tested is operational, not functional: **starting the app
 * must be the only command anyone runs.** No `docker run`, no `pip install`, no
 * `python app.py`. So this suite asserts the state of the world after nothing but
 * `npm run start`.
 *
 * It also asserts the rule that outranks everything else here: OCR being absent,
 * broken or mid-restart must never break the app or remove manual entry.
 *
 * Read-only with respect to yard data. It DOES kill the OCR child process to
 * prove automatic recovery — never the app, and never any database row.
 *
 * Usage: start the app, then `npx tsx tests/ocr-supervisor.test.ts`.
 */
import { execSync } from "node:child_process";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@scrapflow.in";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ScrapFlow@2026";
const OCR_URL = process.env.OCR_SERVICE_URL || "http://localhost:8000";

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
      body: new URLSearchParams({
        csrfToken: csrf.csrfToken,
        email,
        password,
        callbackUrl: BASE + "/admin",
        json: "true",
      }).toString(),
    });
  };
  return { req, login };
}

type Status = {
  state: string;
  detail: string;
  managed: boolean;
  components: Record<string, boolean> | null;
  lastHealthyAt: string | null;
  restarts: number;
  pid: number | null;
  url: string | null;
};

const READY_STATES = ["ready", "degraded"];

async function serviceAnswers(): Promise<boolean> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3000);
    const r = await fetch(`${OCR_URL.replace(/\/$/, "")}/health`, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

async function statusOf(AD: ReturnType<typeof makeClient>): Promise<Status> {
  const r = await AD.req("/api/admin/ocr-status");
  return (await r.json()).ocr as Status;
}

async function main() {
  const AD = makeClient();
  await AD.login(ADMIN_EMAIL, ADMIN_PASSWORD);

  // ── The headline requirement ──────────────────────────────────────────────
  console.log("Auto-start: nothing but `npm run start` was run.");
  const answering = await serviceAnswers();
  check("the OCR service is answering without any manual command", answering, `no response on ${OCR_URL}/health`);

  const s0 = await statusOf(AD);
  console.log(`  state=${s0.state} managed=${s0.managed} pid=${s0.pid ?? "—"} components=${JSON.stringify(s0.components)}`);
  check("the supervisor reports a state", typeof s0.state === "string" && s0.state.length > 0);
  check("the supervisor is not 'disabled'", s0.state !== "disabled", s0.detail);
  check("the state is one the admin panel can explain", ["starting", "ready", "degraded", "unreachable", "unavailable"].includes(s0.state), s0.state);
  if (answering) {
    check("an answering service is reported as ready or degraded", READY_STATES.includes(s0.state), `${s0.state}: ${s0.detail}`);
    check("the supervisor recorded a healthy timestamp", !!s0.lastHealthyAt);
    check("component availability is reported", s0.components !== null, JSON.stringify(s0.components));
    // Distinguishing "up" from "up and able to read" is the whole point of the
    // degraded state — a service with no recogniser can never return a plate.
    if (s0.components && s0.components.ocr === false) {
      check("a service with no recogniser is 'degraded', not 'ready'", s0.state === "degraded", s0.state);
      check("the detail names what is missing", /not loaded/.test(s0.detail), s0.detail);
    }
    if (s0.components && s0.components.ocr === true) {
      check("a service with a recogniser is 'ready'", s0.state === "ready", `${s0.state}: ${s0.detail}`);
    }
  }
  check("the supervisor owns the process it started", s0.managed === true || !answering, `managed=${s0.managed}`);

  // ── Status is admin-only ──────────────────────────────────────────────────
  console.log("\nStatus visibility:");
  const anon = await fetch(`${BASE}/api/admin/ocr-status`, { redirect: "manual" });
  check("an anonymous caller cannot read OCR status", anon.status >= 300, String(anon.status));

  console.log("\nThe admin dashboard carries the status:");
  const dash = await (await AD.req("/api/admin/dashboard")).json();
  check("the dashboard includes an ocr block", !!dash.ocr, "missing");
  check("it agrees with the dedicated endpoint", dash.ocr?.state === s0.state, `${dash.ocr?.state} vs ${s0.state}`);
  // Health must not cost a query — it comes from the supervisor's cached view.
  const t0 = Date.now();
  await AD.req("/api/admin/ocr-status");
  check("status is cheap (no database round trip)", Date.now() - t0 < 400, `${Date.now() - t0}ms`);

  // ── The app never depends on OCR ──────────────────────────────────────────
  console.log("\nThe app is independent of OCR:");
  // /admin as the signed-in admin; /login anonymously, because a signed-in client
  // is redirected away from it (307) — which would be a false failure here.
  const adminPage = await AD.req("/admin");
  check("/admin serves regardless of OCR state", adminPage.status === 200, String(adminPage.status));
  const loginPage = await fetch(`${BASE}/login`, { redirect: "manual" });
  check("/login serves regardless of OCR state", loginPage.status === 200, String(loginPage.status));

  // ── Automatic recovery ────────────────────────────────────────────────────
  console.log("\nAutomatic recovery after the service dies:");
  if (!answering || !s0.pid) {
    console.log("  … service not running under supervision; recovery test skipped");
  } else {
    const pid = s0.pid;
    try {
      // Kill only the OCR child. The app is untouched.
      if (process.platform === "win32") execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
      else execSync(`kill -9 ${pid}`, { stdio: "ignore" });
      check(`the OCR process (pid ${pid}) was killed to test recovery`, true);
    } catch (e) {
      check("could not kill the OCR process", false, String(e));
    }

    // The app must keep serving with OCR gone.
    const during = await AD.req("/admin");
    check("the app still serves with OCR dead", during.status === 200, String(during.status));
    const dStatus = await statusOf(AD);
    check("status is still readable with OCR dead", typeof dStatus.state === "string");

    // The watchdog backoff starts at 2s; allow generous headroom for a model
    // process to bind its port again.
    console.log("  waiting for the supervisor to bring it back…");
    let recovered = false;
    let recoveredState = "";
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const st = await statusOf(AD);
      recoveredState = `${st.state} (${st.detail})`;
      if (READY_STATES.includes(st.state) && (await serviceAnswers())) {
        recovered = true;
        break;
      }
    }
    check("the supervisor restarted the service automatically", recovered, `last state: ${recoveredState}`);
    if (recovered) {
      const after = await statusOf(AD);
      check("the restart was counted", after.restarts >= 1, String(after.restarts));
      check("a new process id is reported", after.pid !== null && after.pid !== pid, `${after.pid} vs ${pid}`);
    }
  }

  // ── Manual fallback survives all of it ────────────────────────────────────
  console.log("\nManual entry remains the fallback:");
  const y = makeClient();
  await y.login(process.env.TEST_OWNER_EMAIL || "test-owner@veloce.test", process.env.TEST_OWNER_PASSWORD || "testowner123");
  const tiny =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
  const ocrRes = await y.req("/api/ocr", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: tiny }),
  });
  check("an OCR request never returns a server error", ocrRes.status < 500, String(ocrRes.status));
  if (ocrRes.status === 200) {
    const b = await ocrRes.json();
    check("the reply always carries a plate field (null is valid)", "plate" in b);
    check("the reply always carries a fallback flag", "fallback" in b);
    check("a failed read leaves the operator able to type", b.fallback === true || typeof b.plate === "string" || b.plate === null);
  } else {
    check("a rate-limited OCR request is still not an error", ocrRes.status === 429, String(ocrRes.status));
  }

  console.log(`\n==== ocr supervisor: ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
