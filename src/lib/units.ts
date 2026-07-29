/**
 * Weight units for the capture keypads.
 *
 * ── The one rule ──────────────────────────────────────────────────────────────
 * Every quantity in the database is kilograms. A unit column on a ledger table
 * would make every historical row ambiguous — you could never again read a
 * weight without also trusting whatever the unit column happened to say at write
 * time. So the unit lives in the UI layer only, and is converted the moment a
 * reading leaves the keypad. Nothing downstream of `toKilograms` knows units
 * exist.
 *
 * Inward, Outward and Sort all import from here so a new unit is added once.
 */

export const UNITS = [
  { code: "KG", label: "KG", toKg: 1 },
  /**
   * US short ton. The factor is the EXACT 907.18474 kg, not a pre-rounded 907.
   *
   * Rounding the constant instead of the result lost 0.18 kg per ton, and the
   * error scaled with the reading: a 12-ton load recorded 10,884 kg instead of
   * 10,886 kg. Single-ton entries are unaffected (both round to 907), which is
   * why it survived — the drift only shows on the large loads that matter most.
   * Rounding happens once, in `toKilograms`, on the product.
   */
  { code: "TON", label: "TON", toKg: 907.18474 },
  { code: "TONNE", label: "TONNE", toKg: 1000 }, // metric tonne
] as const;

export type UnitCode = (typeof UNITS)[number]["code"];

/** Converts a keypad reading to whole kilograms. Rounds — stock is integer kg. */
export function toKilograms(value: number, unit: UnitCode): number {
  const u = UNITS.find((x) => x.code === unit) ?? UNITS[0];
  return Math.round(value * u.toKg);
}

/**
 * The inverse, for pre-filling a keypad from a stored kilogram value.
 *
 * Deliberately NOT rounded: 500 kg is 0.5 TONNE, and rounding that to 1 would
 * misreport stock. Callers format for display; the kilogram value stays canonical.
 */
export function fromKilograms(kg: number, unit: UnitCode): number {
  const u = UNITS.find((x) => x.code === unit) ?? UNITS[0];
  return kg / u.toKg;
}
