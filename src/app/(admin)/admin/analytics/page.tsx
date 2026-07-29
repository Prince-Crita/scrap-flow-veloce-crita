"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "@/lib/fetcher";
import {
  PageHead,
  Kpi,
  Card,
  Pill,
  Stat,
  StatList,
  SubNav,
  EmptyState,
  SkeletonKpis,
  inr,
  kg,
  num,
  pct,
} from "@/components/admin/ui";
import {
  ChartCard,
  Legend,
  LineChart,
  DonutChart,
  GroupedBarChart,
  StackedBarChart,
  RankedBars,
  BarChart,
  LoadingChartState,
  EmptyChartState,
  colorAt,
  compact,
  bucketBy,
  bucketLabel,
  type Granularity,
  type ChartDatum,
} from "@/components/admin/charts";
import { useAdminRealtime } from "@/components/admin/admin-realtime";
import { DateRangePicker, DEFAULT_RANGE, type DateRange } from "@/components/admin/date-range";

/* ────────────────────────────── types ────────────────────────────── */

type DayPoint = { day: string };
type SalesPoint = DayPoint & { count: number; value: number; kg: number };
type InwardPoint = DayPoint & { count: number; kg: number };
type SortPoint = DayPoint & { runs: number; sortedKg: number; wastageKg: number };
type Slice = { label: string; value: number; count?: number; icon?: string; mixed?: boolean; yardCode?: string | null };

type Analytics = {
  window: { days: number; since: string; timeZone: string; yardId: string | null };
  trends: { sales: SalesPoint[]; inward: InwardPoint[]; sort: SortPoint[]; dispatch: InwardPoint[] };
  dispatch: {
    statusDistribution: Slice[];
    awaitingKg: number;
    byMaterial: Slice[];
    byBuyer: Slice[];
    byYard: { yardId: string; label: string; yardName: string; value: number; count: number }[];
  };
  yardComparison: {
    yardId: string;
    label: string;
    yardName: string;
    active: boolean;
    salesValue: number;
    salesKg: number;
    salesCount: number;
    inwardKg: number;
    inwardCount: number;
    stockKg: number;
    pendingLoads: number;
  }[];
  materialBreakdown: Slice[];
  stockBreakdown: Slice[];
  vendorBreakdown: Slice[];
  receivableBreakdown: Slice[];
  totals: {
    salesValue: number;
    salesCount: number;
    salesKg: number;
    inwardKg: number;
    inwardCount: number;
    sortedKg: number;
    wastageKg: number;
    stockKg: number;
    dispatchKg: number;
    dispatchCount: number;
  };
};

type YardLite = { id: string; yardCode: string; yardName: string };
type Section = "overview" | "yards" | "materials" | "vendors" | "dispatch";
/** Every trend card that owns a granularity selector. */
type ChartKey = "sales" | "inward" | "throughput" | "sort" | "dispatch" | "dispatchVolume";

/* ────────────────────────────── page ────────────────────────────── */

