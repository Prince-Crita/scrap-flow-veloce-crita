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
  AlertList,
  AlertRow,
  SubNav,
  EmptyState,
  SkeletonKpis,
  SkeletonRows,
  inr,
  kg,
  num,
  when,
  duration,
  pct,
} from "@/components/admin/ui";
import { DEFAULT_RANGE, type DateRange } from "@/components/admin/date-range";
import {
  ChartCard,
  Sparkline,
  Legend,
  LoadingChartState,
  DonutChart,
  RankedBars,
  SplitBar,
  colorAt,
} from "@/components/admin/charts";

/**
 * Categorical order for the dashboard's own breakdowns.
 *
 * NOT `colorAt`'s default order. The shared PALETTE puts `--led (#6FE3A5)` and
 * `--mint (#9FE6B8)` in adjacent slots, and they are effectively the same colour
 * — ΔE 5.5 to normal vision, 2.8 under protanopia — so any four-slice breakdown
 * using the default cycle produced two segments nobody could tell apart. This
 * order is drawn from the same brand tokens and was validated for adjacent-pair
 * separation against the console's dark surface: worst normal-vision pair ΔE 19.7,
 * worst CVD pair ΔE 14.2, all six above 3:1 contrast.
 *
 * The shared PALETTE is deliberately left alone — changing it would repaint every
 * analytics chart, which is outside a UI-polish pass.
 */
const VIZ = ["#2E8B4F", "#F59E2B", "#4FA3D1", "#FF6B5C", "#B98CD9"] as const;
const vizAt = (i: number) => VIZ[i % VIZ.length];

/**
 * Ranked bars use ONE hue, not the categorical cycle.
 *
 * In a ranked list the bar LENGTH carries the magnitude and the row label carries
 * the identity — so giving each row its own colour invents a categorical encoding
 * that does not exist, and eight rainbow bars read as eight unrelated things
 * rather than one ordered list. Single hue, ordered by length.
 */
const RANK_HUE = "#2E8B4F";

/** Sorted vs unsorted, paid vs outstanding — the two-part splits. */
const TONE = { good: "#6FE3A5", warn: "#F59E2B", quiet: "#4FA3D1", bad: "#FF6B5C" } as const;
import { useAdminRealtime } from "@/components/admin/admin-realtime";

/* ────────────────────────────── types ────────────────────────────── */

type Tone = "warn" | "bad" | "good" | "muted";
type Alert = { id: string; tone: Tone; icon: string; title: string; detail: string; href?: string };

