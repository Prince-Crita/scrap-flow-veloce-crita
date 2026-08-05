import { z } from "zod";
import { requireAdmin, parseBody, ok, fail } from "@/lib/api";
import { audit } from "@/lib/audit";
import { provisionYard } from "@/lib/yard-provisioning";

export const dynamic = "force-dynamic";

/**
 * GET — every yard with a rollup of what it holds.
 *
 * Uses grouped aggregates rather than one query per yard, so this stays O(1) in
 * round trips as the platform grows from one yard to thousands.
 */
export async function GET() {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  const [yards, userGroups, vendorGroups, loadGroups, saleGroups, stockRows, openImpersonations] =
    await Promise.all([
      prisma.yard.findMany({ orderBy: { yardCode: "asc" } }),
      prisma.user.groupBy({ by: ["yardId", "role"], _count: { _all: true } }),
      prisma.vendor.groupBy({ by: ["yardId"], where: { active: true }, _count: { _all: true } }),
      prisma.inwardLoad.groupBy({ by: ["yardId", "status"], _count: { _all: true } }),
      prisma.sale.groupBy({ by: ["yardId"], _count: { _all: true }, _sum: { total: true } }),
      prisma.inventory.groupBy({ by: ["yardId"], _sum: { quantityKg: true } }),
      prisma.impersonationSession.findMany({
        where: { endedAt: null },
        select: { yardId: true, adminId: true, startedAt: true },
      }),
    ]);

  const num = (v: number | null | undefined) => v ?? 0;

  return ok({
    yards: yards.map((y) => {
      const owners = userGroups.find((g) => g.yardId === y.id && g.role === "OWNER")?._count._all ?? 0;
      const managers = userGroups.find((g) => g.yardId === y.id && g.role === "MANAGER")?._count._all ?? 0;
      const sales = saleGroups.find((g) => g.yardId === y.id);
      return {
        id: y.id,
        yardCode: y.yardCode,
        yardName: y.yardName,
        ownerName: y.ownerName,
        city: y.city,
        state: y.state,
        address: y.address,
        contactNumber: y.contactNumber,
        gstNumber: y.gstNumber,
        timezone: y.timezone,
        active: y.active,
        deactivatedAt: y.deactivatedAt,
        createdAt: y.createdAt,
        stats: {
          owners,
          managers,
          users: owners + managers,
          vendors: vendorGroups.find((g) => g.yardId === y.id)?._count._all ?? 0,
          loadsPending:
            loadGroups.find((g) => g.yardId === y.id && g.status === "RECEIVED")?._count._all ?? 0,
          loadsTotal: loadGroups
            .filter((g) => g.yardId === y.id)
            .reduce((a, g) => a + g._count._all, 0),
          sales: sales?._count._all ?? 0,
          salesValue: num(sales?._sum.total),
          stockKg: num(stockRows.find((g) => g.yardId === y.id)?._sum.quantityKg),
        },
        adminInside: openImpersonations.some((i) => i.yardId === y.id),
      };
    }),
  });
}

const yardCodeRe = /^[A-Z0-9-]{3,20}$/;

const createSchema = z.object({
  yardCode: z.string().trim().toUpperCase().regex(yardCodeRe, "3–20 chars: A–Z, 0–9, hyphen"),
  yardName: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().max(120).optional().or(z.literal("")),
  address: z.string().trim().max(300).optional().or(z.literal("")),
  city: z.string().trim().max(80).optional().or(z.literal("")),
  state: z.string().trim().max(80).optional().or(z.literal("")),
  contactNumber: z.string().trim().max(20).optional().or(z.literal("")),
  gstNumber: z.string().trim().max(20).optional().or(z.literal("")),
  timezone: z.string().trim().max(60).optional(),
  /** Seed the new yard with the standard MS/PET/ALU material tree. */
  seedMaterials: z.boolean().optional().default(true),
});

/**
 * POST — create a yard.
 *
 * A yard with no materials cannot receive an inward load, so a new yard is born
 * with the standard material tree (and zeroed inventory) in the same
 * transaction. Either the yard exists complete and usable, or not at all.
 */
export async function POST(req: Request) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma, user } = guard;

  const body = await parseBody(req, createSchema);
  if ("res" in body) return body.res;
  const d = body.data;

  const clash = await prisma.yard.findUnique({ where: { yardCode: d.yardCode } });
  if (clash) return fail("DUPLICATE", `Yard code ${d.yardCode} is already in use`, 409, { yardCode: "Already used" });

  const yard = await prisma.$transaction(async (tx) => {
    const created = await tx.yard.create({
      data: {
        yardCode: d.yardCode,
        yardName: d.yardName,
        ownerName: d.ownerName || null,
        address: d.address || null,
        city: d.city || null,
        state: d.state || null,
        contactNumber: d.contactNumber || null,
        gstNumber: d.gstNumber || null,
        timezone: d.timezone || "Asia/Kolkata",
        country: "India",
        active: true,
      },
    });

    if (d.seedMaterials) await provisionYard(tx, created.id);

    return created;
  });

  await audit({
    action: "yard.create",
    entity: "Yard",
    entityId: yard.id,
    yardId: yard.id,
    actorId: user.id,
    after: { yardCode: yard.yardCode, yardName: yard.yardName, seedMaterials: d.seedMaterials },
    req,
  });

  return ok({ yard: { id: yard.id, yardCode: yard.yardCode, yardName: yard.yardName } }, { status: 201 });
}
