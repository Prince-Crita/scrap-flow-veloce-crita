"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJson, sendJson, newRequestId, ApiError } from "@/lib/fetcher";
import { fmt } from "@/lib/format";
import { UNITS, toKilograms, type UnitCode } from "@/lib/units";
import { useUI } from "@/components/ui-provider";
import { CameraSheet, type CaptureData } from "@/components/camera-sheet";
import { useInvalidateChannels } from "@/components/realtime/provider";

/**
 * Manager Outward — loading sold material onto vehicles.
 *
 * Deliberately the same shape as Inward: same chips, same LED display, same
 * keypad, same camera/OCR sheet, same cart-then-commit rhythm and the same
 * idempotency key. A weighbridge operator should not have to learn a second
 * interaction model to send material out.
 *
 * What differs is the constraint. Inward accepts whatever arrives; Outward can
 * never exceed what the Owner allocated, so every entry is capped by the
 * allocation's balance and by the stock physically present.
 */

type Allocation = {
  saleId: string;
  invoiceNumber: string;
  buyerName: string;
  skuId: string;
  skuName: string;
  icon: string;
  allocatedKg: number;
  loadedKg: number;
  balanceKg: number;
  physicalKg: number;
  status: "PENDING" | "PARTIAL" | "COMPLETED";
};

type CartItem = { key: string; saleId: string; label: string; invoice: string; kg: number; unit: UnitCode };

