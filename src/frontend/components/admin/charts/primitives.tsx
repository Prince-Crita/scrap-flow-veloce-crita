"use client";

import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  DEFAULT_BOX,
  plotArea,
  niceMax,
  ticks,
  compact,
  colorAt,
  yScale,
  bandCentres,
  bandWidth,
  linePath,
  areaPath,
  lineX,
  pieArcs,
  type Box,
} from "./scale";

/**
 * Inline-SVG chart primitives for the admin console.
 *
 * ── Why hand-rolled ──────────────────────────────────────────────────────────
 * No external chart library, no CDN. The published pages run under a strict CSP
 * and the console must stay light, so these are plain SVG elements using the
 * same Veloce tokens as the rest of the app.
 *
 * ── Contract ─────────────────────────────────────────────────────────────────
 * Every chart is a pure function of its props. All of them are `memo`-wrapped
 * and do their geometry inside `useMemo`, so an unrelated re-render (a realtime
 * event landing on another card, a tab change) does not recompute paths or
 * churn the DOM. Charts are drawn into a fixed viewBox and scaled by CSS, which
 * is what makes them responsive without a resize observer.
 *
 * Accessibility: each chart carries `role="img"` and an `aria-label` summarising
 * the data, because an SVG of unlabelled paths is otherwise silent to a screen
 * reader.
 */

/* ────────────────────────── shared types ────────────────────────── */

export type ChartDatum = { label: string; value: number; color?: string; sub?: string };
export type LineSeries = { name: string; color?: string; values: number[] };

type TipState = { x: number; y: number; title: string; rows: { color: string; label: string; value: string }[] } | null;

/* ────────────────────────── states ────────────────────────── */

export function EmptyChartState({
  icon = "📊",
  title = "No data in this window",
  hint,
}: {
  icon?: string;
  title?: string;
  hint?: string;
}) {
  return (
    <div className="cEmpty" role="status">
      <span className="ico">{icon}</span>
      <b>{title}</b>
      {hint && <span>{hint}</span>}
    </div>
  );
}

export function LoadingChartState({ bars = 9 }: { bars?: number }) {
  return (
    <div className="cLoading" role="status" aria-label="Loading chart">
      <div className="barsSkel" aria-hidden>
        {Array.from({ length: bars }, (_, i) => (
          <i key={i} style={{ height: `${28 + ((i * 37) % 62)}%` }} />
        ))}
      </div>
      <span>Loading…</span>
    </div>
  );
}

/** Card chrome for a chart: title, optional subtitle, optional tools. */
export function ChartCard({
  title,
  subtitle,
  tools,
  children,
}: {
  title: string;
  subtitle?: string;
  tools?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="aCard cCard">
      <div className="cHead">
        <div>
          <div className="t">{title}</div>
          {subtitle && <div className="s">{subtitle}</div>}
        </div>
        {tools && <div className="tools">{tools}</div>}
      </div>
      {children}
    </div>
  );
}

/* ────────────────────────── legend ────────────────────────── */

export const Legend = memo(function Legend({
  items,
  active,
}: {
  items: { label: string; color: string; value?: string }[];
  /** Index to highlight; every other item dims. */
  active?: number | null;
}) {
  if (items.length === 0) return null;
  return (
    <div className="cLegend">
      {items.map((it, i) => (
        <span key={`${it.label}-${i}`} className={`item${active != null && active !== i ? " dim" : ""}`}>
          <span className="sw" style={{ background: it.color }} aria-hidden />
          <span className="nm" title={it.label}>
            {it.label}
          </span>
          {it.value && <span className="vl">{it.value}</span>}
        </span>
      ))}
    </div>
  );
});

/* ────────────────────────── tooltip ────────────────────────── */

function Tooltip({ tip }: { tip: TipState }) {
  if (!tip) return null;
  return (
    <div className="cTip" style={{ left: `${tip.x}%`, top: `${tip.y}%` }} role="tooltip">
      <b>{tip.title}</b>
      {tip.rows.map((r, i) => (
        <span className="row" key={i}>
          <span className="sw" style={{ background: r.color }} aria-hidden />
          {r.label} <b>{r.value}</b>
        </span>
      ))}
    </div>
  );
}

/* ────────────────────────── axes ────────────────────────── */

