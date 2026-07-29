import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Lifecycle owner for the ANPR/OCR microservice.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * The OCR pipeline lives in a Python FastAPI process (YOLO + PaddleOCR) because
 * that is where the model ecosystem is. But a weighbridge operator must never be
 * asked to run a terminal command, and a yard must never be blocked because a
 * second process is not running. So the Next.js server owns the service: it
 * starts it, watches it, restarts it, and reports its state.
 *
 * ── Design rules ──────────────────────────────────────────────────────────────
 * 1. **Never block startup.** Spawning is fire-and-forget; the app serves
 *    requests immediately whether or not OCR ever comes up.
 * 2. **Never crash the app.** Every failure path here is caught and recorded as
 *    state, not thrown. A missing interpreter is a status, not an exception.
 * 3. **Adopt, don't duplicate.** If something already answers on the port — a
 *    container, a dev running it by hand, another instance — we attach to it
 *    instead of spawning a rival. Two model processes on one machine would fight
 *    over memory.
 * 4. **Backoff, don't hammer.** A service that cannot start (no deps installed)
 *    must not be respawned in a tight loop for the lifetime of the server.
 * 5. **Manual entry stays.** This raises the odds OCR is available; it does not
 *    change the rule that a failed read falls back to typing.
 *
 * Multi-instance note: only the process that successfully binds the port ends up
 * owning the child. Other instances health-check the same URL and adopt it.
 */

export type OcrState =
  /** No OCR_SERVICE_URL configured — the feature is switched off by deployment. */
  | "disabled"
  /** Spawned or adopted, waiting for /health to answer. */
  | "starting"
  /** /health answers and the model components are loaded. */
  | "ready"
  /** /health answers but the models are not usable — reads will be empty. */
  | "degraded"
  /** Was ready, has stopped answering; a restart is scheduled. */
  | "unreachable"
  /** Cannot be started here (no interpreter, deps missing) — manual entry only. */
  | "unavailable";

export type OcrStatus = {
  state: OcrState;
  /** Human-readable explanation, safe to show an admin. */
  detail: string;
  /** True when this Node process owns the child, false when adopted/remote. */
  managed: boolean;
  /** Component availability as reported by the service itself. */
  components: Record<string, boolean> | null;
  lastHealthyAt: string | null;
  lastCheckAt: string | null;
  restarts: number;
  pid: number | null;
  url: string | null;
};

const HEALTH_TIMEOUT_MS = 2_500;
/** How often the watchdog re-checks a service it believes is up. */
const HEALTH_INTERVAL_MS = 15_000;
/** Backoff ladder for restart attempts. Caps out — never a tight loop. */
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000];
/** How long a request may wait for a starting service before giving up. */
const MAX_WAIT_FOR_READY_MS = 8_000;

/**
 * Supervisor state lives on `globalThis`, not in module scope.
 *
 * This is not defensive style — it is required. Next.js does not guarantee that
 * the instrumentation hook and a route handler share one module instance, so
 * module-level state can be initialised in one copy and read as empty from
 * another. That exact bug made the OCR route report "not initialised" and fall
 * straight through to manual entry while the service was up and healthy.
 * Same reasoning as the shared Prisma client in src/lib/prisma.ts.
 */
type SupervisorGlobal = {
  child: ChildProcess | null;
  timer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  started: boolean;
  status: OcrStatus;
};

const g = globalThis as unknown as { __sfOcr?: SupervisorGlobal };

const state: SupervisorGlobal = (g.__sfOcr ??= {
  child: null,
  timer: null,
  attempt: 0,
  started: false,
  status: {
    state: "disabled",
    detail: "not initialised",
    managed: false,
    components: null,
    lastHealthyAt: null,
    lastCheckAt: null,
    restarts: 0,
    pid: null,
    url: null,
  },
});

const status = state.status;

function set(next: Partial<OcrStatus>) {
  Object.assign(status, next);
}

