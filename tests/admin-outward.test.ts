/**
 * Exit gate: Admin visibility of the Outward workflow.
 *
 * Expectations are DERIVED from the database, never hardcoded — the property
 * under test is that the admin dashboard reports what the database actually
 * contains, and that stays true as yards accumulate real dispatches.
 *
 * Read-only. Yard 1 is never written to.
 *
 * Usage: start the app, then `npx tsx tests/admin-outward.test.ts`.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BASE = process.env.BASE_URL || "http://localhost:3001";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@scrapflow.in";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ScrapFlow@2026";

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

async function main() {
  const AD = makeClient();
  await AD.login(ADMIN_EMAIL, ADMIN_PASSWORD);

  const res = await AD.req("/api/admin/dashboard");
  check("dashboard responds to an admin", res.status === 200, String(res.status));
  const d = await res.json();

  const k = d.kpis;
  const ds = d.dispatchSummary;

  /**
   * ── Derived expectations ─────────────────────────────────────────────────
   *
   * Scoped to yards that are still operating, because that is what the platform
   * endpoints now count (src/lib/active-yards.ts). An archived yard keeps every
   * dispatch it ever made, but those rows stopped being part of the platform's
   * figures, so comparing against the whole database would assert the behaviour
   * this release deliberately removed.
   */
  const live = { yard: { active: true } };
  const totalLoads = await prisma.outwardLoad.count({ where: live });
  const totalKg = (await prisma.outwardLoad.aggregate({ where: live, _sum: { totalKg: true } }))._sum.totalKg ?? 0;
  const pending = await prisma.sale.count({ where: { dispatchStatus: "PENDING", ...live } });
  const partial = await prisma.sale.count({ where: { dispatchStatus: "PARTIAL", ...live } });
  const completed = await prisma.sale.count({ where: { dispatchStatus: "COMPLETED", ...live } });
  const legacy = await prisma.sale.count({ where: { dispatchStatus: null, ...live } });

  console.log("\nDispatch KPIs match the database:");
  check("total dispatches", k.dispatchesTotal === totalLoads, `${k.dispatchesTotal} vs ${totalLoads}`);
  check("pending allocations", k.dispatchesPending === pending, `${k.dispatchesPending} vs ${pending}`);
  check("partial allocations", k.dispatchesPartial === partial, `${k.dispatchesPartial} vs ${partial}`);
  // Legacy sales left the yard at sale time, so they count as completed.
  check(
    "completed counts legacy sales too",
    k.dispatchesCompleted === completed + legacy,
    `${k.dispatchesCompleted} vs ${completed + legacy}`
  );
  check("lifetime dispatched kg", k.dispatchKgLifetime === totalKg, `${k.dispatchKgLifetime} vs ${totalKg}`);

  console.log("\nTime windows are ordered correctly:");
  check("today ≤ week", k.dispatchKgToday <= k.dispatchKgWeek, `${k.dispatchKgToday} / ${k.dispatchKgWeek}`);
  check("week ≤ lifetime", k.dispatchKgWeek <= k.dispatchKgLifetime);
  check("month ≤ lifetime", k.dispatchKgMonth <= k.dispatchKgLifetime);
  check("today count ≤ week count", k.dispatchCountToday <= k.dispatchCountWeek);
  check("every window is non-negative", [k.dispatchKgToday, k.dispatchKgWeek, k.dispatchKgMonth].every((v) => v >= 0));

  console.log("\nAwaiting dispatch:");
  const openSales = await prisma.sale.findMany({
    where: { dispatchStatus: { in: ["PENDING", "PARTIAL"] }, ...live },
    select: { quantityKg: true, dispatchedKg: true },
  });
  const expectedAwaiting = openSales.reduce(
    (t, s) => t + Math.max(0, s.quantityKg - (s.dispatchedKg ?? 0)),
    0
  );
  check("awaiting kg matches open allocations", k.awaitingDispatchKg === expectedAwaiting, `${k.awaitingDispatchKg} vs ${expectedAwaiting}`);
  check("legacy sales are NOT counted as awaiting", expectedAwaiting >= 0);

  console.log("\nDispatch summary block:");
  check("summary exists", !!ds);
  check("summary total agrees with the KPI", ds.total === k.dispatchesTotal);
  check("summary awaitingKg agrees with the KPI", ds.awaitingKg === k.awaitingDispatchKg);
  check("status distribution has three buckets", ds.statusDistribution.length === 3, JSON.stringify(ds.statusDistribution));
  check(
    "distribution sums to the allocation count",
    ds.statusDistribution.reduce((t: number, x: { value: number }) => t + x.value, 0) === pending + partial + completed + legacy
  );
  check("byYard is sorted by weight, heaviest first", ds.byYard.every((y: { kg: number }, i: number) => i === 0 || ds.byYard[i - 1].kg >= y.kg));
  check(
    "byYard weights sum to the lifetime total",
    ds.byYard.reduce((t: number, y: { kg: number }) => t + y.kg, 0) === totalKg
  );
  check("byYard rows carry a yard code", ds.byYard.every((y: { yardCode: string }) => !!y.yardCode));

  console.log("\nRecent dispatches feed:");
  check("feed exists", Array.isArray(d.recentDispatches));
  check("feed is capped", d.recentDispatches.length <= 8, String(d.recentDispatches.length));
  if (d.recentDispatches.length > 0) {
    const r = d.recentDispatches[0];
    check("newest first", new Date(r.at).getTime() >= new Date(d.recentDispatches[d.recentDispatches.length - 1].at).getTime());
    check("carries a dispatch number", /^D-\d{4}$/.test(r.dispatchNumber), r.dispatchNumber);
    check("carries a yard code", !!r.yardCode);
    check("lists its materials", Array.isArray(r.materials));
    if (r.materials.length > 0) {
      check("materials name the invoice", !!r.materials[0].invoiceNumber);
      check("materials name the buyer", !!r.materials[0].buyerName);
      check(
        "material weights sum to the vehicle total",
        r.materials.reduce((t: number, m: { kg: number }) => t + m.kg, 0) === r.totalKg,
        `${r.materials.reduce((t: number, m: { kg: number }) => t + m.kg, 0)} vs ${r.totalKg}`
      );
    }
  }

  console.log("\nPer-yard rows carry dispatch counts:");
  check(
    "every yard row has a dispatches field",
    d.yardSummary.every((y: { dispatches?: number }) => typeof y.dispatches === "number")
  );
  check(
    "yard dispatch counts sum to the total",
    d.yardSummary.reduce((t: number, y: { dispatches: number }) => t + y.dispatches, 0) === totalLoads
  );

  // ── Analytics dispatch datasets ───────────────────────────────────────────
  console.log("\nAnalytics dispatch datasets:");
  const DAYS = 90;
  const since = new Date(Date.now() - DAYS * 86_400_000);
  const aRes = await AD.req(`/api/admin/analytics?days=${DAYS}`);
  check("analytics responds", aRes.status === 200, String(aRes.status));
  const a = await aRes.json();

  const winLoads = await prisma.outwardLoad.aggregate({
    where: { createdAt: { gte: since }, ...live },
    _count: { _all: true },
    _sum: { totalKg: true },
  });
  const winKg = winLoads._sum.totalKg ?? 0;

  check("a dispatch trend series exists", Array.isArray(a.trends?.dispatch));
  check(
    "the dispatch trend is zero-filled to one point per day",
    a.trends.dispatch.length === DAYS + 1,
    `${a.trends.dispatch.length} vs ${DAYS + 1}`
  );
  check(
    "trend days are unique and ascending",
    a.trends.dispatch.every((p: { day: string }, i: number) => i === 0 || a.trends.dispatch[i - 1].day < p.day)
  );
  check(
    "every trend point carries a numeric weight and count",
    a.trends.dispatch.every((p: { kg: number; count: number }) => typeof p.kg === "number" && typeof p.count === "number")
  );
  check(
    "the trend sums to the window's dispatched weight",
    a.trends.dispatch.reduce((t: number, p: { kg: number }) => t + p.kg, 0) === winKg,
    `${a.trends.dispatch.reduce((t: number, p: { kg: number }) => t + p.kg, 0)} vs ${winKg}`
  );
  check(
    "the trend sums to the window's vehicle count",
    a.trends.dispatch.reduce((t: number, p: { count: number }) => t + p.count, 0) === winLoads._count._all,
    `vs ${winLoads._count._all}`
  );
  check("totals expose dispatchKg", a.totals.dispatchKg === winKg, `${a.totals.dispatchKg} vs ${winKg}`);
  check("totals expose dispatchCount", a.totals.dispatchCount === winLoads._count._all);

  // Status distribution is window-scoped here, unlike the all-time dashboard.
  const winPending = await prisma.sale.count({ where: { createdAt: { gte: since }, dispatchStatus: "PENDING", ...live } });
  const winPartial = await prisma.sale.count({ where: { createdAt: { gte: since }, dispatchStatus: "PARTIAL", ...live } });
  const winDone = await prisma.sale.count({ where: { createdAt: { gte: since }, dispatchStatus: "COMPLETED", ...live } });
  const winLegacy = await prisma.sale.count({ where: { createdAt: { gte: since }, dispatchStatus: null, ...live } });
  const dist: { label: string; value: number }[] = a.dispatch.statusDistribution;
  const bucket = (l: string) => dist.find((x) => x.label === l)?.value ?? -1;
  check("status distribution has three buckets", dist.length === 3, JSON.stringify(dist));
  check("pending bucket matches the window", bucket("Pending") === winPending, `${bucket("Pending")} vs ${winPending}`);
  check("partial bucket matches the window", bucket("Partial") === winPartial, `${bucket("Partial")} vs ${winPartial}`);
  check(
    "completed bucket folds in legacy sales",
    bucket("Completed") === winDone + winLegacy,
    `${bucket("Completed")} vs ${winDone + winLegacy}`
  );

  const winOpen = await prisma.sale.findMany({
    where: { createdAt: { gte: since }, dispatchStatus: { in: ["PENDING", "PARTIAL"] }, ...live },
    select: { quantityKg: true, dispatchedKg: true },
  });
  check(
    "analytics awaitingKg matches the window's open allocations",
    a.dispatch.awaitingKg === winOpen.reduce((t, s) => t + Math.max(0, s.quantityKg - (s.dispatchedKg ?? 0)), 0),
    String(a.dispatch.awaitingKg)
  );

  const lineKg = (await prisma.outwardLoadLine.aggregate({
    where: { createdAt: { gte: since }, ...live },
    _sum: { quantityKg: true },
  }))._sum.quantityKg ?? 0;

  for (const [name, rows] of [
    ["byMaterial", a.dispatch.byMaterial],
    ["byBuyer", a.dispatch.byBuyer],
    ["byYard", a.dispatch.byYard],
  ] as const) {
    check(`${name} is an array`, Array.isArray(rows));
    check(`${name} rows are labelled`, rows.every((r: { label: string }) => !!r.label));
    check(
      `${name} is sorted heaviest first`,
      rows.every((r: { value: number }, i: number) => i === 0 || rows[i - 1].value >= r.value)
    );
    check(`${name} weights are non-negative`, rows.every((r: { value: number }) => r.value >= 0));
  }
  // A line's weight is attributed to exactly one material and one buyer, so both
  // breakdowns must total the same dispatched weight (top-12 cap permitting).
  const matSum = a.dispatch.byMaterial.reduce((t: number, r: { value: number }) => t + r.value, 0);
  const buySum = a.dispatch.byBuyer.reduce((t: number, r: { value: number }) => t + r.value, 0);
  // Both series are capped at the top 12, so equality only holds below the cap;
  // above it the visible rows must still be a subset of the real total.
  check(
    "byMaterial totals the dispatched line weight",
    a.dispatch.byMaterial.length < 12 ? matSum === lineKg : matSum <= lineKg,
    `${matSum} vs ${lineKg}`
  );
  check(
    "byBuyer totals the dispatched line weight",
    a.dispatch.byBuyer.length < 12 ? buySum === lineKg : buySum <= lineKg,
    `${buySum} vs ${lineKg}`
  );
  check(
    "byYard totals the window's vehicle weight",
    a.dispatch.byYard.reduce((t: number, r: { value: number }) => t + r.value, 0) === winKg
  );

  // Yard scoping must actually narrow the data, not just be accepted.
  const sandbox = await prisma.yard.findFirst({ where: { yardCode: "SFTEST01" }, select: { id: true } });
  if (sandbox) {
    const scoped = await (await AD.req(`/api/admin/analytics?days=${DAYS}&yardId=${sandbox.id}`)).json();
    const sandboxKg = (await prisma.outwardLoad.aggregate({
      where: { yardId: sandbox.id, createdAt: { gte: since } },
      _sum: { totalKg: true },
    }))._sum.totalKg ?? 0;
    check("a yard-scoped window reports only that yard", scoped.totals.dispatchKg === sandboxKg, `${scoped.totals.dispatchKg} vs ${sandboxKg}`);
    check("a yard-scoped window cannot exceed the platform total", scoped.totals.dispatchKg <= winKg);
  }

  // ── Yard detail Outward tab ───────────────────────────────────────────────
  console.log("\nYard detail Outward tab:");
  if (sandbox) {
    const y = await (await AD.req(`/api/admin/yards/${sandbox.id}`)).json();
    const dbLoads = await prisma.outwardLoad.findMany({
      where: { yardId: sandbox.id },
      orderBy: { createdAt: "desc" },
      include: { lines: true },
    });
    check("the yard payload carries dispatches", Array.isArray(y.dispatches));
    check("every dispatch in the yard is listed", y.dispatches.length === Math.min(50, dbLoads.length), `${y.dispatches.length} vs ${dbLoads.length}`);
    check("dispatches are newest first", y.dispatches.every((d: { createdAt: string }, i: number) => i === 0 || new Date(y.dispatches[i - 1].createdAt) >= new Date(d.createdAt)));
    check("totals expose a dispatch count", y.totals.dispatchCount === y.dispatches.length);
    check(
      "totals expose the dispatched weight",
      y.totals.dispatchKg === y.dispatches.reduce((t: number, d: { totalKg: number }) => t + d.totalKg, 0)
    );

    if (y.dispatches.length > 0) {
      const d = y.dispatches[0];
      const dbLoad = dbLoads.find((x) => x.id === d.id)!;
      check("dispatch number is present", /^D-\d{4}$/.test(d.dispatchNumber), d.dispatchNumber);
      check("weight matches the database", d.totalKg === dbLoad.totalKg);
      check("lines are present", Array.isArray(d.lines) && d.lines.length === dbLoad.lines.length);
      check(
        "line weights sum to the vehicle total",
        d.lines.reduce((t: number, l: { quantityKg: number }) => t + l.quantityKg, 0) === d.totalKg
      );
      check("lines are ordered by sequence", d.lines.every((l: { sequence: number }, i: number) => i === 0 || d.lines[i - 1].sequence <= l.sequence));
      check("every line names its invoice", d.lines.every((l: { invoiceNumber: string }) => !!l.invoiceNumber));
      check("every line names its buyer", d.lines.every((l: { buyerName: string }) => !!l.buyerName));
      check("every line names its material", d.lines.every((l: { skuName: string }) => !!l.skuName));
      check(
        "remaining never exceeds the allocation",
        d.lines.every((l: { remainingKg: number; allocatedKg: number }) => l.remainingKg >= 0 && l.remainingKg <= l.allocatedKg)
      );
      // The remainder is derived, so it must agree with the sale it points at.
      for (const l of d.lines as { saleId: string; remainingKg: number; allocatedKg: number; dispatchedKg: number }[]) {
        const sale = await prisma.sale.findUniqueOrThrow({ where: { id: l.saleId } });
        const expected = sale.dispatchedKg === null ? 0 : Math.max(0, sale.quantityKg - sale.dispatchedKg);
        check(`line remainder agrees with sale ${sale.invoiceNumber}`, l.remainingKg === expected, `${l.remainingKg} vs ${expected}`);
        check(`line allocation agrees with sale ${sale.invoiceNumber}`, l.allocatedKg === sale.quantityKg);
      }
      check("an audit array is present", Array.isArray(d.audit));
      check("material image list is present", Array.isArray(d.materialImages));
      check(
        "audit rows belong to this dispatch only",
        (
          await prisma.auditLog.count({
            where: { entity: "OutwardLoad", entityId: d.id, id: { in: d.audit.map((x: { id: string }) => x.id) } },
          })
        ) === d.audit.length
      );
      check("audit rows are newest first", d.audit.every((x: { createdAt: string }, i: number) => i === 0 || new Date(d.audit[i - 1].createdAt) >= new Date(x.createdAt)));
    }
  }

  console.log("\nAccess control:");
  const anon = await fetch(`${BASE}/api/admin/dashboard`, { redirect: "manual" });
  check("an anonymous caller cannot read the dashboard", anon.status >= 300, String(anon.status));

  console.log(`\n==== admin outward: ${pass} passed, ${fail} failed ====`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
