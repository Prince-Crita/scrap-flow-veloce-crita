/**
 * Admin console icon set.
 *
 * The console previously used emoji (📊 📈 🏭 👤 🧾). Emoji are a *phone*
 * convention: they render at a different weight on every OS, carry their own
 * colour, and cannot be aligned to the surrounding type. On a dense desktop
 * console next to 13px semibold labels they read as decoration rather than
 * navigation.
 *
 * These are geometric line icons drawn on the same 24-unit grid as the Veloce
 * chevron mark, at one stroke width, inheriting `currentColor` so they take the
 * active/hover/muted state from the link exactly as the label does.
 *
 * **Owner and Manager keep their emoji.** That is deliberate, not an
 * inconsistency: the yard app is a phone app used in gloves and daylight, where
 * a big coloured glyph is the correct affordance. This set shares the brand's
 * geometry with it without copying a single icon from it.
 */

const STROKE = 1.75;

type IconProps = { size?: number; className?: string };

function Svg({ size = 20, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

/** Overview — a live gauge/pulse, not a bar chart (Analytics owns bars). */
export function IconOverview(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 12a8.5 8.5 0 0 1 17 0" />
      <path d="M3.5 12v4.5" />
      <path d="M20.5 12v4.5" />
      <path d="M12 12l4-3.2" />
      <circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Analytics — trend line over an axis. */
export function IconAnalytics(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 4v15.5h16" />
      <path d="M7.5 15l3.5-4 3 2.4 4-6" />
      <path d="M18 5.4h-2.2M18 5.4v2.2" />
    </Svg>
  );
}

/** Yards — a plant/site silhouette with a stack. */
export function IconYards(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 20V10.2l5.2 3V10.2l5.2 3V6.5L21 4v16" />
      <path d="M3 20h18" />
      <path d="M17 20v-4h2.5v4" />
    </Svg>
  );
}

/** Users — one figure plus a second shoulder, so it never reads as a single account. */
export function IconUsers(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="9.5" cy="8" r="3.4" />
      <path d="M3.2 19.5a6.3 6.3 0 0 1 12.6 0" />
      <path d="M16.2 5.2a3.4 3.4 0 0 1 0 6.4" />
      <path d="M17.6 14.2a6.3 6.3 0 0 1 3.2 5.3" />
    </Svg>
  );
}

/** Audit Log — a document with ruled entries and a check. */
export function IconAudit(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 3h8.5L19 7.4V21H6z" />
      <path d="M14 3v4.6h4.8" />
      <path d="M9 12h6" />
      <path d="M9 15.6h4" />
      <path d="M9.2 18.8l1.4 1.4 2.8-2.9" />
    </Svg>
  );
}

/** "More" — the overflow affordance on the mobile bar. */
export function IconMore(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="5.2" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="18.8" cy="12" r="1.35" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Sign out — used inside the More sheet. */
export function IconSignOut(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14.5 4.5h-8V19.5h8" />
      <path d="M11 12h9.5" />
      <path d="M17.6 8.6L21 12l-3.4 3.4" />
    </Svg>
  );
}

export function IconClose(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

/** Named lookup so the nav table can stay data-driven. */
export const ADMIN_ICONS = {
  overview: IconOverview,
  analytics: IconAnalytics,
  yards: IconYards,
  users: IconUsers,
  audit: IconAudit,
  more: IconMore,
} as const;

export type AdminIconName = keyof typeof ADMIN_ICONS;
