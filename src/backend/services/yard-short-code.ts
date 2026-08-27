/**
 * The yard's short, spoken code — "TY1", "Y2", "BY1".
 *
 * It is the leading segment of every load's business reference ("TY1-0005"), so
 * the one rule that matters is that it is assigned ONCE and never changes. An
 * identifier people read out over a phone, and that Marketplace will later
 * resolve, cannot move under either of them.
 *
 * The code is DERIVED from the yard's own name rather than typed in or generated
 * randomly: the same yard always produces the same first candidate, so assigning
 * it twice by accident is a no-op rather than a second identity. Uniqueness is
 * settled by the database, not by this file — `Yard.shortCode` is `@unique`, and
 * the loop below simply walks to the next free suffix when a candidate is taken.
 */

/** Minimal client shape, so this accepts the scoped client, a tx, or adminDb. */
type YardDb = {
  yard: {
    findUnique(args: {
      where: { id: string };
      select: { id?: true; shortCode?: true; yardCode?: true; yardName?: true };
    }): Promise<{ shortCode?: string | null; yardCode?: string; yardName?: string } | null>;
    findMany(args: {
      where: { shortCode: { in: string[] } };
      select: { shortCode: true };
    }): Promise<{ shortCode: string | null }[]>;
    update(args: { where: { id: string }; data: { shortCode: string } }): Promise<unknown>;
  };
};

/** How many leading initials a code may carry before it stops being short. */
const MAX_INITIALS = 3;

/**
 * The candidates for a yard, best first.
 *
 * "Testing Yard 1" → initials TY, trailing number 1 → TY1, then TY2, TY3 …
 * "Yard 2"         → Y2, then Y3 …
 * "Bangalore Yard" → no trailing number, so it starts at 1 → BY1, BY2 …
 *
 * Falling back to `yardCode` covers a name with no letters in it at all; the
 * result is longer than ideal but still a valid, stable code.
 */
export function shortCodeCandidates(yardName: string, yardCode: string, count = 40): string[] {
  const tokens = (yardName ?? "").replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);

  const words = tokens.filter((t) => /[A-Za-z]/.test(t));
  let initials = words
    .slice(0, MAX_INITIALS)
    .map((w) => w[0]!.toUpperCase())
    .join("");

  if (!initials) {
    initials = (yardCode ?? "").replace(/[^A-Za-z]/g, "").slice(0, MAX_INITIALS).toUpperCase();
  }
  if (!initials) initials = "Y";

  // A name that already numbers itself ("Yard 2") keeps that number, so the code
  // matches what people call the yard.
  const last = tokens[tokens.length - 1];
  const start = last && /^\d+$/.test(last) ? Math.max(1, Number(last)) : 1;

  return Array.from({ length: count }, (_, i) => `${initials}${start + i}`);
}

/** The first candidate. Exported for the admin form's preview and for tests. */
export function deriveShortCode(yardName: string, yardCode: string): string {
  return shortCodeCandidates(yardName, yardCode, 1)[0];
}

/**
 * Returns the yard's short code, assigning one if it has none yet.
 *
 * Idempotent: a yard that already has a code is never rewritten, which is the
 * property the whole identifier depends on. Concurrent callers racing to assign
 * the same yard settle on the unique index — the loser's update raises P2002 and
 * it re-reads the winner's code rather than inventing a second one.
 */
export async function ensureShortCode(db: YardDb, yardId: string): Promise<string | null> {
  const yard = await db.yard.findUnique({
    where: { id: yardId },
    select: { shortCode: true, yardCode: true, yardName: true },
  });
  if (!yard) return null;
  if (yard.shortCode) return yard.shortCode;

  const candidates = shortCodeCandidates(yard.yardName ?? "", yard.yardCode ?? "");
  const taken = new Set(
    (await db.yard.findMany({ where: { shortCode: { in: candidates } }, select: { shortCode: true } }))
      .map((y) => y.shortCode)
      .filter((c): c is string => !!c)
  );
  const free = candidates.find((c) => !taken.has(c));
  if (!free) return null;

  try {
    await db.yard.update({ where: { id: yardId }, data: { shortCode: free } });
    return free;
  } catch {
    // Someone else got there first — for this yard, or for this code. Re-read:
    // whichever code is now stored is the one that counts.
    const again = await db.yard.findUnique({ where: { id: yardId }, select: { shortCode: true } });
    return again?.shortCode ?? null;
  }
}
