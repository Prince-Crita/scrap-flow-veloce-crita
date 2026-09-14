"use client";

import { useRef, useState } from "react";
import { compressImage } from "@/frontend/lib/image";
import { sendJson } from "@/frontend/lib/api-client";
import { PhonePortal } from "@/frontend/components/phone-portal";

export type CaptureData = {
  frontUrl: string;
  backUrl: string;
  plate: string;
  confidence: number;
  driverName: string;
  /**
   * Collected in `vehicle` mode only — the Inward flow, which is the one that
   * has a column to put it in (`InwardLoad.driverPhone`). Empty from every other
   * mode, so no caller is handed a value it would silently drop.
   */
  driverPhone: string;
  vehicleType: string;
  materialUrls: string[];
};

type Slot = { preview: string; url: string } | null;

const VEHICLE_TYPES = [
  "3-Wheeler",
  "4-Wheel Pickup",
  "6-Wheel Truck",
  "10-Wheel Truck",
  "12-Wheel Truck",
  "Trailer",
  "Other",
];

function useUploader() {
  return async (file: File, kind: string, index?: number): Promise<{ preview: string; url: string }> => {
    const preview = await compressImage(file);
    const res = await sendJson<{ url: string }>("/api/uploads", { dataUrl: preview, kind, index });
    return { preview, url: res.url };
  };
}

/**
 * Which of the three capture steps a caller wants.
 *
 * The steps themselves — the tiles, the uploader, the ANPR call, the plate
 * field — are identical in every mode. A mode only decides which of them are
 * entered and what the finish button commits, so there is exactly one camera
 * implementation and one OCR implementation in the application.
 *
 *   full      1 → 2 → 3   the original flow (kept for Outward)
 *   photos    1           Sell: two vehicle photos, plate/driver collected elsewhere
 *   vehicle   1 → 2       Inward: vehicle images, then plate + driver + type
 *   materials 3           Inward: material images for the material being weighed
 */
export type CaptureMode = "full" | "photos" | "vehicle" | "materials";

