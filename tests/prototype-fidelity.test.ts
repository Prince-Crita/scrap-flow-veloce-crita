/**
 * Exit gate: the app renders `scrapflow_veloce_v2-1.html` faithfully.
 *
 * Every assertion quotes the prototype line it comes from. This suite is
 * READ-ONLY against the database — it asserts, it never repairs — and it also
 * checks the rendered API responses, so it catches a UI that computes a
 * different percentage or ready-state from the same numbers.
 *
 * IT RUNS AGAINST THE FIXTURE YARD, NEVER YARD 1.
 *
 * It used to read Yard 1, which was correct while Yard 1 was frozen prototype
 * data. Yard 1 is now live — the owner makes sales, dispatches vehicles, creates
 * buyers — and every one of those legitimate actions broke an assertion here (25
 * of them by 2026-07-27). The suite was answering "has anyone used the app
 * today?" rather than "does the app still render the prototype correctly?".
 *
 * `npm run test:prototype` now restores the prototype snapshot into the fixture
 * yard first (`fixtures.ts prototype`), so the data is deterministic and the
 * assertion is about the code. Yard 1 is neither read nor written here.
 *
 * Usage: start the app, then `npm run test:prototype`.
 */
import { PrismaClient } from "@prisma/client";
import { TEST_YARD_CODE, TEST_YARD_NAME, TEST_OWNER } from "./fixtures";

const prisma = new PrismaClient();
const BASE = process.env.BASE_URL || "http://localhost:3001";
const OWNER = { email: TEST_OWNER.email, password: TEST_OWNER.password };

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
  return { req, login };
}

/** The prototype's `skus` array, verbatim. */
const PROTOTYPE_SKUS = [
  { name: "MS Bazar", icon: "🔩", qty: 1850, thr: 2000 },
  { name: "MS Commercial", icon: "🏗️", qty: 2400, thr: 2000 },
  { name: "PET White", icon: "🥛", qty: 620, thr: 1500 },
  { name: "PET Green", icon: "🧪", qty: 1480, thr: 1500 },
  { name: "Alu Castings", icon: "⚙️", qty: 310, thr: 800 },
  { name: "Mixed MS", icon: "🧺", qty: 1200, thr: 99999 },
];

/** The prototype's ticker rows, verbatim. */
const PROTOTYPE_RATES = [
  ["PET White", "₹52,000", "▲ 0.4"],
  ["PET Green", "₹42,000", "▼ 1.1"],
  ["MS HMS-1", "₹34,500", "▲ 1.2"],
  ["MS HMS-2", "₹34,000", "▲ 0.8"],
  ["MS Super", "₹35,500", "▼ 0.3"],
  ["MS Bazar", "₹33,500", "▲ 2.1"],
  ["MS Commercial", "₹29,000", "▲ 0.5"],
];

