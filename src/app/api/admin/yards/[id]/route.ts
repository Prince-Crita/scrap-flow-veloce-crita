import { z } from "zod";
import { requireAdmin, parseBody, ok, fail } from "@/backend/http/api";
import { audit, diffFields } from "@/backend/services/audit";
import { publish } from "@/backend/realtime/realtime";

export const dynamic = "force-dynamic";

/** GET — one yard, with its users and a full operational snapshot. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;
  const { id } = await ctx.params;

  const yard = await prisma.yard.findUnique({
    where: { id },
    include: {
      users: {
        orderBy: [{ role: "asc" }, { name: "asc" }],
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          active: true,
          mustChangePassword: true,
          xp: true,
          level: true,
          streak: true,
          lastActiveDate: true,
        },
      },
    },
  });
  if (!yard) return fail("NOT_FOUND", "Yard not found", 404);

  const [stock, loads, sales, receivables, vendors, materials, txnCount, openImp, dispatches] = await Promise.all([
    prisma.sku.findMany({
      where: { yardId: id },
      orderBy: { sortOrder: "asc" },
      include: { inventory: true, material: { select: { name: true, active: true } } },
    }),
    prisma.inwardLoad.findMany({
      where: { yardId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { vendor: { select: { id: true, name: true } }, _count: { select: { weightEntries: true } } },
    }),
    prisma.sale.findMany({
      where: { yardId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        buyer: { select: { name: true } },
        sku: { select: { name: true } },
        receivable: { select: { id: true, status: true, amount: true } },
      },
    }),
    prisma.receivable.aggregate({
      where: { yardId: id, status: { in: ["PENDING", "PARTIAL"] } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.vendor.findMany({
      where: { yardId: id },
      orderBy: { name: "asc" },
      select: { id: true, name: true, gstNumber: true, phone: true, address: true, active: true, _count: { select: { loads: true } } },
    }),
    prisma.material.findMany({
      where: { yardId: id },
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true, category: true, active: true, _count: { select: { skus: true, loads: true } } },
    }),
    prisma.inventoryTransaction.count({ where: { yardId: id } }),
    prisma.impersonationSession.findFirst({
      where: { yardId: id, endedAt: null },
      include: { admin: { select: { name: true, email: true } } },
    }),
    // Outward (Phase 4). Same shape and limit as `loads` above — the Outward tab
    // is the Inward tab's mirror, so it reads the same way.
    prisma.outwardLoad.findMany({
      where: { yardId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        dispatchedBy: { select: { name: true } },
        images: { select: { id: true, url: true } },
        lines: {
          orderBy: { sequence: "asc" },
          include: {
            sku: { select: { name: true, icon: true } },
            // `quantityKg` and `dispatchedKg` on the sale give the remaining
            // balance per invoice: what this buyer is still owed.
            sale: {
              select: {
                id: true,
                invoiceNumber: true,
                quantityKg: true,
                dispatchedKg: true,
                dispatchStatus: true,
                buyer: { select: { name: true } },
              },
            },
          },
        },
      },
    }),
  ]);

  // Audit history for the dispatches above, in one query rather than per row.
  const dispatchAudit = dispatches.length
    ? await prisma.auditLog.findMany({
        where: { yardId: id, entity: "OutwardLoad", entityId: { in: dispatches.map((d) => d.id) } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          entityId: true,
          action: true,
          before: true,
          after: true,
          createdAt: true,
          actor: { select: { name: true } },
        },
      })
    : [];

  return ok({
    yard: {
      id: yard.id,
      yardCode: yard.yardCode,
      yardName: yard.yardName,
      ownerName: yard.ownerName,
      address: yard.address,
      city: yard.city,
      state: yard.state,
      country: yard.country,
      timezone: yard.timezone,
      contactNumber: yard.contactNumber,
      gstNumber: yard.gstNumber,
      active: yard.active,
      deactivatedAt: yard.deactivatedAt,
      createdAt: yard.createdAt,
    },
    users: yard.users,
    stock: stock.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      icon: s.icon,
      materialName: s.material?.name ?? null,
      quantityKg: s.inventory?.quantityKg ?? 0,
      thresholdKg: s.saleThresholdKg,
      isMixedBucket: s.isMixedBucket,
      visible: s.visible,
    })),
    loads: loads.map((l) => ({
      id: l.id,
      lotNumber: l.lotNumber,
      materialLabel: l.materialLabel,
      totalKg: l.totalKg,
      vendorId: l.vendorId,
      vendorName: l.vendor?.name ?? "Walk-in",
      vehicleNumber: l.vehicleNumber,
      vehicleType: l.vehicleType,
      driverName: l.driverName,
      status: l.status,
      weighments: l._count.weightEntries,
      createdAt: l.createdAt,
    })),
    sales: sales.map((s) => ({
      id: s.id,
      invoiceNumber: s.invoiceNumber,
      buyerName: s.buyer.name,
      skuName: s.sku.name,
      quantityKg: s.quantityKg,
      ratePerKg: s.ratePerKg,
      total: s.total,
      vehicleNumber: s.vehicleNumber,
      driverName: s.driverName,
      driverPhone: s.driverPhone,
      status: s.status,
      receivableId: s.receivable?.id ?? null,
      paymentStatus: s.receivable?.status ?? "PENDING",
      createdAt: s.createdAt,
    })),
    /**
     * Dispatches — one row per vehicle that left the yard.
     *
     * `remainingKg` is per line, not per vehicle: a sale is an allocation, so the
     * balance that matters is what the invoice still owes, which several vehicles
     * may whittle down over days. A legacy sale (null `dispatchedKg`) predates
     * Outward and has no allocation to draw down, so its remainder is zero.
     */
    dispatches: dispatches.map((d) => ({
      id: d.id,
      dispatchNumber: d.dispatchNumber,
      vehicleNumber: d.vehicleNumber,
      vehicleType: d.vehicleType,
      driverName: d.driverName,
      totalKg: d.totalKg,
      ocrConfidence: d.ocrConfidence,
      dispatchedBy: d.dispatchedBy?.name ?? null,
      createdAt: d.createdAt,
      frontImageUrl: d.frontImageUrl,
      backImageUrl: d.backImageUrl,
      materialImages: d.images.map((i) => i.url),
      lines: d.lines.map((l) => ({
        id: l.id,
        sequence: l.sequence,
        skuName: l.sku.name,
        skuIcon: l.sku.icon,
        quantityKg: l.quantityKg,
        saleId: l.sale.id,
        invoiceNumber: l.sale.invoiceNumber,
        buyerName: l.sale.buyer.name,
        allocatedKg: l.sale.quantityKg,
        dispatchedKg: l.sale.dispatchedKg ?? 0,
        remainingKg:
          l.sale.dispatchedKg === null ? 0 : Math.max(0, l.sale.quantityKg - l.sale.dispatchedKg),
        dispatchStatus: l.sale.dispatchStatus ?? "COMPLETED",
      })),
      audit: dispatchAudit
        .filter((a) => a.entityId === d.id)
        .map((a) => ({
          id: a.id,
          action: a.action,
          actorName: a.actor?.name ?? "system",
          before: a.before,
          after: a.after,
          createdAt: a.createdAt,
        })),
    })),
    vendors,
    materials,
    totals: {
      stockKg: stock.reduce((a, s) => a + (s.inventory?.quantityKg ?? 0), 0),
      salesValue: sales.reduce((a, s) => a + s.total, 0),
      outstanding: receivables._sum.amount ?? 0,
      outstandingCount: receivables._count._all,
      transactions: txnCount,
      dispatchCount: dispatches.length,
      dispatchKg: dispatches.reduce((a, d) => a + d.totalKg, 0),
    },
    adminInside: openImp
      ? {
          adminName: openImp.admin.name,
          adminEmail: openImp.admin.email,
          startedAt: openImp.startedAt.toISOString(),
        }
      : null,
  });
}

