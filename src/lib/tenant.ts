import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Row-level tenant isolation.
 *
 * Every operational read and write is scoped to a single `yardId` by a
 * per-request Prisma Client Extension that closes over that yardId. The yardId
 * comes from the signed session (or a signed impersonation cookie) and never
 * from request input — see src/lib/api.ts.
 *
 * Behaviour per operation:
 *   findMany/findFirst/count/aggregate/groupBy → inject `where.yardId`
 *   create/createMany                          → set `yardId`
 *   update/delete (by unique id)               → inject `yardId` into `where`
 *                                                (Prisma extended-where-unique;
 *                                                a foreign-yard id raises P2025)
 *   updateMany/deleteMany                      → inject `where.yardId`
 *   upsert                                     → scope `where`, set `create.yardId`
 *   findUnique/findUniqueOrThrow               → post-filter, wrong yard → null
 *                                                (`select` is widened to include
 *                                                yardId, then trimmed back, so a
 *                                                projection cannot defeat it)
 *
 * The extension is defence in depth, not the only defence: handlers still pass
 * `yardId` explicitly on writes (TypeScript enforces it) and read-before-mutate.
 * Fail-closed is the rule — a query it cannot scope must not silently widen.
 *
 * ADMIN uses the unscoped `adminDb`. Non-tenant models (User, Yard, AuditLog,
 * ImpersonationSession, Counter) pass through unchanged.
 */
const TENANT_MODELS = new Set([
  "Vendor",
  "Buyer",
  "Material",
  "Sku",
  "Inventory",
  "InventoryLot",
  "InwardLoad",
  "InwardLoadLine",
  "WeightEntry",
  "OutwardLoad",
  "OutwardLoadLine",
  "OutwardImage",
  "MaterialImage",
  "SegregationRun",
  "SegregationAllocation",
  "Sale",
  "Receivable",
  "InventoryTransaction",
]);

function tenantExtension(yardId: string) {
  return Prisma.defineExtension({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model)) return query(args);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const a = args as any;

          /** AND-combine the caller's filter with the yard predicate. */
          const scopedWhere = (where: unknown) => ({ AND: [where ?? {}, { yardId }] });

          switch (operation) {
            case "findMany":
            case "findFirst":
            case "findFirstOrThrow":
            case "count":
            case "aggregate":
            case "groupBy":
            case "updateMany":
            case "deleteMany":
              return query({ ...a, where: scopedWhere(a.where) });

            // Single-record mutations by unique id. Prisma's extended
            // where-unique lets us add the yard predicate alongside the id, so
            // a foreign-yard id can never be mutated even if a handler forgets
            // to read first. Prisma raises P2025 (not found) — fail closed.
            case "update":
            case "delete":
              return query({ ...a, where: { ...(a.where ?? {}), yardId } });

            case "create":
              return query({ ...a, data: { ...a.data, yardId } });

            case "createMany": {
              const d = a.data;
              return query({
                ...a,
                data: Array.isArray(d)
                  ? d.map((x: object) => ({ ...x, yardId }))
                  : { ...d, yardId },
              });
            }

            case "upsert":
              return query({
                ...a,
                where: { ...(a.where ?? {}), yardId },
                create: { ...a.create, yardId },
              });

            case "findUnique":
            case "findUniqueOrThrow": {
              // findUnique cannot take a non-unique predicate, so post-filter.
              //
              // The post-filter reads `res.yardId`, which a caller's `select` can
              // easily omit — and then EVERY lookup would compare `undefined`
              // against the yard and return null, turning correct code into a
              // silent 404. So the projection is widened to include `yardId` and
              // the field is removed again before the row is handed back: the
              // caller gets exactly the shape it asked for, and the guard always
              // has the column it needs. `include` returns all scalars already.
              const needsYardId = !!a.select && a.select.yardId !== true;
              if (needsYardId) a.select = { ...a.select, yardId: true };

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const res: any = await query(args);
              if (res && res.yardId !== yardId) {
                if (operation === "findUniqueOrThrow") {
                  throw new Prisma.PrismaClientKnownRequestError("Record not found in this yard", {
                    code: "P2025",
                    clientVersion: Prisma.prismaVersion.client,
                  });
                }
                return null;
              }
              if (needsYardId && res) delete res.yardId;
              return res;
            }

            default:
              // Unknown/new operation: refuse rather than widen the blast radius.
              throw new Error(
                `[tenant] operation "${operation}" on ${model} is not yard-scoped; ` +
                  `add explicit handling in src/lib/tenant.ts before using it.`
              );
          }
        },
      },
    },
  });
}

export type ScopedDb = ReturnType<typeof scopedDb>;

/** Yard-scoped Prisma client (per request). Cheap proxy over the shared pool. */
export function scopedDb(yardId: string) {
  if (!yardId) throw new Error("[tenant] scopedDb requires a yardId");
  return prisma.$extends(tenantExtension(yardId));
}

/** Unscoped client for ADMIN / auth / backfill. Use deliberately. */
export const adminDb = prisma;
