"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fmt, fmtInr } from "@/shared/format";
import { UNITS, toKilograms, type UnitCode } from "@/shared/units";
import { useUI } from "@/frontend/components/ui-provider";
import { PhonePortal } from "@/frontend/components/phone-portal";

/**
 * Material → Weight → Rate → Cart.
 *
 * THE material-entry implementation for the whole application. It was Inward's,
 * inline in that page; Outward's dispatch workflow needs the same three-cell
 * row, the same LED keypad, the same pending card and the same cart, so it was
 * lifted here rather than copied. Inward renders it and so does Dispatch —
 * there is one calculator, one cart and one set of rules in the codebase.
 *
 * What differs between the two callers is expressed as props, not as a fork:
 *
 *  • `gate` — Inward requires the material's photographs before a weight is
 *    accepted; Outward does not. The caller supplies the check and the recovery
 *    action, so the gate lives with the workflow that owns it rather than being
 *    a flag this component has to know the meaning of.
 *  • `cart` / `onCartChange` — the cart is CONTROLLED. Inward keeps it until
 *    SAVE LOAD; Dispatch loads it back from the server when a half-finished
 *    dispatch is reopened. Owning it here would make the second impossible.
 */

/** One committed cart line: a material, its weight in kilograms, and its rate. */
export type CartItem = {
  key: string;
  skuId: string;
  label: string;
  kg: number;
  unit: UnitCode;
  ratePerKg: number;
};

/**
 * One bookable material.
 *
 * Everything past `name` is the hierarchy `/api/materials` now returns, and all
 * of it is optional: a caller that has only id+name still renders correctly as
 * one flat "All materials" group.
 */
export type MaterialOption = {
  id: string;
  name: string;
  icon?: string | null;
  /** The main category this hangs off — what the picker groups and searches on. */
  materialId?: string | null;
  materialName?: string | null;
  /** MIXED → the load goes to Sort. DIRECT → straight to this sub-material. */
  isMixedBucket?: boolean;
};

/**
 * How many sub-materials the picker shows before "View All".
 *
 * Mixed buckets are ALWAYS all shown — a yard has a handful of them and they
 * are the top of the tree. It is the finished grades that grow without limit,
 * so they are the ones behind the fold.
 */
const VISIBLE_SUBS = 4;

/** Everything typed in the picker's search box is matched against this. */
function materialHaystack(m: MaterialOption): string {
  return [m.name, m.materialName].filter(Boolean).join(" ").toLowerCase();
}

function matchesMaterial(m: MaterialOption, q: string): boolean {
  const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = materialHaystack(m);
  return tokens.every((t) => hay.includes(t));
}

/** Largest rate the API will accept; mirrored here so the field cannot exceed it. */
export const MAX_RATE = 1_000_000;

/**
 * Reads a typed rate. Blank, malformed or negative all mean zero rather than
 * NaN — clearing the field to start again must not poison the cart total.
 */
