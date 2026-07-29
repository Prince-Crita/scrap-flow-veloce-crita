"use client";

import { useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { getJson, sendJson, newRequestId, ApiError } from "@/lib/fetcher";
import { fmt } from "@/lib/format";
import { UNITS, toKilograms, type UnitCode } from "@/lib/units";
import { useUI } from "@/components/ui-provider";
import { CameraSheet, type CaptureData } from "@/components/camera-sheet";
import { VendorSheet, type VendorLite } from "@/components/vendor-sheet";
import { MaterialSheet } from "@/components/material-sheet";
import { RecentLoads } from "@/components/recent-loads";
import { useInvalidateChannels } from "@/components/realtime/provider";

type Material = { id: string; code: string; name: string; materialId?: string | null; active?: boolean };

/** One "Add To Load" tap: a material and its weight, already in kilograms. */
type CartItem = { key: string; skuId: string; label: string; kg: number; unit: UnitCode };

export default function InwardPage() {
  const { data: session } = useSession();
  const isOwner = session?.user?.role === "OWNER";
  const { toast, party, bump, confirm } = useUI();
  const invalidateChannels = useInvalidateChannels();

  const vendorsQ = useQuery({ queryKey: ["vendors"], queryFn: () => getJson<{ vendors: VendorLite[] }>("/api/vendors") });
  const materialsQ = useQuery({ queryKey: ["materials"], queryFn: () => getJson<{ materials: Material[] }>("/api/materials") });

  const [vendorId, setVendorId] = useState<string | null>(null);
  const [materialId, setMaterialId] = useState<string | null>(null);
  const [led, setLed] = useState("0");
  const [unit, setUnit] = useState<UnitCode>("KG");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [capture, setCapture] = useState<CaptureData | null>(null);
  /** Idempotency key for the in-flight SAVE LOAD; survives retries, cleared on success. */
  const saveRequestId = useRef<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [vendorOpen, setVendorOpen] = useState(false);
  const [materialOpen, setMaterialOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [slip, setSlip] = useState<{ url: string; name: string } | null>(null);
  const [slipBusy, setSlipBusy] = useState(false);
  const slipInput = useRef<HTMLInputElement | null>(null);
  const [capturePrompt, setCapturePrompt] = useState(false);
  const promptTmr = useRef<ReturnType<typeof setTimeout> | null>(null);

  function promptCapture() {
    setCameraOpen(false);
    setCapturePrompt(true);
    if (promptTmr.current) clearTimeout(promptTmr.current);
    promptTmr.current = setTimeout(() => setCapturePrompt(false), 3200);
  }

  async function deleteVendor(v: VendorLite) {
    const ok = await confirm({
      title: "Deactivate vendor",
      message: `Deactivate "${v.name}"? Historical records are kept and you can restore it later.`,
      confirmLabel: "Deactivate",
      danger: true,
    });
    if (!ok) return;
    try {
      await sendJson(`/api/vendors/${v.id}`, undefined, "DELETE");
      if (vendorId === v.id) setVendorId(null);
      invalidateChannels("vendors");
      toast(`Vendor "${v.name}" deactivated`);
    } catch {
      toast("Could not deactivate vendor");
    }
  }

  async function deleteMaterial(m: Material) {
    const ok = await confirm({
      title: "Deactivate material",
      message: `Deactivate "${m.name}"? It will be hidden from inward. Stock and history are kept.`,
      confirmLabel: "Deactivate",
      danger: true,
    });
    if (!ok) return;
    try {
      await sendJson(`/api/materials/${m.id}`, undefined, "DELETE");
      if (materialId === m.id) setMaterialId(null);
      invalidateChannels("materials", "stock");
      toast(`Material "${m.name}" deactivated`);
    } catch {
      toast("Could not deactivate material");
    }
  }

  const vendors = vendorsQ.data?.vendors ?? [];
  const materials = materialsQ.data?.materials ?? [];
  const activeMaterialId = materialId ?? materials[0]?.id ?? null;
  const activeMaterial = materials.find((m) => m.id === activeMaterialId);
  const captureComplete = !!capture;
  const total = cart.reduce((a, b) => a + b.kg, 0);

  function num(n: number) {
    setLed((l) => (l.length < 6 ? (l === "0" ? String(n) : l + n) : l));
  }
  function clr() {
    setLed("0");
  }
  function back() {
    setLed((l) => (l.length > 1 ? l.slice(0, -1) : "0"));
  }

  /** Adds the current material + reading to the load cart. Nothing is committed
   *  until SAVE LOAD, so an item can still be removed. */
  function onAddWt() {
    if (!captureComplete) {
      promptCapture();
      return;
    }
    const reading = Number(led);
    if (!reading) {
      toast("Enter a weight first");
      return;
    }
    if (!activeMaterialId || !activeMaterial) {
      toast("Select a material first");
      return;
    }
    const kg = toKilograms(reading, unit);
    if (kg <= 0) {
      toast("Weight is too small to record");
      return;
    }
    setCart((c) => [
      ...c,
      { key: `${Date.now()}-${c.length}`, skuId: activeMaterialId, label: activeMaterial.name, kg, unit },
    ]);
    setLed("0");
    toast(`⚖️ ${activeMaterial.name} · ${fmt(kg)} kg added · +5 XP`);
    void bump(5);
  }

  function removeCartItem(key: string) {
    setCart((c) => c.filter((i) => i.key !== key));
  }

  /** Stores the weighbridge ticket now; it is attached to the load on save. */
  async function onSlipPicked(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast("Slip must be an image");
      return;
    }
    setSlipBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error("read failed"));
        r.readAsDataURL(file);
      });
      const res = await sendJson<{ url: string }>("/api/uploads", { dataUrl, kind: "weighbridge-slip" });
      setSlip({ url: res.url, name: file.name });
      toast("🧾 Weighbridge slip attached");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not upload slip");
    } finally {
      setSlipBusy(false);
      if (slipInput.current) slipInput.current.value = "";
    }
  }

  async function saveLoad() {
    if (!total) {
      toast("Add at least one weighment");
      return;
    }
    if (!captureComplete) {
      toast("📷 Capture required before saving");
      setCameraOpen(true);
      return;
    }
    setSaving(true);
    // One key per save attempt, held across retries: if the operator taps twice
    // or the request is retried on a poor connection, the server recognises the
    // replay and returns the original lot instead of double-counting the stock.
    const requestId = saveRequestId.current ?? (saveRequestId.current = newRequestId());
    try {
      const res = await sendJson<{ load: { lotNumber: string; totalKg: number; materialLabel: string } }>(
        "/api/inward/loads",
        {
          clientRequestId: requestId,
          // Always kilograms — the unit selector converts before anything is
          // added to the cart, so no unit ever reaches the server.
          lines: cart.map((i) => ({ skuId: i.skuId, kg: i.kg })),
          vendorId,
          vehicleNumber: capture!.plate,
          vehicleType: capture!.vehicleType,
          driverName: capture!.driverName,
          ocrConfidence: capture!.confidence || null,
          frontImageUrl: capture!.frontUrl,
          backImageUrl: capture!.backUrl,
          materialImageUrls: capture!.materialUrls,
          weighbridgeSlipUrl: slip?.url ?? null,
        }
      );
      // Succeeded: retire this key so the NEXT load gets a fresh one.
      saveRequestId.current = null;
      setCart([]);
      setCapture(null);
      setSlip(null);
      setLed("0");
      // Exactly the channels POST /api/inward/loads publishes. Hand-listing the
      // keys is what let this drift: it was missing `sellReady` and
      // `stockSources`, both of which a new load moves.
      invalidateChannels("inward", "stock", "sort");
      await bump(50);
      party("📦", "LOAD SAVED!", `${fmt(res.load.totalKg)} kg ${res.load.materialLabel} · lot ${res.load.lotNumber}`, "+50 XP");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not save load");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="secTitle">Inward · Weight Entry</div>

      {/* Vendor chips */}
      <div className="chips">
        {vendors.map((v) => (
          <div key={v.id} className={`chip${vendorId === v.id ? " on" : ""}`} onClick={() => setVendorId(v.id)}>
            {v.name}
            {isOwner && (
              <span
                className="chipX"
                title="Deactivate vendor"
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteVendor(v);
                }}
              >
                ✕
              </span>
            )}
          </div>
        ))}
        {isOwner && (
          <div className="chip" onClick={() => setVendorOpen(true)}>
            + Vendor
          </div>
        )}
      </div>

      {/* Material chips */}
      <div className="chips">
        {materials.map((m) => (
          <div
            key={m.id}
            className={`chip${activeMaterialId === m.id ? " on" : ""}`}
            onClick={() => setMaterialId(m.id)}
          >
            {m.name}
            {isOwner && (
              <span
                className="chipX"
                title="Deactivate material"
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteMaterial(m);
                }}
              >
                ✕
              </span>
            )}
          </div>
        ))}
        {isOwner && (
          <div className="chip" onClick={() => setMaterialOpen(true)}>
            + Add Material
          </div>
        )}
      </div>

      {/* LED */}
      <div className="led">
        <div className="val">{fmt(Number(led))}</div>
        <div className="unit">
          <span>SCALE · MANUAL</span>
          {/* The unit is a display/entry concern only: the reading is converted
              to kilograms the moment it is added to the cart. */}
          <select
            className="unitSel"
            value={unit}
            onChange={(e) => setUnit(e.target.value as UnitCode)}
            aria-label="Weight unit"
          >
            {UNITS.map((u) => (
              <option key={u.code} value={u.code}>
                {u.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!captureComplete && (
        <p className="hint" style={{ marginTop: 10, color: "var(--orange)" }}>
          📷 Tap the camera key to capture vehicle &amp; material before adding weight.
        </p>
      )}
      {captureComplete && (
        <p className="hint" style={{ marginTop: 10, color: "var(--led)" }}>
          ✓ Captured · vehicle {capture!.plate} · {capture!.materialUrls.length} material image(s)
        </p>
      )}

      {/* Keypad */}
      <div className="pad">
        <button className="key" onClick={() => num(7)}>7</button>
        <button className="key" onClick={() => num(8)}>8</button>
        <button className="key" onClick={() => num(9)}>9</button>
        <button className="key fn" onClick={clr}>CLR</button>
        <button className="key" onClick={() => num(4)}>4</button>
        <button className="key" onClick={() => num(5)}>5</button>
        <button className="key" onClick={() => num(6)}>6</button>
        <button className="key fn" onClick={back}>⌫</button>
        <button className="key" onClick={() => num(1)}>1</button>
        <button className="key" onClick={() => num(2)}>2</button>
        <button className="key" onClick={() => num(3)}>3</button>
        <button className={`key add${!captureComplete ? " locked" : ""}`} onClick={onAddWt}>ADD<br />TO LOAD</button>
        <button className="key" style={{ gridColumn: "span 2" }} onClick={() => num(0)}>0</button>
        <button className={`key fn${capturePrompt ? " needsCapture" : ""}`} onClick={() => setCameraOpen(true)}>📷</button>
        {capturePrompt && <div className="captureTip">Complete vehicle verification first</div>}
      </div>

      {/* Load cart — uncommitted. Items can be removed until SAVE LOAD. */}
      <div className="entries">
        {cart.map((item, i) => (
          <div key={item.key} className="entry">
            <span>
              {i + 1}. {item.label}
            </span>
            <b>
              {fmt(item.kg)} kg
              {item.unit !== "KG" && <em className="entryUnit"> · entered in {item.unit}</em>}
            </b>
            <button
              className="entryX"
              aria-label={`Remove ${item.label}`}
              title="Remove from load"
              onClick={() => removeCartItem(item.key)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="totalRow">
        <span>TOTAL LOAD</span>
        <b>{fmt(total)} kg</b>
      </div>

      <button className="cta" disabled={saving || !captureComplete || total === 0} onClick={saveLoad}>
        {saving ? "SAVING…" : "SAVE LOAD · +50 XP"}
      </button>
      <input
        ref={slipInput}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => void onSlipPicked(e.target.files?.[0])}
      />
      <button className="cta ghost" disabled={slipBusy} onClick={() => slipInput.current?.click()}>
        {slipBusy ? "Uploading…" : slip ? "✓ Slip attached · replace" : "Upload weighbridge slip"}
      </button>

      <RecentLoads />


      <CameraSheet
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onComplete={(data) => {
          setCapture(data);
          setCameraOpen(false);
          toast("✓ Capture attached · you can add weights now");
        }}
      />
      <VendorSheet
        open={vendorOpen}
        onClose={() => setVendorOpen(false)}
        onCreated={(v) => {
          invalidateChannels("vendors");
          setVendorId(v.id);
          toast(`Vendor "${v.name}" added`);
        }}
      />
      <MaterialSheet
        open={materialOpen}
        onClose={() => setMaterialOpen(false)}
        onCreated={(m) => {
          invalidateChannels("materials", "stock");
          setMaterialId(m.id);
          toast(`Material "${m.name}" added`);
        }}
      />
    </>
  );
}
