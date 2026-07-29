import { adminDb } from "@/lib/tenant";
import type { Prisma } from "@prisma/client";

/**
 * Append-only audit trail for privileged actions.
 *
 * Rules:
 *  - Never blocks or fails the operation it describes. An audit write that
 *    throws must not roll back a legitimate business transaction, so failures
 *    are logged and swallowed. (If audit becomes a compliance hard requirement,
 *    pass a `tx` and let it participate in the transaction instead.)
 *  - Stores the changed field subset, not whole rows.
 *  - Never stores secrets: passwordHash and anything password-shaped is stripped.
 */

const REDACTED = "[redacted]";
const SECRET_KEYS = /pass|secret|token|hash/i;

type Json = Prisma.InputJsonValue;

function scrub(value: unknown): Json | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object") return value as Json;
  if (Array.isArray(value)) return value.map((v) => scrub(v) ?? null) as Json;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.test(k)) out[k] = REDACTED;
    else if (v instanceof Date) out[k] = v.toISOString();
    else if (v && typeof v === "object") out[k] = scrub(v) ?? null;
    else out[k] = v ?? null;
  }
  return out as Json;
}

/** Only the fields that actually changed, so the trail stays readable. */
export function diffFields<T extends Record<string, unknown>>(
  before: T | null,
  after: Partial<T>
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(after)) {
    const prev = before ? before[k] : undefined;
    const same =
      prev instanceof Date && v instanceof Date ? prev.getTime() === v.getTime() : prev === v;
    if (!same) {
      if (before) b[k] = prev ?? null;
      a[k] = v ?? null;
    }
  }
  return { before: b, after: a };
}

export type AuditInput = {
  action: string;
  entity: string;
  entityId?: string | null;
  /** Yard the action affected. Null for genuinely platform-wide actions. */
  yardId?: string | null;
  actorId?: string | null;
  before?: unknown;
  after?: unknown;
  req?: Request;
};

function clientMeta(req?: Request) {
  if (!req) return { ip: null, userAgent: null };
  const h = req.headers;
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    null;
  return { ip, userAgent: h.get("user-agent") };
}

export async function audit(input: AuditInput): Promise<void> {
  try {
    const { ip, userAgent } = clientMeta(input.req);
    await adminDb.auditLog.create({
      data: {
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        yardId: input.yardId ?? null,
        actorId: input.actorId ?? null,
        before: scrub(input.before),
        after: scrub(input.after),
        ip,
        userAgent,
      },
    });
  } catch (e) {
    // Deliberately non-fatal — see the contract in this file's header.
    console.error("[audit] failed to record", input.action, input.entity, e);
  }
}
