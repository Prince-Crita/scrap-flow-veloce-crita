import { z } from "zod";
import { requireYard, requireYardCapability, parseBody, ok, fail } from "@/lib/api";
import { publishMany } from "@/lib/realtime";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Sort types — the segregation categories a mixed lot can be sorted into.
 *
 * A sort type IS a non-mixed SKU hanging off a Material: "Mixed MS" is the
 * inward bucket, and "MS Sheet" / "MS Rod" are its sort types. There is
 * deliberately no separate table. Making sort types their own entity would mean
 * every finished kilogram had to be reconciled across two trees, and the
 * segregation run already writes straight into SKU inventory.
 *
 * Roles: Owner and Admin have full CRUD; a Manager can read the tree but not
 * change it, because changing it changes what every future run can produce.
 */

/** GET — the sort tree, grouped by material. Readable by any in-yard role. */
export async function GET(req: Request) {
  const guard = await requireYard();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  const includeHidden = new URL(req.url).searchParams.get("all") === "1";

  const materials = await prisma.material.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, code: true, active: true },
  });

  const skus = await prisma.sku.findMany({
    where: { isMixedBucket: false, materialId: { not: null } },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      code: true,
      icon: true,
      materialId: true,
      visible: true,
      saleThresholdKg: true,
      sortOrder: true,
      inventory: { select: { quantityKg: true } },
    },
  });

  return ok({
    materials: materials.map((m) => ({
      ...m,
      sortTypes: skus
        .filter((s) => s.materialId === m.id && (includeHidden || s.visible))
        .map((s) => ({
          id: s.id,
          name: s.name,
          code: s.code,
          icon: s.icon,
          // `visible` is the active flag: a hidden sort type stays in history and
          // keeps its stock, it simply stops being offered on a new run.
          active: s.visible,
          saleThresholdKg: s.saleThresholdKg,
          sortOrder: s.sortOrder,
          stockKg: s.inventory?.quantityKg ?? 0,
        })),
    })),
  });
}

const createSchema = z.object({
  materialId: z.string().min(1),
  name: z.string().trim().min(2).max(60),
  icon: z.string().trim().max(8).optional(),
  saleThresholdKg: z.number().int().positive().max(1_000_000).optional(),
});

/** Uppercase alphanumeric stem for the SKU code, matching the material route. */
function slug(s: string) {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "SORT";
}

/** POST — create a sort type under a material. Owner/Admin only. */
export async function POST(req: Request) {
  const guard = await requireYardCapability("sortType.write");
  if ("res" in guard) return guard.res;
  const { prisma, yardId } = guard;

  const body = await parseBody(req, createSchema);
  if ("res" in body) return body.res;

  // The tenant extension scopes this, so a foreign materialId simply misses.
  const material = await prisma.material.findUnique({
    where: { id: body.data.materialId },
    select: { id: true, name: true },
  });
  if (!material) return fail("NOT_FOUND", "Material not found", 404);

  const name = body.data.name;
  // Uniqueness is per yard (Sku has @@unique([yardId, name]) and [yardId, code]),
  // so another yard having the same category is fine.
  const nameClash = await prisma.sku.findFirst({ where: { name }, select: { id: true } });
  if (nameClash) return fail("DUPLICATE", `"${name}" already exists in this yard`, 409);

  // Codes must be unique too; a suffix keeps "MS Sheet" and "MS Sheets" apart.
  const stem = slug(name);
  let code = stem;
  for (let i = 2; await prisma.sku.findFirst({ where: { code }, select: { id: true } }); i++) {
    code = `${stem.slice(0, 10)}${i}`;
    if (i > 50) return fail("DUPLICATE", "Could not allocate a unique code", 409);
  }

  const last = await prisma.sku.findFirst({ orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });

  // The inventory row is created with the SKU: a sort type with no inventory row
  // would break the first segregation run that tried to allocate into it.
  const sku = await prisma.$transaction(async (tx) => {
    const created = await tx.sku.create({
      data: {
        yardId,
        name,
        code,
        icon: body.data.icon || "📦",
        materialId: material.id,
        isMixedBucket: false,
        saleThresholdKg: body.data.saleThresholdKg ?? 1000,
        sortOrder: (last?.sortOrder ?? 0) + 1,
      },
    });
    await tx.inventory.create({ data: { yardId, skuId: created.id, quantityKg: 0 } });
    return created;
  });

  await audit({
    action: "sortType.create",
    entity: "Sku",
    entityId: sku.id,
    yardId,
    actorId: guard.user.id,
    after: { name: sku.name, code: sku.code, materialId: material.id, materialName: material.name },
    req,
  });

  publishMany(yardId, [
    { channel: "materials", action: "created", entity: "Sku", entityId: sku.id, actorId: guard.user.id },
    // The Sort page's target list and the Stock screen both change.
    { channel: "stock", action: "updated", entity: "Sku", entityId: sku.id, actorId: guard.user.id },
    { channel: "sort", action: "updated", entity: "Sku", entityId: sku.id, actorId: guard.user.id },
  ]);

  return ok(
    { sortType: { id: sku.id, name: sku.name, code: sku.code, icon: sku.icon, active: sku.visible } },
    { status: 201 }
  );
}
