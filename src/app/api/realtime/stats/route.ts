import { requireYard, ok } from "@/backend/http/api";
import { busStats } from "@/backend/realtime/realtime";

export const dynamic = "force-dynamic";

/**
 * Realtime transport diagnostics.
 *
 * Exists so "is cross-instance delivery actually working?" is an observable fact
 * rather than an inference from whether the UI looks right. Without it, the
 * failure mode is silent staleness — the hardest kind to notice.
 *
 * Authenticated (any in-yard role) and read-only. It reports counters and the
 * connection state, never a connection string.
 */
export async function GET() {
  const guard = await requireYard();
  if ("res" in guard) return guard.res;
  return ok(busStats());
}
