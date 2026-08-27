"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Role } from "@prisma/client";
import { getJson } from "@/frontend/lib/api-client";
import { fmt } from "@/shared/format";
import { StockDetailSheet } from "@/frontend/components/stock-detail-sheet";

type StockSku = {
  id: string;
  code: string;
  name: string;
  icon: string;
  quantityKg: number;
  thresholdKg: number;
  isMixedBucket: boolean;
  visible: boolean;
  ready: boolean;
  /** Last inventory movement. Used only to order ready cards; may be null. */
  updatedAt: string | null;
  /** Parent material — how the yard's tree is already shaped. May be null on legacy SKUs. */
  materialId: string | null;
  materialName: string | null;
  materialCategory: string | null;
};

type YardSummary = {
  stockKg: number;
  readyToSell: number;
  pendingLoads: number;
  inwardToday: { count: number; kg: number };
  outwardToday: { count: number; kg: number };
};

/**
 * A main material category as browsed on this screen.
 *
 * Built from the yard's OWN material tree (Material → its SKUs) — nothing here
 * is a hardcoded category list. `id === null` is the bucket for SKUs created
 * before the material link existed; it renders only when it actually has rows.
 */
type Category = {
  id: string | null;
  name: string;
  /** Material.category, the admin's free-text grouping. Shown when set. */
  subtitle: string | null;
  icon: string;
  skus: StockSku[];
  quantityKg: number;
  readyCount: number;
};

/** Where in the hierarchy the user is. Vendor breakdown is the sheet, one level deeper. */
type View = { kind: "dashboard" } | { kind: "categories" } | { kind: "subs"; categoryId: string | null };

const UNGROUPED_LABEL = "Unassigned";

