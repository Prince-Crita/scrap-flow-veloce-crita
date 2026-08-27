"use client";

import { useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { getJson, sendJson, newRequestId, ApiError } from "@/frontend/lib/api-client";
import { fmt, fmtInr } from "@/shared/format";
import { UNITS, toKilograms, type UnitCode } from "@/shared/units";
import { compressImage } from "@/frontend/lib/image";
import { useUI } from "@/frontend/components/ui-provider";
import { PhonePortal } from "@/frontend/components/phone-portal";
import { usePhotoSource } from "@/frontend/components/photo-source";
import { CameraSheet, type CaptureData } from "@/frontend/components/camera-sheet";
import { VendorSheet, type VendorLite } from "@/frontend/components/vendor-sheet";
import { MaterialSheet } from "@/frontend/components/material-sheet";
import { RecentLoads } from "@/frontend/components/recent-loads";
import { useInvalidateChannels } from "@/frontend/components/realtime/provider";

type Material = { id: string; code: string; name: string; materialId?: string | null; active?: boolean };

/**
 * One committed cart line: a material, its weight in kilograms, and the rate it
 * was bought at. The same material may appear several times at different rates —
 * see `addToCart` for why these are never merged in the UI.
 */
type CartItem = { key: string; skuId: string; label: string; kg: number; unit: UnitCode; ratePerKg: number };

/** Largest rate the API will accept; mirrored here so the field cannot exceed it. */
const MAX_RATE = 1_000_000;

/**
 * Reads a typed rate. Blank, malformed or negative all mean zero rather than
 * NaN — clearing the field to start again must not poison the cart total.
 */
function parseRate(raw: string): number {
  const n = Number.parseFloat(raw.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(MAX_RATE, Math.round(n * 100) / 100);
}

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
  /**
   * Invoice / challan: an explicit question, not an optional text box.
   *
   * `null` is "not answered yet" and blocks SAVE LOAD, so a load can never be
   * committed with the question silently skipped — which is what the old
   * "(Optional)" field allowed, and why nothing was ever recorded about it.
   */
  const [hasInvoice, setHasInvoice] = useState<boolean | null>(null);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoice, setInvoice] = useState<{ url: string; name: string } | null>(null);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [materialId, setMaterialId] = useState<string | null>(null);
  const [led, setLed] = useState("0");
  const [unit, setUnit] = useState<UnitCode>("KG");
  const [cart, setCart] = useState<CartItem[]>([]);
  /**
   * The weight confirmed by ADD TO LOAD but not yet committed to the cart.
   *
   * This is the whole point of the two-step entry: the material, the weight and
   * the rate all stay editable while it sits here, and only ADD TO CART turns it
   * into a cart line. Kilograms, like everything downstream of the keypad.
   */
  const [pendingKg, setPendingKg] = useState<number | null>(null);
  const [pendingUnit, setPendingUnit] = useState<UnitCode>("KG");
  const [rate, setRate] = useState("0");
  const [capture, setCapture] = useState<CaptureData | null>(null);
  /**
   * Material images, keyed by the SKU they were taken for.
   *
   * Keyed rather than a flat list because the validation is per material type:
   * a second weighment of the SAME material must not ask for photographs again,
   * and switching to a different material must.
   */
  const [materialImages, setMaterialImages] = useState<Record<string, string[]>>({});
  /** Idempotency key for the in-flight SAVE LOAD; survives retries, cleared on success. */
  const saveRequestId = useRef<string | null>(null);
  const [vehicleOpen, setVehicleOpen] = useState(false);
  const [matCamOpen, setMatCamOpen] = useState(false);
  /**
   * A weight that ADD TO LOAD accepted but that is waiting on the material's
   * images before it may become a pending entry.
   *
   * The image requirement did not change — only what triggers it. The calculator
   * no longer carries a camera key, so ADD TO LOAD opens the SAME Material
   * Images sheet and parks the reading here until that sheet is completed.
   * Cancelling the sheet drops it, exactly as failing the old check did.
   */
  const [awaitingImages, setAwaitingImages] = useState<{ kg: number; unit: UnitCode } | null>(null);
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
  const [imagePrompt, setImagePrompt] = useState(false);
  const promptTmr = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Camera or gallery for the required slip; the upload itself is unchanged. */
  const slipPicker = usePhotoSource((f) => void onSlipPicked(f), { title: "Upload required slip" });
  /** Same control, same endpoint, for the vendor's invoice / challan. */
  const invoicePicker = usePhotoSource((f) => void onInvoicePicked(f), { title: "Invoice / challan" });

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
  /**
   * No implicit first material.
   *
   * This used to fall back to `materials[0]`, so the card opened already showing
   * "Mixed MS" and a weight could be booked against a material nobody chose. The
   * operator now picks one; until then there is nothing selected.
   */
  const activeMaterialId = materialId;
  const activeMaterial = materials.find((m) => m.id === activeMaterialId) ?? null;
  const vehicleReady = !!capture;
  const total = cart.reduce((a, b) => a + b.kg, 0);
  const cartValue = cart.reduce((a, b) => a + b.kg * b.ratePerKg, 0);
  /** Images already attached for the material currently selected. */
  const currentImages = activeMaterialId ? (materialImages[activeMaterialId] ?? []) : [];
  const invoiceAnswered = hasInvoice === false || (hasInvoice === true && !!invoice);

  function num(n: number) {
    setLed((l) => (l.length < 6 ? (l === "0" ? String(n) : l + n) : l));
  }
  function clr() {
    setLed("0");
  }
  function back() {
    setLed((l) => (l.length > 1 ? l.slice(0, -1) : "0"));
  }

  /**
   * "Upload Material images first."
   *
   * Fires the same tip and the same camera-key glow the vehicle check used to,
   * because the gate moved rather than changed: it is now the material images
   * for the material being weighed, checked per material type so a second
   * weighment of an already-photographed material passes straight through.
   */
  function promptMaterialImages() {
    setImagePrompt(true);
    if (promptTmr.current) clearTimeout(promptTmr.current);
    promptTmr.current = setTimeout(() => setImagePrompt(false), 3200);
    toast("📷 Upload Material images first");
  }

  /**
   * The material and the reading itself, in the order the operator would fix
   * them. Returns the kilograms, or null after complaining. The material-image
   * requirement is checked by the caller, because ADD TO LOAD now answers it by
   * opening the images sheet rather than by refusing.
   */
  function readyKg(reading: number): number | null {
    if (!activeMaterialId || !activeMaterial) {
      toast("Select a material first");
      return null;
    }
    if (!reading) {
      toast("Enter a weight first");
      return null;
    }
    const kg = toKilograms(reading, unit);
    if (kg <= 0) {
      toast("Weight is too small to record");
      return null;
    }
    return kg;
  }

  /** Hands a confirmed reading to the entry card and closes the calculator. */
  function acceptWeight(kg: number, entryUnit: UnitCode) {
    setPendingKg(kg);
    setPendingUnit(entryUnit);
    setLed("0");
    // The calculator is a tool, not the screen: confirming a value hands the
    // weight back to the entry card and gets out of the way.
    setCalcOpen(false);
    toast(`⚖️ ${activeMaterial?.name ?? "Material"} · ${fmt(kg)} kg · set the rate, then ADD TO CART`);
  }

  /**
   * ADD TO LOAD — hands the reading to the entry card, and stops there.
   *
   * Nothing reaches the cart yet: the rate has not been entered, and the
   * material and weight are both still editable. ADD TO CART is what commits.
   *
   * The material's images are still mandatory, and this is now where they are
   * asked for: with none on file for the selected material, the reading is
   * parked and the existing Material Images sheet opens. Only completing that
   * sheet lets the weight through — the gate moved, it did not soften.
   */
  function onAddWt() {
    const kg = readyKg(Number(led));
    if (kg == null) return;
    if (currentImages.length === 0) {
      setAwaitingImages({ kg, unit });
      setMatCamOpen(true);
      return;
    }
    acceptWeight(kg, unit);
  }

  /**
   * ADD TO CART — commits the pending material, weight and rate as one line.
   *
   * Deliberately appended, never merged into a matching line. The same material
   * bought twice off one vehicle at two different rates is two purchases, and
   * collapsing them here would destroy the distinction the operator just made.
   * The API still groups by SKU for stock and sorting; the rate survives that
   * grouping on the weighment rows.
   */
  function addToCart() {
    if (pendingKg == null) {
      toast("Enter a weight first");
      return;
    }
    // Re-checked, not assumed: the material can be changed while an entry is
    // pending, and the images have to belong to whatever is being added.
    if (!activeMaterialId || !activeMaterial) {
      toast("Select a material first");
      return;
    }
    if (currentImages.length === 0) {
      promptMaterialImages();
      return;
    }
    const ratePerKg = parseRate(rate);
    setCart((c) => [
      ...c,
      {
        key: `${Date.now()}-${c.length}`,
        skuId: activeMaterialId,
        label: activeMaterial.name,
        kg: pendingKg,
        unit: pendingUnit,
        ratePerKg,
      },
    ]);
    setPendingKg(null);
    setRate("0");
    toast(`🛒 ${activeMaterial.name} · ${fmt(pendingKg)} kg @ ${fmtInr(ratePerKg)}/kg added · +5 XP`);
    void bump(5);
  }

  function removeCartItem(key: string) {
    setCart((c) => c.filter((i) => i.key !== key));
  }

  /** Stores the required slip now; it is attached to the load on save.
   *  Unchanged — only where the control sits on the page moved. */
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
      toast("🧾 Slip attached");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not upload slip");
    } finally {
      setSlipBusy(false);
    }
  }

  /** The invoice / challan photograph. Same endpoint, same validation, own kind. */
  async function onInvoicePicked(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast("Invoice must be an image");
      return;
    }
    setInvoiceBusy(true);
    try {
      const dataUrl = await compressImage(file);
      const res = await sendJson<{ url: string }>("/api/uploads", { dataUrl, kind: "invoice" });
      setInvoice({ url: res.url, name: file.name });
      toast("🧾 Invoice / challan attached");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not upload invoice");
    } finally {
      setInvoiceBusy(false);
    }
  }

  async function saveLoad() {
    if (!total) {
      toast("Add at least one material to the cart");
      return;
    }
    if (!vehicleReady) {
      toast("🚚 Add vehicle details before saving");
      setVehicleOpen(true);
      return;
    }
    if (hasInvoice === null) {
      toast("Answer Invoice / Challan — Yes or No");
      return;
    }
    if (hasInvoice === true && !invoice) {
      toast("Upload the invoice / challan, or answer No");
      return;
    }
    setSaving(true);
    // One key per save attempt, held across retries: if the operator taps twice
    // or the request is retried on a poor connection, the server recognises the
    // replay and returns the original lot instead of double-counting the stock.
    const requestId = saveRequestId.current ?? (saveRequestId.current = newRequestId());
    try {
      const res = await sendJson<{
        load: { lotNumber: string; loadRef: string; totalKg: number; materialLabel: string };
      }>("/api/inward/loads", {
        clientRequestId: requestId,
        // Always kilograms — the unit selector converts before anything is
        // added to the cart, so no unit ever reaches the server.
        lines: cart.map((i) => ({ skuId: i.skuId, kg: i.kg, ratePerKg: i.ratePerKg })),
        vendorId,
        hasInvoice,
        invoiceNumber: invoiceNo.trim() || null,
        invoiceUrl: invoice?.url ?? null,
        vehicleNumber: capture!.plate,
        vehicleType: capture!.vehicleType,
        driverName: capture!.driverName,
        driverPhone: capture!.driverPhone || null,
        ocrConfidence: capture!.confidence || null,
        frontImageUrl: capture!.frontUrl,
        backImageUrl: capture!.backUrl,
        // Every material's photographs, in the order the materials were shot.
        materialImageUrls: [...new Set(Object.values(materialImages).flat())],
        weighbridgeSlipUrl: slip?.url ?? null,
      });
      // Succeeded: retire this key so the NEXT load gets a fresh one.
      saveRequestId.current = null;
      setCart([]);
      setCapture(null);
      setSlip(null);
      setInvoice(null);
      setInvoiceNo("");
      setHasInvoice(null);
      setMaterialImages({});
      setPendingKg(null);
      setRate("0");
      setLed("0");
      // Exactly the channels POST /api/inward/loads publishes.
      invalidateChannels("inward", "stock", "sort");
      await bump(50);
      party("📦", "LOAD SAVED!", `${fmt(res.load.totalKg)} kg ${res.load.materialLabel} · ${res.load.loadRef}`, "+50 XP");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not save load");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="secTitle">Inward · Weight Entry</div>

      {/* ---- Vendor → vehicle → invoice ---- */}
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

        {/* The vehicle is captured here now, not from the calculator: it belongs
            to the load, not to any one weighment. Same camera, same ANPR — the
            sheet is simply entered in its two-step vehicle mode. */}
        <div className="pickField" style={{ marginTop: 12 }}>
          <label>Vehicle</label>
          <div className={`pickCtl${vehicleReady ? " filled" : ""}`} onClick={() => setVehicleOpen(true)}>
            <span className="pickCtlVal">
              {capture ? `${capture.plate} · ${capture.vehicleType}` : "Add Vehicle Details"}
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
          {capture?.driverName && <p className="hint">Driver · {capture.driverName}</p>}
        </div>

        {/* A question with two answers, not an optional box. "No" is a recorded
            fact; "Yes" is only true once the document is actually attached. */}
        <div className="pickField" style={{ marginTop: 12 }}>
          <label>Invoice / Challan</label>
          <div className="chips">
            <button
              className={`chip${hasInvoice === true ? " on" : ""}`}
              aria-pressed={hasInvoice === true}
              onClick={() => setHasInvoice(true)}
            >
              YES
            </button>
            <button
              className={`chip${hasInvoice === false ? " on" : ""}`}
              aria-pressed={hasInvoice === false}
              onClick={() => {
                setHasInvoice(false);
                setInvoice(null);
                setInvoiceNo("");
              }}
            >
              NO
            </button>
          </div>

          {hasInvoice === true && (
            <>
              <div
                className={`pickCtl${invoice ? " filled" : ""}`}
                style={{ marginTop: 10 }}
                onClick={() => !invoiceBusy && invoicePicker.pick()}
              >
                <span className="pickCtlVal">
                  {invoiceBusy ? "Uploading…" : invoice ? "✓ Invoice / challan attached" : "Upload invoice / challan"}
                </span>
                {invoice && (
                  <button
                    className="pickClear"
                    title="Remove invoice"
                    onClick={(e) => {
                      e.stopPropagation();
                      setInvoice(null);
                    }}
                  >
                    ✕
                  </button>
                )}
                <span className="pickCaret">›</span>
              </div>
              <input
                className="plainInput"
                style={{ marginTop: 10 }}
                value={invoiceNo}
                onChange={(e) => setInvoiceNo(e.target.value)}
                placeholder="Invoice number (optional)"
                aria-label="Invoice or challan number"
              />
            </>
          )}
        </div>
      </div>

      {/* ---- Materials: three primary actions ---- */}
      <div className="entryCard">
        <div className="cardHead">
          <span className="cardHeadTitle">MATERIALS</span>
        </div>

        {/*
          One row, always: Material → Weight → Rate. That order is the order a
          purchase is actually agreed in, so the row reads as the workflow rather
          than as three unrelated buttons — which is why it stays a row at every
          width instead of wrapping underneath on a narrow phone.

          The slip used to occupy the third cell. It has moved to the bottom of
          this card, immediately above SAVE LOAD, where it is actually used.

          All three cells are one control shell (`.actCell`): same height, same
          label, same inset value box, same padding, equal thirds. Only what sits
          inside the box differs — a chosen value on the first, a number and its
          unit in the middle, a currency field on the last.
        */}
        <div className="actRow">
          <button className="actCell" onClick={() => setMaterialPick(true)}>
            <span className="actLbl">Material</span>
            <span className="actInset">
              <b className="actVal">{activeMaterial ? activeMaterial.name : "Select Material"}</b>
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
              <span className={`wtNum${pendingKg ? "" : " empty"}`}>{fmt(pendingKg ?? 0)}</span>
              <span className="wtKg">kg</span>
            </span>
          </div>

          {/* Typed, not picked — so the value box holds a field rather than a
              caption. `inputMode="decimal"` is what opens the numeric keyboard
              on the phones this is used on. */}
          <div className="actCell rate">
            <span className="actLbl">Rate · ₹/kg</span>
            <span className="actInset">
              <span className="rateCur">₹</span>
              <input
                className="rateInput"
                type="text"
                inputMode="decimal"
                aria-label="Rate per kilogram in rupees"
                value={rate}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => {
                  // Digits and a single decimal point. Anything else never
                  // reaches state, so the field cannot hold a malformed value.
                  const cleaned = e.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
                  setRate(cleaned);
                }}
                onBlur={() => setRate(String(parseRate(rate)))}
              />
            </span>
          </div>
        </div>

        {/* The pending entry: everything above it is still editable until this
            is committed. Only shown once a weight has been confirmed. */}
        {pendingKg != null && (
          <div className="pendCard">
            <div className="pendHead">Ready to add</div>
            <div className="pendLine">
              <span>Material</span>
              <b>{activeMaterial ? activeMaterial.name : "Select Material"}</b>
            </div>
            <div className="pendLine">
              <span>Weight</span>
              <b>
                {fmt(pendingKg)} kg
                {pendingUnit !== "KG" && <em className="entryUnit"> · entered in {pendingUnit}</em>}
              </b>
            </div>
            <div className="pendLine">
              <span>Rate</span>
              <b>{fmtInr(parseRate(rate))} / kg</b>
            </div>
            <div className="pendLine">
              <span>Amount</span>
              <b>{fmtInr(pendingKg * parseRate(rate))}</b>
            </div>
            <button className="cta" onClick={addToCart}>
              ADD TO CART
            </button>
            <button className="cta ghost" onClick={() => setPendingKg(null)}>
              Discard entry
            </button>
          </div>
        )}

        {/*
          Current load, restored above SAVE LOAD.

          One row per cart line rather than one per material, because each row is
          individually removable and because two purchases of the same material
          at different rates are two lines, not one.

          Each row is stacked rather than dense. The material, its weight and its
          rate used to compete for one 390px line with the remove button, which
          truncated the name and left every figure in the row's muted metadata
          size. The name now reads as the heading it is, with the figures under
          it. `.entry` itself is untouched — Outward, Recent Loads and Dispatch
          Status all share it — `.cartRow` is a modifier only this list uses.
        */}
        <div className="loadSummary">
          <div className="loadSummaryTop">
            <div className="loadSummaryHead">Current Load</div>
            {cart.length > 0 && (
              <span className="loadSummaryCount">
                {cart.length} {cart.length === 1 ? "entry" : "entries"}
              </span>
            )}
          </div>
          <p className="loadSummarySub">Materials added to this load</p>
          {cart.length === 0 ? (
            <p className="loadSummaryEmpty">No materials added yet</p>
          ) : (
            <div className="entries">
              {cart.map((item) => (
                <div key={item.key} className="entry cartRow">
                  <span className="cartMain">
                    <b className="cartName">{item.label}</b>
                    {/* Weight and rate read together as one measurement; the
                        line's money sits in its own column so it stays aligned
                        down the list whatever the digits before it do. */}
                    <span className="cartFigures">
                      <span className="cartMeasure">
                        <b className="cartKg">{fmt(item.kg)} kg</b>
                        <em className="cartRate">@ {fmtInr(item.ratePerKg)}/kg</em>
                      </span>
                      <em className="cartAmt">{fmtInr(item.kg * item.ratePerKg)}</em>
                    </span>
                  </span>
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
          {cartValue > 0 && (
            <div className="totalRow">
              <span>TOTAL VALUE</span>
              <b>{fmtInr(cartValue)}</b>
            </div>
          )}
        </div>

        {/* The slip, immediately above the irreversible tap — the same upload
            that used to sit in the action row, in the place it is reached. */}
        <div className="pickField" style={{ marginTop: 14 }}>
          <label>Upload Required Slip</label>
          <div className={`pickCtl${slip ? " filled" : ""}`} onClick={() => !slipBusy && slipPicker.pick()}>
            <span className="pickCtlVal">
              {slipBusy ? "Uploading…" : slip ? "✓ Slip attached" : "Add Weight Proof"}
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

        <button className="cta" disabled={saving || total === 0} onClick={saveLoad}>
          {saving ? "SAVING…" : "SAVE LOAD · +50 XP"}
        </button>
        {total > 0 && !(vehicleReady && invoiceAnswered) && (
          <p className="hint" style={{ color: "var(--orange)" }}>
            {!vehicleReady ? "Add vehicle details before saving." : "Answer Invoice / Challan before saving."}
          </p>
        )}
      </div>

      {slipPicker.node}
      {invoicePicker.node}

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
            <div className="sheet calcSheet" onClick={(e) => e.stopPropagation()}>
              <div className="sheetHandle" />
              {/* An additional way out, nothing more: the header is unchanged and
                  this only closes — the reading is never committed by it. */}
              <button className="sheetClose" aria-label="Close calculator" title="Close" onClick={() => setCalcOpen(false)}>
                ✕
              </button>
              <div className="sheetTitle">Weight Entry</div>
              <div className="sheetStep">
                {activeMaterial ? activeMaterial.name : "No material selected"} · ADD TO LOAD hands this to the entry
                card
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

              {currentImages.length === 0 && (
                <p className="hint" style={{ marginTop: 10, color: "var(--orange)" }}>
                  📷 ADD TO LOAD will ask for {activeMaterial ? activeMaterial.name : "the material"} images before the
                  weight is accepted.
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
                {/* No longer drawn locked: this key IS the way to the material
                    images now, so showing it disabled would point nowhere. */}
                <button className="key add" onClick={onAddWt}>ADD<br />TO LOAD</button>
                {/* The camera key that used to sit beside it has gone; 0 takes
                    the three columns the bottom row actually has. */}
                <button className="key zero" onClick={() => num(0)}>0</button>
                {imagePrompt && <div className="captureTip">Upload Material images first</div>}
              </div>

              <div className="totalRow">
                <span>TOTAL LOAD</span>
                <b>{fmt(total)} kg</b>
              </div>

              {/*
                Done finishes the entry; it does not make one. With a reading
                still on the display and nothing handed over, it says so and
                stays open, because the instruction it gives — tap ADD TO LOAD —
                is only actionable while the keypad is on screen. The ✕ above and
                the backdrop both still close outright, without adding anything.
              */}
              <button
                className="cta ghost"
                onClick={() => {
                  if (Number(led) > 0) {
                    toast("Tap Add to Load to add the weight.");
                    return;
                  }
                  setCalcOpen(false);
                }}
              >
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

      {/* Vehicle: image → ANPR → number → confirm. The SAME sheet and the SAME
          /api/ocr call as before; only the material step is not entered. */}
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

      {/* Material images: the same sheet's third step, opened directly and keyed
          by material so re-opening it shows what that material already has.

          It is now reached from ADD TO LOAD instead of a camera key on the
          keypad. When a weight is waiting on it, completing the sheet releases
          that weight to the entry card; closing it without images releases
          nothing and repeats the requirement. */}
      {matCamOpen && activeMaterialId && (
        <CameraSheet
          key={activeMaterialId}
          open
          mode="materials"
          title={activeMaterial?.name}
          initialMaterialUrls={currentImages}
          onClose={() => {
            setMatCamOpen(false);
            if (awaitingImages) {
              setAwaitingImages(null);
              promptMaterialImages();
            }
          }}
          onComplete={(data) => {
            setMaterialImages((m) => ({ ...m, [activeMaterialId]: data.materialUrls }));
            setMatCamOpen(false);
            setImagePrompt(false);
            toast(`✓ ${data.materialUrls.length} image(s) attached to ${activeMaterial?.name ?? "material"}`);
            if (awaitingImages) {
              const held = awaitingImages;
              setAwaitingImages(null);
              acceptWeight(held.kg, held.unit);
            }
          }}
        />
      )}

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
