"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Admin date-range picker.
 *
 * Replaces the 7D / 30D / 90D buttons, which could only ever answer "how are we
 * doing lately". An admin reconciling a month, comparing two Marches, or chasing
 * one bad Tuesday could not ask any of those questions.
 *
 * Emits an inclusive `from`/`to` pair as `YYYY-MM-DD` — the same shape the
 * analytics API now accepts — plus a human label for the page subtitle. All dates
 * are computed in **Asia/Kolkata**, matching the server's bucketing; using the
 * browser's local midnight would put an 11pm load in the wrong day for anyone
 * outside IST.
 */

export type DateRange = { from: string; to: string; label: string };

const TZ = "Asia/Kolkata";
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today in IST as `YYYY-MM-DD`, regardless of where the browser is. */
export function istToday(): string {
  return fmt.format(new Date());
}

/** Shift an ISO day by N days without tripping over DST or month lengths. */
function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const monthName = (m: number) =>
  ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m];

function pretty(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${monthName(m - 1).slice(0, 3)} ${y}`;
}

export function rangeLabel(from: string, to: string): string {
  if (from === to) return pretty(from);
  return `${pretty(from)} → ${pretty(to)}`;
}

/** Last N days INCLUDING today, so "7 days" really is a week of data. */
export function lastDays(n: number): DateRange {
  const to = istToday();
  const from = shift(to, -(n - 1));
  return { from, to, label: `Last ${n} days` };
}

function monthRange(y: number, m: number): DateRange {
  const from = `${y}-${String(m + 1).padStart(2, "0")}-01`;
  // Day 0 of the next month is the last day of this one — no length table.
  const last = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
  return { from, to: last, label: `${monthName(m)} ${y}` };
}

function yearRange(y: number): DateRange {
  return { from: `${y}-01-01`, to: `${y}-12-31`, label: String(y) };
}

export const DEFAULT_RANGE = (): DateRange => lastDays(30);

type Mode = "presets" | "day" | "month" | "year" | "custom";

/**
 * Placement constants. `BOTTOM_NAV_SPACE` matches the fixed admin bottom bar plus
 * safe-area inset — the panel must clear it, not sit under it.
 */
const TABLET_MAX = 1000; // the breakpoint at which the bottom nav appears
const BOTTOM_NAV_SPACE = 84;
const GAP = 10;
/** Enough for the tab strip plus a usable list; below this, centre it instead. */
const PANEL_MIN_H = 300;

export function DateRangePicker({
  value,
  onChange,
  align = "right",
}: {
  value: DateRange;
  onChange: (r: DateRange) => void;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("presets");
  const [draftFrom, setDraftFrom] = useState(value.from);
  const [draftTo, setDraftTo] = useState(value.to);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  /**
   * Where the panel opens, on tablet and phone only.
   *
   * Desktop keeps the plain CSS drop-down; there is always room below a control in
   * a 900px-tall console. Below the bottom-nav breakpoint there often is not, and
   * the panel opened straight off the bottom of the screen — partly behind the
   * fixed navigation, with its Apply button unreachable.
   *
   * Measured rather than assumed: the same control sits at the top of Overview and
   * halfway down Analytics, so a fixed choice is wrong for one of them.
   * `down` → fits below · `up` → fits above · `modal` → neither, so centre it.
   */
  const [placement, setPlacement] = useState<"down" | "up" | "modal">("down");

  const today = istToday();
  const thisYear = Number(today.slice(0, 4));
  const thisMonth = Number(today.slice(5, 7)) - 1;

  // Re-sync the custom drafts whenever the applied range changes from outside,
  // so reopening the panel shows what is actually in effect.
  useEffect(() => {
    setDraftFrom(value.from);
    setDraftTo(value.to);
  }, [value.from, value.to]);

  /**
   * Decide placement when the panel opens, and again if the viewport changes
   * (rotation, or the on-screen keyboard resizing the visual viewport).
   */
  useEffect(() => {
    if (!open) return;

    const place = () => {
      // Desktop: leave it to CSS.
      if (window.innerWidth > TABLET_MAX) {
        setPlacement("down");
        return;
      }
      const btn = btnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom - BOTTOM_NAV_SPACE - GAP;
      const spaceAbove = r.top - GAP;
      if (spaceBelow >= PANEL_MIN_H) setPlacement("down");
      else if (spaceAbove >= PANEL_MIN_H) setPlacement("up");
      else setPlacement("modal");
    };

    place();
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const presets = useMemo<DateRange[]>(
    () => [
      { from: today, to: today, label: "Today" },
      { from: shift(today, -1), to: shift(today, -1), label: "Yesterday" },
      lastDays(7),
      lastDays(30),
      lastDays(90),
      monthRange(thisYear, thisMonth),
      thisMonth === 0 ? monthRange(thisYear - 1, 11) : monthRange(thisYear, thisMonth - 1),
      yearRange(thisYear),
    ],
    [today, thisYear, thisMonth]
  );

  function apply(r: DateRange) {
    onChange(r);
    setOpen(false);
  }

  const years = useMemo(() => Array.from({ length: 6 }, (_, i) => thisYear - i), [thisYear]);
  const customValid = draftFrom !== "" && draftTo !== "" && draftFrom <= draftTo;

  return (
    <div className={`aRange ${align === "left" ? "left" : ""}`} ref={wrapRef}>
      <button
        type="button"
        ref={btnRef}
        className="aBtn sm aRangeBtn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
          <path d="M3.5 9.8h17M8.5 3v4M15.5 3v4" />
        </svg>
        {value.label}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M5 9l7 7 7-7" />
        </svg>
      </button>

      {open && (
        <div className={`aRangePanel place-${placement}`} role="dialog" aria-label="Select date range">
          <div className="aRangeTabs">
            {(["presets", "day", "month", "year", "custom"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={mode === m ? "on" : ""}
                onClick={() => setMode(m)}
              >
                {m === "presets" ? "Quick" : m === "day" ? "Day" : m === "month" ? "Month" : m === "year" ? "Year" : "Custom"}
              </button>
            ))}
          </div>

          {mode === "presets" && (
            <div className="aRangeList">
              {presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={p.from === value.from && p.to === value.to ? "on" : ""}
                  onClick={() => apply(p)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}

          {mode === "day" && (
            <div className="aRangeForm">
              <label>
                Date
                <input
                  type="date"
                  max={today}
                  value={draftFrom}
                  onChange={(e) => {
                    setDraftFrom(e.target.value);
                    setDraftTo(e.target.value);
                  }}
                />
              </label>
              <button
                type="button"
                className="aBtn sm primary"
                disabled={!draftFrom}
                onClick={() => apply({ from: draftFrom, to: draftFrom, label: pretty(draftFrom) })}
              >
                Apply
              </button>
            </div>
          )}

          {mode === "month" && (
            <div className="aRangeForm">
              <label>
                Month
                <input
                  type="month"
                  max={today.slice(0, 7)}
                  value={draftFrom.slice(0, 7)}
                  onChange={(e) => setDraftFrom(`${e.target.value}-01`)}
                />
              </label>
              <button
                type="button"
                className="aBtn sm primary"
                onClick={() => {
                  const [y, m] = draftFrom.slice(0, 7).split("-").map(Number);
                  apply(monthRange(y, m - 1));
                }}
              >
                Apply
              </button>
            </div>
          )}

          {mode === "year" && (
            <div className="aRangeList">
              {years.map((y) => (
                <button
                  key={y}
                  type="button"
                  className={value.label === String(y) ? "on" : ""}
                  onClick={() => apply(yearRange(y))}
                >
                  {y}
                </button>
              ))}
            </div>
          )}

          {mode === "custom" && (
            <div className="aRangeForm">
              <label>
                From
                <input type="date" max={today} value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} />
              </label>
              <label>
                To
                <input type="date" max={today} min={draftFrom} value={draftTo} onChange={(e) => setDraftTo(e.target.value)} />
              </label>
              {!customValid && draftFrom && draftTo && <p className="aRangeErr">From must be on or before To.</p>}
              <button
                type="button"
                className="aBtn sm primary"
                disabled={!customValid}
                onClick={() => apply({ from: draftFrom, to: draftTo, label: rangeLabel(draftFrom, draftTo) })}
              >
                Apply
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
