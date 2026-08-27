import { requireYard, ok } from "@/backend/http/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireYard();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  const skus = await prisma.sku.findMany({
    relationLoadStrategy: "join",
    orderBy: { sortOrder: "asc" },
    include: { inventory: true, material: { select: { id: true, name: true, category: true } } },
  });

  const data = skus.map((s) => {
    const qty = s.inventory?.quantityKg ?? 0;
    const ready = !s.isMixedBucket && qty >= s.saleThresholdKg;
    return {
      id: s.id,
      code: s.code,
      name: s.name,
      icon: s.icon,
      quantityKg: qty,
      thresholdKg: s.saleThresholdKg,
      isMixedBucket: s.isMixedBucket,
      visible: s.visible,
      ready,
      /**
       * When this SKU's stock last moved. Read-only, additive — nothing computes
       * from it server-side.
       *
       * Exposed so the Stock list can order READY TO SELL cards newest-first.
       * There is no `readyAt`, and adding one would mean a schema change; the last
       * inventory movement is the closest truthful proxy, because a SKU becomes
       * ready as a result of exactly that movement.
       */
      updatedAt: s.inventory?.updatedAt?.toISOString() ?? null,
      /**
       * The parent material this SKU was segregated out of. Read-only, additive —
       * nothing computes from it server-side, and every quantity, threshold and
       * `ready` flag above is unchanged.
       *
       * Exposed so the Stock screen can browse the yard the way the material tree
       * is already shaped: material (MS Scrap, PET Plastic…) → its SKUs. SKUs
       * predating the material link carry null and the client groups them apart.
       */
      materialId: s.material?.id ?? null,
      materialName: s.material?.name ?? null,
      materialCategory: s.material?.category ?? null,
    };
  });

  return ok({ skus: data });
}
