"use client";

import { useRef, useState } from "react";
import { compressImage } from "@/lib/image";
import { sendJson } from "@/lib/fetcher";
import { PhonePortal } from "@/components/phone-portal";

export type CaptureData = {
  frontUrl: string;
  backUrl: string;
  plate: string;
  confidence: number;
  driverName: string;
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

export function CameraSheet({
  open,
  onClose,
  onComplete,
}: {
  open: boolean;
  onClose: () => void;
  onComplete: (data: CaptureData) => void;
}) {
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
  const [vehicleType, setVehicleType] = useState("");
  const [materials, setMaterials] = useState<{ preview: string; url: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const frontRef = useRef<HTMLInputElement>(null);
  const backRef = useRef<HTMLInputElement>(null);
  const matRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  function reset() {
    setStep(1);
    setFront(null);
    setBack(null);
    setPlate("");
    setConfidence(0);
    setPlateCrop(null);
    setOcrNote("");
    setDriverName("");
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

  const canFinish = !!front && !!back && plate.trim().length > 0 && materials.length >= 1;

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

        {step === 1 && (
          <>
            <div className="sheetTitle">Vehicle Capture</div>
            <div className="sheetStep">Step 1 of 3 · front &amp; back images (both required)</div>
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
            <button className="cta" disabled={!front || !back || busy} onClick={goToPlateStep}>
              {busy ? "UPLOADING…" : "NEXT · READ NUMBER PLATE"}
            </button>
            <button className="cta ghost" onClick={onClose}>
              Cancel
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <div className="sheetTitle">Vehicle Details</div>
            <div className="sheetStep">Step 2 of 3 · plate auto-detected · driver &amp; type required</div>

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
                  placeholder={ocrRunning ? "Reading…" : "MH12AB1234"}
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
              <input value={driverName} onChange={(e) => setDriverName(e.target.value)} placeholder="Ramesh Kumar" />
            </div>
            <div className="field">
              <label>Vehicle Type *</label>
              <select value={vehicleType} onChange={(e) => setVehicleType(e.target.value)}>
                <option value="">Select type…</option>
                {VEHICLE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <button
              className="cta"
              disabled={plate.trim().length === 0 || driverName.trim().length === 0 || vehicleType === ""}
              onClick={() => setStep(3)}
            >
              NEXT · MATERIAL IMAGES
            </button>
            <button className="cta ghost" onClick={() => setStep(1)}>
              Back
            </button>
          </>
        )}

        {step === 3 && (
          <>
            <div className="sheetTitle">Material Images</div>
            <div className="sheetStep">Step 3 of 3 · at least 1 (2+ recommended)</div>
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
            <p className="hint">{materials.length} image(s) captured for this load.</p>
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
                  vehicleType,
                  materialUrls: materials.map((m) => m.url),
                });
                reset();
              }}
            >
              {busy ? "UPLOADING…" : "✓ ATTACH TO LOAD"}
            </button>
            <button className="cta ghost" onClick={() => setStep(2)}>
              Back
            </button>
          </>
        )}
        </div>
      </div>
    </PhonePortal>
  );
}
