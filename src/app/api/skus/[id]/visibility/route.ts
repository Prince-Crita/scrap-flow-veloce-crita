import { z } from "zod";
import { requireYardCapability, parseBody, ok, fail } from "@/lib/api";
import { publish } from "@/lib/realtime";

const schema = z.object({ visible: z.boolean() });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireYardCapability("sku.visibility");
  if ("res" in guard) return guard.res;
  const { prisma, yardId } = guard;

  const body = await parseBody(req, schema);
  if ("res" in body) return body.res;

  const { id } = await ctx.params;
  const sku = await prisma.sku.findUnique({ where: { id } });
  if (!sku) return fail("NOT_FOUND", "SKU not found", 404);

  await prisma.sku.update({ where: { id }, data: { visible: body.data.visible } });

  publish(yardId, { channel: "stock", action: "updated", entity: "Sku", entityId: id, actorId: guard.user.id });
  return ok({ id, visible: body.data.visible });
}
