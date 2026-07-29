"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { getJson, sendJson, ApiError } from "@/lib/fetcher";
import { useInvalidateChannels } from "@/components/realtime/provider";
import { fmt } from "@/lib/format";
import { UNITS, fromKilograms, toKilograms, type UnitCode } from "@/lib/units";
import { useUI } from "@/components/ui-provider";
import { SortTypeSheet } from "@/components/sort-type-sheet";

type Lot = {
  /** Row identity. A multi-material load contributes several rows sharing one
   *  loadId, so selection must key on this rather than on the load. */
  lotKey: string;
  loadId: string;
  lineId: string | null;
  lotNumber: string;
  materialLabel: string;
  totalKg: number;
  vendorName: string;
  vehicleNumber: string;
  createdAt: string;
  sourceSkuId: string | null;
  targets: { skuId: string; name: string }[];
  sortable: boolean;
};

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
   * Only these roles may edit the sort tree. A Manager still reads it — the
   * target rows below come from the same tree — but is not offered the sheet.
   * The API enforces this independently; hiding the button is not the guard.
   */
  const canManageSortTypes = session?.user?.role === "OWNER" || session?.user?.role === "ADMIN";
  const [sortTypesOpen, setSortTypesOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["sortPending"],
    queryFn: () => getJson<{ lots: Lot[] }>("/api/sort/pending"),
  });

  const lots = data?.lots ?? [];
  const [selectedLotKey, setSelectedLotKey] = useState<string | null>(null);
  const lot = lots.find((l) => l.lotKey === selectedLotKey) ?? lots[0] ?? null;
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

  // Reset allocations when the active lot changes.
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

  async function finish() {
    if (left > 0) {
      // A coarse unit cannot always land exactly on zero; KG stays available for
      // the last few kilograms, which is why it is the default.
      toast(`⚠ ${show(left)} ${suffix} still unsorted`);
      return;
    }
    setSaving(true);
    try {
      const res = await sendJson<{ lotNumber: string; wastagePct: number }>("/api/sort/complete", {
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
      party("🎉", "SORT COMPLETE!", `Lot ${res.lotNumber} · wastage ${res.wastagePct}%`, "+120 XP");
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

      <div className="field">
        <label>Select vendor lot / vehicle</label>
        <select value={lot.lotKey} onChange={(e) => setSelectedLotKey(e.target.value)}>
          {lots.map((l) => (
            <option key={l.lotKey} value={l.lotKey}>
              {l.vendorName} — {l.vehicleNumber} — {l.materialLabel} — {show(l.totalKg)} {suffix}
            </option>
          ))}
        </select>
      </div>

      <div className="lot">
        <h3>
          {lot.materialLabel} · Lot #{lot.lotNumber}
        </h3>
        <div className="big">
          {show(lot.totalKg)} {suffix}
        </div>
        <small style={{ fontFamily: "var(--mono)", color: "var(--muted)" }}>
          {lot.vendorName} · 🚚 {lot.vehicleNumber} · {when}
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
          </div>

          <button className="cta" disabled={saving || left !== 0} onClick={finish}>
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
