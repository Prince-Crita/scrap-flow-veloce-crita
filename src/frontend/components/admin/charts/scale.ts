/**
 * Chart geometry and scales — pure functions, no React, no DOM.
 *
 * Kept separate from the components so the maths is unit-testable on its own and
 * so every chart shares one definition of "nice" axes, tick spacing and paths.
 * Nothing here allocates per render beyond the arrays it returns; the components
 * memoise the results.
 */

export type Point = { label: string; value: number };
export type Series = { name: string; color: string; points: Point[] };

/** Standard plot box. Charts are drawn in a fixed viewBox and scaled by CSS. */
export type Box = { width: number; height: number; top: number; right: number; bottom: number; left: number };

export const DEFAULT_BOX: Box = { width: 720, height: 260, top: 14, right: 14, bottom: 28, left: 52 };

export function plotArea(box: Box) {
  return {
    x: box.left,
    y: box.top,
    w: Math.max(1, box.width - box.left - box.right),
    h: Math.max(1, box.height - box.top - box.bottom),
  };
}

/**
 * Round a maximum up to a readable axis top (1/2/5 × 10ⁿ).
 *
 * Without this, an axis reads "37,412" and the gridlines land on meaningless
 * numbers. With it the top is 40,000 and the ticks are round.
 */
export function niceMax(rawMax: number): number {
  if (!Number.isFinite(rawMax) || rawMax <= 0) return 1;
  const exp = Math.floor(Math.log10(rawMax));
  const pow = Math.pow(10, exp);
  const frac = rawMax / pow;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * pow;
}

/** Evenly spaced tick values from 0 to max inclusive. */
export function ticks(max: number, count = 4): number[] {
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push((max / count) * i);
  return out;
}

/** Compact axis/label formatter: 1.2k, 3.4M, ₹-free (callers add units). */
export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_00_00_000) return `${(n / 1_00_00_000).toFixed(abs >= 1_00_00_000 * 10 ? 0 : 1)}Cr`;
  if (abs >= 1_00_000) return `${(n / 1_00_000).toFixed(abs >= 1_000_000 ? 0 : 1)}L`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/**
 * Categorical palette drawn from the Veloce tokens.
 *
 * Deliberately hard-coded hex rather than `var(--brand)`: SVG `fill` inside a
 * `<defs>` gradient and the legend swatches must resolve to the same literal,
 * and CSS variables in SVG attributes are inconsistently supported when the
 * chart is serialised. These are exactly the token values from globals.css.
 */
export const PALETTE = [
  "#2E8B4F", // --brand
  "#F59E2B", // --orange
  "#6FE3A5", // --led
  "#9FE6B8", // --mint
  "#FF6B5C", // --red
  "#4FA3D1", // cool accent, only used when a 6th+ series exists
  "#B98CD9",
  "#D9C55C",
] as const;

export function colorAt(i: number): string {
  return PALETTE[i % PALETTE.length];
}

/** Linear map from a value to a y pixel, with 0 at the bottom of the plot. */
export function yScale(value: number, max: number, area: { y: number; h: number }): number {
  if (max <= 0) return area.y + area.h;
  const clamped = Math.max(0, Math.min(value, max));
  return area.y + area.h - (clamped / max) * area.h;
}

/** Evenly spaced band centres for n categories. */
export function bandCentres(n: number, area: { x: number; w: number }): number[] {
  if (n <= 0) return [];
  const step = area.w / n;
  return Array.from({ length: n }, (_, i) => area.x + step * i + step / 2);
}

/** Band width for n categories, with an inner gap ratio. */
export function bandWidth(n: number, area: { w: number }, gapRatio = 0.32): number {
  if (n <= 0) return 0;
  return Math.max(1, (area.w / n) * (1 - gapRatio));
}

/** Straight polyline path through the points. */
export function linePath(values: number[], max: number, area: { x: number; y: number; w: number; h: number }): string {
  if (values.length === 0) return "";
  if (values.length === 1) {
    const y = yScale(values[0], max, area);
    return `M ${area.x} ${y} L ${area.x + area.w} ${y}`;
  }
  const step = area.w / (values.length - 1);
  return values
    .map((v, i) => `${i === 0 ? "M" : "L"} ${(area.x + i * step).toFixed(2)} ${yScale(v, max, area).toFixed(2)}`)
    .join(" ");
}

/** Closed area path under the line, for the gradient fill. */
export function areaPath(values: number[], max: number, area: { x: number; y: number; w: number; h: number }): string {
  if (values.length === 0) return "";
  const bottom = area.y + area.h;
  if (values.length === 1) {
    const y = yScale(values[0], max, area);
    return `M ${area.x} ${bottom} L ${area.x} ${y} L ${area.x + area.w} ${y} L ${area.x + area.w} ${bottom} Z`;
  }
  const step = area.w / (values.length - 1);
  const line = values
    .map((v, i) => `${i === 0 ? "M" : "L"} ${(area.x + i * step).toFixed(2)} ${yScale(v, max, area).toFixed(2)}`)
    .join(" ");
  return `${line} L ${(area.x + area.w).toFixed(2)} ${bottom} L ${area.x.toFixed(2)} ${bottom} Z`;
}

/** X pixel for index i on a line chart. */
export function lineX(i: number, n: number, area: { x: number; w: number }): number {
  if (n <= 1) return area.x + area.w / 2;
  return area.x + (area.w / (n - 1)) * i;
}

/* ────────────────────────── pie / donut ────────────────────────── */

export type Arc = {
  path: string;
  /** Mid-angle point, for a leader line or label. */
  centroid: { x: number; y: number };
  fraction: number;
};

