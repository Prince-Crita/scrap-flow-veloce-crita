"use client";

import Link from "next/link";

/**
 * Supervisor Outward — the dispatch dashboard.
 *
 * Three entry points. The dispatch keypad that used to live here was removed
 * when dispatching became the page-based workflow that starts at New Dispatch,
 * and the "Find a dispatch" selector that sat below these cards has been
 * removed too: tracking a dispatch's status is what Active Dispatch is for, and
 * two ways to reach the same record is one more than the screen needs.
 *
 * ── Why these are Stock's cards ──────────────────────────────────────────────
 * They ARE Stock's cards: `.sqGrid` + `.sqCard`, the same panel, border, radius,
 * hover lift, press response and focus ring the yard dashboard already uses. The
 * only additions are a three-column track and a centred icon-over-label stack,
 * because an action card has no figure to report — every other property is
 * inherited rather than restated, so the two screens cannot drift apart.
 */

/**
 * Icons, drawn rather than typed.
 *
 * The app has no icon component library — the yard dashboard renders emoji
 * inside `.chipIcon`. Emoji were the wrong tool for these three: "history"
 * has no unambiguous emoji, and the ones that exist are full-colour glyphs the
 * font vendor chooses, so the same card renders differently on the Android
 * tablet in the yard office and the phone in the operator's pocket.
 *
 * These are line icons on `currentColor` at a common 24px box and a common
 * 1.9px stroke, so the three read as one set. They sit in the SAME `.chipIcon`
 * shell the Stock cards use, which is what carries the visual language.
 */
export const ICON = {
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  fill: "none" as const,
  stroke: "currentColor",
};

export function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden focusable="false" {...ICON}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function TruckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden focusable="false" {...ICON}>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H14a1 1 0 0 1 1 1v9H3z" />
      <path d="M15 10h3.2a1 1 0 0 1 .82.43L21 13.2V16h-6z" />
      <circle cx="7" cy="17.5" r="1.9" />
      <circle cx="17.5" cy="17.5" r="1.9" />
    </svg>
  );
}

export function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden focusable="false" {...ICON}>
      {/* An arc with a return arrow, not a full circle: the gap at the top left
          is what separates "history" from a plain clock at 22px. */}
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3.2 4.8v4.1h4.1" />
      <path d="M12 7.8V12l3 1.8" />
    </svg>
  );
}

const CARDS = [
  { key: "new", href: "/outward/new", label: "New Dispatch", Icon: PlusIcon },
  { key: "active", href: "/outward/active", label: "Active Dispatch", Icon: TruckIcon },
  { key: "history", href: "/outward/history", label: "Dispatch History", Icon: HistoryIcon },
] as const;

/**
 * @param title  The section heading. Defaults to what the Outward route has
 *               always rendered; the Owner's Sell page passes "Dispatch",
 *               because there it is a section of that page rather than the page
 *               itself. Nothing else differs — same cards, same records, same
 *               dispatch IDs.
 */
export function OutwardPickups({ title = "Outward · Dispatch" }: { title?: string } = {}) {
  return (
    <>
      <div className="secTitle">{title}</div>

      <div className="sqGrid actionGrid">
        {CARDS.map(({ key, href, label, Icon }) => (
          <Link key={key} href={href} className="sqCard actionCard">
            <span className="chipIcon actionIcon">
              <Icon />
            </span>
            <span className="actionLbl">{label}</span>
          </Link>
        ))}
      </div>
    </>
  );
}
