"use client";

import { useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { getJson, sendJson, newRequestId, ApiError } from "@/lib/fetcher";
import { fmt } from "@/lib/format";
import { UNITS, toKilograms, type UnitCode } from "@/lib/units";
import { useUI } from "@/components/ui-provider";
import { PhonePortal } from "@/components/phone-portal";
import { usePhotoSource } from "@/components/photo-source";
import { CameraSheet, type CaptureData } from "@/components/camera-sheet";
import { VendorSheet, type VendorLite } from "@/components/vendor-sheet";
import { MaterialSheet } from "@/components/material-sheet";
import { RecentLoads } from "@/components/recent-loads";
import { useInvalidateChannels } from "@/components/realtime/provider";

type Material = { id: string; code: string; name: string; materialId?: string | null; active?: boolean };

/** One "Add To Load" tap: a material and its weight, already in kilograms. */
type CartItem = { key: string; skuId: string; label: string; kg: number; unit: UnitCode };

/**
 * Tap-to-open list picker, used for both Vendor and Material.
 *
 * Replaces the two chip rows: the same options, the same selection handler,
 * moved behind one control so the entry card stays three actions wide however
 * many vendors or materials a yard has. Creating a new one lives inside the
 * picker (`onAdd`) rather than as a separate button on the page.
 */
function PickerSheet<T extends { id: string; name: string }>({
  title,
  subtitle,
  options,
  activeId,
  onPick,
  onClose,
  onDelete,
  addLabel,
  onAdd,
  noneLabel,
}: {
  title: string;
  subtitle: string;
  options: T[];
  activeId: string | null;
  onPick: (id: string | null) => void;
  onClose: () => void;
  onDelete?: (o: T) => void;
  addLabel?: string;
  onAdd?: () => void;
  /** When set, an explicit "no selection" row (e.g. a walk-in vendor). */
  noneLabel?: string;
}) {
  return (
    <PhonePortal>
      <div className="sheetWrap" onClick={onClose}>
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <div className="sheetHandle" />
          <div className="sheetTitle">{title}</div>
          <div className="sheetStep">{subtitle}</div>

          <div className="pickList">
            {noneLabel && (
              <div
                className={`pickRow${activeId === null ? " on" : ""}`}
                onClick={() => {
                  onPick(null);
                  onClose();
                }}
              >
                <span>{noneLabel}</span>
                {activeId === null && <b className="pickTick">✓</b>}
              </div>
            )}
            {options.map((o) => (
              <div
                key={o.id}
                className={`pickRow${activeId === o.id ? " on" : ""}`}
                onClick={() => {
                  onPick(o.id);
                  onClose();
                }}
              >
                <span>{o.name}</span>
                {activeId === o.id && <b className="pickTick">✓</b>}
                {onDelete && (
                  <button
                    className="pickX"
                    title="Deactivate"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(o);
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            {options.length === 0 && <p className="hint">Nothing here yet.</p>}
          </div>

          {onAdd && addLabel && (
            <button className="cta ghost" onClick={onAdd}>
              {addLabel}
            </button>
          )}
          <button className="cta ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </PhonePortal>
  );
}

export default function InwardPage() {
  const { data: session } = useSession();
  const isOwner = session?.user?.role === "OWNER";
  const { toast, party, bump, confirm } = useUI();
  const invalidateChannels = useInvalidateChannels();

  const vendorsQ = useQuery({ queryKey: ["vendors"], queryFn: () => getJson<{ vendors: VendorLite[] }>("/api/vendors") });
  const materialsQ = useQuery({ queryKey: ["materials"], queryFn: () => getJson<{ materials: Material[] }>("/api/materials") });

  const [vendorId, setVendorId] = useState<string | null>(null);
  /** Vendor's invoice / challan number. Display-only in this build — see the field. */
  const [invoiceNo, setInvoiceNo] = useState("");
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
  /** The two list pickers, and the calculator overlay. UI state only. */
  const [vendorPick, setVendorPick] = useState(false);
  const [materialPick, setMaterialPick] = useState(false);
  const [calcOpen, setCalcOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [slip, setSlip] = useState<{ url: string; name: string } | null>(null);
  const [slipBusy, setSlipBusy] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [capturePrompt, setCapturePrompt] = useState(false);
  const promptTmr = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Camera or gallery for the weighbridge slip; the upload itself is unchanged. */
  const slipPicker = usePhotoSource((f) => void onSlipPicked(f), { title: "Weighbridge slip" });

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
  const activeVendor = vendors.find((v) => v.id === vendorId) ?? null;
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
    // The calculator is a tool, not the screen: confirming a value hands the
    // total back to the weight field and gets out of the way.
    setCalcOpen(false);
    toast(`⚖️ ${activeMaterial.name} · ${fmt(kg)} kg added · +5 XP`);
    void bump(5);
  }

  function removeCartItem(key: string) {
    setCart((c) => c.filter((i) => i.key !== key));
  }

  /** Stores the weighbridge ticket now; it is attached to the load on save.
   *  Unchanged — only how the file is chosen (camera or gallery) moved. */
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

      {/* ---- Vendor + vehicle capture ---- */}
      <div className="entryCard">
        <div className="pickField">
          <label>Vendor</label>
          <div className={`pickCtl${activeVendor ? " filled" : ""}`} onClick={() => setVendorPick(true)}>
            <span className="pickCtlVal">{activeVendor ? activeVendor.name : "Walk-in · tap to select"}</span>
            {activeVendor && (
              <button
                className="pickClear"
                title="Clear vendor"
                onClick={(e) => {
                  e.stopPropagation();
                  setVendorId(null);
                }}
              >
                ✕
              </button>
            )}
            <span className="pickCaret">›</span>
          </div>
        </div>

        {/* Invoice / challan number as printed on the vendor's paperwork.
            UI-only for this build: InwardLoad has no column for it and this
            phase adds no schema or API, so it is not sent with the load. */}
        <div className="pickField" style={{ marginTop: 12 }}>
          <label>
            Invoice / Challan <span className="lblOpt">(Optional)</span>
          </label>
          <input
            className="plainInput"
            value={invoiceNo}
            onChange={(e) => setInvoiceNo(e.target.value)}
            placeholder="Enter invoice number"
            aria-label="Invoice or challan number"
          />
        </div>
      </div>

      {/* ---- Materials: three primary actions ---- */}
      <div className="entryCard">
        <div className="cardHead">
          <span className="cardHeadTitle">MATERIALS</span>
        </div>

        {/*
          One row, always: Material → Weight → Slip. That order is the order the
          load is actually processed in, so the row reads as the workflow rather
          than as three unrelated buttons — which is why it stays a row at every
          width instead of wrapping the weight underneath on a narrow phone.

          All three cells are one control shell (`.actCell`): same height, same
          label, same inset value box, same padding, equal thirds. Only what sits
          inside the box differs — a chosen value on the outer two, a number and
          its unit in the middle, because that one is typed rather than picked.
        */}
        <div className="actRow">
          <button className="actCell" onClick={() => setMaterialPick(true)}>
            <span className="actLbl">Material</span>
            <span className="actInset">
              <b className="actVal">{activeMaterial ? activeMaterial.name : "Select"}</b>
            </span>
          </button>

          <div
            className="actCell wt"
            role="button"
            tabIndex={0}
            aria-label="Weight — opens the calculator"
            onClick={() => setCalcOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setCalcOpen(true);
              }
            }}
          >
            <span className="actLbl">Weight</span>
            <span className="actInset">
              <span className={`wtNum${total === 0 ? " empty" : ""}`}>{fmt(total)}</span>
              <span className="wtKg">kg</span>
            </span>
          </div>

          <button className="actCell" disabled={slipBusy} onClick={slipPicker.pick}>
            <span className="actLbl">Weighbridge Slip</span>
            <span className="actInset">
              <b className="actVal">{slipBusy ? "Uploading…" : slip ? "✓ Attached" : "Upload"}</b>
            </span>
          </button>
        </div>

        {/*
          Current load, restored above SAVE LOAD.

          The old permanent keypad kept the weighments and the running total on
          screen at all times; moving the keypad into a dialog took that away, so
          the load could only be checked by reopening the calculator. This is the
          same `cart` state and the same `total` — read-only, no new arithmetic —
          rendered where it is needed: immediately before the irreversible tap.

          One row per weighment rather than one per material, because each row is
          individually removable and merging them would take that away.
        */}
        <div className="loadSummary">
          <div className="loadSummaryHead">Current Load</div>
          {cart.length === 0 ? (
            <p className="loadSummaryEmpty">No materials added yet</p>
          ) : (
            <div className="entries">
              {cart.map((item) => (
                <div key={item.key} className="entry">
                  <span>{item.label}</span>
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
          )}
          <div className="totalRow">
            <span>TOTAL LOAD</span>
            <b>{fmt(total)} kg</b>
          </div>
        </div>

        <button className="cta" disabled={saving || !captureComplete || total === 0} onClick={saveLoad}>
          {saving ? "SAVING…" : "SAVE LOAD · +50 XP"}
        </button>
      </div>

      {slipPicker.node}

      {/* Recent loads no longer sit permanently under the entry section — the
          same cards, the same query, behind one line. */}
      <button className="linkRow" onClick={() => setRecentOpen(true)}>
        <span className="linkRowTitle">Recent Load Details</span>
        <span className="linkRowGo">View Recent Loads ›</span>
      </button>
      {recentOpen && <RecentLoads asModal onClose={() => setRecentOpen(false)} />}

      {/* ---- Calculator overlay: the existing LED + keypad, unchanged ---- */}
      {calcOpen && (
        <PhonePortal>
          <div className="sheetWrap" onClick={() => setCalcOpen(false)}>
            <div className="sheet" onClick={(e) => e.stopPropagation()}>
              <div className="sheetHandle" />
              <div className="sheetTitle">Weight Entry</div>
              <div className="sheetStep">
                {activeMaterial ? activeMaterial.name : "No material selected"} · adds to the load on ADD TO LOAD
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

              <div className="totalRow">
                <span>TOTAL LOAD</span>
                <b>{fmt(total)} kg</b>
              </div>

              <button className="cta ghost" onClick={() => setCalcOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </PhonePortal>
      )}

      {vendorPick && (
        <PickerSheet
          title="Select Vendor"
          subtitle="Leave as walk-in if the load has no vendor"
          options={vendors}
          activeId={vendorId}
          noneLabel="Walk-in (no vendor)"
          onPick={setVendorId}
          onClose={() => setVendorPick(false)}
          onDelete={isOwner ? (v) => void deleteVendor(v) : undefined}
          addLabel={isOwner ? "+ Add Vendor" : undefined}
          onAdd={
            isOwner
              ? () => {
                  setVendorPick(false);
                  setVendorOpen(true);
                }
              : undefined
          }
        />
      )}

      {materialPick && (
        <PickerSheet
          title="Select Material"
          subtitle="The material this weighment is booked against"
          options={materials}
          activeId={activeMaterialId}
          onPick={setMaterialId}
          onClose={() => setMaterialPick(false)}
          onDelete={isOwner ? (m) => void deleteMaterial(m) : undefined}
          addLabel={isOwner ? "+ Add Material" : undefined}
          onAdd={
            isOwner
              ? () => {
                  setMaterialPick(false);
                  setMaterialOpen(true);
                }
              : undefined
          }
        />
      )}

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
