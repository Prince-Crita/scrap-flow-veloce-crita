import { z } from "zod";
import { cookies } from "next/headers";
import { requireAdmin, parseBody, ok, fail } from "@/backend/http/api";
import { audit } from "@/backend/services/audit";
import {
  IMPERSONATION_COOKIE,
  IMPERSONATION_TTL_SECONDS,
  signImpersonationToken,
  verifyImpersonationToken,
  impersonationCookieOptions,
} from "@/backend/auth/impersonation";

export const dynamic = "force-dynamic";

const enterSchema = z.object({ yardId: z.string().min(1) });

function clientMeta(req: Request) {
  const h = req.headers;
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null,
    userAgent: h.get("user-agent"),
  };
}

/**
 * POST — Enter Yard.
 *
 * Opens an ImpersonationSession row, then mints a short-lived signed cookie
 * carrying that row's id. From this point the ordinary yard API guards treat the
 * admin exactly like that yard's Owner, so the mobile UI works unchanged.
 *
 * Only one session may be open per admin: entering a second yard closes the
 * first, so "who is inside which yard right now" always has one answer.
 *
 * The yard's own Owner and Manager receive no signal of any kind — no realtime
 * event is published, no row they can read is written, and the cookie is
 * httpOnly and scoped to the admin's own browser.
 */
export async function POST(req: Request) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma, user } = guard;

  const body = await parseBody(req, enterSchema);
  if ("res" in body) return body.res;

  const yard = await prisma.yard.findUnique({
    where: { id: body.data.yardId },
    select: { id: true, yardName: true, yardCode: true, active: true },
  });
  if (!yard) return fail("NOT_FOUND", "Yard not found", 404);
  if (!yard.active) return fail("YARD_INACTIVE", "Reactivate the yard before entering it", 409);

  const { ip, userAgent } = clientMeta(req);
  const now = new Date();

  // Close any session this admin left open, so state stays unambiguous.
  const stale = await prisma.impersonationSession.findMany({
    where: { adminId: user.id, endedAt: null },
    select: { id: true, startedAt: true, yardId: true },
  });
  for (const s of stale) {
    await prisma.impersonationSession.update({
      where: { id: s.id },
      data: {
        endedAt: now,
        durationSec: Math.max(0, Math.round((now.getTime() - s.startedAt.getTime()) / 1000)),
        endReason: "superseded",
      },
    });
    await audit({
      action: "impersonation.exit",
      entity: "ImpersonationSession",
      entityId: s.id,
      yardId: s.yardId,
      actorId: user.id,
      after: { endReason: "superseded" },
      req,
    });
  }

  const session = await prisma.impersonationSession.create({
    data: { adminId: user.id, yardId: yard.id, ip, userAgent, startedAt: now },
  });

  const token = await signImpersonationToken({
    yardId: yard.id,
    sid: session.id,
    adminId: user.id,
  });

  const jar = await cookies();
  jar.set(IMPERSONATION_COOKIE, token, impersonationCookieOptions(IMPERSONATION_TTL_SECONDS));

  await audit({
    action: "impersonation.enter",
    entity: "ImpersonationSession",
    entityId: session.id,
    yardId: yard.id,
    actorId: user.id,
    after: {
      adminName: user.name,
      adminEmail: user.email,
      yardName: yard.yardName,
      yardCode: yard.yardCode,
      startedAt: session.startedAt.toISOString(),
      expiresInSec: IMPERSONATION_TTL_SECONDS,
    },
    req,
  });

  return ok({
    entered: true,
    sessionId: session.id,
    yard: { id: yard.id, yardName: yard.yardName, yardCode: yard.yardCode },
    startedAt: session.startedAt.toISOString(),
    expiresInSec: IMPERSONATION_TTL_SECONDS,
  });
}

/**
 * DELETE — Exit Yard. Closes the session, records the duration, clears the cookie.
 * Idempotent: exiting when not inside a yard is a success, not an error.
 */
export async function DELETE(req: Request) {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma, user } = guard;

  const jar = await cookies();
  const claims = await verifyImpersonationToken(jar.get(IMPERSONATION_COOKIE)?.value);

  // Always clear the cookie, even if the row is already closed or the token was
  // junk — leaving a stale cookie behind would keep redirecting the admin.
  jar.set(IMPERSONATION_COOKIE, "", impersonationCookieOptions(0));

  if (!claims || claims.adminId !== user.id) return ok({ exited: true, alreadyClosed: true });

  const session = await prisma.impersonationSession.findUnique({ where: { id: claims.sid } });
  if (!session || session.endedAt) return ok({ exited: true, alreadyClosed: true });

  const endedAt = new Date();
  const durationSec = Math.max(0, Math.round((endedAt.getTime() - session.startedAt.getTime()) / 1000));

  await prisma.impersonationSession.update({
    where: { id: session.id },
    data: { endedAt, durationSec, endReason: "manual" },
  });

  await audit({
    action: "impersonation.exit",
    entity: "ImpersonationSession",
    entityId: session.id,
    yardId: session.yardId,
    actorId: user.id,
    after: {
      adminName: user.name,
      startedAt: session.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSec,
      endReason: "manual",
    },
    req,
  });

  return ok({ exited: true, durationSec });
}

/** GET — the caller's current session, for banner state after a reload. */
export async function GET() {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  const { prisma, user } = guard;

  const jar = await cookies();
  const claims = await verifyImpersonationToken(jar.get(IMPERSONATION_COOKIE)?.value);
  if (!claims || claims.adminId !== user.id) return ok({ active: null });

  const session = await prisma.impersonationSession.findUnique({
    where: { id: claims.sid },
    include: { yard: { select: { id: true, yardName: true, yardCode: true } } },
  });
  if (!session || session.endedAt) return ok({ active: null });

  return ok({
    active: {
      sessionId: session.id,
      yard: session.yard,
      startedAt: session.startedAt.toISOString(),
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    },
  });
}
