"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson, newRequestId, ApiError } from "@/frontend/lib/api-client";
import { compressImage } from "@/frontend/lib/image";
import { useUI } from "@/frontend/components/ui-provider";
import { usePhotoSource } from "@/frontend/components/photo-source";
import { CameraSheet, type CaptureData } from "@/frontend/components/camera-sheet";
import { useInvalidateChannels } from "@/frontend/components/realtime/provider";
import { DispatchStepHeader } from "@/frontend/components/dispatch-flow";

/**
 * Fleet Management — step 1 of the dispatch workflow.
 *
 * A page, not a dialog: it is the first of four screens, and on a phone a stack
 * of dialogs that deep cannot be backed out of predictably. As a route it gets
 * the device Back button, survives a refresh, and can be linked to.
 *
 * The vehicle capture is the EXACT Inward implementation — the same
 * `CameraSheet` in `mode="vehicle"`, which is the same two tiles, the same
 * `/api/uploads` path, the same `/api/ocr` call, the same plate/driver/type
 * fields and the same manual-entry fallback. No second OCR module exists, and
 * the file inputs carry `accept="image/*"` WITHOUT `capture`, which is what
 * lets a phone offer both the camera and the gallery.
 */
export default function NewDispatchPage() {
  const router = useRouter();
  const { toast } = useUI();
  const invalidateChannels = useInvalidateChannels();

  const [capture, setCapture] = useState<CaptureData | null>(null);
  const [vehicleOpen, setVehicleOpen] = useState(false);
  const [slip, setSlip] = useState<{ url: string; name: string } | null>(null);
  const [slipBusy, setSlipBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  /** One key per Update attempt, held across retries — see the API's replay check. */
  const requestId = useRef<string | null>(null);
  /**
   * A synchronous in-flight latch.
   *
   * `disabled={saving}` alone is not sufficient: `setSaving(true)` is batched,
   * so two taps landing in the same React tick both read the old value and both
   * enter. The idempotency key already stops that becoming two dispatches — the
   * second request replays and returns the first one — but sending it at all is
   * wasted work on a yard's connection, and a ref flips immediately.
   */
  const inFlight = useRef(false);

  /** The same camera-or-gallery control Inward uses for its slip. */
  const slipPicker = usePhotoSource((f) => void onSlipPicked(f), { title: "Empty weighbridge slip" });

  async function onSlipPicked(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast("Slip must be an image");
      return;
    }
    setSlipBusy(true);
    try {
      const dataUrl = await compressImage(file);
      const res = await sendJson<{ url: string }>("/api/uploads", { dataUrl, kind: "weighbridge-slip" });
      setSlip({ url: res.url, name: file.name });
      toast("🧾 Empty slip attached");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not upload slip");
    } finally {
      setSlipBusy(false);
    }
  }

  const ready = !!capture && !!capture.plate && !!capture.driverName && !!capture.driverPhone && !!capture.vehicleType;

  async function save() {
    if (!capture) {
      toast("🚚 Add vehicle details first");
      setVehicleOpen(true);
      return;
    }
    if (!capture.driverPhone) {
      toast("Driver phone number is required");
      setVehicleOpen(true);
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    // Held across retries so a second tap or a retried request returns the
    // dispatch that already exists instead of opening a second one.
    const key = requestId.current ?? (requestId.current = newRequestId());
    try {
      const res = await sendJson<{ dispatch: { id: string; ref: string }; replayed?: boolean }>(
        "/api/outward/dispatches",
        {
          clientRequestId: key,
          vehicleNumber: capture.plate,
          vehicleType: capture.vehicleType,
          driverName: capture.driverName,
          driverPhone: capture.driverPhone,
          ocrConfidence: capture.confidence || null,
          frontImageUrl: capture.frontUrl || null,
          backImageUrl: capture.backUrl || null,
          emptySlipUrl: slip?.url ?? null,
        }
      );
      requestId.current = null;
      invalidateChannels("outward");
      toast(`✓ Dispatch ${res.dispatch.ref} is now active`);
      // Straight into materials. `replace`, not `push`: Back from Material
      // Entry should return to Outward, not re-open a Fleet form for a
      // dispatch that already exists.
      router.replace(`/outward/${res.dispatch.id}/materials`);
    } catch (e) {
      // Released only on failure: on success the page navigates away, and the
      // latch stays closed so a tap landing during the transition cannot fire
      // a second create.
      inFlight.current = false;
      toast(e instanceof ApiError ? e.message : "Could not create the dispatch");
      setSaving(false);
    }
  }

  return (
    <>
      <DispatchStepHeader title="Fleet Management" step="FLEET" backHref="/outward" />

      <div className="entryCard">
        <div className="pickField">
          <label>Vehicle</label>
          <div className={`pickCtl${capture ? " filled" : ""}`} onClick={() => setVehicleOpen(true)}>
            <span className="pickCtlVal">
              {capture ? `${capture.plate} · ${capture.vehicleType}` : "Scan / Add Vehicle Details"}
            </span>
            {capture && (
              <button
                className="pickClear"
                title="Clear vehicle"
                onClick={(e) => {
                  e.stopPropagation();
                  setCapture(null);
                }}
              >
                ✕
              </button>
            )}
            <span className="pickCaret">›</span>
          </div>
          {capture?.driverName && (
            <p className="hint">
              Driver · {capture.driverName}
              {capture.driverPhone ? ` · ${capture.driverPhone}` : ""}
            </p>
          )}
        </div>

        {/* The empty slip, immediately above Update — the same upload control,
            the same endpoint and the same kind Inward already uses. */}
        <div className="pickField" style={{ marginTop: 14 }}>
          <label>Upload Empty Weighbridge Slip</label>
          <div className={`pickCtl${slip ? " filled" : ""}`} onClick={() => !slipBusy && slipPicker.pick()}>
            <span className="pickCtlVal">
              {slipBusy ? "Uploading…" : slip ? "✓ Empty slip attached" : "Add Empty Weight Proof"}
            </span>
            {slip && (
              <button
                className="pickClear"
                title="Remove slip"
                onClick={(e) => {
                  e.stopPropagation();
                  setSlip(null);
                }}
              >
                ✕
              </button>
            )}
            <span className="pickCaret">›</span>
          </div>
        </div>

        <button className="cta" disabled={saving} onClick={save}>
          {saving ? "SAVING…" : "UPDATE · START DISPATCH"}
        </button>
        {!ready && (
          <p className="hint" style={{ color: "var(--orange)" }}>
            Vehicle number, driver name, driver phone and vehicle type are all required.
          </p>
        )}
      </div>

      {slipPicker.node}

      {/* Image → ANPR → number → confirm. The SAME sheet and the SAME /api/ocr
          call as Inward; `mode="vehicle"` is what makes it stop after the
          driver step instead of asking for material images. */}
      <CameraSheet
        open={vehicleOpen}
        mode="vehicle"
        onClose={() => setVehicleOpen(false)}
        onComplete={(data) => {
          setCapture(data);
          setVehicleOpen(false);
          toast(`✓ ${data.plate} confirmed`);
        }}
      />
    </>
  );
}
