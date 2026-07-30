import { z } from "zod";
import { requireYard, parseBody, ok, fail } from "@/lib/api";
import { storeImage, StorageNotConfiguredError } from "@/lib/storage";
import { validateImageDataUrl, MAX_DATA_URL_CHARS } from "@/lib/image-validate";
import { tooManyRequests } from "@/lib/rate-limit";
import { rateLimitShared } from "@/lib/rate-limit-shared";

export const dynamic = "force-dynamic";

const schema = z.object({
  /**
   * Capped here as the first line of defence so an oversized body is rejected
   * by the schema before any of it is decoded. `validateImageDataUrl` then does
   * the real work: arithmetic size check, then file-signature detection.
   */
  dataUrl: z.string().startsWith("data:image/").max(MAX_DATA_URL_CHARS),
  kind: z.enum(["vehicle-front", "vehicle-back", "material", "scale", "weighbridge-slip"]),
  lotNumber: z.string().max(40).optional(),
  index: z.number().int().min(0).max(50).optional(),
});

export async function POST(req: Request) {
  const guard = await requireYard();
  if ("res" in guard) return guard.res;

  // Keyed on the user: an authenticated caller cannot dodge the limit by
  // changing IP, and one abusive account cannot lock out the whole yard.
  const limit = await rateLimitShared("upload", guard.user.id);
  if (!limit.ok) return tooManyRequests(limit, "upload");

  const body = await parseBody(req, schema);
  if ("res" in body) return body.res;

  // The client's MIME type is never trusted. Format and extension both come
  // from the bytes' own signature.
  const verified = validateImageDataUrl(body.data.dataUrl);
  if (!verified.ok) return fail(verified.code, verified.message, 422);

  try {
    const stored = await storeImage(verified.bytes, {
      // Yard comes from the session, never the request body.
      yardId: guard.yardId,
      lotNumber: body.data.lotNumber,
      kind: body.data.kind,
      index: body.data.index,
      format: verified.format,
    });
    return ok({ url: stored.url, bytes: verified.byteLength, format: verified.format });
  } catch (e) {
    // Misconfiguration, not a bug: say which variable is missing and answer 503
    // so the caller can tell "fix your settings" from "this broke". Same JSON
    // envelope as every other failure — the endpoint's contract is unchanged.
    if (e instanceof StorageNotConfiguredError) {
      console.error("[upload] storage not configured:", e.message);
      return fail("STORAGE_NOT_CONFIGURED", e.message, 503);
    }
    console.error("upload failed", e);
    return fail("UPLOAD_FAILED", "Could not store image", 500);
  }
}
