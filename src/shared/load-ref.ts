/**
 * The user-facing reference for an inward load: `TY1-0005`.
 *
 * ── Why this is DERIVED and not a new column ─────────────────────────────────
 * The load already has two identifiers and neither of them needed replacing:
 *
 *   • `InwardLoad.id` — a cuid, globally unique, and the thing every relation in
 *     the schema already points at (lines, weighments, material images,
 *     segregation runs, inventory lots → sales → outward). That is the internal
 *     identity; it is not going to be re-pointed at anything.
 *   • `InwardLoad.lotNumber` — "A-115", handed out by a per-yard atomic counter
 *     (see backend/services/counters.ts) and protected by
 *     `@@unique([yardId, lotNumber])`. Unique WITHIN a yard, never reused.
 *
 * So the only thing actually missing was a reference a person can say out loud
 * that cannot collide between yards. Composing it from what is already stored
 * costs no column to back-fill, no second uniqueness constraint to police, and
 * no identifier that can drift out of step with the row it describes. It also
 * applies retroactively to every load ever saved.
 *
 * ── Why it cannot collide, and cannot be duplicated ──────────────────────────
 *   {yard short code}-{lot sequence}
 *
 * `Yard.shortCode` is `@unique` and assigned once (backend/services/yard-short-code.ts).
 * The sequence comes from an atomic counter increment inside the same
 * transaction that creates the load — never a "read the latest and add one" —
 * with the per-yard unique index as the backstop. Two loads therefore differ in
 * either the yard segment or the sequence segment, and two concurrent saves in
 * one yard can never be handed the same number.
 *
 * ── Marketplace ──────────────────────────────────────────────────────────────
 * The reference encodes the yard and nothing else. No date, no vendor, no
 * material, no operator — so editing any of those cannot change it, and it means
 * the same thing forever: this exact load, from this exact yard.
 */

/**
 * The numeric tail of a lot number ("A-115" → 115).
 *
 * Reads the trailing digits rather than assuming the "A-" prefix, so a yard whose
 * lots were formatted differently still yields its sequence. Returns null when
 * there is nothing numeric to read, and the caller falls back to the raw string —
 * a reference that looks slightly odd beats one that silently says "0".
 */
export function lotSequence(lotNumber: string): number | null {
  const m = /(\d+)\s*$/.exec(lotNumber ?? "");
  return m ? Number(m[1]) : null;
}

export type LoadRefParts = {
  /**
   * `Yard.shortCode` — unique platform-wide, and fixed once assigned. Callers
   * fall back to `yardCode` for a yard that somehow has no short code yet; the
   * result is longer but still correctly identifies the yard.
   */
  shortCode: string;
  /** `InwardLoad.lotNumber` — unique within the yard, never reissued. */
  lotNumber: string;
};

/** e.g. `TY1-0005`. Stable for the life of the load. */
export function loadRef({ shortCode, lotNumber }: LoadRefParts): string {
  const seq = lotSequence(lotNumber);
  const tail = seq == null ? String(lotNumber ?? "").toUpperCase() : String(seq).padStart(4, "0");
  return `${shortCode}-${tail}`;
}

/**
 * Short, human date for a load — "21 Aug 2026".
 *
 * Not part of the reference (deliberately: a business identifier must not depend
 * on a date), but the Sort selector shows it as its own column. Fixed zone, so
 * the same load reads the same day to everyone.
 */
export function loadRefDate(createdAt: Date | string): string {
  return new Date(createdAt).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