export function parseRate(raw: string): number {
  const n = Number.parseFloat(raw.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(MAX_RATE, Math.round(n * 100) / 100);
}

/**
 * What a caller may interpose between "weight entered" and "weight accepted".
 *
 * `blocked` is asked for the material being weighed. When it answers true the
 * reading is parked and `onBlocked` runs; the caller calls `release()` once its
 * requirement is met, and the parked weight flows through as if nothing had
 * happened. That is what lets Inward open its Material Images sheet from ADD TO
 * LOAD without this component knowing anything about photographs.
 */
export type EntryGate = {
  blocked: (skuId: string) => boolean;
  onBlocked: (skuId: string) => void;
  /** Shown in the calculator's tip when `blocked` refuses. */
  message: string;
};

export type MaterialEntryHandle = {
  /** Lets the parked weight through after the caller satisfied its gate. */
  release: () => void;
  /** Clears a parked weight when the caller's gate was abandoned. */
  discard: () => void;
  /**
   * Returns the control to its resting state — no pending weight, no rate, a
   * blank display. For a caller that has just committed the cart to the server
   * and is starting the next one; the CART itself is the caller's to clear,
   * since the caller owns it.
   */
  reset: () => void;
};

/**
 * Select Material — search, browse, or open everything.
 *
 * The old picker was one flat list of mixed buckets. It now has to carry the
 * whole tree (every category's bucket AND its finished grades), which a flat
 * list cannot do legibly on a 390px phone: the two kinds route the load to
 * completely different workflows, and a scrolling wall of names hides that.
 *
 * So: one search box, mixed buckets first, a few common sub-materials, and the
 * rest behind View All. Nothing is removed — everything is reachable in at most
 * one extra tap, and searching reaches any of it directly.
 *
 * It is the SAME sheet, `.pickList` and `.pickRow` the picker already used;
 * what is new is the grouping, the search and the fold.
 */
function MaterialPicker({
  materials,
  activeMaterialId,
  onPick,
  onClose,
  onAddMaterial,
  onDeleteMaterial,
}: {
  materials: MaterialOption[];
  activeMaterialId: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
  onAddMaterial?: () => void;
  onDeleteMaterial?: (m: MaterialOption) => void;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const searching = query.trim().length > 0;

  const matched = searching ? materials.filter((m) => matchesMaterial(m, query)) : materials;
  const mixed = matched.filter((m) => m.isMixedBucket);
  const subs = matched.filter((m) => !m.isMixedBucket);

  // Searching always shows every hit — a fold that hid the thing just typed
  // would make the search box a liar.
  const expanded = showAll || searching;
  const shownSubs = expanded ? subs : subs.slice(0, VISIBLE_SUBS);
  const hiddenCount = subs.length - shownSubs.length;

  /**
   * Sub-materials grouped under their main category, so the hierarchy is
   * visible without drawing a tree. Categories keep the order the API sent,
   * which is the yard's own `sortOrder`.
   */
  const groups: { key: string; label: string; items: MaterialOption[] }[] = [];
  for (const m of shownSubs) {
    const key = m.materialId ?? "__none";
    const label = m.materialName ?? "Other materials";
    const existing = groups.find((g) => g.key === key);
    if (existing) existing.items.push(m);
    else groups.push({ key, label, items: [m] });
  }

  const row = (m: MaterialOption) => (
    <div
      key={m.id}
      role="option"
      aria-selected={activeMaterialId === m.id}
      className={`pickRow${activeMaterialId === m.id ? " on" : ""}`}
      onClick={() => onPick(m.id)}
    >
      <span className="pickName">
        {m.icon ? <span className="pickIcon">{m.icon}</span> : null}
        <span className="pickLbl">{m.name}</span>
        {/* Says which workflow this choice starts. The whole point of the
            distinction, so it is on the row rather than in a legend. */}
        {m.isMixedBucket ? (
          <em className="pickTag mixed">Sort</em>
        ) : (
          <em className="pickTag direct">Direct</em>
        )}
      </span>
      {activeMaterialId === m.id && <b className="pickTick">✓</b>}
      {onDeleteMaterial && (
        <button
          className="pickX"
          title="Deactivate"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteMaterial(m);
          }}
        >
          ✕
        </button>
      )}
    </div>
  );

  return (
    <PhonePortal>
      <div className="sheetWrap" onClick={onClose}>
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <div className="sheetHandle" />
          <div className="sheetTitle">Select Material</div>
          <div className="sheetStep">The material this entry is booked against</div>

          <div className="field">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search materials…"
              aria-label="Search materials"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>

          <div className="pickList" role="listbox" aria-label="Materials">
            {mixed.length > 0 && (
              <>
                <div className="pickGroup">Mixed materials · go to Sort</div>
                {mixed.map(row)}
              </>
            )}

            {groups.map((g) => (
              <div key={g.key}>
                <div className="pickGroup">{g.label}</div>
                {g.items.map(row)}
              </div>
            ))}

            {matched.length === 0 && (
              <p className="hint">
                {searching ? `No material matches “${query.trim()}”` : "Nothing here yet."}
              </p>
            )}
          </div>

          {!searching && (hiddenCount > 0 || showAll) && (
            <button className="cta ghost pickMore" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show less ▴" : `View All (${hiddenCount} more) ▾`}
            </button>
          )}

          {onAddMaterial && (
            <button className="cta ghost" onClick={onAddMaterial}>
              + Add Material
            </button>
          )}
          <button className="cta ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </PhonePortal>
  );
}