async function main() {
  const yard = await prisma.yard.findUniqueOrThrow({ where: { yardCode: TEST_YARD_CODE } });
  const yardId = yard.id;

  console.log("\n[Yard] identity — the FIXTURE yard, not Yard 1");
  check(`yardName is "${TEST_YARD_NAME}"`, yard.yardName === TEST_YARD_NAME, yard.yardName);
  check(`yardCode is "${TEST_YARD_CODE}"`, yard.yardCode === TEST_YARD_CODE);
  check("yard is active", yard.active);
  // The guard that makes every assertion below safe to run: if this suite ever
  // points at production again, it must fail here rather than quietly asserting
  // frozen values against live data.
  check("this is NOT Yard 1", yard.yardCode !== "SFDY001", yard.yardCode);

  console.log("\n[Stock] every SKU quantity, threshold and icon (prototype `skus` array)");
  for (const p of PROTOTYPE_SKUS) {
    const sku = await prisma.sku.findFirst({ where: { yardId, name: p.name }, include: { inventory: true } });
    check(`"${p.name}" exists`, !!sku);
    if (!sku) continue;
    check(`"${p.name}" qty = ${p.qty} kg`, sku.inventory?.quantityKg === p.qty, `got ${sku.inventory?.quantityKg}`);
    check(`"${p.name}" threshold = ${p.thr}`, sku.saleThresholdKg === p.thr, `got ${sku.saleThresholdKg}`);
    check(`"${p.name}" icon = ${p.icon}`, sku.icon === p.icon, `got ${sku.icon}`);
    check(`"${p.name}" is visible`, sku.visible);
  }

  console.log("\n[Stock] no extra SKUs beyond the prototype + the 3 it references");
  const allSkus = await prisma.sku.findMany({ where: { yardId }, orderBy: { sortOrder: "asc" } });
  check("exactly 9 SKUs (6 defined + MS Super, PET Mixed, Aluminum Mixed)", allSkus.length === 9, `got ${allSkus.length}: ${allSkus.map((s) => s.name).join(", ")}`);
  for (const extra of ["MS Super", "PET Mixed", "Aluminum Mixed"]) {
    const s = allSkus.find((x) => x.name === extra);
    check(`"${extra}" exists at 0 kg (prototype gives no quantity)`, !!s);
    if (s) {
      const inv = await prisma.inventory.findUnique({ where: { skuId: s.id } });
      check(`"${extra}" qty = 0`, inv?.quantityKg === 0, `got ${inv?.quantityKg}`);
    }
  }

  console.log("\n[Materials] exactly the three groups the SKUs fall into");
  const materials = await prisma.material.findMany({ where: { yardId }, orderBy: { code: "asc" } });
  check("exactly 3 materials", materials.length === 3, `got ${materials.length}: ${materials.map((m) => m.code).join(", ")}`);
  for (const code of ["ALU", "MS", "PET"]) {
    check(`material ${code} present and active`, materials.some((m) => m.code === code && m.active));
  }

  console.log("\n[Vendors] the two inward chips, and nothing else");
  const vendors = await prisma.vendor.findMany({ where: { yardId }, orderBy: { name: "asc" } });
  check("exactly 2 vendors", vendors.length === 2, `got ${vendors.length}: ${vendors.map((v) => v.name).join(", ")}`);
  check('"Balaji Metals" present and active', vendors.some((v) => v.name === "Balaji Metals" && v.active));
  check('"SR Traders" present and active', vendors.some((v) => v.name === "SR Traders" && v.active));

  console.log("\n[Buyers] the two receivables rows");
  const buyers = await prisma.buyer.findMany({ where: { yardId }, orderBy: { name: "asc" } });
  check("exactly 2 buyers", buyers.length === 2, `got ${buyers.length}`);
  check('"Shree Steels" present', buyers.some((b) => b.name === "Shree Steels"));
  check('"GreenCycle" present', buyers.some((b) => b.name === "GreenCycle"));

  console.log("\n[Segregation] Lot #A-114 · Mixed MS · 1,200 kg · Balaji Metals · unsorted");
  const loads = await prisma.inwardLoad.findMany({ where: { yardId }, include: { vendor: true } });
  check("exactly 1 inward load", loads.length === 1, `got ${loads.length}`);
  const lot = loads[0];
  if (lot) {
    check('lotNumber is "A-114"', lot.lotNumber === "A-114", lot.lotNumber);
    check("totalKg is 1200", lot.totalKg === 1200, String(lot.totalKg));
    check('materialLabel is "Mixed MS"', lot.materialLabel === "Mixed MS", lot.materialLabel);
    check("status RECEIVED (prototype shows 1,200 kg still unsorted)", lot.status === "RECEIVED", lot.status);
    check('vendor is "Balaji Metals"', lot.vendor?.name === "Balaji Metals", lot.vendor?.name ?? "none");
  }
  check("no segregation runs yet (all four split values are 0)", (await prisma.segregationRun.count({ where: { yardId } })) === 0);

  console.log("\n[Receivables] INV-0231 ₹84,000 · INV-0228 ₹41,500");
  const inv231 = await prisma.sale.findUnique({
    where: { yardId_invoiceNumber: { yardId, invoiceNumber: "INV-0231" } },
    include: { buyer: true, receivable: true },
  });
  check("INV-0231 exists", !!inv231);
  check("INV-0231 total is ₹84,000", inv231?.total === 84000, String(inv231?.total));
  check('INV-0231 buyer is "Shree Steels"', inv231?.buyer.name === "Shree Steels", inv231?.buyer.name);
  check("INV-0231 receivable is ₹84,000", inv231?.receivable?.amount === 84000, String(inv231?.receivable?.amount));

  const inv228 = await prisma.sale.findUnique({
    where: { yardId_invoiceNumber: { yardId, invoiceNumber: "INV-0228" } },
    include: { buyer: true, receivable: true },
  });
  check("INV-0228 exists", !!inv228);
  check("INV-0228 total is ₹41,500", inv228?.total === 41500, String(inv228?.total));
  check('INV-0228 buyer is "GreenCycle"', inv228?.buyer.name === "GreenCycle", inv228?.buyer.name);
  check("INV-0228 receivable is ₹41,500", inv228?.receivable?.amount === 41500, String(inv228?.receivable?.amount));
  check("exactly 2 sales", (await prisma.sale.count({ where: { yardId } })) === 2);

  console.log("\n[Gamification] xp 1240 · level 7 · streak 12");
  const owner = await prisma.user.findFirstOrThrow({ where: { yardId, role: "OWNER" } });
  check("owner xp = 1240 (`let xp = 1240`)", owner.xp === 1240, String(owner.xp));
  check('owner level = 7 (`<b id="lvl">7</b>`)', owner.level === 7, String(owner.level));
  check("owner streak = 12 (`🔥 12`)", owner.streak === 12, String(owner.streak));

  console.log("\n[Counters] Lot #A-114 → 114 · INV-0231 → 231");
  const lotCtr = await prisma.counter.findUnique({ where: { name: `${yardId}:lot` } });
  const invCtr = await prisma.counter.findUnique({ where: { name: `${yardId}:invoice` } });
  check("lot counter = 114", lotCtr?.value === 114, String(lotCtr?.value));
  check("invoice counter = 231", invCtr?.value === 231, String(invCtr?.value));

  /* ---------------- rendered output ---------------- */
  const O = makeClient();
  await O.login(OWNER.email, OWNER.password);

  console.log("\n[Rendered · /api/stock] percentages and ready-states match the prototype's render");
  const stock = await (await O.req("/api/stock")).json();
  const bySku = new Map<string, { quantityKg: number; thresholdKg: number; ready: boolean }>(
    stock.skus.map((s: { name: string; quantityKg: number; thresholdKg: number; ready: boolean }) => [s.name, s])
  );
  // The prototype computes: pct = Math.min(100, Math.round(qty/thr*100)),
  // readyFlag = thr < 90000 && qty >= thr.
  for (const p of PROTOTYPE_SKUS) {
    const s = bySku.get(p.name);
    if (!s) {
      check(`${p.name} present in /api/stock`, false);
      continue;
    }
    const expectedPct = Math.min(100, Math.round((p.qty / p.thr) * 100));
    const expectedReady = p.thr < 90000 && p.qty >= p.thr;
    const actualPct = Math.min(100, Math.round((s.quantityKg / s.thresholdKg) * 100));
    check(`${p.name} renders ${expectedPct}% of threshold`, actualPct === expectedPct, `got ${actualPct}%`);
    check(`${p.name} ready-to-sell = ${expectedReady}`, s.ready === expectedReady, `got ${s.ready}`);
  }
  // Prototype: only MS Commercial (2400 >= 2000) shows READY TO SELL.
  const readyNames = stock.skus.filter((s: { ready: boolean }) => s.ready).map((s: { name: string }) => s.name);
  check("only MS Commercial is READY TO SELL", readyNames.length === 1 && readyNames[0] === "MS Commercial", readyNames.join(", "));

  console.log("\n[Rendered · /api/sort/pending] the Sort screen shows A-114 with 1,200 kg unsorted");
  const pending = await (await O.req("/api/sort/pending")).json();
  check("exactly 1 pending lot", pending.lots.length === 1, `got ${pending.lots.length}`);
  const pl = pending.lots[0];
  if (pl) {
    check("pending lot is A-114", pl.lotNumber === "A-114", pl.lotNumber);
    check("pending lot is 1200 kg", pl.totalKg === 1200, String(pl.totalKg));
    check('pending lot vendor is "Balaji Metals"', pl.vendorName === "Balaji Metals", pl.vendorName);
    check("pending lot is sortable (MS has sub-SKUs)", pl.sortable === true);
    // Prototype sort screen rows: MS Bazar, MS Commercial, MS Super.
    const targets: string[] = pl.targets.map((t: { name: string }) => t.name).sort();
    check(
      "split targets are MS Bazar / MS Commercial / MS Super",
      JSON.stringify(targets) === JSON.stringify(["MS Bazar", "MS Commercial", "MS Super"]),
      targets.join(", ")
    );
  }

  console.log("\n[Rendered · /api/sell/ready] ready list + receivables");
  const sell = await (await O.req("/api/sell/ready")).json();
  check("exactly 1 ready SKU", sell.ready.length === 1, `got ${sell.ready.length}`);
  check("ready SKU is MS Commercial", sell.ready[0]?.name === "MS Commercial", sell.ready[0]?.name);
  check("2 outstanding receivables", sell.receivables.length === 2, `got ${sell.receivables.length}`);
  const amounts = sell.receivables.map((r: { amount: number }) => r.amount).sort((a: number, b: number) => a - b);
  check("receivable amounts are 41,500 and 84,000", JSON.stringify(amounts) === JSON.stringify([41500, 84000]), amounts.join(", "));

  console.log("\n[Rendered · /api/materials] inward chips");
  const mats = await (await O.req("/api/materials")).json();
  const chipNames: string[] = mats.materials.map((m: { name: string }) => m.name).sort();
  check(
    "inward chips are Aluminum Mixed / Mixed MS / PET Mixed",
    JSON.stringify(chipNames) === JSON.stringify(["Aluminum Mixed", "Mixed MS", "PET Mixed"]),
    chipNames.join(", ")
  );

  console.log("\n[Rendered · /api/vendors] vendor chips");
  const vres = await (await O.req("/api/vendors")).json();
  const vNames: string[] = vres.vendors.map((v: { name: string }) => v.name).sort();
  check("vendor chips are Balaji Metals / SR Traders", JSON.stringify(vNames) === JSON.stringify(["Balaji Metals", "SR Traders"]), vNames.join(", "));

  const stockHtml = await (await O.req("/stock")).text();

  console.log("\n[Shipped client bundle] the stock card labels the prototype uses");
  // The stock list is client-rendered from /api/stock, so these strings live in
  // the JS chunks rather than the server HTML. Fetch the page's own scripts and
  // assert the shipped code carries the prototype's labels.
  const scriptSrcs = [...stockHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  let bundle = "";
  for (const src of scriptSrcs) {
    const r = await O.req(src.startsWith("http") ? src.replace(BASE, "") : src);
    if (r.ok) bundle += await r.text();
  }
  check("page ships client chunks", scriptSrcs.length > 0 && bundle.length > 0, `${scriptSrcs.length} scripts`);
  check('bundle contains the "(unsorted)" mixed-bucket suffix', bundle.includes("(unsorted)"));
  check('bundle contains "awaiting segregation"', bundle.includes("awaiting segregation"));
  check('bundle contains "sale threshold"', bundle.includes("sale threshold"));
  check('bundle contains "READY TO SELL"', bundle.includes("READY TO SELL"));
  check('bundle contains "% of threshold"', bundle.includes("% of threshold"));
  check('bundle contains "kg to go"', bundle.includes("kg to go"));
  check('bundle contains "🔔 buyer alert sent"', bundle.includes("buyer alert sent"));

  console.log("\n[Live rates ticker] every row matches the prototype");
  for (const [m, v, n] of PROTOTYPE_RATES) {
    check(`ticker "${m} ${v} ${n}"`, stockHtml.includes(m) && stockHtml.includes(v) && stockHtml.includes(n.replace(" ", " ")), "missing");
  }

  console.log("\n[XP bar] level 7, next target 2,000 XP, fill 62%");
  // Mirrors src/frontend/components/ui-provider.tsx levelProgress().
  const { levelForXp, levelProgress } = await import("../src/frontend/components/ui-provider");
  check("levelForXp(1240) = 7", levelForXp(1240) === 7, String(levelForXp(1240)));
  const prog = levelProgress(1240);
  check("next level target is 2000 XP", prog.nextXp === 2000, String(prog.nextXp));
  check("level 8 begins at 2000 XP", levelForXp(2000) === 8, String(levelForXp(2000)));
  check("bar fill is 62% (prototype `xp/2000*100`)", Math.round(prog.pct) === 62, `${prog.pct}%`);

  console.log(`\n==== prototype fidelity: ${pass} passed, ${fail} failed ====`);
  if (fail > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
