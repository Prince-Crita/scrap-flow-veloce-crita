import { z } from "zod";
import { requireYard, parseBody, ok, MAX_IMAGE_BODY_BYTES } from "@/lib/api";
import { validateImageDataUrl, MAX_DATA_URL_CHARS } from "@/lib/image-validate";
import { tooManyRequests } from "@/lib/rate-limit";
import { rateLimitShared } from "@/lib/rate-limit-shared";
import { awaitOcrReady, ocrStatus, resolveOcrServiceUrl } from "@/lib/ocr-supervisor";
import { snapToKnownPlate, SNAP_HISTORY_LIMIT, SNAP_CONFIDENCE_CEILING } from "@/lib/plate-match";

export const dynamic = "force-dynamic";

/**
 * Per-request ANPR diagnostics, OFF unless `OCR_DEBUG=1`.
 *
 * These lines exist to tell "pointing at the wrong host" from "host is up but
 * rejecting us" — the one thing that was impossible to confirm from outside
 * while the production ANPR path was being diagnosed. They log the endpoint
 * ORIGIN only, never the secret, the image bytes or the plate.
 *
 * They fire on every capture, though, which is log noise a production yard does
 * not need, so they are gated rather than deleted: set `OCR_DEBUG=1` in the
 * environment to bring them back without a deploy. Real failures still go to
 * `console.error` unconditionally.
 */
const trace = (line: string) => {
  if (process.env.OCR_DEBUG === "1") console.log(`[ocr] ${line}`);
};

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

  const body = await parseBody(req, schema, { maxBytes: MAX_IMAGE_BODY_BYTES });
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

  const startedAt = Date.now();
  const origin = url ? safeOrigin(url) : null;
  trace(
    `request received · endpoint=${origin ?? "unresolved"} · hasSecret=${secret.length > 0} · back=${!!body.data.imageBack}`
  );

  if (!url) {
    trace(`skipped · reason=not-configured · ${Date.now() - startedAt}ms`);
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
    trace(
      `not ready · state=${s.state} · detector=${s.components ? JSON.stringify(s.components) : "unknown"} · ${Date.now() - startedAt}ms`
    );
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
    trace(`service responded · status=${res.status} · ${Date.now() - startedAt}ms`);

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
    // Distinguish the 15s abort from a connection failure: "timed out" and
    // "nothing listening / DNS failed" call for completely different fixes, and
    // the old single line could not tell them apart.
    const aborted = e instanceof Error && e.name === "AbortError";
    console.error(
      `[ocr] request failed · endpoint=${origin} · kind=${aborted ? "timeout" : "connect-error"} · ${Date.now() - startedAt}ms ·`,
      e instanceof Error ? e.message : e
    );
    return ok({ plate: null, confidence: 0, crop: null, fallback: true, reason: "OCR service unreachable" });
  }
}

/**
 * Origin of a URL for logging — host and scheme only, never a path, query or
 * credentials, so a diagnostic line can never leak a signed URL or token.
 */
function safeOrigin(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return "invalid-url";
  }
}