export function MaterialEntry({
  materials,
  cart,
  onCartChange,
  activeMaterialId,
  onPickMaterial,
  onAddMaterial,
  onDeleteMaterial,
  gate,
  handleRef,
  summaryTitle = "Current Load",
  summarySubtitle = "Materials added to this load",
  totalLabel = "TOTAL LOAD",
  xpPerLine = 5,
}: {
  materials: MaterialOption[];
  cart: CartItem[];
  onCartChange: (next: CartItem[]) => void;
  activeMaterialId: string | null;
  onPickMaterial: (id: string | null) => void;
  /** Rendered inside the picker when the caller allows creating one. */
  onAddMaterial?: () => void;
  /** Deactivation, offered only to callers whose role permits it (Owner). */
  onDeleteMaterial?: (m: MaterialOption) => void;
  gate?: EntryGate;
  handleRef?: React.MutableRefObject<MaterialEntryHandle | null>;
  summaryTitle?: string;
  summarySubtitle?: string;
  totalLabel?: string;
  /** 0 disables the XP bump — the dispatch flow scores on completion instead. */
  xpPerLine?: number;
}) {
  const { toast, bump } = useUI();

  const [led, setLed] = useState("0");
  const [unit, setUnit] = useState<UnitCode>("KG");
  /**
   * The weight confirmed by ADD TO LOAD but not yet committed to the cart.
   * The material, the weight and the rate all stay editable while it sits here;
   * only ADD TO CART turns it into a cart line. Kilograms, like everything
   * downstream of the keypad.
   */
  const [pendingKg, setPendingKg] = useState<number | null>(null);
  const [pendingUnit, setPendingUnit] = useState<UnitCode>("KG");
  const [rate, setRate] = useState("0");
  const [calcOpen, setCalcOpen] = useState(false);
  const [materialPick, setMaterialPick] = useState(false);
  /** A reading held while the caller's gate is satisfied. */
  const [parked, setParked] = useState<{ kg: number; unit: UnitCode } | null>(null);
  /** The calculator's one message slot — see `.captureTip`. */
  const [calcTip, setCalcTip] = useState<string | null>(null);
  const tipTmr = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeMaterial = materials.find((m) => m.id === activeMaterialId) ?? null;
  const total = cart.reduce((a, b) => a + b.kg, 0);
  const cartValue = cart.reduce((a, b) => a + b.kg * b.ratePerKg, 0);

  function showCalcTip(message: string) {
    setCalcTip(message);
    if (tipTmr.current) clearTimeout(tipTmr.current);
    tipTmr.current = setTimeout(() => setCalcTip(null), 3200);
  }

  function num(n: number) {
    setLed((l) => (l.length < 6 ? (l === "0" ? String(n) : l + n) : l));
  }
  function clr() {
    setLed("0");
  }
  function back() {
    setLed((l) => (l.length > 1 ? l.slice(0, -1) : "0"));
  }

  /** Hands a confirmed reading to the entry card and closes the calculator. */
  function acceptWeight(kg: number, entryUnit: UnitCode) {
    setPendingKg(kg);
    setPendingUnit(entryUnit);
    setLed("0");
    setCalcOpen(false);
    toast(`⚖️ ${activeMaterial?.name ?? "Material"} · ${fmt(kg)} kg · set the rate, then ADD TO CART`);
  }

  /**
   * The parked reading, mirrored into a ref.
   *
   * The imperative handle below is published from an EFFECT, not from render —
   * writing `handleRef.current` during render is a side effect, and a render
   * React discards (StrictMode's double render, or any interrupted concurrent
   * render) would leave the caller holding a closure over state that never
   * committed. Concretely: Inward's image gate would call `release()` on a
   * closure whose `parked` was already `null` and silently drop the weight the
   * operator had just entered.
   *
   * Reading the parked value through a ref keeps the handle's identity stable
   * while still seeing the current value, so the effect does not have to
   * re-publish on every keystroke.
   */
  const parkedRef = useRef<{ kg: number; unit: UnitCode } | null>(null);
  useEffect(() => {
    parkedRef.current = parked;
  }, [parked]);

  // `acceptWeight` and `showCalcTip` close over the current material, so they
  // are reached through refs — that is what lets the callbacks below keep a
  // stable identity instead of being rebuilt on every keystroke.
  const acceptWeightRef = useRef(acceptWeight);
  const showCalcTipRef = useRef(showCalcTip);
  useEffect(() => {
    acceptWeightRef.current = acceptWeight;
    showCalcTipRef.current = showCalcTip;
  });

  const release = useCallback(() => {
    const held = parkedRef.current;
    if (!held) return;
    setParked(null);
    setCalcTip(null);
    acceptWeightRef.current(held.kg, held.unit);
  }, []);

  const discard = useCallback(() => {
    if (!parkedRef.current) return;
    setParked(null);
    showCalcTipRef.current(gate?.message ?? "");
  }, [gate?.message]);

  const reset = useCallback(() => {
    setParked(null);
    setPendingKg(null);
    setRate("0");
    setLed("0");
    setCalcTip(null);
    setCalcOpen(false);
  }, []);

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = { release, discard, reset };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, release, discard, reset]);

  /**
   * The material and the reading itself, in the order the operator would fix
   * them. Returns the kilograms, or null after complaining.
   */
  function readyKg(reading: number): number | null {
    if (!activeMaterialId || !activeMaterial) {
      toast("Select a material first");
      return null;
    }
    if (!reading) {
      toast("Enter a weight first");
      return null;
    }
    const kg = toKilograms(reading, unit);
    if (kg <= 0) {
      toast("Weight is too small to record");
      return null;
    }
    return kg;
  }

  /**
   * ADD TO LOAD — hands the reading to the entry card, and stops there.
   * Nothing reaches the cart yet: the rate has not been entered, and the
   * material and weight are both still editable. ADD TO CART is what commits.
   */
  function onAddWt() {
    const kg = readyKg(Number(led));
    if (kg == null) return;
    if (gate && activeMaterialId && gate.blocked(activeMaterialId)) {
      setParked({ kg, unit });
      gate.onBlocked(activeMaterialId);
      return;
    }
    acceptWeight(kg, unit);
  }

  /**
   * ADD TO CART — commits the pending material, weight and rate as one line.
   *
   * Deliberately appended, never merged into a matching line. The same material
   * at two different rates is two transactions, and collapsing them here would
   * destroy the distinction the operator just made.
   */
  function addToCart() {
    if (pendingKg == null) {
      toast("Enter a weight first");
      return;
    }
    // Re-checked, not assumed: the material can be changed while an entry is
    // pending, and the gate has to apply to whatever is actually being added.
    if (!activeMaterialId || !activeMaterial) {
      toast("Select a material first");
      return;
    }
    if (gate && gate.blocked(activeMaterialId)) {
      gate.onBlocked(activeMaterialId);
      return;
    }
    const ratePerKg = parseRate(rate);
    onCartChange([
      ...cart,
      {
        key: `${Date.now()}-${cart.length}`,
        skuId: activeMaterialId,
        label: activeMaterial.name,
        kg: pendingKg,
        unit: pendingUnit,
        ratePerKg,
      },
    ]);
    setPendingKg(null);
    setRate("0");
    toast(
      `🛒 ${activeMaterial.name} · ${fmt(pendingKg)} kg @ ${fmtInr(ratePerKg)}/kg added${xpPerLine ? " · +5 XP" : ""}`
    );
    if (xpPerLine) void bump(xpPerLine);
  }

  return (
    <>
      {/*
        One row, always: Material → Weight → Rate. That order is the order a
        transaction is actually agreed in, so the row reads as the workflow
        rather than as three unrelated buttons.
      */}
      <div className="actRow">
        <button className="actCell" onClick={() => setMaterialPick(true)}>
          <span className="actLbl">Material</span>
          <span className="actInset">
            <b className="actVal">{activeMaterial ? activeMaterial.name : "Select Material"}</b>
          </span>
        </button>

        <div
          className="actCell wt"
          role="button"
          tabIndex={0}
          aria-label="Weight — opens the calculator"
          onClick={() => setCalcOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setCalcOpen(true);
            }
          }}
        >
          <span className="actLbl">Weight</span>
          <span className="actInset">
            <span className={`wtNum${pendingKg ? "" : " empty"}`}>{fmt(pendingKg ?? 0)}</span>
            <span className="wtKg">kg</span>
          </span>
        </div>

        <div className="actCell rate">
          <span className="actLbl">Rate · ₹/kg</span>
          <span className="actInset">
            <span className="rateCur">₹</span>
            <input
              className="rateInput"
              type="text"
              inputMode="decimal"
              aria-label="Rate per kilogram in rupees"
              value={rate}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => {
                const cleaned = e.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
                setRate(cleaned);
              }}
              onBlur={() => setRate(String(parseRate(rate)))}
            />
          </span>
        </div>
      </div>

      {/* The pending entry: everything above it is still editable until this
          is committed. Only shown once a weight has been confirmed. */}
      {pendingKg != null && (
        <div className="pendCard">
          <div className="pendHead">Ready to add</div>
          <div className="pendLine">
            <span>Material</span>
            <b>{activeMaterial ? activeMaterial.name : "Select Material"}</b>
          </div>
          <div className="pendLine">
            <span>Weight</span>
            <b>
              {fmt(pendingKg)} kg
              {pendingUnit !== "KG" && <em className="entryUnit"> · entered in {pendingUnit}</em>}
            </b>
          </div>
          <div className="pendLine">
            <span>Rate</span>
            <b>{fmtInr(parseRate(rate))} / kg</b>
          </div>
          <div className="pendLine">
            <span>Amount</span>
            <b>{fmtInr(pendingKg * parseRate(rate))}</b>
          </div>
          <button className="cta" onClick={addToCart}>
            ADD TO CART
          </button>
          <button className="cta ghost" onClick={() => setPendingKg(null)}>
            Discard entry
          </button>
        </div>
      )}

      {/* Current load. One row per cart line rather than one per material,
          because each row is individually removable and two entries of the same
          material at different rates are two lines, not one. */}
      <div className="loadSummary">
        <div className="loadSummaryTop">
          <div className="loadSummaryHead">{summaryTitle}</div>
          {cart.length > 0 && (
            <span className="loadSummaryCount">
              {cart.length} {cart.length === 1 ? "entry" : "entries"}
            </span>
          )}
        </div>
        <p className="loadSummarySub">{summarySubtitle}</p>
        {cart.length === 0 ? (
          <p className="loadSummaryEmpty">No materials added yet</p>
        ) : (
          <div className="entries">
            {cart.map((item) => (
              <div key={item.key} className="entry cartRow">
                <span className="cartMain">
                  <b className="cartName">{item.label}</b>
                  <span className="cartFigures">
                    <span className="cartMeasure">
                      <b className="cartKg">{fmt(item.kg)} kg</b>
                      <em className="cartRate">@ {fmtInr(item.ratePerKg)}/kg</em>
                    </span>
                    <em className="cartAmt">{fmtInr(item.kg * item.ratePerKg)}</em>
                  </span>
                </span>
                <button
                  className="entryX"
                  aria-label={`Remove ${item.label}`}
                  title="Remove from load"
                  onClick={() => onCartChange(cart.filter((i) => i.key !== item.key))}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="totalRow">
          <span>{totalLabel}</span>
          <b>{fmt(total)} kg</b>
        </div>
        {cartValue > 0 && (
          <div className="totalRow">
            <span>TOTAL VALUE</span>
            <b>{fmtInr(cartValue)}</b>
          </div>
        )}
      </div>

      {/* ---- Calculator overlay ---- */}
      {calcOpen && (
        <PhonePortal>
          <div className="sheetWrap" onClick={() => setCalcOpen(false)}>
            <div className="sheet calcSheet" onClick={(e) => e.stopPropagation()}>
              <div className="sheetHandle" />
              <button
                className="sheetClose"
                aria-label="Close calculator"
                title="Close"
                onClick={() => setCalcOpen(false)}
              >
                ✕
              </button>
              <div className="sheetTitle">Weight Entry</div>
              <div className="sheetStep">
                {activeMaterial ? activeMaterial.name : "No material selected"} · ADD TO LOAD hands this to the entry
                card
              </div>

              <div className="led">
                <div className="val">{fmt(Number(led))}</div>
                <div className="unit">
                  <span>SCALE · MANUAL</span>
                  <select
                    className="unitSel"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value as UnitCode)}
                    aria-label="Weight unit"
                  >
                    {UNITS.map((u) => (
                      <option key={u.code} value={u.code}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {gate && activeMaterialId && gate.blocked(activeMaterialId) && (
                <p className="hint" style={{ marginTop: 10, color: "var(--orange)" }}>
                  📷 ADD TO LOAD will ask for {activeMaterial ? activeMaterial.name : "the material"} images before the
                  weight is accepted.
                </p>
              )}

              <div className="pad">
                <button className="key" onClick={() => num(7)}>7</button>
                <button className="key" onClick={() => num(8)}>8</button>
                <button className="key" onClick={() => num(9)}>9</button>
                <button className="key fn" onClick={clr}>CLR</button>
                <button className="key" onClick={() => num(4)}>4</button>
                <button className="key" onClick={() => num(5)}>5</button>
                <button className="key" onClick={() => num(6)}>6</button>
                <button className="key fn" onClick={back}>⌫</button>
                <button className="key" onClick={() => num(1)}>1</button>
                <button className="key" onClick={() => num(2)}>2</button>
                <button className="key" onClick={() => num(3)}>3</button>
                <button className="key add" onClick={onAddWt}>ADD<br />TO LOAD</button>
                <button className="key zero" onClick={() => num(0)}>0</button>
                {calcTip && (
                  <div className="captureTip" role="status" aria-live="polite">
                    {calcTip}
                  </div>
                )}
              </div>

              <div className="totalRow">
                <span>{totalLabel}</span>
                <b>{fmt(total)} kg</b>
              </div>

              {/* Done finishes the entry; it does not make one. With a reading
                  still on the display it says so and stays open, because the
                  instruction it gives is only actionable while the keypad is up. */}
              <button
                className="cta ghost"
                onClick={() => {
                  if (Number(led) > 0) {
                    showCalcTip("Tap Add to Load to add the weight.");
                    return;
                  }
                  setCalcOpen(false);
                }}
              >
                Done
              </button>
            </div>
          </div>
        </PhonePortal>
      )}

      {materialPick && (
        <MaterialPicker
          materials={materials}
          activeMaterialId={activeMaterialId}
          onPick={(id) => {
            onPickMaterial(id);
            setMaterialPick(false);
          }}
          onClose={() => setMaterialPick(false)}
          onAddMaterial={
            onAddMaterial
              ? () => {
                  setMaterialPick(false);
                  onAddMaterial();
                }
              : undefined
          }
          onDeleteMaterial={onDeleteMaterial}
        />
      )}
    </>
  );
}