function baseUrl(): string | null {
  const u = process.env.OCR_SERVICE_URL;
  return u ? u.replace(/\/$/, "") : null;
}

/** Ask the service how it is. Never throws. */
async function probe(): Promise<{ ok: boolean; components: Record<string, boolean> | null; detail: string }> {
  const url = baseUrl();
  if (!url) return { ok: false, components: null, detail: "OCR_SERVICE_URL is not set" };
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, components: null, detail: `health returned ${res.status}` };

    /**
     * The service reports components as flat booleans alongside `status`:
     *   { status, detector, vehicle_detector, ocr }
     * Collect every boolean field rather than looking for a `components` object —
     * assuming a nested shape once made a service with nothing loaded report as
     * fully ready, which is exactly the state an admin most needs to see.
     */
    const body = (await res.json()) as Record<string, unknown>;
    const components: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === "boolean") components[k] = v;
    }
    return {
      ok: true,
      components: Object.keys(components).length > 0 ? components : null,
      detail: typeof body.status === "string" ? body.status : "ok",
    };
  } catch {
    return { ok: false, components: null, detail: "no response on /health" };
  }
}

/**
 * Which Python to use. `OCR_PYTHON` wins so a deployment can point at a venv;
 * otherwise a local venv, then whatever `python` is on PATH.
 */
function pythonCommand(): string {
  if (process.env.OCR_PYTHON) return process.env.OCR_PYTHON;
  // Without the ignore hint, Turbopack's file tracer cannot statically resolve
  // process.cwd() and falls back to bundling the whole project into every route
  // that imports this module (confirmed: it pulled backups/ and screenshots/
  // into the ocr-status, ocr and dashboard function outputs, ~1000+ files each,
  // which is what broke the Vercel deploy step). Inlined into each join() call
  // — the marker must sit directly inside the traced call, not on a variable
  // assigned earlier.
  const venvWin = join(/*turbopackIgnore: true*/ process.cwd(), "ocr-service", ".venv", "Scripts", "python.exe");
  const venvNix = join(/*turbopackIgnore: true*/ process.cwd(), "ocr-service", ".venv", "bin", "python");
  if (existsSync(venvWin)) return venvWin;
  if (existsSync(venvNix)) return venvNix;
  return process.platform === "win32" ? "python" : "python3";
}

function servicePort(): string {
  const url = baseUrl();
  if (!url) return "8000";
  try {
    return new URL(url).port || "8000";
  } catch {
    return "8000";
  }
}