function Axes({
  box,
  max,
  xLabels,
  formatY,
  tickCount = 4,
}: {
  box: Box;
  max: number;
  xLabels: string[];
  formatY: (n: number) => string;
  tickCount?: number;
}) {
  const area = plotArea(box);
  const tv = ticks(max, tickCount);

  // Thin the x labels so they never collide: show at most ~8.
  const stride = Math.max(1, Math.ceil(xLabels.length / 8));
  const centres = xLabels.length > 0 ? bandCentres(xLabels.length, area) : [];

  return (
    <>
      <g className="cGrid" aria-hidden>
        {tv.map((t, i) => {
          const y = yScale(t, max, area);
          return (
            <line
              key={i}
              x1={area.x}
              y1={y}
              x2={area.x + area.w}
              y2={y}
              className={i === 0 ? "base" : undefined}
            />
          );
        })}
      </g>
      <g className="cAxis" aria-hidden>
        {tv.map((t, i) => (
          <text key={i} className="y" x={box.left - 8} y={yScale(t, max, area) + 3.5}>
            {formatY(t)}
          </text>
        ))}
        {xLabels.map((l, i) =>
          i % stride === 0 ? (
            <text key={i} className="x" x={centres[i]} y={box.height - 9}>
              {l}
            </text>
          ) : null
        )}
      </g>
    </>
  );
}

/* ────────────────────────── BarChart ────────────────────────── */

