/**
 * Cross-instance realtime (Postgres LISTEN/NOTIFY).
 *
 * The bug this guards against: an SSE client connected to instance A never
 * received an event published on instance B, so a yard showed stale stock with no
 * error. That is invisible to every single-process test, which is why this suite
 * runs **two servers on two ports** and asserts delivery across them.
 *
 * Requires a build (`npm run build`). Starts a second instance on PORT=3100 and
 * shuts it down afterwards. Read-only with respect to yard data — it publishes an
 * inward event by creating nothing; the event is triggered through a real API call
 * against the sandbox yard only.
 *
 * Usage: with the app running on :3001, `npx tsx tests/realtime-multi.test.ts`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { TEST_YARD_CODE, TEST_OWNER } from "./fixtures";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const A = process.env.BASE_URL || "http://localhost:3001";
const B_PORT = process.env.SECOND_PORT || "3100";
const B = `http://localhost:${B_PORT}`;

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

function makeClient(base: string) {
  let cookies: Record<string, string> = {};
  const ch = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const req = async (path: string, opts: RequestInit = {}) => {
    const res = await fetch(base + path, {
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
        callbackUrl: base + "/stock",
        json: "true",
      }).toString(),
    });
  };
  return { req, login, cookieHeader: ch };
}

async function waitUp(base: string, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${base}/login`, { redirect: "manual" });
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Collect SSE `data:` frames from a stream for a bounded time. */
async function collectSse(base: string, path: string, cookie: string, ms: number): Promise<string[]> {
  const frames: string[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(base + path, {
      headers: { cookie, accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.body) return frames;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) frames.push(line.slice(5).trim());
      }
    }
  } catch {
    /* aborted by the timer — expected */
  } finally {
    clearTimeout(timer);
  }
  return frames;
}

async function main() {
  let second: ChildProcess | null = null;
  try {
    const yard = await prisma.yard.findUniqueOrThrow({ where: { yardCode: TEST_YARD_CODE } });

    console.log("Instance A (existing):");
    check("instance A is up", await waitUp(A, 5), A);

    console.log(`\nStarting instance B on :${B_PORT}…`);
    /**
     * `next start -p` directly, not `npm run start`.
     *
     * The package script now pins `-p 3001` for this project, and an explicit
     * `-p` beats the `PORT` env var — so the second instance silently tried to
     * bind 3001, collided with instance A, and never came up.
     */
    second = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "start", "-p", B_PORT], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: B_PORT, OCR_AUTOSTART: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
    });
    second.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      if (/LISTEN|Ready|error/i.test(s)) process.stdout.write(`  [B] ${s.slice(0, 160)}`);
    });

    const bUp = await waitUp(B);
    check("instance B is up on a second port", bUp, B);
    if (!bUp) throw new Error("second instance did not start");

    // Both instances must report the LISTEN connection.
    for (const [name, base] of [["A", A], ["B", B]] as const) {
      const c = makeClient(base);
      await c.login(TEST_OWNER.email, TEST_OWNER.password);
      const r = await c.req("/api/realtime/stats").catch(() => null);
      if (r && r.status === 200) {
        const s = await r.json();
        check(`instance ${name} reports a cross-instance transport`, !!s.crossInstance, JSON.stringify(s.crossInstance));
        check(`instance ${name} is connected via LISTEN`, s.crossInstance?.connected === true, JSON.stringify(s.crossInstance));
        check(`instance ${name} is using DIRECT_URL`, s.crossInstance?.usingDirectUrl === true);
      } else {
        console.log(`  … /api/realtime/stats not exposed on ${name}; skipping transport introspection`);
      }
    }

    // ── The actual property: publish on B, receive on A ────────────────────
    console.log("\nAn event published on B reaches a subscriber on A:");
    const aClient = makeClient(A);
    await aClient.login(TEST_OWNER.email, TEST_OWNER.password);
    const aCookie = aClient.cookieHeader();

    const bClient = makeClient(B);
    await bClient.login(TEST_OWNER.email, TEST_OWNER.password);

    // Start listening on A, then cause a real write on B.
    const listening = collectSse(A, "/api/realtime/stream", aCookie, 12_000);
    await new Promise((r) => setTimeout(r, 1500));

    // A vendor create is the smallest real write that publishes an event.
    const vName = `Cross Instance ${Date.now().toString().slice(-6)}`;
    const created = await bClient.req("/api/vendors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: vName }),
    });
    check("the write on instance B succeeded", created.status === 201 || created.status === 200, String(created.status));

    const frames = await listening;
    const events = frames
      .map((f) => {
        try {
          return JSON.parse(f) as { channel?: string; entity?: string };
        } catch {
          return null;
        }
      })
      .filter((e): e is { channel?: string; entity?: string } => !!e);

    console.log(`  received ${frames.length} frame(s) on A, ${events.length} parseable`);
    check(
      "instance A received an event caused by instance B",
      events.some((e) => e.channel === "vendors"),
      JSON.stringify(events.slice(0, 6))
    );
    // Event names must be untouched — the frontend switches on them.
    check(
      "the event name is unchanged ('vendors')",
      events.some((e) => e.channel === "vendors" && (e.entity === "Vendor" || e.entity === undefined))
    );

    // Clean up the vendor this suite created. Sandbox yard only.
    const v = await prisma.vendor.findFirst({ where: { yardId: yard.id, name: vName } });
    if (v) {
      const refs = await prisma.inwardLoad.count({ where: { vendorId: v.id } });
      if (refs === 0) await prisma.vendor.delete({ where: { id: v.id } });
    }
    check("the test vendor was cleaned up", (await prisma.vendor.count({ where: { yardId: yard.id, name: vName } })) === 0);

    console.log(`\n==== realtime multi-instance: ${pass} passed, ${fail} failed ====`);
  } finally {
    if (second && !second.killed) {
      try {
        if (process.platform === "win32" && second.pid) {
          spawn("taskkill", ["/PID", String(second.pid), "/T", "/F"], { stdio: "ignore" });
        } else second.kill();
      } catch {
        /* already gone */
      }
    }
    await prisma.$disconnect();
  }
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