const patchSchema = z.object({
  yardName: z.string().trim().min(2).max(120).optional(),
  ownerName: z.string().trim().max(120).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  state: z.string().trim().max(80).nullable().optional(),
  contactNumber: z.string().trim().max(20).nullable().optional(),
  gstNumber: z.string().trim().max(20).nullable().optional(),
  timezone: z.string().trim().max(60).optional(),
  active: z.boolean().optional(),
});

/**
 * PATCH — edit yard details, or reactivate it.
 *
 * `yardCode` is deliberately immutable: it is the business identifier printed on
 * paperwork and embedded in this yard's storage key space. Renaming is done
 * through `yardName`.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma, user } = guard;
  const { id } = await ctx.params;

  const body = await parseBody(req, patchSchema);
  if ("res" in body) return body.res;

  const before = await prisma.yard.findUnique({ where: { id } });
  if (!before) return fail("NOT_FOUND", "Yard not found", 404);

  const data: Record<string, unknown> = { ...body.data };
  if (body.data.active === true && !before.active) data.deactivatedAt = null;
  if (body.data.active === false && before.active) data.deactivatedAt = new Date();

  const after = await prisma.yard.update({ where: { id }, data });

  const { before: b, after: a } = diffFields(
    before as unknown as Record<string, unknown>,
    data as Record<string, unknown>
  );
  await audit({
    action: body.data.active === false ? "yard.deactivate" : "yard.update",
    entity: "Yard",
    entityId: id,
    yardId: id,
    actorId: user.id,
    before: b,
    after: a,
    req,
  });

  // Owner/Manager screens pick up renames and status changes immediately.
  publish(id, { channel: "yard", action: "updated", entity: "Yard", entityId: id, actorId: user.id });

  return ok({ yard: { id: after.id, yardName: after.yardName, active: after.active } });
}

/**
 * DELETE — deactivate (never destroy).
 *
 * A yard holds financial history; erasing it is not a supported operation at any
 * permission level. Deactivation locks its users out and hides it from
 * operations while every row stays intact and auditable. The Restrict foreign
 * keys in the schema enforce this at the database level too.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma, user } = guard;
  const { id } = await ctx.params;

  const yard = await prisma.yard.findUnique({ where: { id } });
  if (!yard) return fail("NOT_FOUND", "Yard not found", 404);
  if (!yard.active) return ok({ id, active: false, alreadyInactive: true });

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.yard.update({ where: { id }, data: { active: false, deactivatedAt: now } });
    // Close any admin sitting inside a yard that is being switched off.
    const open = await tx.impersonationSession.findMany({ where: { yardId: id, endedAt: null } });
    for (const s of open) {
      await tx.impersonationSession.update({
        where: { id: s.id },
        data: {
          endedAt: now,
          durationSec: Math.max(0, Math.round((now.getTime() - s.startedAt.getTime()) / 1000)),
          endReason: "yard-deactivated",
        },
      });
    }
  });

  await audit({
    action: "yard.deactivate",
    entity: "Yard",
    entityId: id,
    yardId: id,
    actorId: user.id,
    before: { active: true },
    after: { active: false, deactivatedAt: now.toISOString() },
    req,
  });

  publish(id, { channel: "yard", action: "deactivated", entity: "Yard", entityId: id, actorId: user.id });

  return ok({ id, active: false });
}
