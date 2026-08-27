"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { TAB_ORDER } from "@/frontend/components/bottom-nav";
import { ADMIN_NAV } from "@/frontend/components/admin/nav-items";

/**
 * Directional page transitions for the two shells.
 *
 * ── Why direction rather than a fade ─────────────────────────────────────────
 * A fade tells you the content changed. It does not tell you WHERE you went,
 * and on screens that share a layout it barely registers at all. Movement does:
 * a page arriving from the right reads as "further in", one arriving from the
 * left as "back out". That is the whole purpose of this file.
 *
 * ── Where the direction comes from ───────────────────────────────────────────
 * It is derived from the real relationship between the two routes, never
 * assigned at random:
 *
 *   1. The new route is BELOW the old one (`/admin/yards` → `/admin/yards/x`)
 *      — a step deeper, so it arrives from the right.
 *   2. The old route is below the new one — a step back out, from the left.
 *   3. Otherwise they are siblings in the shell's navigation, and the bar's own
 *      left-to-right order decides it: tapping a tab to the right of the current
 *      one brings the page in from the right, and vice versa. The motion
 *      matches the direction the operator's finger moved along the bar.
 *
 * ── Enter-only, deliberately ─────────────────────────────────────────────────
 * These are App Router navigations: the previous route's markup is gone by the
 * time the new one renders, so there is nothing left to animate out. That is
 * fine here, because sibling pages (Stock vs Inward vs Sort) look nothing alike
 * — the arrival alone is unambiguous. The Stock hierarchy is the case where the
 * two views DO look alike, and that one animates both halves; see `.stockStage`
 * in globals.css.
 */

type Dir = "fwd" | "back";

/** Longest-prefix section match, so `/admin/yards/abc` counts as `/admin/yards`. */
function orderIndex(pathname: string, order: readonly string[]): number {
  let best = -1;
  let bestLen = -1;
  order.forEach((href, i) => {
    const hit = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
    if (hit && href.length > bestLen) {
      best = i;
      bestLen = href.length;
    }
  });
  return best;
}

function directionBetween(from: string, to: string, order: readonly string[]): Dir {
  // Depth first: a descendant route is unambiguously "deeper", whatever the
  // navigation bar happens to say about the section they share.
  if (to.startsWith(`${from}/`)) return "fwd";
  if (from.startsWith(`${to}/`)) return "back";

  const a = orderIndex(from, order);
  const b = orderIndex(to, order);
  if (a === -1 || b === -1 || a === b) return "fwd";
  return b > a ? "fwd" : "back";
}

/**
 * The direction of the move that just happened, or `null` on the very first
 * paint — there is no previous page to have come from, so the shell keeps its
 * own opening animation instead of pretending a navigation occurred.
 */
function useRouteDirection(order: readonly string[]): { key: string; dir: Dir | null } {
  const pathname = usePathname();
  const previous = useRef<string | null>(null);

  /**
   * Resolved after mount, and read here rather than left to CSS so the class is
   * never applied at all for these users — a movement they did not ask for
   * should not be started and then suppressed.
   */
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const from = previous.current;
  const dir = from === null || from === pathname ? null : directionBetween(from, pathname, order);

  // After render, so the value above is still the page we came FROM.
  useEffect(() => {
    previous.current = pathname;
  }, [pathname]);

  return { key: pathname, dir: reduced ? null : dir };
}

function classFor(base: string, dir: Dir | null): string {
  if (!dir) return base;
  return `${base} routeIn ${dir === "fwd" ? "fromRight" : "fromLeft"}`;
}

/**
 * Yard app (Owner / Supervisor). Renders the same `<section className="screen">`
 * the layout always had — the element, its styles and its place in the DOM are
 * unchanged; it only gains a key so the arrival animation replays, which React
 * would otherwise skip by reusing the element.
 *
 * Horizontal travel is already contained: `.screens`, its parent, is
 * `overflow: hidden`, so nothing can reach the viewport edge.
 */
export function ScreenTransition({ children }: { children: React.ReactNode }) {
  const { key, dir } = useRouteDirection(TAB_ORDER);
  return (
    <section className={classFor("screen", dir)} key={key}>
      {children}
    </section>
  );
}

/** Admin console. Same rules, driven by the sidebar's own item order. */
const ADMIN_ORDER = ADMIN_NAV.map((i) => i.href);

export function AdminMainTransition({ children }: { children: React.ReactNode }) {
  const { key, dir } = useRouteDirection(ADMIN_ORDER);
  return (
    <main className={classFor("aMain", dir)} key={key}>
      {children}
    </main>
  );
}
