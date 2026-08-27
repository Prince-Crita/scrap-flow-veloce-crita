"use client";

import { useRef, useState } from "react";
import { sendJson, newRequestId, ApiError } from "@/frontend/lib/api-client";
import { fmt } from "@/shared/format";
import { assetUrl } from "@/shared/config/paths";
import { compressImage } from "@/frontend/lib/image";
import { PhonePortal } from "@/frontend/components/phone-portal";
import { usePhotoSource } from "@/frontend/components/photo-source";
import { CameraSheet } from "@/frontend/components/camera-sheet";

/** One dispatch document slot. `url` is what the sale stores. */
type Doc = { preview: string; url: string } | null;

export type ReadySku = { skuId: string; name: string; icon: string; quantityKg: number; thresholdKg: number };
export type SaleResult = { invoiceNumber: string; total: number; skuName: string; quantityKg: number };

export function SellSheet({
  sku,
  onClose,
  onSold,
}: {
  sku: ReadySku | null;
  onClose: () => void;
  onSold: (r: SaleResult) => void;
}) {
  const [buyerName, setBuyerName] = useState("");
  const [qty, setQty] = useState<string>(sku ? String(sku.thresholdKg) : "0");
  const [rate, setRate] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [driver, setDriver] = useState("");
  const [driverPhone, setDriverPhone] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  /** Idempotency key for the in-flight sale; survives retries, cleared on success. */
  const saleRequestId = useRef<string | null>(null);

  /**
   * Dispatch paperwork. Uploaded the moment it is picked — same
   * compress-then-POST-/api/uploads path the camera sheet uses, so there is one
   * upload implementation in the app — and attached to the sale on submit.
   *
   * The vehicle's two photos come from the existing capture module, opened as a
   * single "Vehicle Photos" entry: it already handles front and back, over
   * camera / gallery / file manager, in one pass.
   */
  const [vehiclePhotos, setVehiclePhotos] = useState<{ frontUrl: string; backUrl: string } | null>(null);
  const [photosOpen, setPhotosOpen] = useState(false);
  const [slipDoc, setSlipDoc] = useState<Doc>(null);
  const [others, setOthers] = useState<{ preview: string; url: string }[]>([]);
  const [docBusy, setDocBusy] = useState<string | null>(null);

  async function upload(file: File, kind: string, index?: number) {
    setDocBusy(kind);
    try {
      const preview = await compressImage(file);
      const res = await sendJson<{ url: string }>("/api/uploads", { dataUrl: preview, kind, index });
      return { preview, url: res.url };
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not upload the file");
      return null;
    } finally {
      setDocBusy(null);
    }
  }

  const slipPick = usePhotoSource(async (f) => setSlipDoc((await upload(f, "weighbridge-slip")) ?? null), {
    title: "Weighbridge slip",
  });
  const otherPick = usePhotoSource(
    async (f) => {
      const d = await upload(f, "sale-document", others.length);
      if (d) setOthers((o) => [...o, d]);
    },
    { title: "Supporting document" }
  );

  if (!sku) return null;

  const qtyN = Number(qty) || 0;
  const rateN = Number(rate) || 0;
  const subtotal = Math.round(qtyN * rateN);
  const gst = Math.round(subtotal * 0.18);
  const total = subtotal + gst;

  async function submit() {
    setErr("");
    if (buyerName.trim().length < 2) return setErr("Enter a buyer name");
    if (qtyN <= 0) return setErr("Enter a valid quantity");
    if (qtyN > sku!.quantityKg) return setErr(`Only ${fmt(sku!.quantityKg)} kg available`);
    if (rateN <= 0) return setErr("Enter a rate per kg");
    setSaving(true);
    // Held across retries so a double tap or a retried request cannot burn a
    // second invoice number and deduct the stock twice.
    const requestId = saleRequestId.current ?? (saleRequestId.current = newRequestId());
    try {
      const res = await sendJson<{ sale: SaleResult }>("/api/sales", {
        clientRequestId: requestId,
        skuId: sku!.skuId,
        buyerName,
        quantityKg: qtyN,
        ratePerKg: rateN,
        gstRate: 18,
        vehicleNumber: vehicle || null,
        driverName: driver || null,
        driverPhone: driverPhone || null,
        frontImageUrl: vehiclePhotos?.frontUrl ?? null,
        backImageUrl: vehiclePhotos?.backUrl ?? null,
        weighbridgeSlipUrl: slipDoc?.url ?? null,
        documentUrls: others.map((o) => o.url),
      });
      saleRequestId.current = null; // retire the key; the next sale gets a fresh one
      onSold(res.sale);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not log sale");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PhonePortal>
    <div className="sheetWrap" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" />
        <div className="sheetTitle">
          Sell · {sku.icon} {sku.name}
        </div>
        <div className="sheetStep">{fmt(sku.quantityKg)} kg in yard · GST 18%</div>
        {err && <p className="hint" style={{ color: "var(--red)" }}>{err}</p>}

        <div className="field">
          <label>Buyer Name *</label>
          <input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} placeholder="Shree Steels" />
        </div>
        <div className="field">
          <label>Quantity (kg) *</label>
          <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" />
        </div>
        <div className="field">
          <label>Rate per kg (₹) *</label>
          <input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" placeholder="33.5" />
        </div>
        <div className="field">
          <label>Vehicle Number</label>
          <input value={vehicle} onChange={(e) => setVehicle(e.target.value.toUpperCase())} placeholder="MH12AB1234" />
        </div>
        <div className="field">
          <label>Driver Name</label>
          <input value={driver} onChange={(e) => setDriver(e.target.value)} placeholder="Ramesh" />
        </div>
        <div className="field">
          <label>Driver Phone</label>
          <input value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} inputMode="tel" />
        </div>

        {/* Dispatch documents. Vehicle Photos opens the existing capture module;
            the slip and any extra document take a camera shot OR a file already
            on the phone, through the same picker used on Inward. */}
        <div className="field">
          <label>
            Dispatch Documents <span className="lblOpt">(camera or gallery)</span>
          </label>
          <div className="captureGrid mat">
            <div className={`capTile${vehiclePhotos ? " filled" : ""}`} onClick={() => setPhotosOpen(true)}>
              {vehiclePhotos ? (
                <>
                  <img src={assetUrl(vehiclePhotos.frontUrl)} alt="vehicle" />
                  <span className="badge">✓ VEHICLE</span>
                </>
              ) : (
                <>
                  <span className="ic">🚚</span>
                  VEHICLE PHOTOS
                </>
              )}
            </div>
            <div className={`capTile${slipDoc ? " filled" : ""}`} onClick={slipPick.pick}>
              {slipDoc ? (
                <>
                  <img src={slipDoc.preview} alt="weighbridge slip" />
                  <span className="badge">✓ SLIP</span>
                </>
              ) : (
                <>
                  <span className="ic">{docBusy === "weighbridge-slip" ? "…" : "🧾"}</span>
                  WEIGHBRIDGE SLIP
                </>
              )}
            </div>
            {others.map((o, i) => (
              <div key={i} className="capTile filled">
                <img src={o.preview} alt={`document ${i + 1}`} />
                <span className="badge">✓ DOC {i + 1}</span>
              </div>
            ))}
            <div className="capTile" onClick={otherPick.pick}>
              <span className="ic">{docBusy === "sale-document" ? "…" : "＋"}</span>
              OTHER DOC
            </div>
          </div>
          <p className="hint">All optional — attach whatever the buyer or transporter needs.</p>
        </div>

        <div className="totalRow">
          <span>INVOICE TOTAL (incl. GST)</span>
          <b>₹ {fmt(total)}</b>
        </div>

        <button className="cta" disabled={saving || !!docBusy} onClick={submit}>
          {saving ? "GENERATING…" : "GENERATE INVOICE · DISPATCH"}
        </button>
        <button className="cta ghost" onClick={onClose}>
          Cancel
        </button>

        {slipPick.node}
        {otherPick.node}

        {/* The existing capture module, front + back only — not a second uploader. */}
        <CameraSheet
          open={photosOpen}
          photosOnly
          title="Vehicle Photos"
          onClose={() => setPhotosOpen(false)}
          onComplete={(d) => {
            setVehiclePhotos({ frontUrl: d.frontUrl, backUrl: d.backUrl });
            setPhotosOpen(false);
          }}
        />
      </div>
    </div>
    </PhonePortal>
  );
}