export function CameraSheet({
  open,
  onClose,
  onComplete,
  photosOnly,
  mode,
  title,
  initialMaterialUrls,
}: {
  open: boolean;
  onClose: () => void;
  onComplete: (data: CaptureData) => void;
  /**
   * Front + back photos only — step 1, and nothing after it.
   *
   * The Sell page needs the vehicle's two photos and already collects the plate
   * and the driver in its own form, so walking it through the plate-reading and
   * material-image steps would ask for the same things twice. This is the SAME
   * component, the same tiles and the same upload path; the OCR flow is simply
   * not entered. `onComplete` still returns a CaptureData, with the fields this
   * mode does not collect left empty.
   *
   * Kept as its own prop so the existing Sell caller reads unchanged; it is just
   * `mode="photos"` spelled the way it always was.
   */
  photosOnly?: boolean;
  /** See `CaptureMode`. Defaults to the original three-step flow. */
  mode?: CaptureMode;
  /** Overrides the step-1 heading; the default is the full capture flow's. */
  title?: string;
  /**
   * `materials` mode only: images already attached for this material, so
   * re-opening the sheet adds to the set instead of starting it again. The
   * stored `/uploads/...` path doubles as the tile preview — it is served by the
   * session-gated upload route, so an <img> resolves it exactly like the data
   * URL a fresh capture produces.
   */
  initialMaterialUrls?: string[];
}) {
  const flow: CaptureMode = mode ?? (photosOnly ? "photos" : "full");
  const upload = useUploader();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [front, setFront] = useState<Slot>(null);
  const [back, setBack] = useState<Slot>(null);
  const [plate, setPlate] = useState("");
  const [confidence, setConfidence] = useState(0);
  const [plateCrop, setPlateCrop] = useState<string | null>(null);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrNote, setOcrNote] = useState("");
  const [driverName, setDriverName] = useState("");
  const [driverPhone, setDriverPhone] = useState("");
  const [vehicleType, setVehicleType] = useState("");
  const [materials, setMaterials] = useState<{ preview: string; url: string }[]>(() =>
    (initialMaterialUrls ?? []).map((url) => ({ preview: url, url }))
  );
  const [busy, setBusy] = useState(false);

  const frontRef = useRef<HTMLInputElement>(null);
  const backRef = useRef<HTMLInputElement>(null);
  const matRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  /**
   * Which step is on screen. `materials` mode has only one, so it is pinned
   * rather than navigated to — otherwise `reset()` would drop the sheet back on
   * the vehicle tiles the mode exists to avoid.
   */
  const activeStep = flow === "materials" ? 3 : step;

  function reset() {
    setStep(1);
    setFront(null);
    setBack(null);
    setPlate("");
    setConfidence(0);
    setPlateCrop(null);
    setOcrNote("");
    setDriverName("");
    setDriverPhone("");
    setVehicleType("");
    setMaterials([]);
  }

  // Runs ANPR on both images. The service tries the front first, falls back to
  // the rear, then fuses both — two independent reads that agree are the
  // strongest evidence available and are surfaced as such.
  // Tiered UX: ≥80% success · 50–79% warning · <50% manual confirmation.
  // Manual entry is ALWAYS available; OCR never gates the workflow.
  async function runOcr(frontImg: string, backImg?: string) {
    setOcrRunning(true);
    setOcrNote("");
    try {
      const res = await sendJson<{
        plate: string | null;
        confidence: number;
        crop?: string | null;
        source?: string | null;
        agreed?: boolean;
        fallback: boolean;
      }>("/api/ocr", { image: frontImg, imageBack: backImg });
      const src = res.agreed ? " (front + back agree)" : res.source ? ` (${res.source})` : "";
      const pctTxt = res.confidence ? ` · ${Math.round(res.confidence * 100)}%` : "";
      if (res.plate) {
        setPlate(res.plate);
        setConfidence(res.confidence);
        setPlateCrop(res.crop ?? null);
        if (res.confidence >= 0.8) setOcrNote(`✓ Detected${src}${pctTxt} — looks good.`);
        else if (res.confidence >= 0.5) setOcrNote(`⚠ Detected${src}${pctTxt} — please verify the number.`);
        else setOcrNote(`Low confidence${src}${pctTxt} — please confirm the number manually.`);
      } else {
        setOcrNote("Couldn't read the plate automatically — enter it manually.");
      }
    } catch {
      setOcrNote("OCR unavailable — enter the number manually.");
    } finally {
      setOcrRunning(false);
    }
  }

  async function onFront(file: File) {
    setBusy(true);
    try {
      setFront(await upload(file, "vehicle-front"));
    } finally {
      setBusy(false);
    }
  }
  async function onBack(file: File) {
    setBusy(true);
    try {
      setBack(await upload(file, "vehicle-back"));
    } finally {
      setBusy(false);
    }
  }
  async function onMaterial(file: File) {
    setBusy(true);
    try {
      const s = await upload(file, "material", materials.length);
      setMaterials((m) => [...m, s]);
    } finally {
      setBusy(false);
    }
  }

  function goToPlateStep() {
    setStep(2);
    if (front) void runOcr(front.preview, back?.preview);
  }

  /** Everything step 2 needs before the vehicle can be confirmed. */
  const vehicleReady = plate.trim().length > 0 && driverName.trim().length > 0 && vehicleType !== "";
  const canFinish = !!front && !!back && plate.trim().length > 0 && materials.length >= 1;

  /** What each mode hands back. Fields a mode does not collect stay empty. */
  function completeVehicle() {
    onComplete({
      frontUrl: front!.url,
      backUrl: back!.url,
      plate: plate.trim(),
      confidence,
      driverName: driverName.trim(),
      driverPhone: driverPhone.trim(),
      vehicleType,
      materialUrls: [],
    });
    reset();
  }
  function completeMaterials() {
    onComplete({
      frontUrl: "",
      backUrl: "",
      plate: "",
      confidence: 0,
      driverName: "",
      driverPhone: "",
      vehicleType: "",
      materialUrls: materials.map((m) => m.url),
    });
  }

  return (
    <PhonePortal>
      <div className="sheetWrap" onClick={onClose}>
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <div className="sheetHandle" />

        {/*
          `capture="environment"` is deliberately ABSENT.

          That attribute does not mean "offer the camera" — it means "use the
          camera and nothing else". iOS and Android honour it by launching the
          rear camera directly, with no way to reach Photos/Gallery or Files, so
          a slip already photographed (or one sent over WhatsApp, or a re-upload
          after a failed save) could not be attached at all.

          With only `accept="image/*"`, both mobile platforms show their native
          chooser — Take Photo *and* Photo Library / Files — so live capture is
          still one tap and the gallery becomes reachable. Desktop is unaffected:
          it ignored `capture` and opened a file picker either way.
        */}
        <input ref={frontRef} type="file" accept="image/*" hidden
          onChange={(e) => e.target.files?.[0] && onFront(e.target.files[0])} />
        <input ref={backRef} type="file" accept="image/*" hidden
          onChange={(e) => e.target.files?.[0] && onBack(e.target.files[0])} />
        <input ref={matRef} type="file" accept="image/*" hidden
          onChange={(e) => e.target.files?.[0] && onMaterial(e.target.files[0])} />

        {activeStep === 1 && (
          <>
            <div className="sheetTitle">{title ?? (flow === "vehicle" ? "Vehicle Image" : "Vehicle Capture")}</div>
            <div className="sheetStep">
              {flow === "photos"
                ? "Front & back of the vehicle"
                : flow === "vehicle"
                  ? "Step 1 of 2 · front & back images (both required)"
                  : "Step 1 of 3 · front & back images (both required)"}
            </div>
            <div className="captureGrid">
              <div className={`capTile${front ? " filled" : ""}`} onClick={() => frontRef.current?.click()}>
                {front ? (
                  <>
                    <img src={front.preview} alt="front" />
                    <span className="badge">✓ FRONT</span>
                  </>
                ) : (
                  <>
                    <span className="ic">📷</span>
                    FRONT
                  </>
                )}
              </div>
              <div className={`capTile${back ? " filled" : ""}`} onClick={() => backRef.current?.click()}>
                {back ? (
                  <>
                    <img src={back.preview} alt="back" />
                    <span className="badge">✓ BACK</span>
                  </>
                ) : (
                  <>
                    <span className="ic">📷</span>
                    BACK
                  </>
                )}
              </div>
            </div>
            <p className="hint">Tap a tile to open the camera or pick from gallery. Both images are mandatory.</p>
            {flow === "photos" ? (
              <button
                className="cta"
                disabled={!front || !back || busy}
                onClick={() => {
                  onComplete({
                    frontUrl: front!.url,
                    backUrl: back!.url,
                    // Not collected in this mode; the caller's own form owns them.
                    plate: "",
                    confidence: 0,
                    driverName: "",
                    driverPhone: "",
                    vehicleType: "",
                    materialUrls: [],
                  });
                  reset();
                }}
              >
                {busy ? "UPLOADING…" : "✓ ATTACH PHOTOS"}
              </button>
            ) : (
              <button className="cta" disabled={!front || !back || busy} onClick={goToPlateStep}>
                {busy ? "UPLOADING…" : "NEXT · READ NUMBER PLATE"}
              </button>
            )}
            <button className="cta ghost" onClick={onClose}>
              Cancel
            </button>
          </>
        )}

        {activeStep === 2 && (
          <>
            <div className="sheetTitle">Vehicle Details</div>
            <div className="sheetStep">
              {flow === "vehicle" ? "Step 2 of 2" : "Step 2 of 3"} · plate auto-detected · driver &amp; type required
            </div>

            {plateCrop && (
              <div className="plateCrop">
                <img src={plateCrop} alt="detected plate" />
              </div>
            )}

            <div className="field">
              <label>Vehicle Number *</label>
              <div className="plateBox">
                <input
                  value={plate}
                  onChange={(e) => setPlate(e.target.value.toUpperCase())}
                  placeholder={ocrRunning ? "Reading…" : "Enter vehicle number"}
                />
                {confidence > 0 && (
                  <span className="conf" style={{ color: confidence < 0.8 ? "var(--orange)" : "var(--led)" }}>
                    {Math.round(confidence * 100)}%
                  </span>
                )}
              </div>
            </div>
            {ocrNote && (
              <p
                className="hint"
                style={{
                  color:
                    confidence >= 0.8
                      ? "var(--led)"
                      : confidence >= 0.5
                        ? "var(--orange)"
                        : confidence > 0
                          ? "var(--red)"
                          : "var(--orange)",
                }}
              >
                {ocrNote}
              </p>
            )}
            <button className="cta ghost" disabled={ocrRunning || !front}
              onClick={() => front && runOcr(front.preview, back?.preview)}>
              {ocrRunning ? "SCANNING…" : "↻ Retry scan"}
            </button>

            <div className="field">
              <label>Driver Name *</label>
              <input value={driverName} onChange={(e) => setDriverName(e.target.value)} placeholder="Enter driver name" />
            </div>
            {/*
              Rendered only in the flow that can store it. Outward runs this same
              step in `full` mode and has no column for a driver's phone, so
              showing the field there would collect a number and throw it away.

              `type="tel"` + `inputMode="tel"` is the same pairing the Sell
              sheet's driver phone already uses — the numeric keypad on a phone,
              and no spell-check or autocapitalise. Optional, like the Sell one:
              it is contact detail, not something to block a load on.
            */}
            {flow === "vehicle" && (
              <div className="field">
                <label>Driver Phone Number</label>
                <input
                  value={driverPhone}
                  onChange={(e) => setDriverPhone(e.target.value)}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  maxLength={15}
                  placeholder="Enter driver phone"
                />
              </div>
            )}
            <div className="field">
              <label>Vehicle Type *</label>
              <select value={vehicleType} onChange={(e) => setVehicleType(e.target.value)}>
                <option value="">Select vehicle type</option>
                {VEHICLE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            {/* The vehicle flow ends here: confirming the number IS the finish,
                because material images belong to the material being weighed and
                are captured from the Materials card instead. */}
            {flow === "vehicle" ? (
              <button className="cta" disabled={!vehicleReady || busy} onClick={completeVehicle}>
                {busy ? "UPLOADING…" : "✓ CONFIRM VEHICLE"}
              </button>
            ) : (
              <button className="cta" disabled={!vehicleReady} onClick={() => setStep(3)}>
                NEXT · MATERIAL IMAGES
              </button>
            )}
            <button className="cta ghost" onClick={() => setStep(1)}>
              Back
            </button>
          </>
        )}

        {activeStep === 3 && (
          <>
            <div className="sheetTitle">Material Images</div>
            <div className="sheetStep">
              {flow === "materials"
                ? `${title ?? "This material"} · at least 1 (2+ recommended)`
                : "Step 3 of 3 · at least 1 (2+ recommended)"}
            </div>
            <div className="captureGrid mat">
              {materials.map((m, i) => (
                <div key={i} className="capTile filled">
                  <img src={m.preview} alt={`material ${i + 1}`} />
                </div>
              ))}
              <div className="capTile" onClick={() => matRef.current?.click()}>
                <span className="ic">＋</span>
                ADD
              </div>
            </div>
            <p className="hint">
              {materials.length} image(s) captured for {flow === "materials" ? "this material" : "this load"}.
            </p>
            {flow === "materials" ? (
              <button className="cta" disabled={materials.length === 0 || busy} onClick={completeMaterials}>
                {busy ? "UPLOADING…" : "✓ ATTACH MATERIAL IMAGES"}
              </button>
            ) : (
              <button
                className="cta"
                disabled={!canFinish || busy}
                onClick={() => {
                  onComplete({
                    frontUrl: front!.url,
                    backUrl: back!.url,
                    plate: plate.trim(),
                    confidence,
                    driverName: driverName.trim(),
                    driverPhone: "",
                    vehicleType,
                    materialUrls: materials.map((m) => m.url),
                  });
                  reset();
                }}
              >
                {busy ? "UPLOADING…" : "✓ ATTACH TO LOAD"}
              </button>
            )}
            <button className="cta ghost" onClick={() => (flow === "materials" ? onClose() : setStep(2))}>
              {flow === "materials" ? "Close" : "Back"}
            </button>
          </>
        )}
        </div>
      </div>
    </PhonePortal>
  );
}
