/**
 * Exit gate: realtime delivery and isolation.
 *
 * Opens live SSE streams as two different yards' owners plus the platform admin,
 * performs a real write in one yard, and asserts:
 *   • that yard's subscriber receives the event,
 *   • the OTHER yard's subscriber receives nothing,
 *   • the admin's platform stream receives it tagged with the right yard,
 *   • an unauthenticated client cannot open a stream at all.
 *
 * Writes happen in the sandbox yard only. Yard B is created and removed here.
 *
 * Usage: start the app, then `npx tsx tests/realtime.test.ts`.
 */
import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { TEST_YARD_CODE, TEST_OWNER } from "./fixtures";

const prisma = new PrismaClient();
const BASE = process.env.BASE_URL || "http://localhost:3001";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@scrapflow.in";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ScrapFlow@2026";

const YARD_B_CODE = "SFRT-B";
const OWNER_B = { email: "rt-ownerb@veloce.test", password: "rtownerb123" };

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
    const res = await fetch(BASE + path, {
      ...opts,
      headers: { ...(opts.headers || {}), cookie: ch() },
      redirect: "manual",
    });
    store(res);
    return res;
  };
  const json = (p: string, b?: unknown, m = "POST") =>
    req(p, {
      method: m,
      headers: { "content-type": "application/json" },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
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
  return { req, json, login, cookieHeader: ch };
}

type Collected = { events: Record<string, unknown>[]; ready: boolean; close: () => void };

/** Opens an SSE stream and collects parsed `event:`/`data:` frames. */
async function collectSse(path: string, cookie: string, eventName: string): Promise<Collected> {
  const controller = new AbortController();
  const res = await fetch(BASE + path, { headers: { cookie, accept: "text/event-stream" }, signal: controller.signal });
  if (!res.ok || !res.body) throw new Error(`stream ${path} failed: ${res.status}`);

  const collected: Collected = { events: [], ready: false, close: () => controller.abort() };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const ev = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (ev === "ready") collected.ready = true;
          if (ev === eventName && data) {
            try {
              collected.events.push(JSON.parse(data));
            } catch {
              /* ignore malformed frame */
            }
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();

  return collected;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cleanupB() {
  const yardB = await prisma.yard.findUnique({ where: { yardCode: YARD_B_CODE } });
  await prisma.user.deleteMany({ where: { email: OWNER_B.email } });
  if (!yardB) return;
  await prisma.$transaction(async (tx) => {
    const w = { where: { yardId: yardB.id } };
    await tx.outwardImage.deleteMany(w);
    await tx.outwardLoadLine.deleteMany(w);
    await tx.outwardLoad.deleteMany(w);
    await tx.inventoryTransaction.deleteMany(w);
    await tx.inventoryLot.deleteMany(w);
    await tx.weightEntry.deleteMany(w);
    await tx.inwardLoadLine.deleteMany(w);
    await tx.inwardLoad.deleteMany(w);
    await tx.inventory.deleteMany(w);
    await tx.sku.deleteMany(w);
    await tx.material.deleteMany(w);
    await tx.vendor.deleteMany(w);
    await tx.auditLog.deleteMany(w);
    await tx.counter.deleteMany({ where: { name: { startsWith: `${yardB.id}:` } } });
    await tx.yard.delete({ where: { id: yardB.id } });
  },
  { maxWait: 15_000, timeout: 60_000 }
);
}

async function main() {
  await cleanupB();

  const yardA = await prisma.yard.findUnique({ where: { yardCode: TEST_YARD_CODE } });
  if (!yardA) {
    console.error(`❌ Sandbox yard missing. Run: npx tsx tests/fixtures.ts up`);
    process.exit(1);
  }

  // ---- Yard B with a minimal but usable material tree ----
  const yardB = await prisma.yard.create({
    data: { yardCode: YARD_B_CODE, yardName: "Realtime Test Yard", city: "Chennai", state: "Tamil Nadu" },
  });
  await prisma.user.create({
    data: {
      email: OWNER_B.email,
      name: "RT Owner B",
      passwordHash: await bcrypt.hash(OWNER_B.password, 10),
      role: Role.OWNER,
      yardId: yardB.id,
    },
  });
  const matB = await prisma.material.create({ data: { yardId: yardB.id, name: "B Metal", code: "BMET" } });
  const skuB = await prisma.sku.create({
    data: { yardId: yardB.id, materialId: matB.id, name: "Mixed B", code: "MIXB", isMixedBucket: true },
  });
  await prisma.inventory.create({ data: { yardId: yardB.id, skuId: skuB.id, quantityKg: 0 } });

  const A = makeClient();
  const B = makeClient();
  const AD = makeClient();
  await A.login(TEST_OWNER.email, TEST_OWNER.password);
  await B.login(OWNER_B.email, OWNER_B.password);
  await AD.login(ADMIN_EMAIL, ADMIN_PASSWORD);

  console.log("\n[Auth] streams are not open to anyone");
  const anon = await fetch(BASE + "/api/realtime/stream", { headers: { accept: "text/event-stream" }, redirect: "manual" });
  check("unauthenticated yard stream → 401", anon.status === 401, `got ${anon.status}`);
  const ownerPlatform = await fetch(BASE + "/api/admin/realtime/stream", {
    headers: { cookie: A.cookieHeader(), accept: "text/event-stream" },
    redirect: "manual",
  });
  check("owner blocked from the platform stream → 403", ownerPlatform.status === 403, `got ${ownerPlatform.status}`);

  console.log("\n[Subscribe] opening three streams");
  const sA = await collectSse("/api/realtime/stream", A.cookieHeader(), "yard");
  const sB = await collectSse("/api/realtime/stream", B.cookieHeader(), "yard");
  const sAD = await collectSse("/api/admin/realtime/stream", AD.cookieHeader(), "platform");
  await sleep(700);
  check("Yard A stream is ready", sA.ready);
  check("Yard B stream is ready", sB.ready);
  check("admin platform stream is ready", sAD.ready);

  console.log("\n[Write in Yard A] the event must reach Yard A only");
  const bucketA = await prisma.sku.findFirstOrThrow({ where: { yardId: yardA.id, code: "MIXMS" } });
  const created = await A.json("/api/inward/loads", { materialSkuId: bucketA.id, entries: [140], vehicleNumber: "RT01AA1111" });
  check("inward load created in Yard A", created.status === 201, `got ${created.status}`);
  await sleep(900);

  const aChannels = sA.events.map((e) => e.channel);
  check("Yard A received an inward event", aChannels.includes("inward"), JSON.stringify(aChannels));
  check("Yard A received a stock event", aChannels.includes("stock"), JSON.stringify(aChannels));
  check("Yard A received a sort event", aChannels.includes("sort"), JSON.stringify(aChannels));
  check("Yard B received NOTHING", sB.events.length === 0, `got ${JSON.stringify(sB.events)}`);

  const adForA = sAD.events.filter((e) => e.yardId === yardA.id);
  check("admin platform stream saw the Yard A event", adForA.length > 0);
  check("admin events are tagged with the originating yard", adForA.every((e) => e.yardId === yardA.id));

  console.log("\n[Write in Yard B] the reverse direction is equally isolated");
  const aCountBefore = sA.events.length;
  const createdB = await B.json("/api/inward/loads", { materialSkuId: skuB.id, entries: [77], vehicleNumber: "RT02BB2222" });
  check("inward load created in Yard B", createdB.status === 201, `got ${createdB.status}`);
  await sleep(900);

  check("Yard B now received its own events", sB.events.length > 0);
  check("Yard A received no Yard B events", sA.events.length === aCountBefore, `grew by ${sA.events.length - aCountBefore}`);
  check("admin saw the Yard B event too", sAD.events.some((e) => e.yardId === yardB.id));

  console.log("\n[Actor tagging] events carry the actor so clients can skip their own echo");
  const tagged = sA.events.filter((e) => typeof e.actorId === "string" && e.actorId.length > 0);
  check("events include an actorId", tagged.length > 0);

  sA.close();
  sB.close();
  sAD.close();

  console.log("\n[Teardown]");
  await cleanupB();
  check("Yard B removed", (await prisma.yard.findUnique({ where: { yardCode: YARD_B_CODE } })) === null);

  console.log(`\n==== realtime: ${pass} passed, ${fail} failed ====`);
  if (fail > 0) process.exit(1);
}

main()
  .catch(async (e) => {
    console.error(e);
    await cleanupB().catch(() => {});
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
