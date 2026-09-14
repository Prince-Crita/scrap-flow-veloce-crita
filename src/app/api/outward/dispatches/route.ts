import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireYardCapability, parseBody, parseQuery, ok, fail } from "@/backend/http/api";
import { nextCounter, formatDispatch } from "@/backend/services/counters";
import { ensureShortCode } from "@/backend/services/yard-short-code";
import { publishMany } from "@/backend/realtime/realtime";
import { dispatchRef } from "@/shared/load-ref";
import { proofComplete, transitComplete, type DispatchFilter } from "@/shared/dispatch-stage";

export const dynamic = "force-dynamic";

/**
 * The Supervisor dispatch workflow's collection endpoint.
 *
 * GET  — the Active Dispatch tabs and Dispatch History, one query per view.
 * POST — Fleet Management "Update": creates the dispatch, and nothing else in
 *        the workflow ever creates one. Every later stage PATCHes this record
 *        through `[id]`, so one dispatch keeps one id and one reference from
 *        the first screen to the last.
 *
 * Guarded by `outward.dispatch`, which is MANAGER + ADMIN — the same capability
 * the allocation flow already uses, so no permission was widened. `requireYard`
 * inside it supplies the tenant-scoped client, so a dispatch can only ever be
 * read or written inside the yard the caller is acting in.
 */

/** Everything a list row needs. Shared so the two views cannot drift apart. */
const LIST_SELECT = {
  id: true,
  dispatchNumber: true,
  vehicleNumber: true,
  vehicleType: true,
  driverName: true,
  driverPhone: true,
  totalKg: true,
  stage: true,
  state: true,
  dispatchedAt: true,
  filledImageUrl: true,
  loadedSlipUrl: true,
  proofById: true,
  invoiceUrl: true,
  createdAt: true,
  dispatchedBy: { select: { name: true } },
  lines: { orderBy: { sequence: "asc" }, select: { materialLabel: true, quantityKg: true, ratePerKg: true } },
} satisfies Prisma.OutwardLoadSelect;

