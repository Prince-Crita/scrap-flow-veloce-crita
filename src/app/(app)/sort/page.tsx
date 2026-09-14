"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { getJson, sendJson, ApiError } from "@/frontend/lib/api-client";
import { useInvalidateChannels } from "@/frontend/components/realtime/provider";
import { fmt } from "@/shared/format";
import { UNITS, fromKilograms, toKilograms, type UnitCode } from "@/shared/units";
import { useUI } from "@/frontend/components/ui-provider";
import { SortTypeSheet } from "@/frontend/components/sort-type-sheet";
import { can } from "@/shared/permissions";
import { roleLabel } from "@/shared/role-label";
import { loadRefDateTime } from "@/shared/load-ref";

type Lot = {
  /** Row identity. A multi-material load contributes several rows sharing one
   *  loadId, so selection must key on this rather than on the load. */
  lotKey: string;
  loadId: string;
  lineId: string | null;
  lotNumber: string;
  /** Platform-unique, human-readable — see src/shared/load-ref.ts. */
  loadRef: string;
  materialLabel: string;
  /** The unsorted balance still to allocate — not necessarily what arrived. */
  totalKg: number;
  receivedKg?: number;
  sortedKg?: number;
  vendorName: string;
  vehicleNumber: string;
  capturedByName: string | null;
  capturedByRole: string | null;
  createdAt: string;
  sourceSkuId: string | null;
  targets: { skuId: string; name: string }[];
  sortable: boolean;
};

/**
 * Who received the load, for the selector.
 *
 * The person's name when there is one, because a name identifies the human and
 * a role does not — two supervisors are not interchangeable. Falls back to the
 * role label ("Owner", "Supervisor") for accounts with no display name, which is
 * the same vocabulary the rest of the app uses. The lot card below shows both.
 */
function enteredBy(l: Pick<Lot, "capturedByName" | "capturedByRole">): string {
  if (l.capturedByName) return l.capturedByName;
  return l.capturedByRole ? roleLabel(l.capturedByRole) : "—";
}

/**
 * The one line that identifies a load.
 *
 * Reference → material → vehicle → who received it → when. The last part now
 * carries the TIME as well as the day: the date alone could not separate two
 * loads booked off the same vehicle for the same material on the same shift.
 * It is the load's own saved `createdAt`, the same value Recent Load Details
 * shows on Inward.
 */
function lotLabel(l: Lot): string {
  return `${l.loadRef} / ${l.materialLabel} / ${l.vehicleNumber} / ${enteredBy(l)} / ${loadRefDateTime(l.createdAt)}`;
}

/**
 * Everything about a load that is worth typing at the selector.
 *
 * The label plus the vendor, which the label has no room for but which is the
 * first thing an operator remembers about a delivery. Built from the SAME
 * `lotLabel` the option renders, so nothing can be searchable that is not
 * visible and nothing visible can fail to match — one string, one source.
 */
function lotHaystack(l: Lot): string {
  return `${lotLabel(l)} / ${l.vendorName} / ${l.lotNumber}`.toLowerCase();
}

/**
 * Matches when EVERY whitespace-separated token appears somewhere in the load.
 *
 * Token-wise rather than as one substring, so "mixed 7146" finds the load that
 * a single `includes()` would miss — the operator recalls two fragments from
 * different columns, not the label verbatim, and the order they say them in is
 * not the order the label happens to use.
 */
function lotMatches(l: Lot, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = lotHaystack(l);
  return tokens.every((t) => hay.includes(t));
}

/**
 * The load selector.
 *
 * This was a native `<select>`, and a native select's popup is drawn by the
 * BROWSER, outside the document. Its width is set by the longest `<option>` and
 * no stylesheet can reach it — which is why a load line like
 * "TY1-0005 / PET Mixed / TN74AR7146 / Testing Yard Supervisor / 24 Aug 2026"
 * pushed the menu off the right edge of a 390px screen, and why no amount of
 * CSS on the `<option>` could wrap it: option text cannot wrap, ever.
 *
 * So the list is rendered IN the page instead, where it can be bounded. The
 * closed control keeps the exact `.field select` treatment it always had — same
 * panel, border, radius, padding, font and focus colour — and the menu is pinned
 * to that control's own left and right edges, so it is physically incapable of
 * being wider than the field. Every option still carries all five parts of the
 * label; they wrap instead of widening.
 *
 * ── One control, not two ─────────────────────────────────────────────────────
 * The field IS the search box. It holds a real `<input>` at all times rather
 * than a button that swaps itself for one, because a control that becomes an
 * input on tap cannot open a phone keyboard: the browser decides that at focus
 * time, and by then the element the finger landed on is gone. Always-an-input
 * means one tap focuses it, raises the keyboard and opens the list together —
 * no second tap and no separate search button.
 *
 * Closed, the input carries the selected load's label so the field reads as a
 * value. Focused, it swaps to the query and prompts for one; typing filters.
 * Blur restores the label. `value` remains the only selection state — the query
 * is scratch, and abandoning a search cannot change what is selected.
 */
