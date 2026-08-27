import { z } from "zod";
import { requireOwnerYard, parseBody, ok, fail } from "@/backend/http/api";
import { nextCounter, formatInvoice } from "@/backend/services/counters";
import { publishMany } from "@/backend/realtime/realtime";
import { dispatchStatusFor, sellableKg } from "@/backend/services/allocation";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireOwnerYard();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  const sales = await prisma.sale.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      buyer: { select: { name: true } },
      sku: { select: { name: true } },
      receivable: { select: { status: true } },
    },
  });
  return ok({
    sales: sales.map((s) => ({
      id: s.id,
      invoiceNumber: s.invoiceNumber,
      buyerName: s.buyer.name,
      skuName: s.sku.name,
      quantityKg: s.quantityKg,
      ratePerKg: s.ratePerKg,
      total: s.total,
      status: s.status,
      paymentStatus: s.receivable?.status ?? "PENDING",
      dispatchStatus: dispatchStatusFor(s),
      dispatchedKg: s.dispatchedKg ?? s.quantityKg,
      remainingKg: Math.max(0, s.quantityKg - (s.dispatchedKg ?? s.quantityKg)),
      createdAt: s.createdAt,
    })),
  });
}

const schema = z.object({
  /** Idempotency key — see the inward route. A replayed sale would otherwise
   *  consume an invoice number and deduct the stock a second time. */
  clientRequestId: z.string().min(8).max(64).optional(),
  skuId: z.string().min(1),
  buyerId: z.string().min(1).optional().nullable(),
  buyerName: z.string().min(2).max(120).optional().nullable(),
  quantityKg: z.number().int().positive(),
  ratePerKg: z.number().positive(),
  gstRate: z.number().min(0).max(28).optional().default(18),
  vehicleNumber: z.string().max(20).optional().nullable(),
  driverName: z.string().max(80).optional().nullable(),
  driverPhone: z.string().max(15).optional().nullable(),
  /** Dispatch paperwork captured with the allocation. All optional. */
  frontImageUrl: z.string().max(600).optional().nullable(),
  backImageUrl: z.string().max(600).optional().nullable(),
  weighbridgeSlipUrl: z.string().max(600).optional().nullable(),
  documentUrls: z.array(z.string().max(600)).max(20).optional().default([]),
});

export async function POST(req: Request) {
  const guard = await requireOwnerYard();
  if ("res" in guard) return guard.res;
  const { prisma, yardId } = guard;

  const body = await parseBody(req, schema);
  if ("res" in body) return body.res;
  const d = body.data;

  if (!d.buyerId && !d.buyerName) {
    return fail("NO_BUYER", "Select or enter a buyer", 422);
  }

  // Replay check before touching stock. The unique index on
  // (yardId, clientRequestId) handles the concurrent case below.
  if (d.clientRequestId) {
    const existing = await prisma.sale.findFirst({
      where: { clientRequestId: d.clientRequestId },
      select: { invoiceNumber: true, total: true, quantityKg: true, sku: { select: { name: true } } },
    });
    if (existing) {
      return ok(
        {
          sale: {
            invoiceNumber: existing.invoiceNumber,
            total: existing.total,
            skuName: existing.sku.name,
            quantityKg: existing.quantityKg,
          },
          replayed: true,
        },
        { status: 200 }
      );
    }
  }

  const sku = await prisma.sku.findUnique({ where: { id: d.skuId }, include: { inventory: true } });
  if (!sku) return fail("NOT_FOUND", "SKU not found", 404);

  // A sale RESERVES stock rather than removing it, so what may be sold is what
  // is physically present MINUS what earlier sales have already promised.
  // Without this an owner could sell the same 2,400 kg twice and the Manager
  // would be unable to load the second invoice.
  const physicalKg = sku.inventory?.quantityKg ?? 0;
  const openSales = await prisma.sale.findMany({
    where: { skuId: sku.id, dispatchedKg: { not: null } },
    select: { quantityKg: true, dispatchedKg: true },
  });
  const available = sellableKg(physicalKg, openSales);
  if (d.quantityKg > available) {
    return fail("INSUFFICIENT_STOCK", `Only ${available} kg available for ${sku.name}`, 422);
  }

  // A buyerId supplied by the client must belong to this yard.
  if (d.buyerId) {
    const buyer = await prisma.buyer.findUnique({ where: { id: d.buyerId } });
    if (!buyer) return fail("BAD_BUYER", "Buyer not found", 422);
  }

  const subtotal = Math.round(d.quantityKg * d.ratePerKg);
  const gstAmount = Math.round((subtotal * d.gstRate) / 100);
  const total = subtotal + gstAmount;

  const result = await prisma.$transaction(async (tx) => {
    let buyerId = d.buyerId ?? null;
    if (!buyerId && d.buyerName) {
      const buyer = await tx.buyer.create({ data: { yardId, name: d.buyerName.trim() } });
      buyerId = buyer.id;
    }

    const seq = await nextCounter(tx, yardId, "invoice");
    const invoiceNumber = formatInvoice(seq);

    const sale = await tx.sale.create({
      data: {
        yardId,
        clientRequestId: d.clientRequestId ?? null,
        invoiceNumber,
        buyerId: buyerId!,
        skuId: sku.id,
        quantityKg: d.quantityKg,
        ratePerKg: d.ratePerKg,
        subtotal,
        gstRate: d.gstRate,
        gstAmount,
        total,
        vehicleNumber: d.vehicleNumber ?? null,
        driverName: d.driverName ?? null,
        driverPhone: d.driverPhone ?? null,
        frontImageUrl: d.frontImageUrl ?? null,
        backImageUrl: d.backImageUrl ?? null,
        weighbridgeSlipUrl: d.weighbridgeSlipUrl ?? null,
        documentUrls: d.documentUrls ?? [],
        status: "DISPATCHED",
        // The sale is an ALLOCATION: nothing physically moves yet. Stock is
        // deducted vehicle by vehicle in the Manager's Outward workflow, which
        // is what allows a single invoice to leave in several loads.
        dispatchedKg: 0,
        dispatchStatus: "PENDING",
        createdById: guard.user.id,
      },
    });

    await tx.receivable.create({
      data: { yardId, saleId: sale.id, buyerId: buyerId!, amount: total, status: "PENDING" },
    });

    return { id: sale.id, invoiceNumber, total, skuName: sku.name, quantityKg: d.quantityKg };
  });

  // Physical stock is unchanged by a sale now, but the sellable figure and the
  // Manager's outward queue both moved, so both still need to refresh.
  publishMany(yardId, [
    { channel: "sales", action: "created", entity: "Sale", entityId: result.id, actorId: guard.user.id },
    { channel: "stock", action: "updated", entity: "Inventory", entityId: sku.id, actorId: guard.user.id },
    { channel: "outward", action: "allocation-created", entity: "Sale", entityId: result.id, actorId: guard.user.id },
  ]);

  return ok(
    {
      sale: {
        invoiceNumber: result.invoiceNumber,
        total: result.total,
        skuName: result.skuName,
        quantityKg: result.quantityKg,
      },
    },
    { status: 201 }
  );
}
