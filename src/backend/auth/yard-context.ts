import { cookies } from "next/headers";
import { auth } from "@/backend/auth/auth";
import { adminDb } from "@/backend/db/tenant";
import { IMPERSONATION_COOKIE, verifyImpersonationToken } from "@/backend/auth/impersonation";
import type { Role } from "@prisma/client";

/**
 * Server-component counterpart to `requireYard` in src/backend/http/api.ts.
 *
 * Pages need the same answer the API guards give — "which yard is this request
 * operating on, and is an admin standing in?" — but they need it as data for
 * rendering rather than as a guarded Prisma client. Both derive tenancy the
 * same way: signed session for OWNER/MANAGER, signed cookie + open
 * ImpersonationSession row for ADMIN.
 */
export type PageYardContext = {
  user: { id: string; name?: string | null; email?: string | null; role: Role };
  yardId: string;
  yardName: string;
  yardCode: string;
  /** True only when an ADMIN is acting inside this yard. */
  impersonating: boolean;
  impersonationSid: string | null;
  impersonationStartedAt: Date | null;
};

export async function getYardContext(): Promise<PageYardContext | null> {
  const session = await auth();
  if (!session?.user) return null;
  const user = session.user;

  if (user.role !== "ADMIN") {
    if (!user.yardId) return null;
    const yard = await adminDb.yard.findUnique({
      where: { id: user.yardId },
      select: { id: true, yardName: true, yardCode: true, active: true },
    });
    if (!yard || !yard.active) return null;
    return {
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      yardId: yard.id,
      yardName: yard.yardName,
      yardCode: yard.yardCode,
      impersonating: false,
      impersonationSid: null,
      impersonationStartedAt: null,
    };
  }

  // ADMIN: only inside an active Enter Yard session.
  const jar = await cookies();
  const claims = await verifyImpersonationToken(jar.get(IMPERSONATION_COOKIE)?.value);
  if (!claims || claims.adminId !== user.id) return null;

  const imp = await adminDb.impersonationSession.findUnique({
    where: { id: claims.sid },
    select: {
      id: true,
      startedAt: true,
      endedAt: true,
      adminId: true,
      yardId: true,
      yard: { select: { id: true, yardName: true, yardCode: true } },
    },
  });
  if (!imp || imp.endedAt || imp.adminId !== user.id || imp.yardId !== claims.yardId) return null;

  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    yardId: imp.yard.id,
    yardName: imp.yard.yardName,
    yardCode: imp.yard.yardCode,
    impersonating: true,
    impersonationSid: imp.id,
    impersonationStartedAt: imp.startedAt,
  };
}
