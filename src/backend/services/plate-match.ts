/**
 * Snap a low-confidence plate read onto a vehicle this yard has seen before.
 *
 * A scrap yard is a repeat-business operation: the same vendors send the same
 * trucks week after week. That history is free, high-quality prior knowledge, and
 * it is exactly what fixes the failure the OCR grammar cannot — a single
 * substituted character in a read that is otherwise structurally legal. `MH12AB1234`
 * misread as `MH12AB1284` passes every grammar check in `plate.py`, names a real
 * state, and is wrong. One edit away from a plate that has physically been through
 * the gate, it is almost certainly that truck.
 *
 * Deliberately conservative, because the failure mode of being wrong here is worse
 * than the failure mode of doing nothing (the operator retypes six characters):
 *
 *  - only for reads the service is NOT already confident about;
 *  - only substitutions and single insert/delete — distance exactly 1;
 *  - only when EXACTLY ONE known plate is that close. Two neighbours at distance 1
 *    means the read is genuinely ambiguous, and guessing between them is worse
 *    than presenting what was actually read;
 *  - never invents a plate when the OCR returned none.
 *
 * Yard-scoped by construction: the caller passes plates read through the
 * tenant-scoped client, so one yard's fleet can never correct another's.
 */

/** Confidence at or above which a read is left alone. Mirrors CONF_WARN in main.py. */
export const SNAP_CONFIDENCE_CEILING = 0.8;

/** How many historical plates to consider. Bounded so the query stays cheap. */
export const SNAP_HISTORY_LIMIT = 500;

/**
 * Levenshtein distance, abandoned as soon as it exceeds `max`.
 *
 * The early exit is not micro-optimisation: this runs against several hundred
 * historical plates per OCR call, and almost every pair is nowhere near a match.
 */
export function levenshtein(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** Strip everything that cannot appear in a registration. Mirrors clean_plate(). */
export function normalisePlate(v: string | null | undefined): string {
  return (v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type SnapResult = {
  plate: string;
  confidence: number;
  /** True when history changed the answer. Surfaced so the UI can say why. */
  snapped: boolean;
  /** The read as the OCR service returned it, when a snap happened. */
  original?: string;
};

/**
 * Correct `plate` against `known` when the evidence is unambiguous.
 *
 * Returns the input unchanged in every case that is not a clear single-neighbour
 * match, including the confident-read and empty-history cases.
 */
export function snapToKnownPlate(
  plate: string | null | undefined,
  confidence: number,
  known: Iterable<string>
): SnapResult | null {
  const read = normalisePlate(plate);
  if (!read) return null;
  const unchanged: SnapResult = { plate: read, confidence, snapped: false };

  // A confident read is already better evidence than the history.
  if (confidence >= SNAP_CONFIDENCE_CEILING) return unchanged;

  let match: string | null = null;
  for (const raw of known) {
    const candidate = normalisePlate(raw);
    // A blank history row is not evidence of anything — skip it. (Returning
    // early here treated one empty string as "nothing to correct against" and
    // silently disabled the whole stage.)
    if (!candidate) continue;
    // An exact hit means the read is already right; nothing to correct.
    if (candidate === read) return unchanged;
    if (levenshtein(read, candidate, 1) !== 1) continue;
    // A second neighbour makes the read ambiguous — leave it alone.
    if (match && match !== candidate) return unchanged;
    match = candidate;
  }
  if (!match) return unchanged;

  return {
    plate: match,
    // Corroborated by a vehicle that has physically been through the gate, but
    // still one edit from what was read — capped well short of certainty.
    confidence: Math.min(0.9, Math.max(confidence, 0.75)),
    snapped: true,
    original: read,
  };
}
