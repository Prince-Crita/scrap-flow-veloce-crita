/**
 * Daily activity streak.
 *
 * The prototype renders a streak ("🔥 12") but never computes one, and until now
 * neither did this app: `streak` was written once at seed time and then frozen,
 * so the number on every user's header was decorative. This makes it real.
 *
 * Rules:
 *   • Same day as the last activity      → unchanged (idempotent within a day)
 *   • Exactly the previous day           → +1
 *   • A gap of two or more days          → reset to 1 (today counts)
 *   • Never active before                → 1
 *
 * Days are computed in the YARD's timezone, not the server's or the browser's.
 * A yard in Asia/Kolkata must roll over at local midnight, or a load booked at
 * 11pm IST would land on the previous UTC day and silently break the streak.
 */

/** Calendar day key (YYYY-MM-DD) for an instant, in the given IANA timezone. */
export function dayKey(at: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which sorts and compares correctly as a string.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Whole days between two day keys. Both must be YYYY-MM-DD. */
export function daysBetween(fromKey: string, toKey: string): number {
  const from = Date.UTC(+fromKey.slice(0, 4), +fromKey.slice(5, 7) - 1, +fromKey.slice(8, 10));
  const to = Date.UTC(+toKey.slice(0, 4), +toKey.slice(5, 7) - 1, +toKey.slice(8, 10));
  return Math.round((to - from) / 86_400_000);
}

export type StreakResult = {
  streak: number;
  /** True when this activity extended the streak (worth celebrating). */
  extended: boolean;
  /** True when a gap broke the previous streak. */
  reset: boolean;
  /** False when the user was already active today — nothing changed. */
  changed: boolean;
};

/**
 * Pure function: given the stored streak and last-active instant, what should
 * the streak be after activity at `now`? Kept pure so it is trivially testable
 * and has no opinion about how it is persisted.
 */
export function nextStreak(
  current: number,
  lastActiveDate: Date | null,
  now: Date,
  timeZone: string
): StreakResult {
  const today = dayKey(now, timeZone);

  if (!lastActiveDate) {
    return { streak: 1, extended: true, reset: false, changed: true };
  }

  const last = dayKey(lastActiveDate, timeZone);
  const gap = daysBetween(last, today);

  if (gap <= 0) {
    // Already counted today (or a clock skew put "last" in the future).
    return { streak: Math.max(1, current), extended: false, reset: false, changed: false };
  }
  if (gap === 1) {
    return { streak: Math.max(1, current) + 1, extended: true, reset: false, changed: true };
  }
  return { streak: 1, extended: false, reset: true, changed: true };
}