export default function AdminAnalyticsPage() {
  const { connected } = useAdminRealtime();
  const [section, setSection] = useState<Section>("overview");
  const [range, setRange] = useState<DateRange>(DEFAULT_RANGE);
  const [yardId, setYardId] = useState("");
  /**
   * Granularity is PER CHART.
   *
   * It used to be a single `gran` shared by every trend card, so switching the
   * sales chart to Weekly silently re-bucketed inward, throughput, segregation
   * and both dispatch charts too — you could not compare a weekly sales trend
   * against a daily inward one, which is the main reason to have the control.
   * Keyed by chart id; a chart with no entry falls back to the default for the
   * current window width.
   */
  const [grans, setGrans] = useState<Partial<Record<ChartKey, Granularity>>>({});

  const yardsQ = useQuery({
    queryKey: ["adminYards"],
    queryFn: () => getJson<{ yards: YardLite[] }>("/api/admin/yards"),
  });

  const qs = new URLSearchParams({ from: range.from, to: range.to });
  if (yardId) qs.set("yardId", yardId);

  const { data, isLoading, error } = useQuery({
    queryKey: ["adminAnalytics", range.from, range.to, yardId],
    queryFn: () => getJson<Analytics>(`/api/admin/analytics?${qs.toString()}`),
    // The window rarely changes underneath you, and re-fetching on every tab
    // focus was a visible stall on a page this heavy.
    staleTime: 60_000,
  });

  const yards = yardsQ.data?.yards ?? [];
  const scopeLabel = yardId ? yards.find((y) => y.id === yardId)?.yardName ?? "one yard" : "all yards";

  /* ---------- derived series, memoised so SVG paths are not recomputed ---------- */

  /**
   * Default bucket width for the CURRENT window. A 90-day span plotted daily is
   * 90 unreadable ticks, so wide windows open on weeks — but only as a default;
   * the per-chart control overrides it.
   */
  const defaultGran: Granularity = data && data.window.days > 60 ? "week" : "day";
  const granOf = (k: ChartKey): Granularity => grans[k] ?? defaultGran;
  const setGranOf = (k: ChartKey, g: Granularity) => setGrans((prev) => ({ ...prev, [k]: g }));

  const gSales = granOf("sales");
  const gInward = granOf("inward");
  const gThroughput = granOf("throughput");
  const gSort = granOf("sort");
  const gDispatch = granOf("dispatch");
  const gDispatchVol = granOf("dispatchVolume");

  const salesBuckets = useMemo(
    () => bucketBy(data?.trends.sales ?? [], gSales, ["count", "value", "kg"]),
    [data?.trends.sales, gSales]
  );
  const inwardBuckets = useMemo(
    () => bucketBy(data?.trends.inward ?? [], gInward, ["count", "kg"]),
    [data?.trends.inward, gInward]
  );
  /** Throughput overlays two series, so both must be bucketed at ITS width. */
  const thruSales = useMemo(
    () => bucketBy(data?.trends.sales ?? [], gThroughput, ["count", "value", "kg"]),
    [data?.trends.sales, gThroughput]
  );
  const thruInward = useMemo(
    () => bucketBy(data?.trends.inward ?? [], gThroughput, ["count", "kg"]),
    [data?.trends.inward, gThroughput]
  );
  const sortBuckets = useMemo(
    () => bucketBy(data?.trends.sort ?? [], gSort, ["runs", "sortedKg", "wastageKg"]),
    [data?.trends.sort, gSort]
  );
  const dispatchBuckets = useMemo(
    () => bucketBy(data?.trends.dispatch ?? [], gDispatch, ["count", "kg"]),
    [data?.trends.dispatch, gDispatch]
  );
  const dispatchVolBuckets = useMemo(
    () => bucketBy(data?.trends.dispatch ?? [], gDispatchVol, ["count", "kg"]),
    [data?.trends.dispatch, gDispatchVol]
  );

  const salesLabels = useMemo(() => salesBuckets.map((b) => bucketLabel(b.bucket, gSales)), [salesBuckets, gSales]);
  const inwardLabels = useMemo(() => inwardBuckets.map((b) => bucketLabel(b.bucket, gInward)), [inwardBuckets, gInward]);
  const thruLabels = useMemo(() => thruInward.map((b) => bucketLabel(b.bucket, gThroughput)), [thruInward, gThroughput]);
  const sortLabels = useMemo(() => sortBuckets.map((b) => bucketLabel(b.bucket, gSort)), [sortBuckets, gSort]);
  const dispatchVolLabels = useMemo(
    () => dispatchVolBuckets.map((b) => bucketLabel(b.bucket, gDispatchVol)),
    [dispatchVolBuckets, gDispatchVol]
  );

  const salesSeries = useMemo(
    () => [{ name: "Sales value", color: colorAt(0), values: salesBuckets.map((b) => b.value) }],
    [salesBuckets]
  );
  const inwardSeries = useMemo(
    () => [{ name: "Received", color: colorAt(1), values: inwardBuckets.map((b) => b.kg) }],
    [inwardBuckets]
  );
  const throughputSeries = useMemo(
    () => [
      { name: "Inward kg", color: colorAt(1), values: thruInward.map((b) => b.kg) },
      { name: "Sold kg", color: colorAt(2), values: thruSales.map((b) => b.kg) },
    ],
    [thruInward, thruSales]
  );
  const sortSeries = useMemo(
    () => [
      { name: "Sorted", color: colorAt(0), values: sortBuckets.map((b) => b.sortedKg - b.wastageKg) },
      { name: "Wastage", color: colorAt(4), values: sortBuckets.map((b) => b.wastageKg) },
    ],
    [sortBuckets]
  );

  const dispatchLabels = useMemo(
    () => dispatchBuckets.map((b) => bucketLabel(b.bucket, gDispatch)),
    [dispatchBuckets, gDispatch]
  );

  /** Dispatch weight alone — the trend line. */
  const dispatchSeries = useMemo(
    () => [{ name: "Dispatched", color: colorAt(2), values: dispatchBuckets.map((b) => b.kg) }],
    [dispatchBuckets]
  );

  /** Vehicle count alongside weight — volume, as distinct from weight. */
  const dispatchVolumeSeries = useMemo(
    () => [{ name: "Vehicles", color: colorAt(3), values: dispatchVolBuckets.map((b) => b.count) }],
    [dispatchVolBuckets]
  );

  const dispatchStatusData = useMemo<ChartDatum[]>(
    () =>
      (data?.dispatch.statusDistribution ?? []).map((s) => ({
        label: s.label,
        value: s.value,
        sub: `${num(s.value)} allocation${s.value === 1 ? "" : "s"}`,
        // Same colour language as receivables: green done, amber part-way, red owed.
        color: s.label === "Completed" ? colorAt(2) : s.label === "Partial" ? colorAt(1) : colorAt(4),
      })),
    [data?.dispatch.statusDistribution]
  );

  const dispatchMaterialData = useMemo<ChartDatum[]>(
    () =>
      (data?.dispatch.byMaterial ?? []).slice(0, 8).map((m, i) => ({
        label: m.label,
        value: m.value,
        sub: `${num(m.count ?? 0)} line${(m.count ?? 0) === 1 ? "" : "s"}`,
        color: colorAt(i),
      })),
    [data?.dispatch.byMaterial]
  );

  const dispatchBuyerData = useMemo<ChartDatum[]>(
    () =>
      (data?.dispatch.byBuyer ?? []).slice(0, 10).map((b, i) => ({
        label: b.label,
        value: b.value,
        sub: `${num(b.count ?? 0)} vehicle${(b.count ?? 0) === 1 ? "" : "s"}`,
        color: colorAt(i),
      })),
    [data?.dispatch.byBuyer]
  );

  const dispatchYardData = useMemo<ChartDatum[]>(
    () =>
      (data?.dispatch.byYard ?? [])
        .filter((y) => y.value > 0)
        .map((y, i) => ({
          label: y.label,
          value: y.value,
          sub: `${y.yardName} · ${num(y.count)} vehicles`,
          color: colorAt(i),
        })),
    [data?.dispatch.byYard]
  );

  const receivableData = useMemo<ChartDatum[]>(
    () =>
      (data?.receivableBreakdown ?? []).map((r) => ({
        label: r.label === "PAID" ? "Paid" : r.label === "PARTIAL" ? "Partial" : "Pending",
        value: r.value,
        sub: `${num(r.count ?? 0)} invoices`,
        color: r.label === "PAID" ? colorAt(2) : r.label === "PARTIAL" ? colorAt(1) : colorAt(4),
      })),
    [data?.receivableBreakdown]
  );

  const stockData = useMemo<ChartDatum[]>(
    () =>
      (data?.stockBreakdown ?? []).slice(0, 8).map((s, i) => ({
        label: s.label,
        value: s.value,
        sub: s.mixed ? "mixed" : "finished",
        color: s.mixed ? colorAt(1) : colorAt(i % 2 === 0 ? 0 : 3),
      })),
    [data?.stockBreakdown]
  );

  const materialData = useMemo<ChartDatum[]>(
    () =>
      (data?.materialBreakdown ?? []).slice(0, 8).map((m, i) => ({
        label: m.label,
        value: m.value,
        sub: `${num(m.count ?? 0)} loads`,
        color: colorAt(i),
      })),
    [data?.materialBreakdown]
  );

  const vendorData = useMemo<ChartDatum[]>(
    () =>
      (data?.vendorBreakdown ?? []).slice(0, 10).map((v, i) => ({
        label: v.label,
        value: v.value,
        sub: `${v.yardCode ?? "—"} · ${num(v.count ?? 0)} loads`,
        color: colorAt(i),
      })),
    [data?.vendorBreakdown]
  );

  const yardCompare = useMemo(() => {
    const rows = [...(data?.yardComparison ?? [])].sort((a, b) => b.salesValue - a.salesValue).slice(0, 10);
    return {
      categories: rows.map((r) => r.label),
      rows,
      series: [
        { name: "Sales ₹", color: colorAt(0), values: rows.map((r) => r.salesValue) },
        { name: "Inward kg", color: colorAt(1), values: rows.map((r) => r.inwardKg) },
        { name: "Stock kg", color: colorAt(3), values: rows.map((r) => r.stockKg) },
      ],
    };
  }, [data?.yardComparison]);

  const pendingOps = useMemo<ChartDatum[]>(
    () =>
      (data?.yardComparison ?? [])
        .filter((y) => y.pendingLoads > 0)
        .sort((a, b) => b.pendingLoads - a.pendingLoads)
        .map((y, i) => ({ label: y.label, value: y.pendingLoads, sub: y.yardName, color: colorAt(i) })),
    [data?.yardComparison]
  );

  /* ---------- controls ---------- */

  const controls = (
    <>
      <span className={`aLive ${connected ? "on" : ""}`}>
        <i />
        {connected ? "Live" : "Reconnecting"}
      </span>
      <select value={yardId} onChange={(e) => setYardId(e.target.value)} aria-label="Yard scope">
        <option value="">All yards</option>
        {yards.map((y) => (
          <option key={y.id} value={y.id}>
            {y.yardName} ({y.yardCode})
          </option>
        ))}
      </select>
      <DateRangePicker value={range} onChange={setRange} />
    </>
  );

  /**
   * One selector per chart. `granTools(key)` returns a control bound to that
   * chart's own state, so the six trend cards no longer fight over one value.
   */
  const granTools = (k: ChartKey) => (
    <>
      {(["day", "week", "month"] as Granularity[]).map((g) => (
        <button
          key={g}
          className={`aBtn sm${granOf(k) === g ? " primary" : " ghost"}`}
          onClick={() => setGranOf(k, g)}
        >
          {g === "day" ? "Daily" : g === "week" ? "Weekly" : "Monthly"}
        </button>
      ))}
    </>
  );

  const granNoteFor = (k: ChartKey) =>
    `${granOf(k) === "day" ? "Daily" : granOf(k) === "week" ? "Weekly" : "Monthly"} · ${data?.window.timeZone ?? "Asia/Kolkata"}`;

  /* ---------- loading / error ---------- */

  if (isLoading) {
    return (
      <>
        <PageHead title="Analytics" subtitle="Loading platform analytics…">
          {controls}
        </PageHead>
        <SkeletonKpis count={4} />
        <div className="aSectionTitle">Trends</div>
        <div className="aCols two">
          <ChartCard title="Sales trend">
            <LoadingChartState />
          </ChartCard>
          <ChartCard title="Inward trend">
            <LoadingChartState />
          </ChartCard>
        </div>
      </>
    );
  }

  if (error || !data) {
    return (
      <>
        <PageHead title="Analytics">{controls}</PageHead>
        <Card>
          <EmptyState
            icon="⚠️"
            title="Could not load analytics"
            hint="The aggregate query failed. No yard is affected — this page is read-only."
            action={
              <button className="aBtn primary" onClick={() => location.reload()}>
                Retry
              </button>
            }
          />
        </Card>
      </>
    );
  }

  const t = data.totals;
  const hasTrade = t.salesCount > 0 || t.inwardCount > 0;


  return (
    <>
      <PageHead
        title="Analytics"
        subtitle={`${range.label} · ${scopeLabel} · bucketed in ${data.window.timeZone}`}
      >
        {controls}
      </PageHead>

      <SubNav<Section>
        items={[
          { key: "overview", label: "Overview" },
          { key: "yards", label: "Yard comparison", count: data.yardComparison.length },
          { key: "materials", label: "Materials", count: data.materialBreakdown.length },
          { key: "vendors", label: "Vendors", count: data.vendorBreakdown.length },
          { key: "dispatch", label: "Dispatch", count: t.dispatchCount },
        ]}
        active={section}
        onChange={setSection}
      />

      {/* ══════════════════ OVERVIEW ══════════════════ */}
      {section === "overview" && (
        <>
          <div className="aGrid">
            <Kpi
              label={`Sales · ${data.window.days}d`}
              value={inr(t.salesValue)}
              foot={`${num(t.salesCount)} invoices · ${num(t.salesKg)} kg`}
            />
            <Kpi label={`Inward · ${data.window.days}d`} value={kg(t.inwardKg)} foot={`${num(t.inwardCount)} loads received`} />
            <Kpi
              label={`Sorted · ${data.window.days}d`}
              value={kg(t.sortedKg)}
              foot={t.sortedKg > 0 ? `${pct(t.wastageKg, t.sortedKg)}% wastage (${num(t.wastageKg)} kg)` : "no segregation runs"}
            />
            <Kpi label="Stock On Hand" value={kg(t.stockKg)} foot="current, not windowed" />
          </div>

          <div className="aSectionTitle">Trends</div>
          <div className="aCols two">
            <ChartCard title="Sales trend" subtitle={granNoteFor("sales")} tools={granTools("sales")}>
              <LineChart
                series={salesSeries}
                xLabels={salesLabels}
                formatValue={(n) => `₹${compact(n)}`}
                ariaLabel={`Sales value trend over ${salesLabels.length} ${gSales} buckets, total ${inr(t.salesValue)}`}
              />
              <Legend items={[{ label: "Sales value", color: colorAt(0), value: inr(t.salesValue) }]} />
            </ChartCard>

            <ChartCard title="Inward trend" subtitle={granNoteFor("inward")} tools={granTools("inward")}>
              <LineChart
                series={inwardSeries}
                xLabels={inwardLabels}
                formatValue={compact}
                unit=" kg"
                ariaLabel={`Inward weight trend over ${inwardLabels.length} ${gInward} buckets, total ${kg(t.inwardKg)}`}
              />
              <Legend items={[{ label: "Received", color: colorAt(1), value: kg(t.inwardKg) }]} />
            </ChartCard>
          </div>

          <div className="aCols two">
            <ChartCard title="Throughput · in vs out" subtitle={granNoteFor("throughput")} tools={granTools("throughput")}>
              <LineChart
                series={throughputSeries}
                xLabels={thruLabels}
                formatValue={compact}
                unit=" kg"
                area={false}
                ariaLabel="Inward weight against sold weight over time"
              />
              <Legend
                items={[
                  { label: "Inward kg", color: colorAt(1), value: kg(t.inwardKg) },
                  { label: "Sold kg", color: colorAt(2), value: kg(t.salesKg) },
                ]}
              />
            </ChartCard>

            <ChartCard title="Segregation &amp; wastage" subtitle={granNoteFor("sort")} tools={granTools("sort")}>
              {t.sortedKg > 0 ? (
                <>
                  <StackedBarChart
                    categories={sortLabels}
                    series={sortSeries}
                    formatValue={compact}
                    unit=" kg"
                    ariaLabel={`Sorted output versus wastage, ${pct(t.wastageKg, t.sortedKg)} percent wastage`}
                  />
                  <Legend
                    items={[
                      { label: "Recovered", color: colorAt(0), value: kg(Math.max(0, t.sortedKg - t.wastageKg)) },
                      { label: "Wastage", color: colorAt(4), value: `${kg(t.wastageKg)} · ${pct(t.wastageKg, t.sortedKg)}%` },
                    ]}
                  />
                </>
              ) : (
                <EmptyChartState
                  icon="🧲"
                  title="No segregation runs in this window"
                  hint="Once a yard sorts a mixed lot, recovered weight and wastage appear here stacked per bucket."
                />
              )}
            </ChartCard>
          </div>

          <div className="aSectionTitle">Composition</div>
          <div className="aCols two">
            <ChartCard title="Stock distribution" subtitle="Current holdings by SKU · not windowed">
              <div className="aCols" style={{ gridTemplateColumns: "minmax(180px, 240px) minmax(0, 1fr)", alignItems: "center" }}>
                <DonutChart
                  data={stockData}
                  centreValue={compact(t.stockKg)}
                  centreLabel="kg on hand"
                  unit=" kg"
                  ariaLabel={`Stock distribution donut, ${kg(t.stockKg)} total`}
                />
                <RankedBars data={stockData} unit=" kg" />
              </div>
            </ChartCard>

            <ChartCard title="Collection status" subtitle="Receivables by amount">
              {receivableData.length > 0 ? (
                <>
                  <DonutChart
                    data={receivableData}
                    centreValue={`₹${compact(receivableData.reduce((a, r) => a + r.value, 0))}`}
                    centreLabel="invoiced"
                    formatValue={(n) => `₹${compact(n)}`}
                    ariaLabel="Receivables split by payment status"
                  />
                  <Legend
                    items={receivableData.map((r) => ({
                      label: r.label,
                      color: r.color ?? colorAt(0),
                      value: inr(r.value),
                    }))}
                  />
                </>
              ) : (
                <EmptyChartState icon="🧾" title="No receivables yet" hint="Appears once a sale is raised." />
              )}
            </ChartCard>
          </div>

          <div className="aSectionTitle">Pending operations</div>
          <ChartCard
            title="Lots awaiting segregation, by yard"
            subtitle="Current backlog · not windowed"
            tools={
              <Link className="aBtn sm ghost" href="/admin/yards">
                Manage yards
              </Link>
            }
          >
            {pendingOps.length > 0 ? (
              <>
                <BarChart data={pendingOps} formatValue={(n) => String(n)} unit=" lots" ariaLabel="Pending lots per yard" />
                <Legend items={pendingOps.map((p) => ({ label: `${p.label} · ${p.sub}`, color: p.color ?? colorAt(0), value: `${p.value}` }))} />
              </>
            ) : (
              <EmptyChartState
                icon="🎯"
                title="Nothing awaiting segregation"
                hint="Every received lot has been sorted. This chart fills as new mixed loads arrive."
              />
            )}
          </ChartCard>
        </>
      )}

      {/* ══════════════════ YARD COMPARISON ══════════════════ */}
      {section === "yards" && (
        <>
          <div className="aSectionTitle">Yard comparison · {range.label}</div>
          <ChartCard
            title="Sales, inward and stock by yard"
            subtitle={`Top ${yardCompare.rows.length} by sales value`}
          >
            {yardCompare.categories.length > 0 ? (
              <>
                <GroupedBarChart
                  categories={yardCompare.categories}
                  series={yardCompare.series}
                  formatValue={compact}
                  ariaLabel="Grouped comparison of sales value, inward weight and stock per yard"
                />
                <Legend
                  items={[
                    { label: "Sales ₹", color: colorAt(0) },
                    { label: "Inward kg", color: colorAt(1) },
                    { label: "Stock kg", color: colorAt(3) },
                  ]}
                />
                <div className="aTiny aMuted" style={{ marginTop: 10 }}>
                  Bars share one axis: rupees and kilograms are different units, so read each series against its own
                  legend rather than comparing bar heights across colours.
                </div>
              </>
            ) : (
              <EmptyChartState icon="🏭" title="No yards to compare" hint="Create a second yard to see comparisons." />
            )}
          </ChartCard>

          <ChartCard title="Throughput ratio" subtitle="Sold weight as a share of received weight">
            {yardCompare.rows.length > 0 ? (
              <RankedBars
                data={yardCompare.rows.map((y, i) => ({
                  label: y.yardName,
                  value: y.inwardKg > 0 ? Math.min(100, pct(y.salesKg, y.inwardKg)) : 0,
                  sub: `in ${num(y.inwardKg)} · out ${num(y.salesKg)} kg`,
                  color: y.inwardKg > 0 && y.salesKg >= y.inwardKg ? colorAt(2) : colorAt(i % 2 === 0 ? 1 : 0),
                }))}
                formatValue={(n) => String(Math.round(n))}
                unit="%"
                max={100}
              />
            ) : (
              <EmptyChartState icon="⚖️" title="No throughput data" />
            )}
          </ChartCard>

          <div className="aSectionTitle">Yard activity summary</div>
          <Card>
            <div className="aTableWrap">
              <table className="aTable">
                <thead>
                  <tr>
                    <th>Yard</th>
                    <th>Status</th>
                    <th className="num">Sales</th>
                    <th className="num">Sold kg</th>
                    <th className="num">Inward kg</th>
                    <th className="num">Stock</th>
                    <th className="num">Pending</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {[...data.yardComparison]
                    .sort((a, b) => b.salesValue - a.salesValue)
                    .map((y) => (
                      <tr key={y.yardId}>
                        <td>
                          <Link href={`/admin/yards/${y.yardId}`}>
                            <b>{y.yardName}</b>
                          </Link>
                          <div className="aTiny aMuted aMono">{y.label}</div>
                        </td>
                        <td>{y.active ? <Pill tone="ok">Active</Pill> : <Pill tone="off">Inactive</Pill>}</td>
                        <td className="num">
                          {inr(y.salesValue)}
                          <div className="aTiny aMuted">{num(y.salesCount)} inv</div>
                        </td>
                        <td className="num">{num(y.salesKg)}</td>
                        <td className="num">
                          {num(y.inwardKg)}
                          <div className="aTiny aMuted">{num(y.inwardCount)} loads</div>
                        </td>
                        <td className="num">{num(y.stockKg)}</td>
                        <td className="num">{y.pendingLoads > 0 ? num(y.pendingLoads) : "—"}</td>
                        <td>
                          <div className="actions">
                            <Link className="aBtn sm ghost" href={`/admin/yards/${y.yardId}`}>
                              Open
                            </Link>
                          </div>
                        </td>
                      </tr>
                    ))}
                  {data.yardComparison.length === 0 && (
                    <tr>
                      <td colSpan={8}>
                        <EmptyState icon="🏭" title="No yards yet" hint="Create the first yard to populate this table." />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {/* ══════════════════ MATERIALS ══════════════════ */}
      {section === "materials" && (
        <>
          <div className="aSectionTitle">Material analytics · {range.label}</div>
          <div className="aCols two">
            <ChartCard title="Inward volume by material" subtitle={`Share of ${kg(t.inwardKg)} received`}>
              {materialData.length > 0 ? (
                <>
                  <DonutChart
                    data={materialData}
                    centreValue={compact(t.inwardKg)}
                    centreLabel="kg received"
                    unit=" kg"
                    ariaLabel="Material mix of received weight"
                  />
                  <Legend
                    items={materialData.map((m) => ({
                      label: m.label,
                      color: m.color ?? colorAt(0),
                      value: `${pct(m.value, t.inwardKg)}%`,
                    }))}
                  />
                </>
              ) : (
                <EmptyChartState
                  icon="🧺"
                  title="No inward in this window"
                  hint="Widen the window or book a load to populate material analytics."
                />
              )}
            </ChartCard>

            <ChartCard title="Stock held by material" subtitle="Current holdings, sorted versus mixed">
              <RankedBars data={stockData} unit=" kg" />
              <Legend
                items={[
                  { label: "Finished", color: colorAt(0) },
                  { label: "Mixed · awaiting segregation", color: colorAt(1) },
                ]}
              />
            </ChartCard>
          </div>

          <ChartCard title="Material volume ranking" subtitle={`Received weight per material · ${range.label}`}>
            {materialData.length > 0 ? (
              <BarChart data={materialData} unit=" kg" ariaLabel="Received weight per material" />
            ) : (
              <EmptyChartState icon="🧺" title="No inward in this window" />
            )}
          </ChartCard>
        </>
      )}

      {/* ══════════════════ VENDORS ══════════════════ */}
      {section === "vendors" && (
        <>
          <div className="aSectionTitle">Vendor analytics · {range.label}</div>
          <ChartCard
            title="Supply by vendor"
            subtitle={`Top ${vendorData.length} suppliers · ${kg(t.inwardKg)} received in total`}
          >
            {vendorData.length > 0 ? (
              <>
                <RankedBars data={vendorData} unit=" kg" />
                <div className="aTiny aMuted" style={{ marginTop: 12 }}>
                  Concentration: the top supplier accounts for {pct(vendorData[0].value, t.inwardKg)}% of received
                  weight in this window.
                </div>
              </>
            ) : (
              <EmptyChartState
                icon="🚚"
                title="No vendor supply in this window"
                hint="Vendor analytics populate as inward loads are attributed to vendors. Walk-in loads have no vendor and are excluded."
              />
            )}
          </ChartCard>

          <div className="aCols two">
            <ChartCard title="Vendor share" subtitle="Proportion of received weight">
              {vendorData.length > 0 ? (
                <>
                  <DonutChart
                    data={vendorData.slice(0, 8)}
                    centreValue={compact(t.inwardKg)}
                    centreLabel="kg received"
                    unit=" kg"
                    ariaLabel="Vendor share of received weight"
                  />
                  <Legend
                    items={vendorData.slice(0, 8).map((v) => ({
                      label: v.label,
                      color: v.color ?? colorAt(0),
                      value: `${pct(v.value, t.inwardKg)}%`,
                    }))}
                  />
                </>
              ) : (
                <EmptyChartState icon="🚚" title="No vendor supply in this window" />
              )}
            </ChartCard>

            <Card title="Vendor detail">
              {vendorData.length > 0 ? (
                <StatList>
                  {vendorData.map((v, i) => (
                    <Stat
                      key={`vendor-${i}-${v.label}`}
                      label={v.label}
                      sub={v.sub}
                      value={kg(v.value)}
                      bar={{ pct: pct(v.value, vendorData[0].value) }}
                    />
                  ))}
                </StatList>
              ) : (
                <EmptyState icon="🚚" title="No vendors supplied in this window" />
              )}
            </Card>
          </div>
        </>
      )}

      {/* ══════════════════ DISPATCH ══════════════════ */}
      {section === "dispatch" && (
        <>
          <div className="aGrid">
            <Kpi
              label={`Dispatched · ${data.window.days}d`}
              value={kg(t.dispatchKg)}
              foot={`${num(t.dispatchCount)} vehicle${t.dispatchCount === 1 ? "" : "s"} loaded`}
            />
            <Kpi
              label="Awaiting Dispatch"
              value={kg(data.dispatch.awaitingKg)}
              foot={data.dispatch.awaitingKg > 0 ? "sold but still in yard" : "nothing owed to buyers"}
              accent={data.dispatch.awaitingKg > 0}
            />
            <Kpi
              label="Avg Load"
              value={t.dispatchCount > 0 ? kg(Math.round(t.dispatchKg / t.dispatchCount)) : "—"}
              foot="per vehicle in this window"
            />
            <Kpi
              label="Dispatch Fulfilment"
              value={`${pct(t.dispatchKg, t.dispatchKg + data.dispatch.awaitingKg)}%`}
              foot="dispatched against allocated"
            />
          </div>

          <div className="aSectionTitle">Dispatch trends</div>
          <div className="aCols two">
            <ChartCard title="Dispatch trend" subtitle={granNoteFor("dispatch")} tools={granTools("dispatch")}>
              {t.dispatchCount > 0 ? (
                <>
                  <LineChart
                    series={dispatchSeries}
                    xLabels={dispatchLabels}
                    formatValue={compact}
                    unit=" kg"
                    ariaLabel={`Dispatched weight over ${dispatchLabels.length} ${gDispatch} buckets, total ${kg(t.dispatchKg)}`}
                  />
                  <Legend items={[{ label: "Dispatched", color: colorAt(2), value: kg(t.dispatchKg) }]} />
                </>
              ) : (
                <EmptyChartState
                  icon="🚛"
                  title="No dispatches in this window"
                  hint="A sale allocates stock; a dispatch is the vehicle that carries it out. This chart populates as managers load vehicles."
                />
              )}
            </ChartCard>

            <ChartCard title="Dispatch volume" subtitle={`Vehicles loaded · ${granNoteFor("dispatchVolume")}`} tools={granTools("dispatchVolume")}>
              {t.dispatchCount > 0 ? (
                <>
                  <LineChart
                    series={dispatchVolumeSeries}
                    xLabels={dispatchVolLabels}
                    formatValue={(v) => String(Math.round(v))}
                    area={false}
                    ariaLabel={`Vehicles dispatched over ${dispatchVolLabels.length} ${gDispatchVol} buckets, total ${num(t.dispatchCount)}`}
                  />
                  <Legend items={[{ label: "Vehicles", color: colorAt(3), value: num(t.dispatchCount) }]} />
                </>
              ) : (
                <EmptyChartState icon="🚛" title="No vehicles loaded in this window" />
              )}
            </ChartCard>
          </div>

          <div className="aCols two">
            {/* A sale reserves stock; this shows how far each reservation has shipped. */}
            <ChartCard title="Dispatch status" subtitle="Allocations raised in this window">
              {dispatchStatusData.some((s) => s.value > 0) ? (
                <>
                  <DonutChart
                    data={dispatchStatusData}
                    centreValue={num(dispatchStatusData.reduce((a, s) => a + s.value, 0))}
                    centreLabel="allocations"
                    ariaLabel="Distribution of dispatch status across allocations"
                  />
                  <Legend
                    items={dispatchStatusData.map((s) => ({
                      label: s.label,
                      color: s.color ?? colorAt(0),
                      value: num(s.value),
                    }))}
                  />
                </>
              ) : (
                <EmptyChartState icon="📦" title="No allocations in this window" />
              )}
            </ChartCard>

            <ChartCard title="Dispatch by material" subtitle={`Top ${dispatchMaterialData.length} by weight`}>
              {dispatchMaterialData.length > 0 ? (
                <RankedBars data={dispatchMaterialData} unit=" kg" />
              ) : (
                <EmptyChartState icon="🧱" title="Nothing dispatched in this window" />
              )}
            </ChartCard>
          </div>

          <div className="aCols two">
            <ChartCard title="Dispatch by buyer" subtitle="Weight attributed through each invoice">
              {dispatchBuyerData.length > 0 ? (
                <>
                  <RankedBars data={dispatchBuyerData} unit=" kg" />
                  <div className="aTiny aMuted" style={{ marginTop: 12 }}>
                    Concentration: the largest buyer took {pct(dispatchBuyerData[0].value, t.dispatchKg)}% of dispatched
                    weight in this window.
                  </div>
                </>
              ) : (
                <EmptyChartState
                  icon="🏭"
                  title="No buyer dispatches in this window"
                  hint="Every dispatched kilogram is attributed to the invoice it satisfies, so this fills in as vehicles load."
                />
              )}
            </ChartCard>

            <ChartCard title="Dispatch by yard" subtitle={`${num(dispatchYardData.length)} yards dispatching`}>
              {dispatchYardData.length > 0 ? (
                <BarChart
                  data={dispatchYardData}
                  unit=" kg"
                  formatValue={compact}
                  ariaLabel="Dispatched weight by yard"
                />
              ) : (
                <EmptyChartState icon="🏗️" title="No yard dispatched in this window" />
              )}
            </ChartCard>
          </div>

          <Card title="Dispatch detail by yard">
            {dispatchYardData.length > 0 ? (
              <StatList>
                {dispatchYardData.map((y, i) => (
                  <Stat
                    key={`dyard-${i}-${y.label}`}
                    label={y.label}
                    sub={y.sub}
                    value={kg(y.value)}
                    bar={{ pct: pct(y.value, dispatchYardData[0].value) }}
                  />
                ))}
              </StatList>
            ) : (
              <EmptyState icon="🏗️" title="No yard dispatched in this window" />
            )}
          </Card>
        </>
      )}

      {!hasTrade && (
        <Card>
          <EmptyState
            icon="📊"
            title="Not much to analyse yet"
            hint="Analytics become meaningful once yards start booking loads and raising invoices. Every chart here updates live as that happens — no refresh needed."
            action={
              <Link className="aBtn primary" href="/admin/yards">
                Go to yards
              </Link>
            }
          />
        </Card>
      )}
    </>
  );
}