type Dashboard = {
  generatedAt: string;
  kpis: {
    yardsActive: number;
    yardsInactive: number;
    yardsTotal: number;
    usersTotal: number;
    owners: number;
    managers: number;
    admins: number;
    usersInactive: number;
    stockKg: number;
    finishedKg: number;
    unsortedKg: number;
    pendingLoads: number;
    // ---- dispatch (Phase 4 Outward) ----
    dispatchesTotal: number;
    dispatchesPending: number;
    dispatchesPartial: number;
    dispatchesCompleted: number;
    dispatchKgToday: number;
    dispatchKgWeek: number;
    dispatchKgMonth: number;
    dispatchKgLifetime: number;
    dispatchCountToday: number;
    dispatchCountWeek: number;
    dispatchCountMonth: number;
    awaitingDispatchKg: number;
    readyToSellCount: number;
    salesTodayValue: number;
    salesTodayCount: number;
    sales7Value: number;
    sales7Count: number;
    salesLifetimeValue: number;
    salesLifetimeCount: number;
    salesLifetimeKg: number;
    outstanding: number;
    outstandingCount: number;
    collected: number;
    collectedCount: number;
    inwardTodayCount: number;
    inwardTodayKg: number;
    inward7Count: number;
    inward7Kg: number;
    adminsInsideYards: number;
  };
  yardSummary: {
    id: string;
    yardCode: string;
    yardName: string;
    city: string | null;
    state: string | null;
    active: boolean;
    owners: number;
    managers: number;
    stockKg: number;
    pendingLoads: number;
    pendingKg: number;
    sales30Count: number;
    sales30Value: number;
    lastSaleAt: string | null;
    adminInside: boolean;
  }[];
  stockSummary: {
    totalKg: number;
    finishedKg: number;
    unsortedKg: number;
    mixedBuckets: number;
    batches: number;
    batchRemainingKg: number;
    readyToSell: { name: string; icon: string; kg: number; thresholdKg: number }[];
    topSkus: { name: string; icon: string; kg: number; yards: number }[];
  };
  vendorSummary: {
    active: number;
    inactive: number;
    top: { id: string | null; name: string; yardCode: string | null; active: boolean; kg: number; loads: number }[];
  };
  materialSummary: {
    active: number;
    inactive: number;
    byVolume: { label: string; kg: number; loads: number }[];
  };
  sellSummary: {
    today: { count: number; value: number; kg: number };
    last7: { count: number; value: number; kg: number };
    lifetime: { count: number; value: number; kg: number };
    receivables: { status: string; count: number; amount: number }[];
    topBuyers: { id: string; name: string; yardCode: string | null; value: number; invoices: number }[];
  };
  dispatchSummary: {
    total: number;
    pending: number;
    partial: number;
    completed: number;
    awaitingKg: number;
    kg: { today: number; week: number; month: number; lifetime: number };
    count: { today: number; week: number; month: number };
    statusDistribution: { label: string; value: number }[];
    byYard: { yardId: string; yardCode: string; yardName: string; dispatches: number; kg: number }[];
  };
  recentDispatches: {
    id: string;
    yardCode: string;
    dispatchNumber: string;
    vehicleNumber: string | null;
    driverName: string | null;
    totalKg: number;
    dispatchedBy: string | null;
    at: string;
    materials: { name: string; kg: number; invoiceNumber: string; buyerName: string }[];
  }[];
  opsSummary: {
    inwardToday: { count: number; kg: number };
    inward7: { count: number; kg: number };
    sort7: { runs: number; kg: number; wastageKg: number };
    pendingByYard: { yardId: string; yardCode: string; loads: number; kg: number }[];
    oldestPending: { id: string; lotNumber: string; totalKg: number; createdAt: string; yardId: string; yardCode: string } | null;
  };
  /** OCR sidecar health, supplied by the supervisor rather than a query. */
  ocr?: {
    state: "disabled" | "starting" | "ready" | "degraded" | "unreachable" | "unavailable";
    detail: string;
    managed: boolean;
    components: Record<string, boolean> | null;
    lastHealthyAt: string | null;
    restarts: number;
    pid: number | null;
    url: string | null;
  };
  alerts: Alert[];
  pendingActions: Alert[];
  recentActivity: {
    sales: {
      id: string;
      invoiceNumber: string;
      total: number;
      quantityKg: number;
      createdAt: string;
      yardId: string;
      yardCode: string;
      buyerName: string;
      skuName: string;
      skuIcon: string;
    }[];
    loads: {
      id: string;
      lotNumber: string;
      materialLabel: string;
      totalKg: number;
      status: string;
      createdAt: string;
      yardId: string;
      yardCode: string;
      vendorName: string;
    }[];
    audit: {
      id: string;
      action: string;
      entity: string;
      createdAt: string;
      actorName: string;
      yardId: string | null;
      yardCode: string | null;
    }[];
  };
  activeImpersonations: {
    id: string;
    adminName: string;
    adminEmail: string;
    yardId: string;
    yardCode: string;
    yardName: string;
    startedAt: string;
  }[];
};

type ActivityTab = "sales" | "loads" | "audit";

/* ────────────────────────────── page ────────────────────────────── */