export default function OutwardPage() {
  const { toast, party, bump } = useUI();
  const invalidateChannels = useInvalidateChannels();

  const queueQ = useQuery({
    queryKey: ["outwardQueue"],
    queryFn: () => getJson<{ allocations: Allocation[]; pending: Allocation[] }>("/api/outward/queue"),
  });

  const [saleId, setSaleId] = useState<string | null>(null);
  const [led, setLed] = useState("0");
  const [unit, setUnit] = useState<UnitCode>("KG");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [capture, setCapture] = useState<CaptureData | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [capturePrompt, setCapturePrompt] = useState(false);
  const promptTmr = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** One key per SAVE DISPATCH attempt, held across retries. */
  const saveRequestId = useRef<string | null>(null);

  function promptCapture() {
    setCameraOpen(false);
    setCapturePrompt(true);
    if (promptTmr.current) clearTimeout(promptTmr.current);
    promptTmr.current = setTimeout(() => setCapturePrompt(false), 3200);
  }

  const pending = queueQ.data?.pending ?? [];
  const activeSaleId = saleId ?? pending[0]?.saleId ?? null;
  const active = pending.find((a) => a.saleId === activeSaleId) ?? null;
  const captureComplete = !!capture;
  const total = cart.reduce((a, b) => a + b.kg, 0);

  /** Already in the cart against this allocation but not yet committed. */
  const inCartFor = (id: string) => cart.filter((c) => c.saleId === id).reduce((a, c) => a + c.kg, 0);
  /** What may still be added: the allocation balance, less anything staged. */
  const availableFor = (a: Allocation) => Math.max(0, Math.min(a.balanceKg, a.physicalKg) - inCartFor(a.saleId));

  function num(n: number) {
    setLed((l) => (l.length < 6 ? (l === "0" ? String(n) : l + n) : l));
  }
  function clr() {
    setLed("0");
  }
  function back() {
    setLed((l) => (l.length > 1 ? l.slice(0, -1) : "0"));
  }

  function onAddToLoad() {
    if (!captureComplete) {
      promptCapture();
      return;
    }
    if (!active) {
      toast("Nothing waiting to be dispatched");
      return;
    }
    const reading = Number(led);
    if (!reading) {
      toast("Enter a weight first");
      return;
    }
    const kg = toKilograms(reading, unit);
    const room = availableFor(active);
    // Refused here AND re-checked on the server: two phones must not be able to
    // over-dispatch the same allocation by racing each other.
    if (kg > room) {
      toast(room === 0 ? "This allocation is fully loaded" : `Only ${fmt(room)} kg left on this allocation`);
      return;
    }
    setCart((c) => [
      ...c,
      {
        key: `${Date.now()}-${c.length}`,
        saleId: active.saleId,
        label: active.skuName,
        invoice: active.invoiceNumber,
        kg,
        unit,
      },
    ]);
    setLed("0");
    toast(`🏁 ${active.skuName} · ${fmt(kg)} kg loaded · +5 XP`);
    void bump(5);
  }

  function removeCartItem(key: string) {
    setCart((c) => c.filter((i) => i.key !== key));
  }

  async function saveDispatch() {
    if (!total) {
      toast("Add at least one weight");
      return;
    }
    if (!captureComplete) {
      toast("📷 Capture required before dispatch");
      setCameraOpen(true);
      return;
    }
    setSaving(true);
    const requestId = saveRequestId.current ?? (saveRequestId.current = newRequestId());
    try {
      const res = await sendJson<{ dispatch: { dispatchNumber: string; totalKg: number } }>(
        "/api/outward/dispatch",
        {
          clientRequestId: requestId,
          lines: cart.map((i) => ({ saleId: i.saleId, kg: i.kg })),
          vehicleNumber: capture!.plate,
          vehicleType: capture!.vehicleType,
          driverName: capture!.driverName,
          ocrConfidence: capture!.confidence || null,
          frontImageUrl: capture!.frontUrl,
          backImageUrl: capture!.backUrl,
          materialImageUrls: capture!.materialUrls,
        }
      );
      saveRequestId.current = null;
      setCart([]);
      setCapture(null);
      setLed("0");
      // Matches what /api/outward/dispatch publishes; `sellReady` and
      // `stockSources` were missing and both move when a vehicle leaves.
      invalidateChannels("outward", "stock", "sales");
      await bump(50);
      party(
        "🏁",
        "DISPATCHED!",
        `${fmt(res.dispatch.totalKg)} kg · ${res.dispatch.dispatchNumber}`,
        "+50 XP"
      );
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not save dispatch");
    } finally {
      setSaving(false);
    }
  }

  if (queueQ.isLoading) {
    return (
      <>
        <div className="secTitle">Outward · Dispatch</div>
        <div className="skel" style={{ height: 90, marginBottom: 12 }} />
        <div className="skel" style={{ height: 54, marginBottom: 8 }} />
      </>
    );
  }

  if (pending.length === 0) {
    return (
      <>
        <div className="secTitle">Outward · Dispatch</div>
        <div className="lot">
          <h3>Nothing waiting to load</h3>
          <div className="big" style={{ fontSize: 18 }}>All dispatched 🎉</div>
          <small style={{ fontFamily: "var(--mono)", color: "var(--muted)" }}>
            When the Owner records a sale it appears here for loading.
          </small>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="secTitle">Outward · Dispatch</div>

      {/* Allocation chips — the Outward equivalent of Inward's material chips. */}
      <div className="chips">
        {pending.map((a) => (
          <div
            key={a.saleId}
            className={`chip${activeSaleId === a.saleId ? " on" : ""}`}
            onClick={() => setSaleId(a.saleId)}
          >
            {a.skuName} · {a.invoiceNumber}
          </div>
        ))}
      </div>

      {active && (
        <div className="allocBar">
          <div className="allocRow">
            <span>Buyer</span>
            <b>{active.buyerName}</b>
          </div>
          <div className="allocRow">
            <span>Allocated</span>
            <b>{fmt(active.allocatedKg)} kg</b>
          </div>
          <div className="allocRow">
            <span>Already loaded</span>
            <b>{fmt(active.loadedKg + inCartFor(active.saleId))} kg</b>
          </div>
          <div className="allocRow bal">
            <span>Balance</span>
            <b>{fmt(availableFor(active))} kg</b>
          </div>
          {active.physicalKg < active.balanceKg && (
            <p className="hint" style={{ color: "var(--orange)", marginTop: 6 }}>
              ⚠ Only {fmt(active.physicalKg)} kg physically in stock
            </p>
          )}
        </div>
      )}

      {/* LED — identical to Inward, including the unit selector. */}
      <div className="led">
        <div className="val">{fmt(Number(led))}</div>
        <div className="unit">
          <span>SCALE · MANUAL</span>
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
          📷 Tap the camera key to capture vehicle &amp; material before loading.
        </p>
      )}
      {captureComplete && (
        <p className="hint" style={{ marginTop: 10, color: "var(--led)" }}>
          ✓ Captured · vehicle {capture!.plate} · {capture!.materialUrls.length} material image(s)
        </p>
      )}

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
        <button className={`key add${!captureComplete ? " locked" : ""}`} onClick={onAddToLoad}>ADD<br />TO LOAD</button>
        <button className="key" style={{ gridColumn: "span 2" }} onClick={() => num(0)}>0</button>
        <button className={`key fn${capturePrompt ? " needsCapture" : ""}`} onClick={() => setCameraOpen(true)}>📷</button>
        {capturePrompt && <div className="captureTip">Complete vehicle verification first</div>}
      </div>

      {/* Load cart — uncommitted until SAVE DISPATCH. */}
      <div className="entries">
        {cart.map((item, i) => (
          <div key={item.key} className="entry">
            <span>
              {i + 1}. {item.label} · {item.invoice}
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
        <span>TOTAL DISPATCH</span>
        <b>{fmt(total)} kg</b>
      </div>

      <button className="cta" disabled={saving || !captureComplete || total === 0} onClick={saveDispatch}>
        {saving ? "SAVING…" : "SAVE DISPATCH · +50 XP"}
      </button>

      <CameraSheet
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onComplete={(data) => {
          setCapture(data);
          setCameraOpen(false);
          toast("✓ Capture attached · you can load now");
        }}
      />
    </>
  );
}
