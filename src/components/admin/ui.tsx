"use client";

import { useEffect, useRef } from "react";

/**
 * Small shared pieces for the admin console. Deliberately thin wrappers over the
 * classes in src/styles/admin.css — the design language lives in CSS, not in a
 * component abstraction, so it stays in step with the yard app's tokens.
 */

export function PageHead({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="aHead">
      <div>
        <div className="aTitle">{title}</div>
        {subtitle && <div className="aSub">{subtitle}</div>}
      </div>
      {children && <div className="aHeadActions">{children}</div>}
    </div>
  );
}

export function Kpi({
  label,
  value,
  foot,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  foot?: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={`aKpi${accent ? " accent" : ""}`}>
      <div className="aKpiLabel">{label}</div>
      <div className="aKpiValue">{value}</div>
      {foot && <div className="aKpiFoot">{foot}</div>}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
}: {
  title?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="aCard">
      {(title || actions) && (
        <div className="aCardHead">
          {title && <div className="aCardTitle">{title}</div>}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

export function Pill({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "ok" | "off" | "warn" | "role";
  children: React.ReactNode;
}) {
  return <span className={`aPill ${tone}`}>{children}</span>;
}

/** Escape-to-close, focus-trapped-enough modal. Uses in-app UI, never window.confirm. */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  /**
   * Latest `onClose` held in a ref so the effects below can depend on nothing.
   *
   * This is the fix for a real bug: both the Escape listener and the initial
   * focus used to live in one effect keyed on `[onClose]`. Every caller passes an
   * inline arrow (`onClose={() => setCreating(false)}`), which is a NEW function
   * identity on every render — so every keystroke in a form field re-ran the
   * effect, and the effect's last act was to move focus back to the dialog's
   * FIRST focusable element. Type one character in "Yard name" and focus jumped
   * to "Yard code": unusable, and it read like the dialog was resetting itself.
   */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Escape closes. Subscribed once for the dialog's lifetime.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /**
   * Move focus into the dialog so keyboard users are not left behind it — ON MOUNT
   * ONLY. Re-running this is what stole focus mid-typing; it is a one-time
   * courtesy, not something to reassert on every render.
   */
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
  }, []);

  return (
    <div className="aModalBack" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="aModal" ref={ref} role="dialog" aria-modal="true" aria-label={title}>
        <div className="aModalHead">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="aX" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`aField${wide ? " wide" : ""}`}>
      <label>{label}</label>
      {children}
      {error ? <span className="fieldErr">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="aEmpty">{children}</div>;
}

/* ────────────────────────────────────────────────────────────────────────────
   Phase 2A additions. Purely presentational, all backed by scoped classes in
   src/styles/admin.css. `Empty` above is left untouched so the pages already
   using it keep rendering identically; `EmptyState` is the richer variant.
   ──────────────────────────────────────────────────────────────────────────── */

/** Shimmer placeholder. Prefer this over a bare "Loading…" string. */
export function Skeleton({
  height,
  width,
  className = "",
  style,
}: {
  height?: number | string;
  width?: number | string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return <div className={`aSkel ${className}`} style={{ height, width, ...style }} aria-hidden />;
}

/** A KPI-row's worth of skeletons, matching the real grid so nothing jumps. */
export function SkeletonKpis({ count = 4 }: { count?: number }) {
  return (
    <div className="aGrid">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="aSkelKpi" />
      ))}
    </div>
  );
}

/** Table-shaped skeleton, so the layout does not shift when rows arrive. */
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="aSkelRow" />
      ))}
    </div>
  );
}

/**
 * Empty state that explains itself and offers the next step.
 * An empty screen should never look like a broken screen.
 */
export function EmptyState({
  icon = "📭",
  title,
  hint,
  action,
}: {
  icon?: string;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="aEmptyBox">
      <span className="ico">{icon}</span>
      <h4>{title}</h4>
      {hint && <p>{hint}</p>}
      {action}
    </div>
  );
}

export type SubNavItem = { key: string; label: string; count?: number };