const listQuery = z.object({
  filter: z.enum(["ALL", "ACTIVE", "IN_TRANSIT", "COMPLETED"]).optional().default("ALL"),
  /** History is the completed view; kept separate so the cap can differ. */
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export async function GET(req: Request) {
  const guard = await requireYardCapability("outward.dispatch");
  if ("res" in guard) return guard.res;
  const { prisma, yardId } = guard;

  const q = parseQuery(req, listQuery);
  if ("res" in q) return q.res;
  const filter = q.data.filter as DispatchFilter;

  // The yard's short code does not depend on the dispatches, so the two run
  // together rather than costing this list two serial round trips.
  const [yard, rows] = await Promise.all([
    prisma.yard.findUnique({ where: { id: yardId }, select: { shortCode: true, yardCode: true } }),
    prisma.outwardLoad.findMany({
      relationLoadStrategy: "join",
      where: filter === "ALL" ? {} : { state: filter },
      orderBy: { createdAt: "desc" },
      take: q.data.limit,
      select: LIST_SELECT,
    }),
  ]);
  const shortCode = yard?.shortCode ?? yard?.yardCode ?? "";

  return ok({
    dispatches: rows.map((r) => ({
      id: r.id,
      ref: dispatchRef({ shortCode, dispatchNumber: r.dispatchNumber }),
      dispatchNumber: r.dispatchNumber,
      vehicleNumber: r.vehicleNumber,
      vehicleType: r.vehicleType,
      driverName: r.driverName,
      driverPhone: r.driverPhone,
      totalKg: r.totalKg,
      stage: r.stage,
      state: r.state,
      dispatchedAt: r.dispatchedAt,
      createdAt: r.createdAt,
      dispatchedBy: r.dispatchedBy?.name ?? null,
      // The facts `currentStage()` needs to place this on the rail, sent
      // rather than recomputed on the client from a partial line list.
      lineCount: r.lines.length,
      hasTransit: transitComplete({ dispatchedAt: r.dispatchedAt, filledImageUrl: r.filledImageUrl }),
      hasProof: proofComplete({ loadedSlipUrl: r.loadedSlipUrl, proofById: r.proofById }),
      invoiceUrl: r.invoiceUrl,
      materials: r.lines.map((l) => ({
        label: l.materialLabel ?? "Material",
        kg: l.quantityKg,
        ratePerKg: l.ratePerKg,
      })),
    })),
  });
}

/**
 * Fleet Management → Update.
 *
 * Required here and not later, because these four facts are what make the
 * record a dispatch at all: a vehicle, who is driving it, how to reach them,
 * and what kind of vehicle it is.
 */
const createSchema = z.object({
  /** Idempotency key per Update tap — a double tap must not open two dispatches. */
  clientRequestId: z.string().min(8).max(64),
  vehicleNumber: z.string().trim().min(1).max(20),
  vehicleType: z.string().trim().min(1).max(30),
  driverName: z.string().trim().min(1).max(80),
  driverPhone: z.string().trim().min(1).max(15),
  ocrConfidence: z.number().min(0).max(1).optional().nullable(),
  frontImageUrl: z.string().max(600).optional().nullable(),
  backImageUrl: z.string().max(600).optional().nullable(),
  emptySlipUrl: z.string().max(600).optional().nullable(),
});

export async function POST(req: Request) {
  const guard = await requireYardCapability("outward.dispatch");
  if ("res" in guard) return guard.res;
  const { prisma, yardId, user } = guard;

  const body = await parseBody(req, createSchema);
  if ("res" in body) return body.res;
  const d = body.data;

  const shortCode = (await ensureShortCode(prisma, yardId)) ?? "";

  /**
   * Replay check BEFORE the transaction, with the composite unique as the race
   * backstop. Tapping Update twice on a slow connection must return the
   * dispatch that already exists, never open a second one against the same
   * vehicle — which is exactly the corruption §31 asks to prevent.
   */
  const existing = await prisma.outwardLoad.findFirst({
    where: { clientRequestId: d.clientRequestId },
    select: { id: true, dispatchNumber: true },
  });
  if (existing) {
    return ok({
      dispatch: { id: existing.id, ref: dispatchRef({ shortCode, dispatchNumber: existing.dispatchNumber }) },
      replayed: true,
    });
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Atomic increment inside the transaction — never "read the latest + 1".
      const seq = await nextCounter(tx, yardId, "dispatch");
      return tx.outwardLoad.create({
        data: {
          yardId,
          clientRequestId: d.clientRequestId,
          dispatchNumber: formatDispatch(seq),
          vehicleNumber: d.vehicleNumber,
          vehicleType: d.vehicleType,
          driverName: d.driverName,
          driverPhone: d.driverPhone,
          ocrConfidence: d.ocrConfidence ?? null,
          frontImageUrl: d.frontImageUrl ?? null,
          backImageUrl: d.backImageUrl ?? null,
          emptySlipUrl: d.emptySlipUrl ?? null,
          totalKg: 0,
          // Fleet is done, nothing is loaded: ACTIVE, awaiting materials.
          stage: "FLEET",
          state: "ACTIVE",
          dispatchedById: user.id,
        },
        select: { id: true, dispatchNumber: true },
      });
    });

    publishMany(yardId, [
      { channel: "outward", action: "created", entity: "OutwardLoad", entityId: created.id, actorId: user.id },
    ]);
    return ok(
      {
        dispatch: {
          id: created.id,
          ref: dispatchRef({ shortCode, dispatchNumber: created.dispatchNumber }),
        },
      },
      { status: 201 }
    );
  } catch (e) {
    // The unique index caught a genuine race: return the winner, not an error.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const won = await prisma.outwardLoad.findFirst({
        where: { clientRequestId: d.clientRequestId },
        select: { id: true, dispatchNumber: true },
      });
      if (won) {
        return ok({
          dispatch: { id: won.id, ref: dispatchRef({ shortCode, dispatchNumber: won.dispatchNumber }) },
          replayed: true,
        });
      }
    }
    throw e;
  }
}