export const BarChart = memo(function BarChart({
  data,
  box = DEFAULT_BOX,
  formatValue = (n) => compact(n),
  unit = "",
  ariaLabel,
}: {
  data: ChartDatum[];
  box?: Box;
  formatValue?: (n: number) => string;
  unit?: string;
  ariaLabel?: string;
}) {
  const [tip, setTip] = useState<TipState>(null);
  const [hover, setHover] = useState<number | null>(null);

  const geom = useMemo(() => {
    const area = plotArea(box);
    const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
    const centres = bandCentres(data.length, area);
    const bw = Math.min(56, bandWidth(data.length, area));
    return {
      area,
      max,
      bars: data.map((d, i) => {
        const y = yScale(d.value, max, area);
        return {
          x: centres[i] - bw / 2,
          y,
          w: bw,
          h: Math.max(d.value > 0 ? 2 : 0, area.y + area.h - y),
          color: d.color ?? colorAt(i),
          centre: centres[i],
        };
      }),
    };
  }, [data, box]);

  const onEnter = useCallback(
    (i: number) => {
      const d = data[i];
      const b = geom.bars[i];
      setHover(i);
      setTip({
        x: (b.centre / box.width) * 100,
        y: (b.y / box.height) * 100,
        title: d.label,
        rows: [{ color: b.color, label: d.sub ?? "Value", value: `${formatValue(d.value)}${unit}` }],
      });
    },
    [data, geom, box, formatValue, unit]
  );

  const clear = useCallback(() => {
    setHover(null);
    setTip(null);
  }, []);

  if (data.length === 0) return <EmptyChartState />;

  return (
    <div className="cWrap" onMouseLeave={clear}>
      <svg
        viewBox={`0 0 ${box.width} ${box.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel ?? `Bar chart: ${data.map((d) => `${d.label} ${formatValue(d.value)}${unit}`).join(", ")}`}
      >
        <Axes box={box} max={geom.max} xLabels={data.map((d) => d.label)} formatY={compact} />
        {geom.bars.map((b, i) => (
          <rect
            key={i}
            className={`cBar${hover === i ? " on" : ""}`}
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            fill={b.color}
            onMouseEnter={() => onEnter(i)}
          />
        ))}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
});

/* ────────────────────────── LineChart ────────────────────────── */

export const LineChart = memo(function LineChart({
  series,
  xLabels,
  box = DEFAULT_BOX,
  formatValue = (n) => compact(n),
  unit = "",
  area: fillArea = true,
  ariaLabel,
}: {
  series: LineSeries[];
  xLabels: string[];
  box?: Box;
  formatValue?: (n: number) => string;
  unit?: string;
  area?: boolean;
  ariaLabel?: string;
}) {
  const [tip, setTip] = useState<TipState>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const geom = useMemo(() => {
    const a = plotArea(box);
    const allValues = series.flatMap((s) => s.values);
    const max = niceMax(Math.max(0, ...allValues));
    const n = xLabels.length;
    return {
      a,
      max,
      n,
      paths: series.map((s, i) => ({
        color: s.color ?? colorAt(i),
        line: linePath(s.values, max, a),
        fill: fillArea ? areaPath(s.values, max, a) : "",
      })),
    };
  }, [series, xLabels.length, box, fillArea]);

  /**
   * One hover handler for the whole plot rather than a hit target per point:
   * with a 91-point series, per-point handlers mean 91 listeners and a jumpy
   * tooltip. This maps the pointer's x to the nearest index instead.
   */
  const onMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = wrapRef.current;
      if (!el || geom.n === 0) return;
      const rect = el.getBoundingClientRect();
      const rel = (e.clientX - rect.left) / rect.width; // 0..1 across the wrapper
      const plotStart = geom.a.x / box.width;
      const plotSpan = geom.a.w / box.width;
      const t = Math.max(0, Math.min(1, (rel - plotStart) / plotSpan));
      const idx = Math.round(t * (geom.n - 1));
      if (idx === hoverIdx) return;
      setHoverIdx(idx);
      setTip({
        x: (lineX(idx, geom.n, geom.a) / box.width) * 100,
        y: (Math.min(...series.map((s) => yScale(s.values[idx] ?? 0, geom.max, geom.a))) / box.height) * 100,
        title: xLabels[idx] ?? "",
        rows: series.map((s, i) => ({
          color: s.color ?? colorAt(i),
          label: s.name,
          value: `${formatValue(s.values[idx] ?? 0)}${unit}`,
        })),
      });
    },
    [geom, series, xLabels, box, formatValue, unit, hoverIdx]
  );

  const clear = useCallback(() => {
    setHoverIdx(null);
    setTip(null);
  }, []);

  const hasAny = series.some((s) => s.values.some((v) => v > 0));
  if (xLabels.length === 0) return <EmptyChartState />;

  return (
    <div className="cWrap" ref={wrapRef} onMouseMove={onMove} onMouseLeave={clear}>
      <svg
        viewBox={`0 0 ${box.width} ${box.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={
          ariaLabel ??
          `Line chart over ${xLabels.length} points: ${series.map((s) => `${s.name} peaking at ${formatValue(Math.max(0, ...s.values))}${unit}`).join(", ")}`
        }
      >
        <defs>
          {geom.paths.map((p, i) => (
            <linearGradient key={i} id={`cg${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={p.color} stopOpacity="0.32" />
              <stop offset="100%" stopColor={p.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        <Axes box={box} max={geom.max} xLabels={xLabels} formatY={compact} />

        {fillArea &&
          geom.paths.map((p, i) => <path key={`a${i}`} className="cArea" d={p.fill} fill={`url(#cg${i})`} />)}
        {geom.paths.map((p, i) => (
          <path key={`l${i}`} className="cLine" d={p.line} stroke={p.color} />
        ))}

        {hoverIdx != null && hasAny && (
          <g aria-hidden>
            <line
              className="cHover"
              x1={lineX(hoverIdx, geom.n, geom.a)}
              y1={geom.a.y}
              x2={lineX(hoverIdx, geom.n, geom.a)}
              y2={geom.a.y + geom.a.h}
            />
            {series.map((s, i) => (
              <circle
                key={i}
                className="cDot"
                cx={lineX(hoverIdx, geom.n, geom.a)}
                cy={yScale(s.values[hoverIdx] ?? 0, geom.max, geom.a)}
                r={3.5}
                fill={s.color ?? colorAt(i)}
              />
            ))}
          </g>
        )}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
});

/* ────────────────────────── Pie / Donut ────────────────────────── */

export const PieChart = memo(function PieChart({
  data,
  size = 240,
  /** 0 = pie, 0.6 = donut. */
  innerRatio = 0,
  centreLabel,
  centreValue,
  formatValue = (n) => compact(n),
  unit = "",
  ariaLabel,
}: {
  data: ChartDatum[];
  size?: number;
  innerRatio?: number;
  centreLabel?: string;
  centreValue?: string;
  formatValue?: (n: number) => string;
  unit?: string;
  ariaLabel?: string;
}) {
  const [tip, setTip] = useState<TipState>(null);
  const [hover, setHover] = useState<number | null>(null);

  const geom = useMemo(() => {
    const cx = size / 2;
    const cy = size / 2;
    const rOuter = size / 2 - 4;
    const rInner = rOuter * innerRatio;
    const total = data.reduce((a, d) => a + Math.max(0, d.value), 0);
    return { cx, cy, rOuter, rInner, total, slices: pieArcs(data.map((d) => d.value), cx, cy, rOuter, rInner) };
  }, [data, size, innerRatio]);

  const clear = useCallback(() => {
    setHover(null);
    setTip(null);
  }, []);

  if (geom.total <= 0) return <EmptyChartState icon="🥧" title="Nothing to break down yet" />;

  return (
    <div className="cWrap" onMouseLeave={clear} style={{ maxWidth: size, margin: "0 auto" }}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={
          ariaLabel ??
          `Pie chart: ${data
            .filter((d) => d.value > 0)
            .map((d) => `${d.label} ${Math.round((d.value / geom.total) * 100)}%`)
            .join(", ")}`
        }
      >
        {geom.slices.map(({ arc: a, index }) => (
          <path
            key={index}
            className={`cSlice${hover === index ? " on" : ""}`}
            d={a.path}
            fill={data[index].color ?? colorAt(index)}
            onMouseEnter={() => {
              setHover(index);
              setTip({
                x: (a.centroid.x / size) * 100,
                y: (a.centroid.y / size) * 100,
                title: data[index].label,
                rows: [
                  {
                    color: data[index].color ?? colorAt(index),
                    label: `${Math.round(a.fraction * 100)}%`,
                    value: `${formatValue(data[index].value)}${unit}`,
                  },
                ],
              });
            }}
          />
        ))}
        {innerRatio > 0 && (centreValue || centreLabel) && (
          <g className="cDonutLabel" aria-hidden>
            {centreValue && (
              <text className="big" x={geom.cx} y={geom.cy + (centreLabel ? 2 : 7)}>
                {centreValue}
              </text>
            )}
            {centreLabel && (
              <text className="small" x={geom.cx} y={geom.cy + 20}>
                {centreLabel}
              </text>
            )}
          </g>
        )}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
});

export const DonutChart = memo(function DonutChart(
  props: Omit<React.ComponentProps<typeof PieChart>, "innerRatio"> & { innerRatio?: number }
) {
  return <PieChart {...props} innerRatio={props.innerRatio ?? 0.62} />;
});

/* ────────────────────────── Sparkline ────────────────────────── */

/** Tiny inline trend, no axes. Used on the dashboard KPI strip. */
export const Sparkline = memo(function Sparkline({
  values,
  color = colorAt(0),
  width = 220,
  height = 44,
  ariaLabel,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  ariaLabel?: string;
}) {
  const geom = useMemo(() => {
    const a = { x: 1, y: 3, w: width - 2, h: height - 6 };
    const max = niceMax(Math.max(0, ...values));
    return { a, max, line: linePath(values, max, a), fill: areaPath(values, max, a) };
  }, [values, width, height]);

  if (values.length === 0) return null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height }}
      role="img"
      aria-label={ariaLabel ?? `Trend sparkline, peak ${compact(Math.max(0, ...values))}`}
    >
      <defs>
        <linearGradient id={`sp-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.34" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path className="cArea" d={geom.fill} fill={`url(#sp-${color.replace("#", "")})`} />
      <path className="cLine" d={geom.line} stroke={color} strokeWidth={1.75} />
    </svg>
  );
});

/* ────────────────────────── Ranked bars ────────────────────────── */

/**
 * Horizontal ranked bars. Better than a vertical bar chart when labels are long
 * (vendor and material names), which is exactly where a rotated-label chart
 * becomes unreadable.
 */
export const RankedBars = memo(function RankedBars({
  data,
  formatValue = (n) => compact(n),
  unit = "",
  max: explicitMax,
}: {
  data: ChartDatum[];
  formatValue?: (n: number) => string;
  unit?: string;
  max?: number;
}) {
  const max = useMemo(
    () => explicitMax ?? Math.max(1, ...data.map((d) => d.value)),
    [data, explicitMax]
  );

  if (data.length === 0) return <EmptyChartState icon="📶" title="Nothing ranked yet" />;

  return (
    <div className="cRank">
      {data.map((d, i) => (
        <div className="row" key={`${d.label}-${i}`}>
          <div className="top">
            <span className="nm" title={d.label}>
              {d.label}
              {d.sub && <span className="sub"> · {d.sub}</span>}
            </span>
            <span className="vl">
              {formatValue(d.value)}
              {unit}
            </span>
          </div>
          <div className="track">
            <i style={{ width: `${Math.max(1, (d.value / max) * 100)}%`, background: d.color ?? colorAt(i) }} />
          </div>
        </div>
      ))}
    </div>
  );
});

/* ────────────────────────── Split bar ────────────────────────── */

/**
 * One horizontal bar showing how a single total divides.
 *
 * The dashboard had several "part of a whole" facts written as stacked text rows
 * — sorted vs unsorted stock, paid vs pending money, sorted vs wastage — each of
 * which had to be read line by line and mentally divided. This is the same
 * numbers as one glanceable proportion.
 *
 * Chosen over a donut for these because a donut of two or three parts wastes a
 * lot of space to say very little, and several donuts stacked down a column all
 * start to look alike. A bar also sits naturally inside an existing card without
 * forcing a square aspect.
 *
 * Segments carry a 2px surface gap so adjacent fills never read as one block, and
 * the legend always carries the value, so identity is never colour-alone.
 */
export const SplitBar = memo(function SplitBar({
  data,
  formatValue = (n) => compact(n),
  unit = "",
  /**
   * 10px to match `.cRank`'s 9px track — every proportion bar on a page should
   * read as the same family of control. The first version was 14px with the share
   * printed inside each segment; side by side with the ranked bars it looked like
   * a different component, and a percentage set in 9px on a coloured fill was the
   * least legible text on the dashboard. The share moved to the legend instead,
   * where it also matches how the donut legends are written.
   */
  height = 10,
  ariaLabel,
}: {
  data: ChartDatum[];
  formatValue?: (n: number) => string;
  unit?: string;
  height?: number;
  ariaLabel?: string;
}) {
  const total = useMemo(() => data.reduce((a, d) => a + Math.max(0, d.value), 0), [data]);

  if (total <= 0) return <EmptyChartState icon="📊" title="Nothing to split yet" />;

  return (
    <div className="cSplit">
      <div
        className="track"
        style={{ height }}
        role="img"
        aria-label={
          ariaLabel ??
          `${data.map((d) => `${d.label} ${Math.round((Math.max(0, d.value) / total) * 100)}%`).join(", ")}`
        }
      >
        {data.map((d, i) => {
          const share = (Math.max(0, d.value) / total) * 100;
          if (share <= 0) return null;
          return (
            <span
              key={`${d.label}-${i}`}
              className="seg"
              style={{ width: `${share}%`, background: d.color ?? colorAt(i) }}
              title={`${d.label}: ${formatValue(d.value)}${unit} (${Math.round(share)}%)`}
            />
          );
        })}
      </div>
      <Legend
        items={data.map((d, i) => ({
          label: d.label,
          color: d.color ?? colorAt(i),
          // "₹2,97,693 · 100%" — same shape as the donut legends elsewhere on the
          // page, so a reader learns one format rather than two.
          value: `${formatValue(d.value)}${unit} · ${Math.round((Math.max(0, d.value) / total) * 100)}%`,
        }))}
      />
    </div>
  );
});

/* ────────────────────────── Grouped bars ────────────────────────── */

/** Two or three measures side by side per category — the yard comparison. */
export const GroupedBarChart = memo(function GroupedBarChart({
  categories,
  series,
  box = DEFAULT_BOX,
  formatValue = (n) => compact(n),
  unit = "",
  ariaLabel,
}: {
  categories: string[];
  series: { name: string; color?: string; values: number[] }[];
  box?: Box;
  formatValue?: (n: number) => string;
  unit?: string;
  ariaLabel?: string;
}) {
  const [tip, setTip] = useState<TipState>(null);
  const [hover, setHover] = useState<string | null>(null);

  const geom = useMemo(() => {
    const area = plotArea(box);
    const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
    const centres = bandCentres(categories.length, area);
    const group = Math.min(84, bandWidth(categories.length, area));
    const bw = Math.max(2, group / Math.max(1, series.length) - 3);
    return { area, max, centres, group, bw };
  }, [categories.length, series, box]);

  const clear = useCallback(() => {
    setHover(null);
    setTip(null);
  }, []);

  if (categories.length === 0) return <EmptyChartState />;

  return (
    <div className="cWrap" onMouseLeave={clear}>
      <svg
        viewBox={`0 0 ${box.width} ${box.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel ?? `Grouped bar chart comparing ${series.map((s) => s.name).join(" and ")} across ${categories.length} categories`}
      >
        <Axes box={box} max={geom.max} xLabels={categories} formatY={compact} />
        {categories.map((cat, ci) =>
          series.map((s, si) => {
            const v = s.values[ci] ?? 0;
            const y = yScale(v, geom.max, geom.area);
            const x = geom.centres[ci] - geom.group / 2 + si * (geom.bw + 3);
            const key = `${ci}-${si}`;
            const color = s.color ?? colorAt(si);
            return (
              <rect
                key={key}
                className={`cBar${hover === key ? " on" : ""}`}
                x={x}
                y={y}
                width={geom.bw}
                height={Math.max(v > 0 ? 2 : 0, geom.area.y + geom.area.h - y)}
                fill={color}
                onMouseEnter={() => {
                  setHover(key);
                  setTip({
                    x: (geom.centres[ci] / box.width) * 100,
                    y: (y / box.height) * 100,
                    title: cat,
                    rows: series.map((ss, i) => ({
                      color: ss.color ?? colorAt(i),
                      label: ss.name,
                      value: `${formatValue(ss.values[ci] ?? 0)}${unit}`,
                    })),
                  });
                }}
              />
            );
          })
        )}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
});

/* ────────────────────────── Stacked bars ────────────────────────── */

/** Sorted-vs-wastage per bucket: two measures that sum to a meaningful total. */
export const StackedBarChart = memo(function StackedBarChart({
  categories,
  series,
  box = DEFAULT_BOX,
  formatValue = (n) => compact(n),
  unit = "",
  ariaLabel,
}: {
  categories: string[];
  series: { name: string; color?: string; values: number[] }[];
  box?: Box;
  formatValue?: (n: number) => string;
  unit?: string;
  ariaLabel?: string;
}) {
  const [tip, setTip] = useState<TipState>(null);
  const [hover, setHover] = useState<number | null>(null);

  const geom = useMemo(() => {
    const area = plotArea(box);
    const totals = categories.map((_, ci) => series.reduce((a, s) => a + (s.values[ci] ?? 0), 0));
    const max = niceMax(Math.max(0, ...totals));
    const centres = bandCentres(categories.length, area);
    const bw = Math.min(56, bandWidth(categories.length, area));
    return { area, max, centres, bw, totals };
  }, [categories, series, box]);

  const clear = useCallback(() => {
    setHover(null);
    setTip(null);
  }, []);

  if (categories.length === 0) return <EmptyChartState />;

  return (
    <div className="cWrap" onMouseLeave={clear}>
      <svg
        viewBox={`0 0 ${box.width} ${box.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel ?? `Stacked bar chart of ${series.map((s) => s.name).join(" and ")}`}
      >
        <Axes box={box} max={geom.max} xLabels={categories} formatY={compact} />
        {categories.map((cat, ci) => {
          let acc = 0;
          return series.map((s, si) => {
            const v = s.values[ci] ?? 0;
            const yTop = yScale(acc + v, geom.max, geom.area);
            const yBottom = yScale(acc, geom.max, geom.area);
            acc += v;
            const h = Math.max(v > 0 ? 1.5 : 0, yBottom - yTop);
            return (
              <rect
                key={`${ci}-${si}`}
                className={`cBar${hover === ci ? " on" : ""}`}
                x={geom.centres[ci] - geom.bw / 2}
                y={yTop}
                width={geom.bw}
                height={h}
                fill={s.color ?? colorAt(si)}
                onMouseEnter={() => {
                  setHover(ci);
                  setTip({
                    x: (geom.centres[ci] / box.width) * 100,
                    y: (yScale(geom.totals[ci], geom.max, geom.area) / box.height) * 100,
                    title: cat,
                    rows: series.map((ss, i) => ({
                      color: ss.color ?? colorAt(i),
                      label: ss.name,
                      value: `${formatValue(ss.values[ci] ?? 0)}${unit}`,
                    })),
                  });
                }}
              />
            );
          });
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
});
