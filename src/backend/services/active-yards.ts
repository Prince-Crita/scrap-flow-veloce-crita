import { Prisma } from "@prisma/client";

/**
 * Platform analytics count OPERATING yards only.
 *
 * A deactivated yard keeps every row it ever wrote — nothing is deleted, and
 * `/admin/yards` still lists it — but it has stopped trading, so its tonnage,
 * invoices and receivables must not be added into platform totals. Otherwise a
 * decommissioned yard keeps inflating "Stock On Hand" and "Outstanding" forever,
 * and the numbers describe a business that no longer exists.
 *
 * Every table that carries a `yardId` is filtered through the helpers here, so
 * the rule lives in one place rather than being restated per query.
 *
 * ── Why a relation filter and not a list of ids ──────────────────────────────
 * The first version fetched the active ids and spread `{ yardId: { in: ids } }`
 * everywhere. Correct, but it forced an extra round trip that the whole query
 * batch had to wait on — every other query in `/api/admin/dashboard` depends on
 * it, so it could not be parallelised away. A relation filter (and the matching
 * SQL sub-select) says the same thing inside the query the database was going to
 * run anyway: same results, one fewer serial round trip per request.
 */

/** Prisma `where` fragment: rows belonging to a yard that is still operating. */
export const inLiveYards = { yard: { active: true } } as const;

/**
 * Scope for a route that also supports an explicit single-yard drill-down.
 * A named yard is honoured whether it is active or archived — asking for one
 * deliberately is not the same as counting it in a platform total.
 */
export const inYardScope = (yardId: string | null) => (yardId ? { yardId } : inLiveYards);

/**
 * The same predicate for raw SQL, as a trailing `AND …` fragment.
 *
 * `column` is a Prisma.sql literal so a joined query can qualify it
 * (`i."yardId"`) — an unqualified `"yardId"` is ambiguous once two tables that
 * both carry one are joined, and Postgres refuses to plan it.
 */
export function andLiveYards(column: Prisma.Sql = Prisma.sql`"yardId"`): Prisma.Sql {
  return Prisma.sql`AND ${column} IN (SELECT "id" FROM "Yard" WHERE "active" = true)`;
}

/** Raw-SQL scope matching `inYardScope`: one named yard, or every live yard. */
export function andYardScope(yardId: string | null, column: Prisma.Sql = Prisma.sql`"yardId"`): Prisma.Sql {
  return yardId ? Prisma.sql`AND ${column} = ${yardId}` : andLiveYards(column);
}

/** Users of live yards, plus platform admins — who belong to no yard at all. */
export const liveYardUsers = { OR: [{ yard: { active: true } }, { yardId: null }] };