function LoadSelect({
  lots,
  value,
  onChange,
}: {
  lots: Lot[];
  /** `null` until the operator picks one — nothing is selected on arrival. */
  value: string | null;
  onChange: (lotKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = lots.find((l) => l.lotKey === value) ?? null;
  const matches = query.trim() ? lots.filter((l) => lotMatches(l, query)) : lots;

  /** Leaves search mode without touching the selection. */
  function close() {
    setOpen(false);
    setQuery("");
  }

  function choose(lotKey: string) {
    onChange(lotKey);
    close();
    // Give the field back its own focus ring rather than leaving it on a list
    // row that no longer exists.
    inputRef.current?.blur();
  }

  // Close on an outside tap or Escape — what a native select does for free.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        inputRef.current?.blur();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /**
   * On a phone the keyboard covers the lower half of the screen the moment this
   * opens, and the menu hangs BELOW the field — so a field sitting mid-screen
   * puts its own list under the keyboard. Bringing the field up first is what
   * keeps the list in the part of the viewport that is still visible.
   */
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => wrapRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 60);
    return () => clearTimeout(t);
  }, [open]);

  return (
    <div className="selectWrap" ref={wrapRef}>
      {/* The `.selectCtl` shell is unchanged — same panel, border, radius,
          padding, font and focus colour. Only what sits inside it went from a
          span to an input. */}
      <div
        className={`selectCtl${open ? " searching" : ""}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="loadSelectMenu"
        onClick={() => inputRef.current?.focus()}
      >
        <input
          ref={inputRef}
          type="text"
          className={`selectCtlVal${!open && !selected ? " placeholder" : ""}`}
          aria-label="Select load — type to search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          // Focused: the query and a prompt for one. Idle: the chosen load.
          value={open ? query : selected ? lotLabel(selected) : ""}
          placeholder={open ? "Type to search loads…" : "Click here to select load"}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            // Typing without opening first still searches — the field never
            // needs to be "activated" before it will accept a query.
            setOpen(true);
            setQuery(e.target.value);
          }}
          onKeyDown={(e) => {
            // Enter takes the single obvious answer, which is what a search
            // narrowed to one row means. Never guesses between several.
            if (e.key === "Enter" && matches.length > 0) {
              e.preventDefault();
              choose(matches[0].lotKey);
            }
          }}
        />
        <span className="selectCaret" aria-hidden>
          ▾
        </span>
      </div>

      {open && (
        <ul className="selectMenu" id="loadSelectMenu" role="listbox" aria-label="Select load">
          {matches.map((l) => (
            <li
              key={l.lotKey}
              role="option"
              aria-selected={l.lotKey === value}
              className={`selectOpt${l.lotKey === value ? " on" : ""}`}
              // `pointerdown`, not click: the input's blur would otherwise tear
              // the row out from under the finger before the click landed.
              onPointerDown={(e) => {
                e.preventDefault();
                choose(l.lotKey);
              }}
            >
              {lotLabel(l)}
            </li>
          ))}
          {matches.length === 0 && (
            <li className="selectOpt selectNone" aria-disabled>
              No load matches “{query.trim()}”
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Compact per-row unit selector. Same shared UNITS table everywhere. */
function UnitSelect({
  value,
  onChange,
  label,
  variant = "row",
}: {
  value: UnitCode;
  onChange: (u: UnitCode) => void;
  label: string;
  /**
   * `summary` governs the lot total and "Unsorted left"; `row` governs one
   * material. They were rendered identically, which made them
   * indistinguishable — to automation and, more importantly, to an operator
   * scanning the screen for the control that moves the number they are looking
   * at. The class is what makes each one addressable.
   */
  variant?: "row" | "summary";
}) {
  return (
    <select
      className={`unitSel ${variant === "summary" ? "summaryUnit" : "rowUnit"}`}
      value={value}
      onChange={(e) => onChange(e.target.value as UnitCode)}
      aria-label={label}
    >
      {UNITS.map((u) => (
        <option key={u.code} value={u.code}>
          {u.label}
        </option>
      ))}
    </select>
  );
}

/**
 * How much one tap moves, expressed in the selected unit.
 *
 * Sort uses steppers rather than a keypad, so the unit has to change the step as
 * well as the display — nudging a 20-tonne lot by 50 kg at a time would be
 * unusable. The resulting delta is converted to kilograms before it touches
 * state, so allocations stay integer kilograms exactly as before.
 */
const STEP_IN_UNIT: Record<UnitCode, { alloc: number; waste: number }> = {
  KG: { alloc: 50, waste: 10 },
  TON: { alloc: 0.5, waste: 0.1 },
  TONNE: { alloc: 0.5, waste: 0.1 },
};

/**
 * The allocation value, editable in place.
 *
 * Keeps the `splitVal` class so the existing layout and the suites that address
 * it are unaffected — this replaces a read-only <div> with an <input> carrying
 * the same class, not a new control in a new place.
 *
 * `inputMode="decimal"` is what opens the numeric keyboard on the phones this is
 * used on. Committing happens on blur and on Enter, never per keystroke, so a
 * half-typed "0." is not treated as a value.
 */
function ValueCell({
  rowId,
  display,
  draft,
  onDraft,
  onCommit,
  label,
}: {
  rowId: string;
  display: string;
  draft: string | undefined;
  onDraft: (rowId: string, v: string) => void;
  onCommit: (rowId: string, v: string) => void;
  label: string;
}) {
  return (
    <input
      className="splitVal"
      type="text"
      inputMode="decimal"
      aria-label={label}
      value={draft ?? display}
      onFocus={(e) => {
        onDraft(rowId, display);
        // Select all, so typing replaces rather than appends to the current value.
        e.currentTarget.select();
      }}
      onChange={(e) => onDraft(rowId, e.target.value)}
      onBlur={(e) => onCommit(rowId, e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export default function SortPage() {
  const { toast, party, bump } = useUI();
  const invalidateChannels = useInvalidateChannels();
  const { data: session } = useSession();
  /**
   * Who may edit the sort tree, read from the one permission matrix rather than
   * re-listed here — that is what keeps the button and the API guard from
   * drifting apart. Every in-yard role now qualifies: the Manager runs the
   * segregation, so the Manager maintains its categories too.
   * The API enforces this independently; hiding the button is not the guard.
   */
  const role = session?.user?.role;
  const canManageSortTypes = !!role && can(role, "sortType.write");
  const [sortTypesOpen, setSortTypesOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["sortPending"],
    queryFn: () => getJson<{ lots: Lot[] }>("/api/sort/pending"),
  });

  const lots = data?.lots ?? [];
  const [selectedLotKey, setSelectedLotKey] = useState<string | null>(null);
  /**
   * NOTHING is selected until the operator selects it.
   *
   * This used to fall back to a lot of its own choosing — first `lots[0]`, then
   * the most recent — so the screen always opened on some load and a segregation
   * run could be started against one nobody had picked. Guessing wrong is worse
   * than not guessing: the allocations, the wastage and the ledger entry all
   * belong to whichever lot happened to be underneath.
   *
   * So the selector opens empty and the operator names the load. `null` here
   * means "not chosen yet", which is a different screen from "no lots waiting"
   * — see the two branches below.
   */
  const lot = lots.find((l) => l.lotKey === selectedLotKey) ?? null;
  const [alloc, setAlloc] = useState<Record<string, number>>({});
  const [waste, setWaste] = useState(0);
  const [saving, setSaving] = useState(false);
  const [activeLotId, setActiveLotId] = useState<string | null>(null);
  /**
   * Display/entry unit, PER ROW.
   *
   * One shared unit forced the whole run into a single scale, which does not
   * match how a lot is actually sorted: the bulk grades come off in tonnes while
   * the last high-value grade and the wastage are weighed in kilograms. Keyed by
   * SKU id, with `"__waste"` for the wastage row.
   *
   * `alloc` and `waste` remain ALWAYS kilograms — changing a unit re-renders the
   * same numbers, it never rewrites state, so no unit change can alter what is
   * written to the ledger. That property is what keeps the totals correct no
   * matter how many different units are in play at once.
   */
  const WASTE_ROW = "__waste";
  const [units, setUnits] = useState<Record<string, UnitCode>>({});
  /**
   * In-progress text for a row being typed into, keyed by row id.
   *
   * Needed because "0." and "" are not numbers but are valid things to have typed
   * halfway through entering 0.5 — committing on every keystroke would rewrite the
   * field under the operator's fingers. The draft lives only while the field is
   * focused; state stays kilograms.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const unitOf = (rowId: string): UnitCode => units[rowId] ?? "KG";
  const setUnitOf = (rowId: string, u: UnitCode) => setUnits((prev) => ({ ...prev, [rowId]: u }));

  // Reset allocations when the active lot changes. No pinning is needed now
  // that `lot` IS the explicit selection — a load saved by someone else mid-run
  // can no longer slide underneath an operator part-way through allocating.
  useEffect(() => {
    if (lot && lot.lotKey !== activeLotId) {
      setActiveLotId(lot.lotKey);
      setAlloc(Object.fromEntries(lot.targets.map((t) => [t.skuId, 0])));
      setWaste(0);
      setUnits({});
      setDrafts({});
    }
  }, [lot, activeLotId]);

  if (isLoading) {
    return (
      <>
        <div className="secTitle">Segregation Run</div>
        <div className="skel" style={{ height: 90, marginBottom: 12 }} />
        <div className="skel" style={{ height: 54, marginBottom: 8 }} />
        <div className="skel" style={{ height: 54, marginBottom: 8 }} />
      </>
    );
  }

  /**
   * Lots ARE waiting, but the operator has not named one yet.
   *
   * The selector is the whole screen at this point, in the same `.field` shell
   * it occupies once a load is chosen, so choosing one changes what is below it
   * and not where the control sits.
   */
  if (!lot && lots.length > 0) {
    return (
      <>
        <div className="secTitle">Segregation Run</div>
        <div className="field">
          <label>Select load</label>
          <LoadSelect lots={lots} value={null} onChange={setSelectedLotKey} />
        </div>
        <div className="lot">
          <h3>No load selected</h3>
          <div className="big" style={{ fontSize: 18 }}>
            {lots.length} waiting
          </div>
          <small style={{ fontFamily: "var(--mono)", color: "var(--muted)" }}>
            Tap the field above and choose the load you are about to sort.
          </small>
        </div>
        {canManageSortTypes && (
          <>
            <div className="chip manageChip" onClick={() => setSortTypesOpen(true)}>
              ⚙ Manage Sort Types
            </div>
            <SortTypeSheet open={sortTypesOpen} onClose={() => setSortTypesOpen(false)} />
          </>
        )}
      </>
    );
  }

  if (!lot) {
    return (
      <>
        <div className="secTitle">Segregation Run</div>
        <div className="lot">
          <h3>No mixed lots waiting</h3>
          <div className="big" style={{ fontSize: 18 }}>All sorted 🎉</div>
          <small style={{ fontFamily: "var(--mono)", color: "var(--muted)" }}>
            Save a Mixed load in Inward to start a segregation run.
          </small>
        </div>
        {/* Reachable with no lots waiting: an Owner configures the sort tree
            before the first mixed load arrives, not after. */}
        {canManageSortTypes && (
          <>
            <div className="chip manageChip" onClick={() => setSortTypesOpen(true)}>
              ⚙ Manage Sort Types
            </div>
            <SortTypeSheet open={sortTypesOpen} onClose={() => setSortTypesOpen(false)} />
          </>
        )}
      </>
    );
  }

  const used = Object.values(alloc).reduce((a, b) => a + b, 0) + waste;
  const left = lot.totalKg - used;

  /** One tap for a row, in kilograms. Never zero, or a tap would silently do nothing. */
  const allocStepKgFor = (rowId: string) =>
    Math.max(1, toKilograms(STEP_IN_UNIT[unitOf(rowId)].alloc, unitOf(rowId)));
  const wasteStepKg = Math.max(1, toKilograms(STEP_IN_UNIT[unitOf(WASTE_ROW)].waste, unitOf(WASTE_ROW)));

  /**
   * Renders a kilogram value in a given row's unit. Kilograms print whole; a
   * fraction of a tonne needs decimals, and 907 kg really is 0.907 TONNE —
   * rounding that to 1 would misreport the lot.
   */
  const showIn = (kilos: number, u: UnitCode) =>
    u === "KG" ? fmt(kilos) : Number(fromKilograms(kilos, u).toFixed(3)).toLocaleString("en-IN");
  const suffixOf = (u: UnitCode) => (u === "KG" ? "kg" : u.toLowerCase());

  /**
   * Totals — lot size, unsorted-left, the finish warning — render in KILOGRAMS.
   *
   * They used to follow a separate "Totals in" selector, which was a second
   * control doing what the per-row selectors already do and was the most common
   * thing to mistake for a row's own unit. Kilograms is the ledger unit, so the
   * total now always reads in the same scale the data is stored in, whatever mix
   * of units the rows are being entered in. Nothing about the arithmetic changed:
   * `alloc`/`waste`/`left` were always kilograms.
   */
  const TOTALS_UNIT: UnitCode = "KG";
  const show = (kilos: number) => showIn(kilos, TOTALS_UNIT);
  const suffix = suffixOf(TOTALS_UNIT);

  function step(skuId: string, delta: number) {
    if (delta > 0 && used + delta > lot!.totalKg) {
      toast("Nothing left to allocate");
      return;
    }
    setAlloc((a) => ({ ...a, [skuId]: Math.max(0, (a[skuId] ?? 0) + delta) }));
  }
  function stepWaste(delta: number) {
    if (delta > 0 && used + delta > lot!.totalKg) {
      toast("Nothing left to allocate");
      return;
    }
    setWaste((w) => Math.max(0, w + delta));
  }

  /**
   * Typed entry, routed through the SAME guard as the steppers.
   *
   * A stepper is fine for nudging and miserable for "put 8.5 tonnes here" — that
   * is 17 taps. Tapping the value now opens the keyboard instead.
   *
   * Both paths converge on `setRowKg`, so there is exactly one place that decides
   * what is allowed: non-negative, and never more than the lot has left. The
   * typed value is converted with the row's own unit via the shared `toKilograms`
   * (which rounds once, on the product) so 8.5 TON becomes the same integer
   * kilograms a stepper would have produced.
   */
  function setRowKg(rowId: string, nextKg: number) {
    const clamped = Math.max(0, Math.round(nextKg));
    const currentKg = rowId === WASTE_ROW ? waste : (alloc[rowId] ?? 0);
    // `used` already includes this row, so remove it before testing the lot cap.
    if (used - currentKg + clamped > lot!.totalKg) {
      toast("Nothing left to allocate");
      return;
    }
    if (rowId === WASTE_ROW) setWaste(clamped);
    else setAlloc((a) => ({ ...a, [rowId]: clamped }));
  }

  /**
   * Commits a typed string. Blank or unparseable means zero rather than NaN —
   * clearing the field to start again must not poison the total.
   */
  function commitDraft(rowId: string, raw: string) {
    const n = Number.parseFloat(raw.replace(/,/g, ""));
    setRowKg(rowId, Number.isFinite(n) ? toKilograms(n, unitOf(rowId)) : 0);
    setDrafts((d) => {
      const next = { ...d };
      delete next[rowId];
      return next;
    });
  }

  /**
   * Completing no longer requires the lot to be fully segregated.
   *
   * Whatever is left stays in the mixed bucket, attributed to this load, and
   * comes back up in the queue as an unsorted balance — so an operator can book
   * the grades they finished today instead of holding the run open. The only
   * floor is that SOMETHING was allocated.
   */
  async function finish() {
    if (used <= 0) {
      toast("Allocate some weight first");
      return;
    }
    setSaving(true);
    try {
      const res = await sendJson<{ lotNumber: string; wastagePct: number; remainingKg: number }>("/api/sort/complete", {
        loadId: lot!.loadId,
        lineId: lot!.lineId,
        wastageKg: waste,
        allocations: lot!.targets.map((t) => ({ skuId: t.skuId, kg: alloc[t.skuId] ?? 0 })),
      });
      // Matches what /api/sort/complete publishes. The old hand-list missed
      // `sales`, `outwardQueue` and `dispatchStatus`, which a completed sort moves.
      invalidateChannels("sort", "stock", "sales");
      setActiveLotId(null);
      await bump(120);
      party(
        "🎉",
        res.remainingKg > 0 ? "SORT SAVED!" : "SORT COMPLETE!",
        res.remainingKg > 0
          ? `Lot ${res.lotNumber} · ${show(res.remainingKg)} ${suffix} kept as unsorted balance`
          : `Lot ${res.lotNumber} · wastage ${res.wastagePct}%`,
        "+120 XP"
      );
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not complete sort");
    } finally {
      setSaving(false);
    }
  }

  const when = new Date(lot.createdAt).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <>
      <div className="secTitle">Segregation Run</div>

      {/*
        The load, identified by what actually distinguishes it.

        "Walk-in — TN99X4429 — Mixed MS" could name two different loads on the
        same day, in the same yard, and said nothing at all across yards. The
        reference leads instead, and the material, vehicle, receiver and date
        follow it — enough to recognise a load without opening it.
      */}
      <div className="field">
        <label>Select load</label>
        <LoadSelect lots={lots} value={lot.lotKey} onChange={setSelectedLotKey} />
      </div>

      <div className="lot">
        <h3>
          {lot.materialLabel} · {lot.loadRef}
        </h3>
        <div className="big">
          {show(lot.totalKg)} {suffix}
        </div>
        {(lot.sortedKg ?? 0) > 0 && (
          <small style={{ fontFamily: "var(--mono)", color: "var(--orange)", display: "block", marginBottom: 4 }}>
            Unsorted balance · {show(lot.receivedKg ?? lot.totalKg)} {suffix} received, {show(lot.sortedKg ?? 0)}{" "}
            {suffix} already sorted
          </small>
        )}
        <small style={{ fontFamily: "var(--mono)", color: "var(--muted)", display: "block" }}>
          {lot.vendorName} · 🚚 {lot.vehicleNumber} · {when}
        </small>
        {/* Both the person and the role here, where there is room for them —
            the selector above only has space for one. */}
        <small style={{ fontFamily: "var(--mono)", color: "var(--muted)" }}>
          Lot #{lot.lotNumber} · entered by {enteredBy(lot)}
          {lot.capturedByName && lot.capturedByRole ? ` · ${roleLabel(lot.capturedByRole)}` : ""}
        </small>
      </div>

      {lot.sortable ? (
        <>
          {lot.targets.map((t) => {
            const u = unitOf(t.skuId);
            const stepKg = allocStepKgFor(t.skuId);
            return (
              <div key={t.skuId} className="splitRow">
                <span>{t.name}</span>
                <button className="step" onClick={() => step(t.skuId, -stepKg)}>−</button>
                <ValueCell
                  rowId={t.skuId}
                  display={showIn(alloc[t.skuId] ?? 0, u)}
                  draft={drafts[t.skuId]}
                  onDraft={(id, v) => setDrafts((d) => ({ ...d, [id]: v }))}
                  onCommit={commitDraft}
                  label={`${t.name} weight`}
                />
                <UnitSelect value={u} onChange={(nu) => setUnitOf(t.skuId, nu)} label={`${t.name} weight unit`} />
                <button className="step" onClick={() => step(t.skuId, stepKg)}>+</button>
              </div>
            );
          })}

          <div className="splitRow waste">
            <span>Wastage</span>
            <button className="step" onClick={() => stepWaste(-wasteStepKg)}>−</button>
            <ValueCell
              rowId={WASTE_ROW}
              display={showIn(waste, unitOf(WASTE_ROW))}
              draft={drafts[WASTE_ROW]}
              onDraft={(id, v) => setDrafts((d) => ({ ...d, [id]: v }))}
              onCommit={commitDraft}
              label="Wastage weight"
            />
            <UnitSelect
              value={unitOf(WASTE_ROW)}
              onChange={(nu) => setUnitOf(WASTE_ROW, nu)}
              label="Wastage weight unit"
            />
            <button className="step" onClick={() => stepWaste(wasteStepKg)}>+</button>
          </div>

          <div className="remain">
            Unsorted left: {show(left)} {suffix}
            {left > 0 && used > 0 && (
              <em className="remainNote">kept as unsorted balance · sortable later</em>
            )}
          </div>

          <button className="cta" disabled={saving || used <= 0} onClick={finish}>
            {saving ? "SAVING…" : "COMPLETE SORT · +120 XP"}
          </button>
        </>
      ) : (
        <div className="splitRow" style={{ display: "block" }}>
          <span style={{ color: "var(--muted)", fontFamily: "var(--mono)", fontSize: 12 }}>
            No segregation categories configured for {lot.materialLabel} yet. This lot is logged and traceable;
            configure sort types to sort it.
          </span>
        </div>
      )}

      {canManageSortTypes && (
        <>
          <div className="chip manageChip" onClick={() => setSortTypesOpen(true)}>
            ⚙ Manage Sort Types
          </div>
          <SortTypeSheet open={sortTypesOpen} onClose={() => setSortTypesOpen(false)} />
        </>
      )}
    </>
  );
}