/** Tab strip for in-page sections (yard detail, analytics, audit views). */
export function SubNav<T extends string>({
  items,
  active,
  onChange,
}: {
  items: (SubNavItem & { key: T })[];
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="aSubNav" role="tablist">
      {items.map((it) => (
        <button
          key={it.key}
          role="tab"
          aria-selected={active === it.key}
          className={active === it.key ? "on" : ""}
          onClick={() => onChange(it.key)}
        >
          {it.label}
          {typeof it.count === "number" && <span className="cnt">{num(it.count)}</span>}
        </button>
      ))}
    </div>
  );
}

/** One line in a summary card: label (+ optional sub-label) and a mono value. */
export function Stat({
  label,
  sub,
  value,
  dim,
  bar,
}: {
  label: React.ReactNode;
  sub?: React.ReactNode;
  value: React.ReactNode;
  dim?: boolean;
  /** 0–100; renders a proportion bar under the row. */
  bar?: { pct: number; tone?: "brand" | "orange" | "mint" | "red" };
}) {
  return (
    <div className="aStat" style={bar ? { flexWrap: "wrap" } : undefined}>
      <span className="lbl">
        {sub ? (
          <>
            <b>{label}</b>
            {sub}
          </>
        ) : (
          label
        )}
      </span>
      <span className={`val${dim ? " dim" : ""}`}>{value}</span>
      {bar && (
        <div className="aBar" style={{ flexBasis: "100%" }}>
          <i
            className={bar.tone && bar.tone !== "brand" ? bar.tone : undefined}
            style={{ width: `${Math.max(0, Math.min(100, bar.pct))}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function StatList({ children }: { children: React.ReactNode }) {
  return <div className="aStatList">{children}</div>;
}

export type AlertTone = "warn" | "bad" | "good" | "muted";

/** An alert or pending action. `href` turns the row into a navigable item. */
export function AlertRow({
  tone = "muted",
  icon,
  title,
  detail,
  action,
}: {
  tone?: AlertTone;
  icon: string;
  title: React.ReactNode;
  detail?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className={`aAlert${tone === "muted" ? "" : ` ${tone}`}`}>
      <span className="ico">{icon}</span>
      <span className="body">
        <b>{title}</b>
        {detail && <span>{detail}</span>}
      </span>
      {action && <span className="go">{action}</span>}
    </div>
  );
}

export function AlertList({ children }: { children: React.ReactNode }) {
  return <div className="aAlertList">{children}</div>;
}

/**
 * Reserved space for a Phase 2B chart.
 *
 * Deliberately the same box the chart will occupy, so mounting an inline-SVG
 * chart later is a swap of children — no layout rework, no reflow of the page
 * around it. `data-chart` names the dataset the chart should bind to.
 */
export function ChartPlaceholder({
  chart,
  title,
  hint,
  tall,
}: {
  chart: string;
  title: string;
  hint?: string;
  tall?: boolean;
}) {
  return (
    <div className={`aChartBox${tall ? " tall" : ""}`} data-chart={chart}>
      <span className="ico">📈</span>
      <b>{title}</b>
      {hint && <span>{hint}</span>}
    </div>
  );
}

/** Breadcrumb trail. Keeps deep admin pages orientable. */
export function Crumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav className="aCrumbs" aria-label="Breadcrumb">
      {items.map((it, i) => (
        <span key={`${it.label}-${i}`} style={{ display: "inline-flex", gap: 7, alignItems: "center" }}>
          {i > 0 && <span className="sep">/</span>}
          {it.href ? <a href={it.href}>{it.label}</a> : <span className="cur">{it.label}</span>}
        </span>
      ))}
    </nav>
  );
}

/** Compact percentage for summary rows. Guards against divide-by-zero. */
export function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

/** Indian-format integer/currency helpers — matches the yard app's presentation. */
export const inr = (n: number) =>
  "₹" + Math.round(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
export const kg = (n: number) => n.toLocaleString("en-IN") + " kg";
export const num = (n: number) => n.toLocaleString("en-IN");

export function when(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
