/**
 * Exit gate: Phase 2B charts.
 *
 * Three layers:
 *   1. Pure geometry — the scale/arc/bucket maths, unit-tested with no DOM.
 *   2. Shipped output — the chart components reach the browser, the reserved
 *      placeholder boxes are gone, and no external chart library was pulled in.
 *   3. Live behaviour — charts render with real and with empty data, and a
 *      yard-side write propagates to the admin's platform SSE stream so the
 *      charts refresh without polling.
 *
 * READ-ONLY against Yard 1. The SSE propagation check writes one small inward
 * load into the disposable sandbox yard.
 *
 * Usage: start the app, then `npm run test:charts`.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import {
  niceMax,
  ticks,
  compact,
  yScale,
  bandCentres,
  bandWidth,
  linePath,
  areaPath,
  lineX,
  arc,
  pieArcs,
  plotArea,
  weekKey,
  monthKey,
  bucketBy,
  bucketLabel,
  colorAt,
  PALETTE,
  DEFAULT_BOX,
} from "../src/components/admin/charts/scale";
import { TEST_YARD_CODE, TEST_OWNER } from "./fixtures";

const prisma = new PrismaClient();
const BASE = process.env.BASE_URL || "http://localhost:3001";
const ADMIN = {
  email: process.env.ADMIN_EMAIL || "admin@scrapflow.in",
  password: process.env.ADMIN_PASSWORD || "ScrapFlow@2026",
};
const OWNER = { email: "owner@veloce.in", password: "owner123" };

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
  return { req, json, login, cookieHeader: ch };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  /* ══════════════ 1. PURE GEOMETRY ══════════════ */
  // niceMax climbs a 1/2/5 × 10ⁿ ladder, so 37,412 rounds up to 50,000 — the
  // next readable stop — not to 40,000, which is not on the ladder.
  console.log("\n[Scales] axis maxima round to readable values");
  check("niceMax(37412) → 50000", niceMax(37412) === 50000, String(niceMax(37412)));
  check("niceMax(18000) → 20000", niceMax(18000) === 20000, String(niceMax(18000)));
  check("niceMax(4200) → 5000", niceMax(4200) === 5000, String(niceMax(4200)));
  check("niceMax(1) → 1", niceMax(1) === 1, String(niceMax(1)));
  check("niceMax(1200) → 2000", niceMax(1200) === 2000, String(niceMax(1200)));
  check("niceMax(0) → 1 (never zero, avoids divide-by-zero)", niceMax(0) === 1, String(niceMax(0)));
  check("niceMax(-5) → 1 (negatives cannot break the axis)", niceMax(-5) === 1, String(niceMax(-5)));
  check("niceMax(NaN) → 1", niceMax(NaN) === 1, String(niceMax(NaN)));
  check("ticks(100, 4) spans 0..100 inclusive", JSON.stringify(ticks(100, 4)) === JSON.stringify([0, 25, 50, 75, 100]));

  console.log("\n[Scales] compact formatting uses Indian units");
  check("compact(950) → 950", compact(950) === "950", compact(950));
  check("compact(1500) → 1.5k", compact(1500) === "1.5k", compact(1500));
  check("compact(84000) → 84k", compact(84000) === "84k", compact(84000));
  check("compact(125500) → 1.3L", compact(125500) === "1.3L", compact(125500));
  check("compact(0) → 0", compact(0) === "0", compact(0));

  console.log("\n[Scales] y mapping is inverted and clamped");
  const area = plotArea(DEFAULT_BOX);
  check("value 0 sits on the baseline", yScale(0, 100, area) === area.y + area.h);
  check("value == max sits at the top", yScale(100, 100, area) === area.y);
  check("value above max is clamped, never drawn off-canvas", yScale(500, 100, area) === area.y);
  check("negative value clamps to the baseline", yScale(-10, 100, area) === area.y + area.h);
  check("max of 0 does not divide by zero", Number.isFinite(yScale(5, 0, area)));

  console.log("\n[Scales] bands and paths");
  const centres = bandCentres(4, area);
  check("4 bands produce 4 centres", centres.length === 4);
  check("band centres ascend", centres.every((c, i, a) => i === 0 || a[i - 1] < c));
  check("band centres sit inside the plot", centres.every((c) => c >= area.x && c <= area.x + area.w));
  check("bandWidth is positive", bandWidth(4, area) > 0);
  check("bandCentres(0) is empty, not a crash", bandCentres(0, area).length === 0);

  check("linePath of [] is empty", linePath([], 10, area) === "");
  check("linePath of one point draws a flat line", linePath([5], 10, area).startsWith("M "));
  const lp = linePath([1, 2, 3], 3, area);
  check("linePath has one M and two L commands", (lp.match(/M /g) ?? []).length === 1 && (lp.match(/L /g) ?? []).length === 2);
  check("linePath emits no NaN", !lp.includes("NaN"));
  const ap = areaPath([1, 2, 3], 3, area);
  check("areaPath closes the shape", ap.trim().endsWith("Z"));
  check("areaPath emits no NaN", !ap.includes("NaN"));
  check("all-zero series still produces a valid path", !linePath([0, 0, 0], 1, area).includes("NaN"));
  check("lineX centres a single point", lineX(0, 1, area) === area.x + area.w / 2);

  console.log("\n[Scales] pie/donut arcs");
  const full = arc(0, 1, 100, 100, 90, 0);
  check("a full circle produces a path (single-category pie is not blank)", full.path.length > 0);
  check("full circle uses two arcs", (full.path.match(/A /g) ?? []).length >= 2);
  check("full-circle path has no NaN", !full.path.includes("NaN"));
  const donutFull = arc(0, 1, 100, 100, 90, 55);
  check("full donut carves the inner ring", (donutFull.path.match(/A /g) ?? []).length >= 4);
  const half = arc(0, 0.5, 100, 100, 90, 0);
  check("half slice sets the large-arc flag off", half.path.includes(" 0 1 "), half.path);
  check("arc centroid is finite", Number.isFinite(half.centroid.x) && Number.isFinite(half.centroid.y));

  const arcs = pieArcs([50, 30, 20], 100, 100, 90, 0);
  check("three values → three arcs", arcs.length === 3);
  check("fractions sum to 1", Math.abs(arcs.reduce((a, s) => a + s.arc.fraction, 0) - 1) < 1e-9);
  check("zero-valued slices are dropped", pieArcs([50, 0, 50], 100, 100, 90, 0).length === 2);
  check("all-zero data produces no arcs (renders the empty state)", pieArcs([0, 0], 100, 100, 90, 0).length === 0);
  check("indices survive dropped slices", pieArcs([5, 0, 5], 100, 100, 90, 0).map((a) => a.index).join(",") === "0,2");

  console.log("\n[Buckets] weekly and monthly roll-up");
  check("weekKey is ISO format", /^\d{4}-W\d{2}$/.test(weekKey("2026-07-26")), weekKey("2026-07-26"));
  check("Mon and Sun of one ISO week share a key", weekKey("2026-07-20") === weekKey("2026-07-26"), `${weekKey("2026-07-20")} vs ${weekKey("2026-07-26")}`);
  check("the next Monday starts a new week", weekKey("2026-07-27") !== weekKey("2026-07-26"));
  check("monthKey trims to YYYY-MM", monthKey("2026-07-26") === "2026-07");

  const daily = [
    { day: "2026-07-20", kg: 10, count: 1 },
    { day: "2026-07-21", kg: 20, count: 2 },
    { day: "2026-07-27", kg: 5, count: 1 },
    { day: "2026-08-03", kg: 7, count: 1 },
  ];
  const weekly = bucketBy(daily, "week", ["kg", "count"]);
  check("weekly roll-up collapses to 3 buckets", weekly.length === 3, String(weekly.length));
  check("weekly sums the measures (10+20=30)", weekly[0].kg === 30, String(weekly[0].kg));
  check("weekly sums counts (1+2=3)", weekly[0].count === 3, String(weekly[0].count));
  const monthly = bucketBy(daily, "month", ["kg", "count"]);
  check("monthly roll-up collapses to 2 buckets", monthly.length === 2, String(monthly.length));
  check("monthly sums July (10+20+5=35)", monthly[0].kg === 35, String(monthly[0].kg));
  check("day granularity is a pass-through", bucketBy(daily, "day", ["kg"]).length === daily.length);
  check("roll-up preserves chronological order", weekly.every((b, i, a) => i === 0 || a[i - 1].bucket <= b.bucket));
  check("bucketBy([]) is empty, not a crash", bucketBy([], "week", ["kg"]).length === 0);
  check("bucketLabel(month) is human", /\w{3}/.test(bucketLabel("2026-07", "month")), bucketLabel("2026-07", "month"));

  console.log("\n[Palette] categorical colours are stable and wrap");
  check("palette has at least 8 colours", PALETTE.length >= 8);
  check("colorAt wraps past the end", colorAt(0) === colorAt(PALETTE.length));
  check("every palette entry is a hex literal", PALETTE.every((c) => /^#[0-9A-Fa-f]{6}$/.test(c)));
  check("first colour is the Veloce brand green", colorAt(0) === "#2E8B4F");

  /* ══════════════ 2. SHIPPED OUTPUT ══════════════ */
  const AD = makeClient();
  await AD.login(ADMIN.email, ADMIN.password);

  console.log("\n[Shipped] charts reach the browser and placeholders are gone");
  const anHtml = await (await AD.req("/admin/analytics")).text();
  const scripts = [...anHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  let bundle = "";
  for (const src of scripts) {
    const r = await AD.req(src.startsWith("http") ? src.replace(BASE, "") : src);
    if (r.ok) bundle += await r.text();
  }
  check("analytics ships client chunks", bundle.length > 0, `${scripts.length} scripts`);
  check("chart CSS classes ship", bundle.includes("cWrap") && bundle.includes("cLegend"));
  check("the reserved aChartBox placeholder is GONE from analytics", !bundle.includes("aChartBox"));
  check("SVG paths are generated client-side", bundle.includes("viewBox"));
  check("tooltip component ships", bundle.includes("cTip"));
  check("donut centre label ships", bundle.includes("cDonutLabel"));
  check("ranked bars ship", bundle.includes("cRank"));

  console.log("\n[Shipped] no external chart library and no CDN");
  // Read from disk: Node's fetch does not implement the file: scheme.
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const banned of ["recharts", "chart.js", "d3", "victory", "nivo", "apexcharts", "echarts", "plotly.js", "highcharts"]) {
    check(`no "${banned}" dependency`, !Object.keys(deps).some((d) => d === banned || d.startsWith(`${banned}/`)));
  }
  check("no CDN script tags on the analytics page", !/<script[^>]+src="https?:\/\//.test(anHtml));
  check("no external stylesheet links", !/<link[^>]+href="https?:\/\/(?!fonts\.)/.test(anHtml));

  console.log("\n[Shipped] dashboard sparklines replaced its placeholder");
  const dashHtml = await (await AD.req("/admin")).text();
  const dScripts = [...dashHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  let dBundle = "";
  for (const src of dScripts) {
    const r = await AD.req(src.startsWith("http") ? src.replace(BASE, "") : src);
    if (r.ok) dBundle += await r.text();
  }
  check("dashboard ships the sparkline row", dBundle.includes("cSparkRow"));
  check("dashboard no longer says charts live elsewhere", !dBundle.includes("Charts live on the Analytics page"));

  /* ══════════════ 3. LIVE DATA ══════════════ */
  console.log("\n[Live data] every window and granularity returns chartable series");
  for (const days of ["7", "30", "90"]) {
    const a = await (await AD.req(`/api/admin/analytics?days=${days}`)).json();
    const pts = a.trends.sales as { day: string; value: number; kg: number; count: number }[];
    check(`days=${days}: series is continuous`, pts.length === Number(days) + 1, String(pts.length));
    check(`days=${days}: every value is finite`, pts.every((p) => Number.isFinite(p.value) && Number.isFinite(p.kg)));
    check(`days=${days}: no negative values could invert a bar`, pts.every((p) => p.value >= 0));
    // Roll-up must conserve the total, or the chart lies about the period.
    const dailyTotal = pts.reduce((s, p) => s + p.value, 0);
    const weeklyTotal = bucketBy(pts, "week", ["value"]).reduce((s, p) => s + p.value, 0);
    const monthlyTotal = bucketBy(pts, "month", ["value"]).reduce((s, p) => s + p.value, 0);
    check(`days=${days}: weekly roll-up conserves the total`, Math.abs(dailyTotal - weeklyTotal) < 0.01, `${dailyTotal} vs ${weeklyTotal}`);
    check(`days=${days}: monthly roll-up conserves the total`, Math.abs(dailyTotal - monthlyTotal) < 0.01, `${dailyTotal} vs ${monthlyTotal}`);
  }

  console.log("\n[Empty data] charts survive a yard with no activity");
  // A brand-new yard has zero of everything — the charts must render an empty
  // state, not divide by zero or produce NaN paths.
  const emptyYard = await prisma.yard.create({
    data: { yardCode: "SFCHART0", yardName: "Chart Empty Yard", city: "Nowhere" },
  });
  try {
    const e = await (await AD.req(`/api/admin/analytics?days=30&yardId=${emptyYard.id}`)).json();
    check("empty yard responds 200 with a full series", e.trends.sales.length === 31, String(e.trends.sales.length));
    check("empty yard totals are all zero", e.totals.salesValue === 0 && e.totals.inwardKg === 0 && e.totals.stockKg === 0);
    check("empty yard breakdowns are empty arrays", e.stockBreakdown.length === 0 && e.materialBreakdown.length === 0);
    check("empty yard receivables are empty", e.receivableBreakdown.length === 0);
    // Feed the zeros through the real geometry.
    const zeros = e.trends.sales.map((p: { value: number }) => p.value);
    check("zero series produces a NaN-free line path", !linePath(zeros, niceMax(Math.max(0, ...zeros)), area).includes("NaN"));
    check("zero series produces a NaN-free area path", !areaPath(zeros, niceMax(Math.max(0, ...zeros)), area).includes("NaN"));
    check("zero series produces no pie arcs", pieArcs(zeros, 100, 100, 90, 0).length === 0);
    check("empty yard comparison has one row", e.yardComparison.length === 1);
  } finally {
    await prisma.yard.delete({ where: { id: emptyYard.id } });
  }
  check("chart-test yard removed", (await prisma.yard.findUnique({ where: { yardCode: "SFCHART0" } })) === null);

  /* ══════════════ 4. SSE PROPAGATION ══════════════ */
  console.log("\n[Realtime] a yard write reaches the admin stream that drives the charts");
  const sandbox = await prisma.yard.findUnique({ where: { yardCode: TEST_YARD_CODE } });
  if (!sandbox) {
    check("sandbox yard present (run tests/fixtures.ts up)", false);
  } else {
    const controller = new AbortController();
    const res = await fetch(BASE + "/api/admin/realtime/stream", {
      headers: { cookie: AD.cookieHeader(), accept: "text/event-stream" },
      signal: controller.signal,
    });
    check("admin platform stream opens", res.ok && !!res.body, `status ${res.status}`);

    const events: { yardId: string; channel: string }[] = [];
    let ready = false;
    if (res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      (async () => {
        let buf = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const frames = buf.split("\n\n");
            buf = frames.pop() ?? "";
            for (const f of frames) {
              const ev = /^event: (.+)$/m.exec(f)?.[1];
              const data = /^data: (.+)$/m.exec(f)?.[1];
              if (ev === "ready") ready = true;
              if (ev === "platform" && data) {
                try {
                  events.push(JSON.parse(data));
                } catch {
                  /* ignore */
                }
              }
            }
          }
        } catch {
          /* aborted */
        }
      })();
    }

    await sleep(700);
    check("stream signalled ready", ready);

    const O = makeClient();
    await O.login(TEST_OWNER.email, TEST_OWNER.password);
    const bucket = await prisma.sku.findFirstOrThrow({ where: { yardId: sandbox.id, code: "MIXMS" } });
    const before = (await (await AD.req("/api/admin/analytics?days=7")).json()).totals.inwardKg;

    const created = await O.json("/api/inward/loads", { materialSkuId: bucket.id, entries: [90] });
    check("sandbox inward load created", created.status === 201, `got ${created.status}`);
    await sleep(900);

    check("admin stream received the event", events.length > 0, JSON.stringify(events.slice(0, 3)));
    check("event is tagged with the sandbox yard", events.some((e) => e.yardId === sandbox.id));
    check(
      "event is on a channel the charts listen to",
      events.some((e) => ["inward", "stock", "sort"].includes(e.channel)),
      events.map((e) => e.channel).join(",")
    );

    // The chart data source must actually reflect the write — this is what the
    // SSE-triggered invalidation refetches.
    const after = (await (await AD.req("/api/admin/analytics?days=7")).json()).totals.inwardKg;
    check(`analytics inward rose by 90 kg (${before} → ${after})`, after === before + 90, `got ${after}`);

    controller.abort();
  }

  console.log("\n[Realtime] the charts' query key is registered for invalidation");
  const rtSrc = await (await AD.req("/admin")).text();
  const rtScripts = [...rtSrc.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  let rtBundle = "";
  for (const src of rtScripts) {
    const r = await AD.req(src.startsWith("http") ? src.replace(BASE, "") : src);
    if (r.ok) rtBundle += await r.text();
  }
  check("adminAnalytics key is in the invalidation list", rtBundle.includes("adminAnalytics"));

  /**
   * Assert on OUR source, not the shipped bundle: TanStack Query defines
   * `refetchInterval` as an option in its own code, so the string is always
   * present downstream regardless of whether we use it. Scanning source is the
   * only way to prove we introduced no polling.
   */
  const sourceFiles = [
    "src/app/(admin)/admin/page.tsx",
    "src/app/(admin)/admin/analytics/page.tsx",
    "src/components/admin/charts/primitives.tsx",
    "src/components/admin/charts/scale.ts",
    "src/components/admin/admin-realtime.tsx",
    "src/app/(app)/stock/page.tsx",
    "src/app/(app)/sell/page.tsx",
  ];
  for (const f of sourceFiles) {
    const src = readFileSync(f, "utf8");
    check(`${f.split("/").pop()} uses no refetchInterval`, !/refetchInterval/.test(src));
  }
  // setInterval is allowed only for the SSE heartbeat and the impersonation
  // elapsed-time ticker — never to poll an endpoint.
  const chartSrc = readFileSync("src/components/admin/charts/primitives.tsx", "utf8");
  check("chart primitives contain no timers at all", !/setInterval|setTimeout/.test(chartSrc));
  check("chart primitives issue no fetches", !/fetch\(/.test(chartSrc));

  /* ══════════════ 5. ISOLATION ══════════════ */
  console.log("\n[Isolation] chart CSS cannot reach the phone UI");
  const O2 = makeClient();
  await O2.login(OWNER.email, OWNER.password);
  for (const path of ["/stock", "/inward", "/sort", "/sell"]) {
    const html = await (await O2.req(path)).text();
    const body = /<body[^>]*>/i.exec(html)?.[0] ?? "";
    check(`${path} body has no admin shell attribute`, !/data-shell=["']?admin/i.test(body), body);
    check(`${path} still has the phone frame`, html.includes('id="phoneFrame"'));
    check(`${path} renders no chart markup`, !html.includes("cWrap") && !html.includes("cLegend"));
  }

  console.log(`\n==== charts: ${pass} passed, ${fail} failed ====`);
  if (fail > 0) process.exit(1);
}

main()
  .catch(async (e) => {
    console.error(e);
    await prisma.yard.deleteMany({ where: { yardCode: "SFCHART0" } }).catch(() => {});
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
