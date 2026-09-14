"use client";

import { useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { getJson, sendJson, newRequestId, ApiError } from "@/frontend/lib/api-client";
import { fmt } from "@/shared/format";
import { compressImage } from "@/frontend/lib/image";
import { useUI } from "@/frontend/components/ui-provider";
import { PhonePortal } from "@/frontend/components/phone-portal";
import { usePhotoSource } from "@/frontend/components/photo-source";
import { CameraSheet, type CaptureData } from "@/frontend/components/camera-sheet";
import { VendorSheet, type VendorLite } from "@/frontend/components/vendor-sheet";
import { MaterialSheet } from "@/frontend/components/material-sheet";
import { RecentLoads } from "@/frontend/components/recent-loads";
import {
  MaterialEntry,
  type CartItem,
  type MaterialEntryHandle,
} from "@/frontend/components/material-entry";
import { useInvalidateChannels } from "@/frontend/components/realtime/provider";

/**
 * A bookable material. `isMixedBucket` decides the workflow the load enters —
 * mixed goes to Sort, direct goes straight to that sub-material's stock — and
 * comes from the material configuration, never from the name.
 */
type Material = {
  id: string;
  code: string;
  name: string;
  icon?: string | null;
  materialId?: string | null;
  materialName?: string | null;
  isMixedBucket?: boolean;
  active?: boolean;
};

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
  /**
   * The committed cart. Owned here rather than by the shared entry, because
   * SAVE LOAD is what consumes it and the entry is a control, not the screen.
   */
  const [cart, setCart] = useState<CartItem[]>([]);
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
  /**
   * The shared entry's handle. `release()` lets a weight parked by the image
   * gate through once the photographs are attached; `discard()` drops it when
   * the sheet is closed without any. Replaces the page's own copy of that
   * state — the parked reading belongs to the entry, not to this screen.
   */
  const entryRef = useRef<MaterialEntryHandle | null>(null);
  const [vendorOpen, setVendorOpen] = useState(false);
  const [materialOpen, setMaterialOpen] = useState(false);
  /** The vendor picker. The material picker now lives inside the shared entry. */
  const [vendorPick, setVendorPick] = useState(false);
  const [saving, setSaving] = useState(false);
  const [slip, setSlip] = useState<{ url: string; name: string } | null>(null);
  const [slipBusy, setSlipBusy] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  /**
   * Camera or gallery for the weight proof — the same shared picker the rest
   * of the app uses. Opened by SAVE LOAD, not by a control of its own.
   */
  const slipPicker = usePhotoSource((f) => void onSlipPicked(f), { title: "Upload weight proof" });
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

  /**
   * The material-image gate, kept here because the requirement is Inward's.
   *
   * The shared entry parks the reading and calls this; completing the sheet
   * releases it, closing the sheet without images discards it. Same rule as
   * before — checked per material type, so a second weighment of an
   * already-photographed material passes straight through.
   */
  function promptMaterialImages() {
    toast("📷 Upload Material images first");
  }


  /**
   * The weight proof, picked from the popup SAVE LOAD opens.
   *
   * Same upload as before — compress, `/api/uploads`, kind `weighbridge-slip`.
   * What changed is when it is asked for: only at SAVE LOAD, once the load is
   * otherwise ready, so a successful upload carries straight on into the save.
   * The URL is handed to `saveLoad` directly because `slip` state set a line
   * earlier is not visible until the next render.
   *
   * A failed upload, a non-image, or closing the popup all leave the load
   * unsaved with the cart exactly as it was.
   */
  async function onSlipPicked(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast("Weight proof must be an image");
      return;
    }
    setSlipBusy(true);
    let url: string | null = null;
    try {
      const dataUrl = await compressImage(file);
      const res = await sendJson<{ url: string }>("/api/uploads", { dataUrl, kind: "weighbridge-slip" });
      url = res.url;
      setSlip({ url: res.url, name: file.name });
      toast("🧾 Weight proof attached");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not upload weight proof");
    } finally {
      setSlipBusy(false);
    }
    if (url) await saveLoad(url);
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

  /**
   * @param slipUrl  The weight proof just uploaded from the popup. Omitted when
   *                 SAVE LOAD is tapped, in which case the stored `slip` is used
   *                 — so a save that failed after a successful upload can be
   *                 retried without asking for the proof again.
   */
  async function saveLoad(slipUrl: string | null = slip?.url ?? null) {
    if (saving || slipBusy) return;
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
    /**
     * Weight proof is asked for HERE, last, once everything else about the load
     * is ready — never as a separate step while the load is still being built.
     * Nothing is sent until it is attached; closing the popup simply returns to
     * the load with the cart untouched.
     */
    if (!slipUrl) {
      toast("🧾 Upload the weight proof to save this load");
      slipPicker.pick();
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
        weighbridgeSlipUrl: slipUrl,
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
      // The weight/rate/display belong to the shared entry now.
      entryRef.current?.reset();
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
          Material → Weight → Rate → Cart is the SHARED `MaterialEntry`
          component — the same one the Outward dispatch workflow renders. It
          used to be written out here; extracting it is what keeps one
          calculator, one cart and one set of rules in the application.

          What stays Inward's is the gate: a material may not be weighed until
          it has been photographed. That is passed in rather than built in, so
          Outward (which has no such requirement) is not carrying a flag it
          would have to switch off.
        */}
        <MaterialEntry
          materials={materials}
          cart={cart}
          onCartChange={setCart}
          activeMaterialId={activeMaterialId}
          onPickMaterial={setMaterialId}
          onAddMaterial={isOwner ? () => setMaterialOpen(true) : undefined}
          onDeleteMaterial={isOwner ? (m) => void deleteMaterial(m as Material) : undefined}
          handleRef={entryRef}
          gate={{
            message: "Upload Material images first",
            blocked: (skuId) => (materialImages[skuId] ?? []).length === 0,
            onBlocked: (skuId) => {
              setMaterialId(skuId);
              setMatCamOpen(true);
            },
          }}
        />

        {/* No separate weight-proof control: SAVE LOAD asks for it in a popup
            once the load is ready, and saves as soon as it is attached. */}
        <button className="cta" disabled={saving || slipBusy || total === 0} onClick={() => void saveLoad()}>
          {saving ? "SAVING…" : slipBusy ? "UPLOADING PROOF…" : "SAVE LOAD · +50 XP"}
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
            // Only when the requirement is still unmet: reopening the sheet on
            // an already-photographed material and closing it must not nag.
            if (currentImages.length === 0) {
              entryRef.current?.discard();
              promptMaterialImages();
            }
          }}
          onComplete={(data) => {
            setMaterialImages((m) => ({ ...m, [activeMaterialId]: data.materialUrls }));
            setMatCamOpen(false);
            toast(`✓ ${data.materialUrls.length} image(s) attached to ${activeMaterial?.name ?? "material"}`);
            // The gate is satisfied: let the weight the operator already
            // entered through to the entry card.
            entryRef.current?.release();
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