/** Spawn the FastAPI process. Detached from the request lifecycle. */
function spawnService(): boolean {
  /**
   * A serverless function has no persistent process to spawn a lasting child
   * into and no Python runtime — `process.env.VERCEL` is set on every Vercel
   * build and execution. This does not disable OCR there: `OCR_SERVICE_URL`
   * can still point at a service hosted elsewhere, and `tick()`/`probe()`
   * above health-check it over plain `fetch`, which works the same anywhere.
   * Only the local spawn attempt — meaningless off a persistent host — is
   * skipped, so a Vercel deployment does not spend a cold start on a spawn
   * that was always going to fail.
   */
  if (process.env.VERCEL) {
    set({ state: "unavailable", detail: "local spawn is disabled on Vercel — set OCR_SERVICE_URL to a hosted OCR service", managed: false });
    return false;
  }
  const dir = join(/*turbopackIgnore: true*/ process.cwd(), "ocr-service");
  if (!existsSync(join(dir, "main.py"))) {
    set({ state: "unavailable", detail: "ocr-service/main.py not found", managed: false });
    return false;
  }

  const python = pythonCommand();
  try {
    /**
     * `run.py`, not `-m uvicorn`.
     *
     * The launcher selects the Selector event loop on Windows and awaits the
     * server properly. Spawning uvicorn's CLI left the default ProactorEventLoop
     * in place, whose teardown raised an AttributeError that in turn surfaced as
     * `coroutine 'Server.serve' was never awaited` on every stop. See
     * ocr-service/run.py for the full explanation.
     */
    const proc = spawn(python, ["run.py"], {
      cwd: dir,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        OCR_HOST: "127.0.0.1",
        OCR_PORT: servicePort(),
      },
      stdio: ["ignore", "pipe", "pipe"],
      // Not detached: the service should die with the app rather than leak a
      // model process holding a gigabyte of RAM after a restart.
      detached: false,
      windowsHide: true,
    });

    state.child = proc;
    set({ managed: true, pid: proc.pid ?? null, state: "starting", detail: `spawned ${python}` });

    // Surface the service's own startup errors as status, prefixed so they are
    // identifiable in the app's log.
    proc.stdout?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[ocr] ${line.slice(0, 400)}`);
    });
    proc.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (!line) return;
      console.log(`[ocr] ${line.slice(0, 400)}`);
      // A missing dependency is the common case and is worth reporting exactly,
      // because the fix is a pip install and nothing else will reveal that.
      if (/ModuleNotFoundError|No module named/.test(line)) {
        set({
          state: "unavailable",
          detail: `Python dependency missing — run: pip install -r ocr-service/requirements.txt (${line.slice(0, 120)})`,
        });
      }
    });

    proc.on("error", (e) => {
      // ENOENT here means there is no usable interpreter. That is a deployment
      // fact, not a transient fault, so do not keep retrying it forever.
      set({
        state: "unavailable",
        detail: `cannot launch ${python}: ${e.message}`,
        managed: false,
        pid: null,
      });
      state.child = null;
    });

    proc.on("exit", (code, signal) => {
      state.child = null;
      set({ pid: null, managed: false });
      if (status.state !== "unavailable") {
        set({ state: "unreachable", detail: `service exited (code ${code ?? "null"}, signal ${signal ?? "none"})` });
      }
      scheduleCheck();
    });

    return true;
  } catch (e) {
    set({
      state: "unavailable",
      detail: `spawn failed: ${e instanceof Error ? e.message : String(e)}`,
      managed: false,
    });
    return false;
  }
}

/** Schedule the next watchdog tick with backoff appropriate to the state. */
function scheduleCheck() {
  if (state.timer) clearTimeout(state.timer);
  const healthy = status.state === "ready" || status.state === "degraded";
  const delay = healthy ? HEALTH_INTERVAL_MS : BACKOFF_MS[Math.min(state.attempt, BACKOFF_MS.length - 1)];
  state.timer = setTimeout(() => void tick(), delay);
  // Do not hold the process open just for the watchdog.
  state.timer.unref?.();
}

/**
 * One watchdog pass: probe, and restart if we own a service that has died.
 *
 * `unavailable` is deliberately still re-probed, just slowly — the deps might be
 * installed while the app runs, and requiring an app restart to notice would be
 * exactly the manual intervention this module exists to remove.
 */
async function tick() {
  const url = baseUrl();
  if (!url) {
    set({ state: "disabled", detail: "OCR_SERVICE_URL is not set", url: null });
    return;
  }

  const health = await probe();
  set({ lastCheckAt: new Date().toISOString(), url });

  if (health.ok) {
    const comps = health.components;
    /**
     * "Answers but cannot read" is a real and distinct state.
     *
     * The text recogniser (`ocr`) is the one component nothing works without.
     * The detectors are optional — the service falls back to classical
     * morphology for plate localisation — so their absence lowers accuracy but
     * still produces reads. Treating any-component-loaded as ready would report
     * a service that can never return a plate as fully healthy.
     */
    const usable = !comps || (typeof comps.ocr === "boolean" ? comps.ocr : Object.values(comps).some(Boolean));
    const missing = comps
      ? Object.entries(comps)
          .filter(([, v]) => !v)
          .map(([k]) => k)
      : [];
    set({
      state: usable ? "ready" : "degraded",
      detail: usable
        ? missing.length > 0
          ? `healthy (reduced accuracy — ${missing.join(", ")} not loaded)`
          : "healthy"
        : `running but cannot read plates — ${missing.join(", ")} not loaded`,
      components: comps,
      lastHealthyAt: new Date().toISOString(),
    });
    state.attempt = 0;
    scheduleCheck();
    return;
  }

  // Not answering. If we are permitted to manage it, (re)start it.
  const autoStart = process.env.OCR_AUTOSTART !== "0";
  if (autoStart && !state.child && status.state !== "unavailable") {
    state.attempt++;
    /**
     * A spawn counts as a *restart* if the service was ever healthy — that is
     * precisely what distinguishes "recovering from a crash" from "coming up for
     * the first time". Keying it off the attempt counter instead missed the first
     * recovery, which is the one an operator is most likely to be looking at.
     */
    if (status.lastHealthyAt) set({ restarts: status.restarts + 1 });
    set({ state: "starting", detail: `starting (state.attempt ${state.attempt})`, components: null });
    spawnService();
  } else if (!autoStart) {
    set({ state: "unreachable", detail: "not answering; autostart disabled (OCR_AUTOSTART=0)", components: null });
    state.attempt++;
  } else if (status.state === "unavailable") {
    // Keep the slow re-probe alive so a later pip install is picked up.
    state.attempt++;
  } else {
    state.attempt++;
    set({ state: "starting", detail: `waiting for service (state.attempt ${state.attempt})` });
  }
  scheduleCheck();
}

/**
 * Begin supervising. Idempotent, and safe to call from module scope.
 *
 * Returns immediately — startup is never blocked on a model loading.
 */
export function startOcrSupervisor(): void {
  if (state.started) return;
  state.started = true;

  const url = baseUrl();
  if (!url) {
    set({ state: "disabled", detail: "OCR_SERVICE_URL is not set" });
    return;
  }
  set({ state: "starting", detail: "initialising", url });
  void tick();

  // Take the child down with the app so a restart does not leak a model process.
  const shutdown = () => {
    if (state.timer) clearTimeout(state.timer);
    const child = state.child;
    if (!child || child.killed) return;
    try {
      /**
       * Ask first, then insist.
       *
       * SIGTERM lets `run.py` set `should_exit` and close its transports in
       * order; killing outright is what produced asyncio teardown tracebacks.
       * On Windows `kill()` cannot reach a process tree, so a `taskkill /T /F`
       * follows shortly after as the backstop — otherwise a stuck interpreter
       * survives the app and holds port 8000 against the next start.
       */
      child.kill("SIGTERM");
      const hard = setTimeout(() => {
        if (child.killed || child.exitCode !== null) return;
        try {
          if (process.platform === "win32" && child.pid) {
            spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          /* already gone */
        }
      }, 2000);
      // Must not hold the event loop open — that is what makes a shutdown hang
      // on "Waiting for application shutdown".
      hard.unref?.();
    } catch {
      /* already gone */
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("beforeExit", shutdown);
}

/** Current status, for the admin panel and for the OCR route's own decisions. */
export function ocrStatus(): OcrStatus {
  return { ...status };
}

/**
 * Wait briefly for a service that is still coming up.
 *
 * This is the "queue requests while reconnecting" behaviour: a capture taken
 * seconds after the app boots should not fall back to manual entry merely
 * because the model was still loading. Bounded, because an operator waiting on a
 * spinner is worse than typing six characters.
 *
 * Returns true if the service is usable, false to fall back to manual entry.
 */
export async function awaitOcrReady(maxWaitMs = MAX_WAIT_FOR_READY_MS): Promise<boolean> {
  if (status.state === "ready" || status.state === "degraded") return true;
  // Nothing to wait for: these states are not going to resolve within a request.
  if (status.state === "disabled" || status.state === "unavailable") return false;

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const health = await probe();
    if (health.ok) {
      set({
        state: "ready",
        detail: "healthy",
        components: health.components,
        lastHealthyAt: new Date().toISOString(),
        lastCheckAt: new Date().toISOString(),
      });
      state.attempt = 0;
      return true;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
