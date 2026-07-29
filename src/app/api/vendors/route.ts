import { z } from "zod";
import { requireYard, requireYardCapability, parseBody, ok } from "@/lib/api";
import { publish } from "@/lib/realtime";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guard = await requireYard();
  if ("res" in guard) return guard.res;
  const { prisma } = guard;

  const includeInactive = new URL(req.url).searchParams.get("all") === "1";
  const vendors = await prisma.vendor.findMany({
    where: includeInactive ? undefined : { active: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, gstNumber: true, phone: true, active: true },
  });
  return ok({ vendors });
}

const createSchema = z.object({
  name: z.string().min(2).max(120),
  gstNumber: z.string().max(20).optional().or(z.literal("")),
  phone: z.string().max(15).optional().or(z.literal("")),
  address: z.string().max(300).optional().or(z.literal("")),
});

export async function POST(req: Request) {
  const guard = await requireYardCapability("vendor.write");
  if ("res" in guard) return guard.res;
  const { prisma, yardId } = guard;

  const body = await parseBody(req, createSchema);
  if ("res" in body) return body.res;

  const vendor = await prisma.vendor.create({
    data: {
      yardId,
      name: body.data.name.trim(),
      gstNumber: body.data.gstNumber || null,
      phone: body.data.phone || null,
      address: body.data.address || null,
      createdById: guard.user.id,
    },
    select: { id: true, name: true, gstNumber: true, phone: true },
  });

  publish(yardId, {
    channel: "vendors",
    action: "created",
    entity: "Vendor",
    entityId: vendor.id,
    actorId: guard.user.id,
  });

  return ok({ vendor }, { status: 201 });
}