/**
 * Arc path for a pie/donut slice.
 *
 * A slice covering the whole circle cannot be drawn with a single arc (start and
 * end coincide), so a full circle is emitted as two half-arcs. Without this, a
 * single-category pie renders as nothing at all.
 */
export function arc(
  startFraction: number,
  endFraction: number,
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number
): Arc {
  const span = Math.max(0, endFraction - startFraction);
  const a0 = startFraction * Math.PI * 2 - Math.PI / 2;
  const a1 = endFraction * Math.PI * 2 - Math.PI / 2;
  const mid = (a0 + a1) / 2;

  const p = (angle: number, r: number) => ({
    x: cx + Math.cos(angle) * r,
    y: cy + Math.sin(angle) * r,
  });

  if (span >= 0.999999) {
    // Full circle: two 180° arcs, plus the inner ring for a donut.
    const outerTop = p(-Math.PI / 2, rOuter);
    const outerBottom = p(Math.PI / 2, rOuter);
    let d =
      `M ${outerTop.x} ${outerTop.y} ` +
      `A ${rOuter} ${rOuter} 0 1 1 ${outerBottom.x} ${outerBottom.y} ` +
      `A ${rOuter} ${rOuter} 0 1 1 ${outerTop.x} ${outerTop.y} Z`;
    if (rInner > 0) {
      const innerTop = p(-Math.PI / 2, rInner);
      const innerBottom = p(Math.PI / 2, rInner);
      d +=
        ` M ${innerTop.x} ${innerTop.y} ` +
        `A ${rInner} ${rInner} 0 1 0 ${innerBottom.x} ${innerBottom.y} ` +
        `A ${rInner} ${rInner} 0 1 0 ${innerTop.x} ${innerTop.y} Z`;
    }
    return { path: d, centroid: p(mid, (rOuter + rInner) / 2), fraction: 1 };
  }

  const largeArc = span > 0.5 ? 1 : 0;
  const o0 = p(a0, rOuter);
  const o1 = p(a1, rOuter);

  if (rInner <= 0) {
    return {
      path: `M ${cx} ${cy} L ${o0.x} ${o0.y} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${o1.x} ${o1.y} Z`,
      centroid: p(mid, rOuter * 0.62),
      fraction: span,
    };
  }

  const i1 = p(a1, rInner);
  const i0 = p(a0, rInner);
  return {
    path:
      `M ${o0.x} ${o0.y} ` +
      `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${o1.x} ${o1.y} ` +
      `L ${i1.x} ${i1.y} ` +
      `A ${rInner} ${rInner} 0 ${largeArc} 0 ${i0.x} ${i0.y} Z`,
    centroid: p(mid, (rOuter + rInner) / 2),
    fraction: span,
  };
}

/**
 * Slice a dataset into arcs. Zero-valued entries are dropped — a 0% slice is
 * invisible but still steals a palette colour and a legend row.
 */
export function pieArcs(
  values: number[],
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number
): { arc: Arc; index: number }[] {
  const total = values.reduce((a, v) => a + Math.max(0, v), 0);
  if (total <= 0) return [];
  const out: { arc: Arc; index: number }[] = [];
  let cursor = 0;
  values.forEach((v, i) => {
    const val = Math.max(0, v);
    if (val <= 0) return;
    const frac = val / total;
    out.push({ arc: arc(cursor, cursor + frac, cx, cy, rOuter, rInner), index: i });
    cursor += frac;
  });
  return out;
}

/* ────────────────────────── time bucketing ────────────────────────── */

/** ISO week key (YYYY-Www) for a YYYY-MM-DD day, ISO-8601 Monday-start. */
export function weekKey(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = (date.getUTCDay() + 6) % 7; // Mon = 0
  date.setUTCDate(date.getUTCDate() - dow + 3); // Thursday of this week
  const isoYear = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow);
  const week = Math.round((date.getTime() - week1Monday.getTime()) / (7 * 86_400_000)) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Month key (YYYY-MM) for a YYYY-MM-DD day. */
export function monthKey(day: string): string {
  return day.slice(0, 7);
}

export type Granularity = "day" | "week" | "month";

/**
 * Roll daily points up to weeks or months, summing the numeric fields.
 *
 * The 90-day window at daily granularity is 91 points — too dense to read on a
 * 720px-wide chart, and the gaps carry no information. Rolling up keeps the
 * shape and makes the axis legible.
 */
export function bucketBy<T extends { day: string }>(
  rows: T[],
  granularity: Granularity,
  sumKeys: (keyof T)[]
): (T & { bucket: string })[] {
  if (granularity === "day") return rows.map((r) => ({ ...r, bucket: r.day }));

  const keyOf = granularity === "week" ? weekKey : monthKey;
  const map = new Map<string, T & { bucket: string }>();
  const order: string[] = [];

  for (const row of rows) {
    const k = keyOf(row.day);
    const existing = map.get(k);
    if (!existing) {
      map.set(k, { ...row, bucket: k });
      order.push(k);
    } else {
      for (const sk of sumKeys) {
        (existing[sk] as unknown as number) =
          ((existing[sk] as unknown as number) ?? 0) + ((row[sk] as unknown as number) ?? 0);
      }
    }
  }
  return order.map((k) => map.get(k)!);
}

/** Short human label for a bucket key. */
export function bucketLabel(key: string, granularity: Granularity): string {
  if (granularity === "month") {
    const [y, m] = key.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
  }
  if (granularity === "week") return key.replace(/^\d{4}-/, "");
  const [, m, d] = key.split("-").map(Number);
  return `${d} ${new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString("en-IN", { month: "short" })}`;
}
