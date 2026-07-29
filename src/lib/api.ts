import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { auth } from "@/auth";
import type { Role } from "@prisma/client";
import { scopedDb, adminDb, type ScopedDb } from "@/lib/tenant";
import { can, type Capability } from "@/lib/permissions";
import { IMPERSONATION_COOKIE, verifyImpersonationToken } from "@/lib/impersonation";

export type SessionUser = {
  id: string;
  role: Role;
  yardId: string | null;
  mustChangePassword: boolean;
  name?: string | null;
  email?: string | null;
};

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function fail(code: string, message: string, status = 400, fields?: Record<string, string>) {
  return NextResponse.json({ error: { code, message, fields } }, { status });
}

export async function getUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user) return null;
  return session.user as SessionUser;
}

export async function requireUser(): Promise<{ user: SessionUser } | { res: NextResponse }> {
  const user = await getUser();
  if (!user) return { res: fail("UNAUTHENTICATED", "Login required", 401) };
  return { user };
}

/**
 * The acting yard for this request.
 *
 * OWNER/MANAGER  → their own `yardId` from the signed JWT. Never from input.
 * ADMIN          → only inside an active, signed "Enter Yard" session.
 *
 * Returns the impersonation session id when present so writes can be tied to it.
 */
async function resolveActingYard(
  user: SessionUser
): Promise<{ yardId: string; impersonationSid: string | null } | null> {
  if (user.role !== "ADMIN") {
    return user.yardId ? { yardId: user.yardId, impersonationSid: null } : null;
  }

  const jar = await cookies();
  const claims = await verifyImpersonationToken(jar.get(IMPERSONATION_COOKIE)?.value);
  if (!claims) return null;

  // A cookie minted for a different admin is inert.
  if (claims.adminId !== user.id) return null;

  // The session row must still be open — this is what makes "revoke" work.
  const session = await adminDb.impersonationSession.findUnique({
    where: { id: claims.sid },
    select: { id: true, yardId: true, adminId: true, endedAt: true },
  });
  if (!session || session.endedAt || session.adminId !== user.id || session.yardId !== claims.yardId) {
    return null;
  }

  return { yardId: claims.yardId, impersonationSid: claims.sid };
}

export type YardContext = {
  user: SessionUser;
  yardId: string;
  /** Yard-scoped client. Alias this as `prisma` in handlers. */
  prisma: ScopedDb;
  /** Non-null when an ADMIN is acting inside this yard. */
  impersonationSid: string | null;
};

/**
 * Guard for every yard-scoped route. Returns a Prisma client that physically
 * cannot read or write another yard's rows.
 */
export async function requireYard(): Promise<YardContext | { res: NextResponse }> {
  const user = await getUser();
  if (!user) return { res: fail("UNAUTHENTICATED", "Login required", 401) };

  const acting = await resolveActingYard(user);
  if (!acting) {
    if (user.role === "ADMIN") {
      return {
        res: fail("NO_YARD_CONTEXT", "Open a yard first (Enter Yard) to use this endpoint", 409),
      };
    }
    return { res: fail("NO_YARD", "Your account is not assigned to a yard", 403) };
  }

  return {
    user,
    yardId: acting.yardId,
    prisma: scopedDb(acting.yardId),
    impersonationSid: acting.impersonationSid,
  };
}

/** Yard-scoped AND requires a capability (e.g. sale.create → OWNER or ADMIN). */
export async function requireYardCapability(
  cap: Capability
): Promise<YardContext | { res: NextResponse }> {
  const ctx = await requireYard();
  if ("res" in ctx) return ctx;
  if (!can(ctx.user.role, cap)) {
    return { res: fail("FORBIDDEN", "You do not have access to this action", 403) };
  }
  return ctx;
}

/** Owner-level actions inside a yard. ADMIN inherits these while impersonating. */
export function requireOwnerYard(): Promise<YardContext | { res: NextResponse }> {
  return requireYardCapability("sale.create");
}

export type AdminContext = { user: SessionUser; prisma: typeof adminDb };

/** Platform console guard. Unscoped client — every use is deliberate + audited. */
export async function requireAdmin(): Promise<AdminContext | { res: NextResponse }> {
  const user = await getUser();
  if (!user) return { res: fail("UNAUTHENTICATED", "Login required", 401) };
  if (user.role !== "ADMIN") return { res: fail("FORBIDDEN", "Admin access required", 403) };
  return { user, prisma: adminDb };
}

export async function parseBody<T extends z.ZodTypeAny>(
  req: Request,
  schema: T
): Promise<{ data: z.infer<T> } | { res: NextResponse }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { res: fail("BAD_JSON", "Invalid JSON body", 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fields[issue.path.join(".")] = issue.message;
    }
    return { res: fail("VALIDATION", "Please check the highlighted fields", 422, fields) };
  }
  return { data: parsed.data };
}

/** Parses `?a=1&b=2` against a schema. Used by admin list endpoints. */
export function parseQuery<T extends z.ZodTypeAny>(
  req: Request,
  schema: T
): { data: z.infer<T> } | { res: NextResponse } {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join(".")] = issue.message;
    return { res: fail("VALIDATION", "Invalid query parameters", 422, fields) };
  }
  return { data: parsed.data };
}