export default function AdminDashboardPage() {
  const { connected, lastEvent } = useAdminRealtime();
  const [tab, setTab] = useState<ActivityTab>("sales");
  /**
   * Window for the trend card at the foot of the page.
   *
   * Fixed, not user-selectable. The header briefly carried a range picker, but it
   * could only ever scope this one section — every KPI card, alert and table above
   * is served by `/api/admin/dashboard`, which computes its own fixed windows
   * server-side and takes no parameters. A control that visibly moved one card and
   * left the rest of the dashboard unchanged read as broken, so it was removed and
   * the section keeps the 30-day default. `/admin/analytics` is where a date range
   * belongs, and it still has one.
   */
  const range: DateRange = useMemo(() => DEFAULT_RANGE(), []);

  const { data, isLoading, error } = useQuery({
    queryKey: ["adminDashboard"],
    queryFn: () => getJson<Dashboard>("/api/admin/dashboard"),
  });

  /* ---------- loading: mirror the real layout so nothing jumps ---------- */
  if (isLoading) {
    return (
      <>
        <PageHead title="Platform Overview" subtitle="Loading platform data…" />
        <SkeletonKpis count={6} />
        <div className="aSectionTitle">Attention</div>
        <div className="aCols">
          <Card title="Alerts">
            <SkeletonRows rows={3} />
          </Card>
          <Card title="Pending actions">
            <SkeletonRows rows={3} />
          </Card>
        </div>
        <div className="aSectionTitle">Yards</div>
        <Card>
          <SkeletonRows rows={5} />
        </Card>
      </>
    );
  }

  if (error || !data) {
    return (
      <>
        <PageHead title="Platform Overview" />
        <Card>
          <EmptyState
            icon="⚠️"
            title="Could not load the dashboard"
            hint="The platform data request failed. This does not affect any yard — Owner and Manager apps are unaffected."
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

  const k = data.kpis;
  const s = data.stockSummary;
  const yardsWithData = data.yardSummary.length > 0;

  return (
    <>
      <PageHead
        title="Platform Overview"
        subtitle={`${num(k.yardsActive)} active ${k.yardsActive === 1 ? "yard" : "yards"} · ${num(k.usersTotal)} yard users · updated ${when(data.generatedAt)}`}
      >
        <span className={`aLive ${connected ? "on" : ""}`}>
          <i />
          {connected ? "Live" : "Reconnecting"}
        </span>
      </PageHead>

      {/* ══════════ 1. HEADLINE KPIs ══════════ */}
      <div className="aGrid">
        <Kpi
          label="Active Yards"
          value={num(k.yardsActive)}
          foot={k.yardsInactive > 0 ? `${num(k.yardsInactive)} deactivated` : "all yards active"}
        />
        <Kpi label="Stock On Hand" value={kg(k.stockKg)} foot={`${kg(k.unsortedKg)} still unsorted`} />
        <Kpi
          label="Sales Today"
          value={inr(k.salesTodayValue)}
          foot={`${num(k.salesTodayCount)} ${k.salesTodayCount === 1 ? "invoice" : "invoices"} · ${inr(k.sales7Value)} this week`}
        />
        <Kpi
          label="Outstanding"
          value={inr(k.outstanding)}
          foot={`${num(k.outstandingCount)} unpaid · ${inr(k.collected)} collected`}
          accent={k.outstanding > 0}
        />
        <Kpi
          label="Awaiting Sort"
          value={num(k.pendingLoads)}
          foot={k.pendingLoads > 0 ? "lots need segregation" : "nothing pending"}
          accent={k.pendingLoads > 0}
        />
        <Kpi
          label="Yard Users"
          value={num(k.usersTotal)}
          foot={`${num(k.owners)} owners · ${num(k.managers)} managers${k.usersInactive ? ` · ${num(k.usersInactive)} disabled` : ""}`}
        />
        {/* Dispatch (Phase 4 Outward). Same Kpi primitive as every tile above —
            these join the existing row rather than introducing a new band. */}
        <Kpi
          label="Dispatches"
          value={num(k.dispatchesTotal)}
          foot={`${num(k.dispatchesPending)} pending · ${num(k.dispatchesPartial)} partial · ${num(k.dispatchesCompleted)} completed`}
          accent={k.dispatchesPartial > 0}
        />
        <Kpi
          label="Awaiting Dispatch"
          value={kg(k.awaitingDispatchKg)}
          foot={k.awaitingDispatchKg > 0 ? "sold but still in yard" : "nothing owed to buyers"}
          accent={k.awaitingDispatchKg > 0}
        />
        <Kpi
          label="Dispatched Today"
          value={kg(k.dispatchKgToday)}
          foot={`${num(k.dispatchCountToday)} vehicle${k.dispatchCountToday === 1 ? "" : "s"} · ${kg(k.dispatchKgWeek)} this week`}
        />
        <Kpi
          label="Dispatched This Month"
          value={kg(k.dispatchKgMonth)}
          foot={`${num(k.dispatchCountMonth)} vehicles · ${kg(k.dispatchKgLifetime)} lifetime`}
        />
      </div>

      {/*
        A "Today at a glance" strip was built here and then removed on looking at
        the rendered page: the KPI row directly above already carries SALES TODAY
        and DISPATCHED TODAY, and the Operations card carries "Inward today" — so
        all four of its figures already existed elsewhere. It added a third band of
        small numbers above the fold and increased reading rather than reducing it,
        which is the opposite of this phase's goal. Left out deliberately.
      */}

      {/* ══════════ 2. ATTENTION: alerts + pending actions ══════════ */}
      <div className="aSectionTitle">Needs attention</div>
      <div className="aCols">
        <Card title={`Alerts (${data.alerts.filter((a) => a.tone !== "good").length + (data.ocr && data.ocr.state !== "ready" && data.ocr.state !== "disabled" ? 1 : 0)})`}>
          <AlertList>
            {/* OCR sidecar health. Shown only when it needs attention: a healthy
                service is not news, and "disabled" is a deployment choice, not a
                fault. Reuses AlertRow — no new component, no redesign. */}
            {data.ocr && data.ocr.state !== "ready" && data.ocr.state !== "disabled" && (
              <AlertRow
                tone={data.ocr.state === "starting" ? "warn" : "bad"}
                icon="📷"
                title={
                  data.ocr.state === "starting"
                    ? "ANPR service is starting"
                    : data.ocr.state === "degraded"
                      ? "ANPR service is running without models"
                      : data.ocr.state === "unavailable"
                        ? "ANPR service cannot start"
                        : "ANPR service is not responding"
                }
                detail={`${data.ocr.detail}. Plate capture falls back to manual entry — no yard is blocked.${
                  data.ocr.restarts > 0 ? ` ${data.ocr.restarts} restart(s) so far.` : ""
                }`}
              />
            )}
            {data.alerts.map((a) => (
              <AlertRow
                key={a.id}
                tone={a.tone}
                icon={a.icon}
                title={a.title}
                detail={a.detail}
                action={
                  a.href ? (
                    <Link className="aBtn sm ghost" href={a.href}>
                      View
                    </Link>
                  ) : undefined
                }
              />
            ))}
          </AlertList>
        </Card>

        <Card title={`Pending actions (${data.pendingActions.filter((a) => a.tone !== "good").length})`}>
          <AlertList>
            {data.pendingActions.map((a) => (
              <AlertRow
                key={a.id}
                tone={a.tone}
                icon={a.icon}
                title={a.title}
                detail={a.detail}
                action={
                  a.href ? (
                    <Link className="aBtn sm ghost" href={a.href}>
                      Open
                    </Link>
                  ) : undefined
                }
              />
            ))}
          </AlertList>
        </Card>
      </div>

      {/* ══════════ 3. ADMIN SESSIONS (only when relevant) ══════════ */}
      {data.activeImpersonations.length > 0 && (
        <>
          <div className="aSectionTitle">Admin sessions inside yards</div>
          <Card>
            <div className="aTableWrap">
              <table className="aTable">
                <thead>
                  <tr>
                    <th>Admin</th>
                    <th>Yard</th>
                    <th>Entered</th>
                    <th className="num">Elapsed</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.activeImpersonations.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <b>{i.adminName}</b>
                        <div className="aTiny aMuted">{i.adminEmail}</div>
                      </td>
                      <td>
                        <Link href={`/admin/yards/${i.yardId}`}>{i.yardName}</Link>
                        <div className="aTiny aMuted aMono">{i.yardCode}</div>
                      </td>
                      <td className="aTiny aMuted">{when(i.startedAt)}</td>
                      <td className="num">
                        {duration(Math.max(0, Math.round((Date.now() - new Date(i.startedAt).getTime()) / 1000)))}
                      </td>
                      <td>
                        <div className="actions">
                          <Link className="aBtn sm ghost" href="/admin/audit">
                            Audit
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {/* ══════════ 4. YARD OVERVIEW ══════════ */}
      <div className="aSectionTitle">Yard overview · last 30 days</div>
      <Card actions={<Link className="aBtn sm ghost" href="/admin/yards">Manage yards</Link>}>
        {yardsWithData ? (
          <div className="aTableWrap">
            <table className="aTable">
              <thead>
                <tr>
                  <th>Yard</th>
                  <th>Location</th>
                  <th>Status</th>
                  <th className="num">Staff</th>
                  <th className="num">Stock</th>
                  <th className="num">Pending</th>
                  <th className="num">Sales (30d)</th>
                  <th>Last sale</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.yardSummary.map((y) => (
                  <tr key={y.id}>
                    <td>
                      <Link href={`/admin/yards/${y.id}`}>
                        <b>{y.yardName}</b>
                      </Link>
                      <div className="aTiny aMuted aMono">{y.yardCode}</div>
                      {y.adminInside && (
                        <div style={{ marginTop: 4 }}>
                          <Pill tone="warn">Admin inside</Pill>
                        </div>
                      )}
                    </td>
                    <td className="aTiny">{[y.city, y.state].filter(Boolean).join(", ") || "—"}</td>
                    <td>{y.active ? <Pill tone="ok">Active</Pill> : <Pill tone="off">Inactive</Pill>}</td>
                    <td className="num">
                      {num(y.owners + y.managers)}
                      <div className="aTiny aMuted">
                        {y.owners}O · {y.managers}M
                      </div>
                    </td>
                    <td className="num">{num(y.stockKg)}</td>
                    <td className="num">
                      {y.pendingLoads > 0 ? (
                        <>
                          {num(y.pendingLoads)}
                          <div className="aTiny aMuted">{num(y.pendingKg)} kg</div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="num">
                      {inr(y.sales30Value)}
                      <div className="aTiny aMuted">{num(y.sales30Count)} inv</div>
                    </td>
                    <td className="aTiny aMuted">{y.lastSaleAt ? when(y.lastSaleAt) : "never"}</td>
                    <td>
                      <div className="actions">
                        <Link className="aBtn sm ghost" href={`/admin/yards/${y.id}`}>
                          Open
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon="🏭"
            title="No yards yet"
            hint="Create the first yard to start operating. It is provisioned with the standard MS / PET / Aluminum material tree so it can receive a load immediately."
            action={
              <Link className="aBtn primary" href="/admin/yards">
                Create the first yard
              </Link>
            }
          />
        )}
      </Card>

      {/* ══════════ 5. STOCK + SELL ══════════ */}
      <div className="aSectionTitle">Stock &amp; trade</div>
      <div className="aCols two">
        <Card title="Stock overview">
          {/*
            The headline question is "how much of our stock is actually sellable?".
            That is one number divided in two, which a donut answers instantly and
            two stacked text rows did not — the total sits in the middle, so the
            absolute and the proportion are read in one look.
          */}
          {s.totalKg > 0 ? (
            <>
              <DonutChart
                data={[
                  { label: "Sorted / finished", value: s.finishedKg, color: TONE.good },
                  { label: "Unsorted (mixed)", value: s.unsortedKg, color: TONE.warn },
                ]}
                size={190}
                centreValue={kg(s.totalKg)}
                centreLabel="on hand"
                formatValue={(n) => kg(n)}
                ariaLabel={`Stock split: sorted ${pct(s.finishedKg, s.totalKg)}%, unsorted ${pct(s.unsortedKg, s.totalKg)}%`}
              />
              <Legend
                items={[
                  { label: "Sorted / finished", color: TONE.good, value: `${kg(s.finishedKg)} · ${pct(s.finishedKg, s.totalKg)}%` },
                  { label: "Unsorted (mixed)", color: TONE.warn, value: `${kg(s.unsortedKg)} · ${pct(s.unsortedKg, s.totalKg)}%` },
                ]}
              />
            </>
          ) : (
            <EmptyState icon="📦" title="No stock recorded" hint="Stock appears here once a yard books its first inward load." />
          )}

          {/* The counts stay as figures: they are not parts of the tonnage above. */}
          <StatList>
            <Stat label="Traceable batches" value={num(s.batches)} dim />
            <Stat label="Mixed buckets" value={num(s.mixedBuckets)} dim />
            <Stat label="Ready to sell" value={num(s.readyToSell.length)} dim />
          </StatList>

          {s.topSkus.length > 0 && (
            <div className="aCardViz">
              <div className="aCardTitle" style={{ marginBottom: 8 }}>
                Largest holdings
              </div>
              {/* Ranked magnitude — bars against the largest holding, so the
                  relative sizes are the point rather than the raw numbers. */}
              <RankedBars
                data={s.topSkus.map((t) => ({
                  // SKU NAMES REPEAT ACROSS YARDS — there is no id in this
                  // aggregate, so position remains the only stable identity.
                  label: `${t.icon} ${t.name}`,
                  value: t.kg,
                  sub: `${t.yards} yard${t.yards === 1 ? "" : "s"}`,
                  color: RANK_HUE,
                }))}
                formatValue={(n) => kg(n)}
              />
            </div>
          )}
        </Card>

        <Card title="Sell overview">
          {/*
            Today / 7 days / lifetime are the SAME measure over nested windows, so
            they are deliberately left as figures. Charted together, lifetime would
            flatten today to an invisible sliver — the classic scale mistake.
          */}
          <StatList>
            <Stat
              label="Today"
              sub={`${num(data.sellSummary.today.count)} invoice${data.sellSummary.today.count === 1 ? "" : "s"} · ${num(data.sellSummary.today.kg)} kg`}
              value={inr(data.sellSummary.today.value)}
            />
            <Stat
              label="Last 7 days"
              sub={`${num(data.sellSummary.last7.count)} invoices · ${num(data.sellSummary.last7.kg)} kg`}
              value={inr(data.sellSummary.last7.value)}
            />
            <Stat
              label="Lifetime"
              sub={`${num(data.sellSummary.lifetime.count)} invoices · ${num(data.sellSummary.lifetime.kg)} kg`}
              value={inr(data.sellSummary.lifetime.value)}
              dim
            />
          </StatList>

          <div className="aCardViz">
            <div className="aCardTitle" style={{ marginBottom: 8 }}>
              Collection status
            </div>
            {data.sellSummary.receivables.length > 0 ? (
              <>
                {/*
                  Money owed against money collected is a single pot divided by
                  state, so one proportion bar says it — and unlike the stock
                  donut above, it keeps its place inside a dense card without
                  demanding a square. Status colours are the reserved ones and
                  every segment is labelled, so state is never colour-alone.
                */}
                {/* The legend below the bar carries the amount AND the invoice
                    count, so the stat rows that used to repeat both were removed
                    rather than left to say the same thing twice. */}
                <SplitBar
                  data={data.sellSummary.receivables.map((r) => ({
                    label: `${r.status === "PAID" ? "Paid" : r.status === "PARTIAL" ? "Partial" : "Pending"} · ${num(r.count)} inv`,
                    value: r.amount,
                    color: r.status === "PAID" ? TONE.good : r.status === "PARTIAL" ? TONE.warn : TONE.quiet,
                  }))}
                  formatValue={(n) => inr(n)}
                  ariaLabel="Receivables by collection status"
                />
              </>
            ) : (
              <EmptyState icon="🧾" title="No invoices yet" hint="Receivables appear once a yard owner raises the first sale." />
            )}
          </div>

          {data.sellSummary.topBuyers.length > 0 && (
            <div className="aCardViz">
              <div className="aCardTitle" style={{ marginBottom: 8 }}>
                Top buyers · 30 days
              </div>
              <RankedBars
                data={data.sellSummary.topBuyers.map((b) => ({
                  label: b.name,
                  value: b.value,
                  sub: `${b.yardCode ?? "—"} · ${num(b.invoices)} invoice${b.invoices === 1 ? "" : "s"}`,
                  color: RANK_HUE,
                }))}
                formatValue={(n) => inr(n)}
              />
            </div>
          )}
        </Card>
      </div>

      {/* ══════════ 6. VENDOR + MATERIAL + OPS ══════════ */}
      <div className="aSectionTitle">Supply &amp; operations</div>
      <div className="aCols">
        <Card title="Vendor overview">
          <StatList>
            <Stat label="Active vendors" value={num(data.vendorSummary.active)} />
            <Stat label="Deactivated" value={num(data.vendorSummary.inactive)} dim />
          </StatList>
          {data.vendorSummary.top.length > 0 ? (
            <div className="aCardViz">
              <div className="aCardTitle" style={{ marginBottom: 8 }}>
                Top suppliers · 30 days
              </div>
              {/* Ranked magnitude. Bars beat a donut here because the question is
                  "who is biggest", not "what share of the whole" — and the list is
                  a top-N, so a share of it would be a share of nothing real. */}
              <RankedBars
                data={data.vendorSummary.top.map((v) => ({
                  // `v.id` is nullable and the fallback must never be the NAME —
                  // two yards both supplying "Balaji Metals" collide.
                  label: v.name,
                  value: v.kg,
                  sub: `${v.yardCode ?? "—"} · ${num(v.loads)} load${v.loads === 1 ? "" : "s"}${v.active ? "" : " · inactive"}`,
                  color: RANK_HUE,
                }))}
                formatValue={(n) => kg(n)}
              />
            </div>
          ) : (
            <EmptyState icon="🚚" title="No supply in the last 30 days" hint="Vendor volumes appear here as inward loads are booked." />
          )}
        </Card>

        <Card title="Material overview">
          <StatList>
            <Stat label="Active materials" value={num(data.materialSummary.active)} />
            <Stat label="Deactivated" value={num(data.materialSummary.inactive)} dim />
          </StatList>
          {data.materialSummary.byVolume.length > 0 ? (
            <div className="aCardViz">
              <div className="aCardTitle" style={{ marginBottom: 8 }}>
                Inward volume · 30 days
              </div>
              {/*
                A donut, not bars — deliberately different from the Vendor card
                beside it. This IS a complete set (every material received), so
                "what is our intake made of" is a fair share question, and the mix
                is what an admin actually reads here.
              */}
              <DonutChart
                data={data.materialSummary.byVolume.map((m, i) => ({
                  label: m.label,
                  value: m.kg,
                  color: vizAt(i),
                }))}
                size={172}
                centreValue={kg(data.materialSummary.byVolume.reduce((a, m) => a + m.kg, 0))}
                centreLabel="received"
                formatValue={(n) => kg(n)}
                ariaLabel="Inward volume by material, last 30 days"
              />
              <Legend
                items={data.materialSummary.byVolume.map((m, i) => ({
                  label: m.label,
                  color: vizAt(i),
                  value: `${kg(m.kg)} · ${num(m.loads)} load${m.loads === 1 ? "" : "s"}`,
                }))}
              />
            </div>
          ) : (
            <EmptyState icon="🧺" title="No inward in the last 30 days" hint="Material volumes appear here as loads are received." />
          )}
        </Card>

        <Card title="Operations">
          <StatList>
            <Stat
              label="Inward today"
              sub={`${num(data.opsSummary.inwardToday.count)} load${data.opsSummary.inwardToday.count === 1 ? "" : "s"}`}
              value={kg(data.opsSummary.inwardToday.kg)}
            />
            <Stat
              label="Inward · 7 days"
              sub={`${num(data.opsSummary.inward7.count)} loads`}
              value={kg(data.opsSummary.inward7.kg)}
            />
          </StatList>

          {data.opsSummary.sort7.kg > 0 && (
            <div className="aCardViz">
              <div className="aCardTitle" style={{ marginBottom: 8 }}>
                Sorting yield · 7 days
              </div>
              {/*
                Wastage only means something next to what was sorted, and it was
                previously two rows the reader had to divide in their head. One
                proportion bar makes the yield the headline. A ring was rejected
                here: the Material donut sits immediately to the left, and two
                circles side by side blur into each other.
              */}
              <SplitBar
                data={[
                  { label: "Recovered", value: Math.max(0, data.opsSummary.sort7.kg - data.opsSummary.sort7.wastageKg), color: TONE.good },
                  { label: "Wastage", value: data.opsSummary.sort7.wastageKg, color: TONE.bad },
                ]}
                formatValue={(n) => kg(n)}
                ariaLabel={`Sorting yield: ${pct(data.opsSummary.sort7.wastageKg, data.opsSummary.sort7.kg)}% wastage`}
              />
              <StatList>
                <Stat
                  label="Sorted"
                  sub={`${num(data.opsSummary.sort7.runs)} run${data.opsSummary.sort7.runs === 1 ? "" : "s"}`}
                  value={kg(data.opsSummary.sort7.kg)}
                  dim
                />
              </StatList>
            </div>
          )}

          {data.opsSummary.sort7.kg === 0 && (
            <StatList>
              <Stat
                label="Sorted · 7 days"
                sub={`${num(data.opsSummary.sort7.runs)} run${data.opsSummary.sort7.runs === 1 ? "" : "s"}`}
                value={kg(data.opsSummary.sort7.kg)}
                dim
              />
            </StatList>
          )}

          {data.opsSummary.oldestPending && (
            <div className="aCardViz">
              <div className="aCardTitle" style={{ marginBottom: 8 }}>
                Oldest unsorted lot
              </div>
              <AlertRow
                tone="warn"
                icon="⏳"
                title={`${data.opsSummary.oldestPending.lotNumber} · ${kg(data.opsSummary.oldestPending.totalKg)}`}
                detail={`${data.opsSummary.oldestPending.yardCode} · received ${when(data.opsSummary.oldestPending.createdAt)}`}
                action={
                  <Link className="aBtn sm ghost" href={`/admin/yards/${data.opsSummary.oldestPending.yardId}`}>
                    Open
                  </Link>
                }
              />
            </div>
          )}
        </Card>
      </div>

      {/* ══════════ 7. RECENT ACTIVITY ══════════ */}
      <div className="aSectionTitle">Recent activity</div>
      <Card>
        <SubNav<ActivityTab>
          items={[
            { key: "sales", label: "Sales", count: data.recentActivity.sales.length },
            { key: "loads", label: "Inward", count: data.recentActivity.loads.length },
            { key: "audit", label: "Admin actions", count: data.recentActivity.audit.length },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === "sales" &&
          (data.recentActivity.sales.length > 0 ? (
            <div className="aTableWrap">
              <table className="aTable" style={{ minWidth: 0 }}>
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Yard</th>
                    <th>Buyer</th>
                    <th className="num">Kg</th>
                    <th className="num">Total</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentActivity.sales.map((r) => (
                    <tr key={r.id}>
                      <td className="aMono">
                        <b>{r.invoiceNumber}</b>
                        <div className="aTiny aMuted">
                          {r.skuIcon} {r.skuName}
                        </div>
                      </td>
                      <td className="aTiny aMono">
                        <Link href={`/admin/yards/${r.yardId}`}>{r.yardCode}</Link>
                      </td>
                      <td className="aTiny">{r.buyerName}</td>
                      <td className="num">{num(r.quantityKg)}</td>
                      <td className="num">{inr(r.total)}</td>
                      <td className="aTiny aMuted">{when(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon="🧾" title="No sales yet" hint="Invoices raised by yard owners appear here as they happen." />
          ))}

        {tab === "loads" &&
          (data.recentActivity.loads.length > 0 ? (
            <div className="aTableWrap">
              <table className="aTable" style={{ minWidth: 0 }}>
                <thead>
                  <tr>
                    <th>Lot</th>
                    <th>Yard</th>
                    <th>Vendor</th>
                    <th className="num">Kg</th>
                    <th>Status</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentActivity.loads.map((r) => (
                    <tr key={r.id}>
                      <td className="aMono">
                        <b>{r.lotNumber}</b>
                        <div className="aTiny aMuted">{r.materialLabel}</div>
                      </td>
                      <td className="aTiny aMono">
                        <Link href={`/admin/yards/${r.yardId}`}>{r.yardCode}</Link>
                      </td>
                      <td className="aTiny">{r.vendorName}</td>
                      <td className="num">{num(r.totalKg)}</td>
                      <td>
                        {r.status === "RECEIVED" ? <Pill tone="warn">Pending sort</Pill> : <Pill tone="ok">Segregated</Pill>}
                      </td>
                      <td className="aTiny aMuted">{when(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon="⚖️" title="No inward loads yet" hint="Loads booked at the weighbridge appear here in real time." />
          ))}

        {tab === "audit" &&
          (data.recentActivity.audit.length > 0 ? (
            <div className="aTableWrap">
              <table className="aTable" style={{ minWidth: 0 }}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Entity</th>
                    <th>Yard</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentActivity.audit.map((r) => (
                    <tr key={r.id}>
                      <td className="aTiny aMuted">{when(r.createdAt)}</td>
                      <td className="aTiny">{r.actorName}</td>
                      <td className="aTiny aMono">{r.action}</td>
                      <td className="aTiny">{r.entity}</td>
                      <td className="aTiny aMono">
                        {r.yardId ? <Link href={`/admin/yards/${r.yardId}`}>{r.yardCode}</Link> : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon="🧾" title="Nothing audited yet" hint="Every privileged action — yard, user, record edit, Enter Yard — is recorded here." />
          ))}

        <div className="aRowBetween" style={{ marginTop: 14 }}>
          <span className="aTiny aMuted">
            {lastEvent ? `Last live change ${when(new Date(lastEvent.at))}` : "Waiting for live activity"}
          </span>
          <Link className="aBtn sm ghost" href="/admin/audit">
            Full audit log →
          </Link>
        </div>
      </Card>

      {/* ══════════ 8. TRENDS ══════════ */}
      {/* The range picker in the header governs THIS section. The heading follows
          it instead of claiming "last 30 days" regardless of what was selected. */}
      <div className="aSectionTitle">Trends · {range.label.toLowerCase()}</div>
      <DashboardTrends range={range} />
    </>
  );
}

/**
 * Compact 30-day trend strip for the dashboard.
 *
 * Reuses `/api/admin/analytics` rather than adding an endpoint, and is its own
 * component so a realtime refresh of the trend data re-renders only this card —
 * the KPI grid, alerts and tables above it are untouched.
 */
function DashboardTrends({ range }: { range: DateRange }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["adminAnalytics", range.from, range.to, ""],
    queryFn: () =>
      getJson<TrendsResponse>(`/api/admin/analytics?from=${range.from}&to=${range.to}`),
    staleTime: 60_000,
  });

  const series = useMemo(() => {
    if (!data) return null;
    return {
      salesValue: data.trends.sales.map((p) => p.value),
      salesKg: data.trends.sales.map((p) => p.kg),
      inwardKg: data.trends.inward.map((p) => p.kg),
      sortedKg: data.trends.sort.map((p) => p.sortedKg),
      labels: data.trends.sales.map((p) => p.day),
    };
  }, [data]);

  if (isLoading) {
    return (
      <ChartCard title="Platform trends">
        <LoadingChartState />
      </ChartCard>
    );
  }

  if (error || !data || !series) {
    return (
      <Card title="Platform trends">
        <EmptyState icon="📈" title="Trend data unavailable" hint="The aggregate query failed. Operational data above is unaffected." />
      </Card>
    );
  }

  const t = data.totals;

  return (
    <ChartCard
      title="Platform trends"
      subtitle={`${range.label} · Asia/Kolkata · updates live`}
      tools={
        <Link className="aBtn sm ghost" href="/admin/analytics">
          Full analytics →
        </Link>
      }
    >
      <div className="cSparkRow">
        <div className="cSpark">
          <div className="lbl">Sales value</div>
          <div className="val">{inr(t.salesValue)}</div>
          <div className="sub">{num(t.salesCount)} invoices · {range.label.toLowerCase()}</div>
          <Sparkline values={series.salesValue} color={colorAt(0)} ariaLabel={`Sales value trend, total ${inr(t.salesValue)}`} />
        </div>
        <div className="cSpark">
          <div className="lbl">Inward weight</div>
          <div className="val">{kg(t.inwardKg)}</div>
          <div className="sub">{num(t.inwardCount)} loads received</div>
          <Sparkline values={series.inwardKg} color={colorAt(1)} ariaLabel={`Inward weight trend, total ${kg(t.inwardKg)}`} />
        </div>
        <div className="cSpark">
          <div className="lbl">Sold weight</div>
          <div className="val">{kg(t.salesKg)}</div>
          <div className="sub">
            {t.inwardKg > 0 ? `${pct(t.salesKg, t.inwardKg)}% of received` : "no inward to compare"}
          </div>
          <Sparkline values={series.salesKg} color={colorAt(2)} ariaLabel={`Sold weight trend, total ${kg(t.salesKg)}`} />
        </div>
        <div className="cSpark">
          <div className="lbl">Sorted weight</div>
          <div className="val">{kg(t.sortedKg)}</div>
          <div className="sub">
            {t.sortedKg > 0 ? `${pct(t.wastageKg, t.sortedKg)}% wastage` : "no segregation runs"}
          </div>
          <Sparkline values={series.sortedKg} color={colorAt(3)} ariaLabel={`Sorted weight trend, total ${kg(t.sortedKg)}`} />
        </div>
      </div>

      <Legend
        items={[
          { label: "Sales value", color: colorAt(0) },
          { label: "Inward kg", color: colorAt(1) },
          { label: "Sold kg", color: colorAt(2) },
          { label: "Sorted kg", color: colorAt(3) },
        ]}
      />
    </ChartCard>
  );
}

type TrendsResponse = {
  trends: {
    sales: { day: string; count: number; value: number; kg: number }[];
    inward: { day: string; count: number; kg: number }[];
    sort: { day: string; runs: number; sortedKg: number; wastageKg: number }[];
  };
  totals: {
    salesValue: number;
    salesCount: number;
    salesKg: number;
    inwardKg: number;
    inwardCount: number;
    sortedKg: number;
    wastageKg: number;
    stockKg: number;
  };
};
