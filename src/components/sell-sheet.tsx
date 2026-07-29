"use client";

import { useRef, useState } from "react";
import { sendJson, newRequestId, ApiError } from "@/lib/fetcher";
import { fmt } from "@/lib/format";
import { PhonePortal } from "@/components/phone-portal";

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

        <div className="totalRow">
          <span>INVOICE TOTAL (incl. GST)</span>
          <b>₹ {fmt(total)}</b>
        </div>

        <button className="cta" disabled={saving} onClick={submit}>
          {saving ? "GENERATING…" : "GENERATE INVOICE · DISPATCH"}
        </button>
        <button className="cta ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
    </PhonePortal>
  );
}
