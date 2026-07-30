import { z } from "zod";
import { requireYard, parseBody, ok } from "@/lib/api";
import { validateImageDataUrl, MAX_DATA_URL_CHARS } from "@/lib/image-validate";
import { tooManyRequests } from "@/lib/rate-limit";
import { rateLimitShared } from "@/lib/rate-limit-shared";
import { awaitOcrReady, ocrStatus, resolveOcrServiceUrl } from "@/lib/ocr-supervisor";
import { snapToKnownPlate, SNAP_HISTORY_LIMIT, SNAP_CONFIDENCE_CEILING } from "@/lib/plate-match";

export const dynamic = "force-dynamic";

const schema = z.object({
  image: z.string().startsWith("data:image/").max(MAX_DATA_URL_CHARS),
  imageBack: z.string().startsWith("data:image/").max(MAX_DATA_URL_CHARS).optional().nullable(),
});

/**
 * Proxies the front vehicle image to the FastAPI ANPR service.
 * OCR is assistive: any failure degrades gracefully to manual entry
 * (fallback:true) and never blocks the yard workflow.
 */
export async function POST(req: Request) {
  // Yard-gated like the rest of the inward flow, so an account without a yard
  // context cannot burn OCR capacity.
  const guard = await requireYard();
  if ("res" in guard) return guard.res;

  // The most expensive endpoint in the app: several GPU-class OCR passes per
  // image, and now up to two images per call. Limited per user so one stuck
  // retry loop cannot starve the rest of the yard.
  const limit = await rateLimitShared("ocr", guard.user.id);
  if (!limit.ok) return tooManyRequests(limit, "OCR");

  const body = await parseBody(req, schema);
  if ("res" in body) return body.res;

  // Verify both images are genuinely images before shipping megabytes to the
  // OCR service. Degrades to manual entry rather than erroring — OCR is
  // assistive and must never block the yard workflow.
  const front = validateImageDataUrl(body.data.image);
  if (!front.ok) {
    return ok({ plate: null, confidence: 0, crop: null, fallback: true, reason: front.message });
  }
  if (body.data.imageBack) {
    const back = validateImageDataUrl(body.data.imageBack);
    if (!back.ok) {
      return ok({ plate: null, confidence: 0, crop: null, fallback: true, reason: back.message });
    }
  }

  /**
   * Resolved, not read raw: `resolveOcrServiceUrl()` also rejects a loopback URL
   * when running on Vercel, where no sidecar can exist on localhost. Reading the
   * env var directly meant a leftover `http://localhost:8000` was still dialled
   * on every capture, burning the fetch timeout before falling back. Recognition
   * logic below is untouched — only how the endpoint is resolved changed.
   */
  const url = resolveOcrServiceUrl();
  const secret = process.env.OCR_SERVICE_SECRET ?? "";
  if (!url) {
    return ok({ plate: null, confidence: 0, crop: null, fallback: true, reason: "OCR service not configured" });
  }

  /**
   * Hold the request briefly if the service is still coming up.
   *
   * A capture taken seconds after a deploy should not drop the operator into
   * manual entry just because the model was still loading. Bounded at a few
   * seconds — waiting on a spinner is worse than typing six characters — and any
   * other state (disabled, dependencies missing) returns immediately.
   */
  const ready = await awaitOcrReady();
  if (!ready) {
    const s = ocrStatus();
    return ok({
      plate: null,
      confidence: 0,
      crop: null,
      fallback: true,
      reason: `OCR service ${s.state}: ${s.detail}`,
    });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(`${url.replace(/\/$/, "")}/anpr`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ocr-secret": secret },
      body: JSON.stringify({ image: body.data.image, image_back: body.data.imageBack ?? null }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return ok({ plate: null, confidence: 0, crop: null, fallback: true, reason: `OCR service ${res.status}` });
    }
    const json = (await res.json()) as {
      plate?: string;
      confidence?: number;
      crop?: string;
      source?: string;
      agreed?: boolean;
      attempts?: number;
    };
    /**
     * Last accuracy stage: correct a hesitant read against this yard's own fleet.
     *
     * Runs here rather than in the Python service because it needs the database,
     * and the tenant-scoped client is what guarantees one yard cannot correct a
     * plate using another yard's history. Skipped entirely when the service is
     * already confident, so the common case costs nothing.
     */
    let plate = json.plate ?? null;
    let confidence = json.confidence ?? 0;
    let snapped = false;
    if (plate && confidence < SNAP_CONFIDENCE_CEILING) {
      try {
        const seen = await guard.prisma.inwardLoad.findMany({
          where: { vehicleNumber: { not: "" } },
          select: { vehicleNumber: true },
          distinct: ["vehicleNumber"],
          orderBy: { createdAt: "desc" },
          take: SNAP_HISTORY_LIMIT,
        });
        const snap = snapToKnownPlate(
          plate,
          confidence,
          seen.map((l) => l.vehicleNumber ?? "")
        );
        if (snap) {
          plate = snap.plate;
          confidence = snap.confidence;
          snapped = snap.snapped;
        }
      } catch (e) {
        // Assistive on top of assistive — never let it cost the operator the read.
        console.error("[ocr] plate history lookup failed; using the raw read", e);
      }
    }

    return ok({
      plate,
      confidence,
      crop: json.crop ?? null,
      source: json.source ?? null,
      /** True when a vehicle already seen in this yard corrected the read. */
      snapped,
      // Front and back independently read the same plate — the strongest
      // signal the service can offer, so the UI can say so.
      agreed: json.agreed ?? false,
      // How many preprocessing passes it took. A rising average is the early
      // warning that camera placement or lighting has drifted.
      attempts: json.attempts ?? 0,
      fallback: false,
    });
  } catch (e) {
    console.error("OCR proxy error", e);
    return ok({ plate: null, confidence: 0, crop: null, fallback: true, reason: "OCR service unreachable" });
  }
}