export function StockScreen({ role }: { role: Role }) {
  const [detailSku, setDetailSku] = useState<string | null>(null);

  // The Owner (and an ADMIN inside the yard, who inherits Owner screens) lands on
  // the yard dashboard. A Supervisor has no dashboard and opens straight into the
  // material categories.
  const hasDashboard = role === "OWNER" || role === "ADMIN";
  const [view, setView] = useState<View>(hasDashboard ? { kind: "dashboard" } : { kind: "categories" });

  /**
   * The move currently playing: which way it went, and the level being left.
   *
   * Keeping the OUTGOING level mounted for the length of the move is the whole
   * point. Animating only the arriving level — the previous attempt — is
   * invisible in practice, because the level it replaces vanishes instantly and
   * there is nothing to see it move against. Two levels on screen for ~300ms is
   * what actually reads as "one slid out, the other came in".
   *
   * `null` on first paint, so the initial render keeps the screen's own entry
   * animation instead of stacking a second one on it.
   */
  const [nav, setNav] = useState<{ dir: "fwd" | "back"; from: View } | null>(null);

  /**
   * Step between levels of the hierarchy.
   *
   * The levels are one component swapping a `view` state, not separate routes,
   * so this function IS the navigation boundary and the transition belongs here.
   * `dir` drives nothing but the animation; the navigation itself is unchanged.
   *
   * Reduced motion is decided here rather than left to CSS: the outgoing level
   * is removed when its own animation ends, so a CSS rule that silently dropped
   * the animation would leave that level on screen forever. Read live from the
   * media query, so the OS setting is honoured without a reload.
   */
  function go(next: View, dir: "fwd" | "back") {
    const reduced =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setNav(reduced ? null : { dir, from: view });
    setView(next);
  }

  /**
   * Safety net for the outgoing level.
   *
   * It is normally removed by its own `animationend`. That event does not arrive
   * if the browser never runs the animation — a backgrounded tab, a device that
   * drops it under load — and the level would then sit there. Clearing on a
   * timer past the 300ms animation as well means the screen always settles.
   */
  useEffect(() => {
    if (!nav) return;
    const t = setTimeout(() => setNav(null), 500);
    return () => clearTimeout(t);
  }, [nav]);

  /**
   * Identity of the level on screen. Used as the arriving layer's `key` so React
   * mounts a fresh node per level, which is what lets its animation replay —
   * React would otherwise reuse the element and animate on first mount only.
   * Derived from the view alone: a data refresh must not remount and must not
   * re-animate.
   */
  const levelKey = view.kind === "subs" ? `subs:${view.categoryId ?? "__ungrouped"}` : view.kind;

  // No polling: RealtimeProvider invalidates ["stock"] on inward/sort/sale
  // events, so this list reflects the yard the moment it changes.
  const { data, isLoading } = useQuery({
    queryKey: ["stock"],
    queryFn: () => getJson<{ skus: StockSku[] }>("/api/stock"),
  });

  /**
   * READY TO SELL cards float to the top, newest first.
   *
   * The point of this screen is "what can I sell right now", and a ready SKU sat
   * wherever `sortOrder` happened to put it — below three cards that are nowhere
   * near their threshold. Ready items lead, ordered by their most recent stock
   * movement so the one that just crossed the line is first; everything else keeps
   * the existing `sortOrder` sequence the API returns.
   *
   * Display only. Nothing here touches quantities, thresholds or the `ready` flag
   * itself — all three are computed server-side and used exactly as received.
   */
  const visible = useMemo(() => (data?.skus ?? []).filter((s) => s.visible), [data]);
  const ordered = useMemo(
    () => [
      ...visible
        .filter((s) => s.ready)
        .sort((a, b) => {
          const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
          const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
          return bt - at; // newest ready first
        }),
      ...visible.filter((s) => !s.ready),
    ],
    [visible]
  );

  /**
   * Group the SKUs under their parent material, preserving the API's order.
   *
   * Totals here are plain sums of the server's own `quantityKg` and `ready` flag —
   * a category card reports what its SKUs already say, it does not recompute
   * anything.
   */
  const categories = useMemo(() => {
    const byId = new Map<string, Category>();
    const ungrouped: Category = {
      id: null,
      name: UNGROUPED_LABEL,
      subtitle: null,
      icon: "📦",
      skus: [],
      quantityKg: 0,
      readyCount: 0,
    };

    for (const s of ordered) {
      const key = s.materialId;
      let cat: Category;
      if (key === null) {
        cat = ungrouped;
      } else {
        const existing = byId.get(key);
        if (existing) {
          cat = existing;
        } else {
          cat = {
            id: key,
            name: s.materialName ?? s.name,
            subtitle: s.materialCategory,
            // The mixed bucket is the material's own icon; until one shows up,
            // the first SKU's icon stands in.
            icon: s.icon,
            skus: [],
            quantityKg: 0,
            readyCount: 0,
          };
          byId.set(key, cat);
        }
        if (s.isMixedBucket) cat.icon = s.icon;
      }
      cat.skus.push(s);
      cat.quantityKg += s.quantityKg;
      if (s.ready) cat.readyCount += 1;
    }

    const list = [...byId.values()];
    if (ungrouped.skus.length > 0) list.push(ungrouped);
    return list;
  }, [ordered]);

  function openSku(s: StockSku) {
    setDetailSku(s.id);
  }

  /**
   * One level of the hierarchy, rendered from an explicit view rather than from
   * state. That is what lets the level being left keep rendering itself while it
   * animates away. Every branch below is the markup that was already here.
   */
  function renderLevel(v: View) {
    /* ─────────────────────────── OWNER DASHBOARD ─────────────────────────── */
    if (v.kind === "dashboard") {
      return (
        <div className="stockWrap">
          <YardDashboard onEnterStock={() => go({ kind: "categories" }, "fwd")} />
        </div>
      );
    }

    /* ────────────────────────── MAIN CATEGORIES ────────────────────────── */
    if (v.kind === "categories") {
      return (
        <div className="stockWrap">
          {hasDashboard && <BackBar label="Yard dashboard" onBack={() => go({ kind: "dashboard" }, "back")} />}
          <div className="secTitle">Live Stock · Materials</div>

          {isLoading && <SquareSkeletons />}

          {!isLoading && categories.length === 0 && (
            <div className="recv">
              <span>No materials configured for this yard yet</span>
            </div>
          )}

          <div className="sqGrid">
            {categories.map((c) => (
              <button
                key={c.id ?? "__ungrouped"}
                type="button"
                className={`sqCard${c.readyCount > 0 ? " isReady" : ""}`}
                onClick={() => go({ kind: "subs", categoryId: c.id }, "fwd")}
              >
                <div className="sqTop">
                  <span className="chipIcon">{c.icon}</span>
                  <span className="sqCount">{c.skus.length}</span>
                </div>
                <div className="sqBody">
                  <div className="sqName">{c.name}</div>
                  <div className="sqSub">
                    {c.subtitle ? `${c.subtitle} · ` : ""}
                    {c.skus.length} {c.skus.length === 1 ? "type" : "types"}
                  </div>
                  <div className="sqKg">
                    <b>{fmt(c.quantityKg)}</b>
                    <span>KG</span>
                  </div>
                </div>
                <div className={`sqFoot${c.readyCount > 0 ? " on" : ""}`}>
                  {c.readyCount > 0 ? `🔔 ${c.readyCount} ready to sell` : "View sub-materials →"}
                </div>
              </button>
            ))}
          </div>
        </div>
      );
    }

    /* ─────────────────────── SUB MATERIALS OF A CATEGORY ─────────────────────── */
    const openCategory = categories.find((c) => c.id === v.categoryId) ?? null;
    return (
      <div className="stockWrap">
        <BackBar label="All materials" onBack={() => go({ kind: "categories" }, "back")} />
        <div className="secTitle">{openCategory ? openCategory.name : "Sub-materials"}</div>

        {isLoading && <SquareSkeletons />}

        {!isLoading && openCategory && openCategory.skus.length === 0 && (
          <div className="recv">
            <span>No sub-materials under this category</span>
          </div>
        )}

        <div className="sqGrid">
          {(openCategory?.skus ?? []).map((s) => {
            const showMeter = s.thresholdKg < 90000;
            const pct = Math.min(100, Math.round((s.quantityKg / s.thresholdKg) * 100));
            const barCol = s.ready ? "var(--led)" : pct > 70 ? "var(--mint)" : "var(--orange)";
            return (
              <button
                key={s.id}
                type="button"
                className={`sqCard${s.ready ? " isReady" : ""}`}
                onClick={() => openSku(s)}
              >
                <div className="sqTop">
                  <span className="chipIcon">{s.icon}</span>
                  {s.ready && <span className="sqTag">READY</span>}
                </div>
                {/* The prototype's stock card labels the mixed bucket
                    "Mixed MS (unsorted)" while the inward chip and sort header
                    use the bare "Mixed MS". The suffix is display-only, applied
                    here, so the stored SKU name stays the one shared by all
                    three screens. */}
                <div className="sqBody">
                  <div className="sqName">
                    {s.name}
                    {s.isMixedBucket ? " (unsorted)" : ""}
                  </div>
                  <div className="sqSub">
                    {showMeter ? `threshold ${fmt(s.thresholdKg)} kg` : "awaiting segregation"}
                  </div>
                  <div className="sqKg">
                    <b>{fmt(s.quantityKg)}</b>
                    <span>KG</span>
                  </div>
                  {showMeter && (
                    <div className="meter">
                      <i style={{ width: `${pct}%`, background: barCol }} />
                    </div>
                  )}
                </div>
                <div className="sqFoot">
                  {showMeter
                    ? s.ready
                      ? "🔔 buyer alert sent"
                      : `${pct}% · ${fmt(Math.max(0, s.thresholdKg - s.quantityKg))} kg to go`
                    : "Vendor breakdown →"}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className={`stockStage${nav ? " isNavigating" : ""}`}>
      {/* The level being left, still rendering itself as it moves off. Inert:
          a picture of where the operator just was, not a control. */}
      {nav && (
        <div
          className={`stockLayer stockLeave ${nav.dir === "fwd" ? "toLeft" : "toRight"}`}
          aria-hidden
          onAnimationEnd={(e) => {
            // Only this layer's own animation ends the move. Animation events
            // bubble, and the cards inside carry their own (the READY pulse,
            // the loading shimmer).
            if (e.target === e.currentTarget) setNav(null);
          }}
        >
          {renderLevel(nav.from)}
        </div>
      )}

      <div
        key={levelKey}
        className={`stockLayer${nav ? ` stockEnter ${nav.dir === "fwd" ? "fromRight" : "fromLeft"}` : ""}`}
      >
        {renderLevel(view)}
      </div>

      {/* One sheet for the whole screen, outside the animating layers: it is a
          portal driven by `detailSku`, and mounting it per level would put a
          second copy on the page for the length of every move. */}
      <StockDetailSheet skuId={detailSku} onClose={() => setDetailSku(null)} />
    </div>
  );
}

/* ───────────────────────────── pieces ───────────────────────────── */

function BackBar({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button type="button" className="backBar" onClick={onBack}>
      <span aria-hidden>←</span> {label}
    </button>
  );
}

function SquareSkeletons() {
  return (
    <div className="sqGrid">
      <div className="skel sqSkel" />
      <div className="skel sqSkel" />
      <div className="skel sqSkel" />
      <div className="skel sqSkel" />
    </div>
  );
}

/**
 * The Owner's yard-at-a-glance strip.
 *
 * Every tile is a figure the app already calculates — /api/stock/summary only
 * scopes those same rules to this yard. Nothing is invented here and nothing is
 * recomputed client-side.
 */
function YardDashboard({ onEnterStock }: { onEnterStock: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["yardSummary"],
    queryFn: () => getJson<YardSummary>("/api/stock/summary"),
  });

  const tiles = [
    { label: "Stock On Hand", value: data ? fmt(data.stockKg) : "—", unit: "KG", foot: "across every SKU", icon: "📦" },
    {
      label: "Ready To Sell",
      value: data ? fmt(data.readyToSell) : "—",
      unit: data?.readyToSell === 1 ? "SKU" : "SKUS",
      foot: "at or above threshold",
      icon: "🔔",
      on: (data?.readyToSell ?? 0) > 0,
    },
    {
      label: "Pending Loads",
      value: data ? fmt(data.pendingLoads) : "—",
      unit: data?.pendingLoads === 1 ? "LOT" : "LOTS",
      foot: "awaiting segregation",
      icon: "🧲",
    },
    {
      label: "Today's Inward",
      value: data ? fmt(data.inwardToday.kg) : "—",
      unit: "KG",
      foot: data ? `${fmt(data.inwardToday.count)} ${data.inwardToday.count === 1 ? "load" : "loads"}` : "—",
      icon: "⚖️",
    },
    {
      label: "Today's Outward",
      value: data ? fmt(data.outwardToday.kg) : "—",
      unit: "KG",
      foot: data
        ? `${fmt(data.outwardToday.count)} ${data.outwardToday.count === 1 ? "dispatch" : "dispatches"}`
        : "—",
      icon: "🏁",
    },
  ];

  return (
    <>
      <div className="secTitle">Yard Dashboard</div>

      {isLoading ? (
        <SquareSkeletons />
      ) : (
        <div className="sqGrid">
          {tiles.map((t) => (
            <div key={t.label} className={`sqCard sqTile${t.on ? " isReady" : ""}`}>
              <div className="sqTop">
                <span className="chipIcon">{t.icon}</span>
              </div>
              <div className="sqBody">
                {/* On a tile the label IS the primary information — it is what
                    tells you which figure you are looking at. It shared the
                    secondary `.sqSub` size with the category cards, where the
                    same class genuinely is metadata, so it read as the smallest
                    thing on the card. `.sqTileLbl` separates the two jobs. */}
                <div className="sqSub sqTileLbl">{t.label}</div>
                <div className="sqKg">
                  <b>{t.value}</b>
                  <span>{t.unit}</span>
                </div>
              </div>
              <div className={`sqFoot${t.on ? " on" : ""}`}>{t.foot}</div>
            </div>
          ))}
        </div>
      )}

      <button className="cta" onClick={onEnterStock}>
        📦 Browse Stock by Material
      </button>
    </>
  );
}
