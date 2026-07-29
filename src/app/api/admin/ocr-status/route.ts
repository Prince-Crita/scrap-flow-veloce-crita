import { requireAdmin, ok } from "@/lib/api";
import { ocrStatus } from "@/lib/ocr-supervisor";

export const dynamic = "force-dynamic";

/**
 * OCR service health, for the admin console.
 *
 * Admin-only: it names the interpreter path and dependency errors, which is
 * operational detail a yard user has no use for and should not see.
 *
 * Read-only and cheap — it returns the supervisor's cached view rather than
 * probing, so polling this from a status widget could never load the model
 * process. (The console does not poll it; it arrives with the dashboard.)
 */
export async function GET() {
  const guard = await requireAdmin();
  if ("res" in guard) return guard.res;
  return ok({ ocr: ocrStatus() });
}
