import { z } from "zod";
import { requireYard, requireYardCapability, parseBody, ok, fail } from "@/backend/http/api";
import { publishMany } from "@/backend/realtime/realtime";

export const dynamic = "force-dynamic";

/**
 * The materials that can be BOOKED against — Inward's selector, and Dispatch's.
 *
 * Two shapes, chosen by `?all=1`:
 *
 *   default   the selectable set. Every mixed bucket (PET Mixed, Mixed MS) AND
 *             every visible sub-material (PET White, MS Bazar), each carrying
 *             the main category it hangs off. A mixed choice routes the load to
 *             Sort; a sub-material choice goes straight to that sub-material's
 *             stock — see src/shared/material-kind.ts, which is the one place
 *             that rule is written down.
 *
 *   ?all=1    main categories only, including deactivated ones. This is the
 *             MANAGEMENT view (`material-sheet.tsx` lists inactive materials to
 *             restore or purge them), so it is deliberately unchanged.
 *
 * Hidden SKUs are excluded from the selectable set: `visible: false` is how a
 * sort type is retired, and a retired category must stop being offered on new
 * work while keeping its stock and its history.
 */
export async function GET(req: Request) {
  const guard = await requireYard();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  const managementView = new URL(req.url).searchParams.get("all") === "1";
  const rows = await prisma.sku.findMany({
    where: managementView
      ? { isMixedBucket: true }
      : {
          visible: true,
          // A SKU with no material predates the hierarchy; it is still bookable.
          OR: [{ material: { active: true } }, { materialId: null }],
        },
    // Mixed buckets first within a category, then the yard's own ordering, so
    // the picker groups the way the material tree is actually shaped.
    orderBy: [{ isMixedBucket: "desc" }, { sortOrder: "asc" }],
    select: {
      id: true,
      code: true,
      name: true,
      icon: true,
      isMixedBucket: true,
      material: { select: { id: true, name: true, active: true } },
    },
  });
  return ok({
    materials: rows.map((b) => ({
      id: b.id,
      code: b.code,
      name: b.name,
      icon: b.icon,
      materialId: b.material?.id ?? null,
      /** The main category's name — what the picker groups and searches on. */
      materialName: b.material?.name ?? null,
      /** MIXED → Sort. DIRECT → straight to this sub-material's stock. */
      isMixedBucket: b.isMixedBucket,
      active: b.material?.active ?? true,
    })),
  });
}

const createSchema = z.object({
  name: z.string().min(2).max(60),
  category: z.string().max(60).optional().or(z.literal("")),
  threshold: z.number().int().positive().max(1_000_000).optional().nullable(),
});

function slug(s: string) {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "MAT";
}

/**
 * Owner-only. Creates a parent Material + a mixed-bucket SKU (e.g. "Copper" →
 * "Mixed Copper"). Segregation sub-SKUs are configured later (Phase 2).
 *
 * Uniqueness is per yard: another yard may already have "Copper", which is fine.
 */
export async function POST(req: Request) {
  const guard = await requireYardCapability("material.write");
  if ("res" in guard) return guard.res;
  const { prisma, yardId } = guard;

  const body = await parseBody(req, createSchema);
  if ("res" in body) return body.res;

  const name = body.data.name.trim();
  const baseCode = slug(name);
  const materialCode = baseCode;
  const skuCode = `MIX${baseCode}`;

  // Scoped: only clashes within this yard matter.
  const clash = await prisma.material.findFirst({
    where: { OR: [{ code: materialCode }, { name }] },
  });
  if (clash) return fail("DUPLICATE", `Material "${name}" already exists`, 409);

  const skuClash = await prisma.sku.findFirst({ where: { OR: [{ code: skuCode }, { name: `Mixed ${name}` }] } });
  if (skuClash) return fail("DUPLICATE", `Material "${name}" already exists`, 409);

  const last = await prisma.sku.findFirst({ orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
  const nextOrder = (last?.sortOrder ?? 0) + 1;

  const bucket = await prisma.$transaction(async (tx) => {
    const material = await tx.material.create({
      data: { yardId, name, code: materialCode, category: body.data.category || null },
    });
    const sku = await tx.sku.create({
      data: {
        yardId,
        name: `Mixed ${name}`,
        code: skuCode,
        icon: "🧺",
        materialId: material.id,
        isMixedBucket: true,
        saleThresholdKg: body.data.threshold ?? 99999,
        sortOrder: nextOrder,
      },
    });
    await tx.inventory.create({ data: { yardId, skuId: sku.id, quantityKg: 0 } });
    return sku;
  });

  publishMany(yardId, [
    { channel: "materials", action: "created", entity: "Material", entityId: bucket.id, actorId: guard.user.id },
    { channel: "stock", action: "updated", entity: "Sku", entityId: bucket.id, actorId: guard.user.id },
  ]);

  return ok({ material: { id: bucket.id, code: bucket.code, name: bucket.name } }, { status: 201 });
}
