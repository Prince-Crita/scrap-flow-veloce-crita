import { requireAdmin, ok, fail } from "@/backend/http/api";
import { audit, diffFields } from "@/backend/services/audit";
import { publish } from "@/backend/realtime/realtime";
import {
  EDITABLE_ENTITIES,
  RECORD_SCHEMAS,
  ENTITY_CHANNEL,
  ENTITY_MODEL,
  findLedgerFields,
  type EditableEntity,
} from "@/backend/services/admin-records";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/admin/records/{entity}/{id}
 *
 * The admin "edit any record" surface. One endpoint, a per-entity field
 * whitelist (src/backend/services/admin-records.ts), before/after auditing, and a realtime
 * publish so the yard's Owner and Manager see the correction immediately.
 *
 * Ledger-derived quantities are refused with an explanation rather than silently
 * dropped — see the header of src/backend/services/admin-records.ts for the reasoning.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ entity: string; id: string }> }) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma, user } = guard;

  const { entity: rawEntity, id } = await ctx.params;
  const entity = rawEntity as EditableEntity;
  if (!EDITABLE_ENTITIES.includes(entity)) {
    return fail("BAD_ENTITY", `"${rawEntity}" is not an editable record type`, 404);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("BAD_JSON", "Invalid JSON body", 400);
  }
  const payload = (raw ?? {}) as Record<string, unknown>;

  // Refuse ledger fields loudly, before validation strips them silently.
  const ledger = findLedgerFields(payload);
  if (ledger.length > 0) {
    return fail(
      "LEDGER_PROTECTED",
      `These fields drive the inventory ledger and cannot be edited in place: ${ledger.join(", ")}. ` +
        `Correcting a quantity requires a compensating stock adjustment so the running totals, ` +
        `batch remainders and transaction history stay consistent.`,
      422
    );
  }

  const parsed = RECORD_SCHEMAS[entity].safeParse(payload);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join(".")] = issue.message;
    return fail("VALIDATION", "Please check the highlighted fields", 422, fields);
  }
  const data = parsed.data as Record<string, unknown>;
  if (Object.keys(data).length === 0) return fail("NO_CHANGES", "Nothing to update", 422);

  // Dynamic model access. `entity` is whitelisted above, so this cannot be
  // steered at an arbitrary model.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const delegate = (prisma as any)[entity] as {
    findUnique(a: unknown): Promise<Record<string, unknown> | null>;
    update(a: unknown): Promise<Record<string, unknown>>;
  };

  const before = await delegate.findUnique({ where: { id } });
  if (!before) return fail("NOT_FOUND", `${ENTITY_MODEL[entity]} not found`, 404);

  const yardId = before.yardId as string;

  // A reassigned vendor must belong to the same yard as the load.
  if (entity === "inwardLoad" && typeof data.vendorId === "string") {
    const vendor = await prisma.vendor.findUnique({ where: { id: data.vendorId }, select: { yardId: true } });
    if (!vendor || vendor.yardId !== yardId) {
      return fail("CROSS_YARD", "That vendor belongs to a different yard", 422, { vendorId: "Wrong yard" });
    }
  }

  // Per-yard uniqueness must hold after an admin rename, just as it does for owners.
  if ((entity === "material" || entity === "sku") && typeof data.name === "string") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clash = await (prisma as any)[entity].findFirst({
      where: { yardId, name: data.name, id: { not: id } },
      select: { id: true },
    });
    if (clash) return fail("DUPLICATE", `"${data.name}" already exists in this yard`, 409, { name: "Already used" });
  }

  const after = await delegate.update({ where: { id }, data });

  const { before: b, after: a } = diffFields(before, data);
  await audit({
    action: `${entity}.adminEdit`,
    entity: ENTITY_MODEL[entity],
    entityId: id,
    yardId,
    actorId: user.id,
    before: b,
    after: a,
    req,
  });

  publish(yardId, {
    channel: ENTITY_CHANNEL[entity],
    action: "updated",
    entity: ENTITY_MODEL[entity],
    entityId: id,
    actorId: user.id,
  });

  return ok({ entity, id, updated: Object.keys(data), record: { id: after.id } });
}
