"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { getJson, sendJson, ApiError } from "@/frontend/lib/api-client";
import { useUI } from "@/frontend/components/ui-provider";
import { useInvalidateChannels } from "@/frontend/components/realtime/provider";
import { MaterialEntry, type CartItem, type MaterialEntryHandle } from "@/frontend/components/material-entry";
import { CameraSheet } from "@/frontend/components/camera-sheet";
import { DispatchStepHeader } from "@/frontend/components/dispatch-flow";
import type { DispatchProgress } from "@/shared/dispatch-stage";

/**
 * The same `/api/materials` payload Inward reads. A dispatch can load any
 * bookable material, so the hierarchy fields ride along and the shared picker
 * groups and searches identically on both screens.
 */
type Material = {
  id: string;
  name: string;
  icon?: string | null;
  materialId?: string | null;
  materialName?: string | null;
  isMixedBucket?: boolean;
};
type Detail = {
  id: string;
  ref: string;
  stage: DispatchProgress["stage"];
  state: DispatchProgress["state"];
  lineCount: number;
  hasTransit: boolean;
  hasProof: boolean;
  vehicleNumber: string | null;
  materials: { id: string; skuId: string; label: string; kg: number; ratePerKg: number | null }[];
  /** Photographs already attached to this dispatch's materials. */
  materialImages: string[];
};

/**
 * Material Entry — step 2.
 *
 * The material row, the calculator, the pending card and the cart are the
 * shared `MaterialEntry` component — the same one Inward renders. There is no
 * second calculator and no second cart implementation in the codebase.
 *
 * The cart is SEEDED from the server on open, which is what makes the workflow
 * resumable: a dispatch left half-finished comes back with the lines it already
 * had, and Update replaces them rather than appending. React state is never the
 * source of truth here.
 */
export default function DispatchMaterialsPage() {
  /**
   * `useParams()`, NOT `use(params)`.
   *
   * `params` is a promise, and `use()` on a pending promise SUSPENDS. There is
   * no Suspense boundary and no `loading.tsx` anywhere between this page and
   * the app shell, and `ScreenTransition` keys its `<section>` on the pathname
   * — so every navigation tears the subtree down and mounts a new one. A page
   * that suspends in that position has nothing to fall back to.
   *
   * Whether it suspended at all depended on whether the params promise had
   * already resolved by the time React rendered: a microtask race, which is
   * exactly why the failure was intermittent rather than constant. `useParams`
   * is synchronous, returns the already-parsed route params, and cannot
   * suspend. It is also what the rest of the codebase's client pages use (see
   * `src/app/(admin)/admin/yards/[id]/page.tsx`).
   */
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useUI();
  const invalidateChannels = useInvalidateChannels();

  const detailQ = useQuery({
    queryKey: ["dispatch", id],
    queryFn: () => getJson<{ dispatch: Detail }>(`/api/outward/dispatches/${id}`),
    /**
     * A missing dispatch is an answer, not a failure — retrying a 404 three
     * times only makes the operator wait longer to be told the same thing. A
     * transport failure IS worth retrying, which is what a yard's mobile
     * signal actually produces.
     */
    retry: (count, err) => !(err instanceof ApiError && err.code === "NOT_FOUND") && count < 2,
  });
  const materialsQ = useQuery({
    queryKey: ["materials"],
    queryFn: () => getJson<{ materials: Material[] }>("/api/materials"),
  });

  const [cart, setCart] = useState<CartItem[]>([]);
  const [materialId, setMaterialId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * Material photographs, keyed by SKU — byte-for-byte Inward's structure.
   * A material may not be weighed onto the vehicle until it has been
   * photographed, which is the same rule Inward enforces on the way in.
   */
  const [materialImages, setMaterialImages] = useState<Record<string, string[]>>({});
  const [matCamOpen, setMatCamOpen] = useState(false);
  /**
   * The shared entry's handle. `release()` lets a weight parked by the image
   * gate through once the photographs are attached; `discard()` drops it when
   * the sheet is closed without any.
   */
  const entryRef = useRef<MaterialEntryHandle | null>(null);
  /** Seeded once per dispatch, so a re-render never re-seeds over live edits. */
  const [seeded, setSeeded] = useState<string | null>(null);

  const detail = detailQ.data?.dispatch ?? null;
  const materials = materialsQ.data?.materials ?? [];

  useEffect(() => {
    if (!detail || seeded === detail.id) return;
    setSeeded(detail.id);
    setCart(
      detail.materials.map((m, i) => ({
        key: `${m.id}-${i}`,
        skuId: m.skuId,
        label: m.label,
        kg: m.kg,
        unit: "KG" as const,
        ratePerKg: m.ratePerKg ?? 0,
      }))
    );
    /**
     * A resumed dispatch already satisfied the gate for the materials it
     * carries — re-photographing them would be busy-work, and the images are
     * on the record. Seeding the map with the stored URLs is what makes the
     * gate agree with what the dispatch actually has.
     */
    if (detail.materialImages?.length) {
      const byS: Record<string, string[]> = {};
      for (const m of detail.materials) byS[m.skuId] = detail.materialImages;
      setMaterialImages(byS);
    }
  }, [detail, seeded]);

  const activeMaterial = materials.find((m) => m.id === materialId) ?? null;
  const currentImages = materialId ? (materialImages[materialId] ?? []) : [];

  /** The same nudge Inward gives when the gate turns a weight away. */
  function promptMaterialImages() {
    toast("📷 Upload Material images first");
  }

  async function save() {
    if (cart.length === 0) {
      toast("Add at least one material");
      return;
    }
    setSaving(true);
    try {
      await sendJson(
        `/api/outward/dispatches/${id}`,
        {
          step: "MATERIALS",
          // Always kilograms — the unit selector converts before anything is
          // added to the cart, so no unit ever reaches the server.
          lines: cart.map((c) => ({ skuId: c.skuId, kg: c.kg, ratePerKg: c.ratePerKg })),
          // Every photograph the gate collected, stored against the dispatch —
          // the same `materialImageUrls` field name Inward posts.
          materialImageUrls: [...new Set(Object.values(materialImages).flat())],
        },
        "PATCH"
      );
      invalidateChannels("outward");
      toast("✓ Materials saved");
      // Step 3, NOT step 4. In Transit is a stage of this workflow, not a
      // formality to skip — and the API refuses a proof written before it.
      router.push(`/outward/${id}/transit`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not save the materials");
    } finally {
      setSaving(false);
    }
  }

  if (detailQ.isLoading) {
    return (
      <>
        <div className="secTitle">Material Entry</div>
        <div className="skel" style={{ height: 120, marginBottom: 12 }} />
      </>
    );
  }
  /**
   * A transport failure is NOT a missing dispatch.
   *
   * Both used to land on "Dispatch not found", so a dropped request on a yard's
   * mobile signal looked exactly like a deleted record and left the operator at
   * a dead end with a dispatch that was in fact fine. They are now separate
   * states, and the recoverable one offers the recovery.
   */
  if (detailQ.isError) {
    const missing = detailQ.error instanceof ApiError && detailQ.error.code === "NOT_FOUND";
    return (
      <>
        <div className="dTopRow">
          <button type="button" className="dBack" onClick={() => router.push("/outward")}>
            ‹ Back
          </button>
        </div>
        <div className="secTitle">Material Entry</div>
        <div className="lot">
          <h3>{missing ? "Dispatch not found" : "Could not load this dispatch"}</h3>
          <small style={{ fontFamily: "var(--mono)", color: "var(--muted)", display: "block" }}>
            {missing
              ? "It may belong to another yard, or it may have been removed."
              : "The connection dropped before the dispatch could be read. Nothing has been lost."}
          </small>
          {!missing && (
            <button className="cta" onClick={() => void detailQ.refetch()}>
              TRY AGAIN
            </button>
          )}
        </div>
      </>
    );
  }

  if (!detail) {
    return (
      <>
        <div className="secTitle">Material Entry</div>
        <div className="lot">
          <h3>Dispatch not found</h3>
          <small style={{ fontFamily: "var(--mono)", color: "var(--muted)" }}>
            It may belong to another yard, or it may have been removed.
          </small>
        </div>
      </>
    );
  }

  return (
    <>
      <DispatchStepHeader
        title="Material Entry"
        step="MATERIALS"
        backHref="/outward"
        refCode={detail.ref}
        progress={detail}
      />

      <div className="entryCard">
        <div className="cardHead">
          <span className="cardHeadTitle">MATERIALS</span>
        </div>

        {/*
          The SAME `MaterialEntry` Inward renders, now carrying the SAME gate.

          `gate` is the component's existing extension point: it parks a weight,
          runs the caller's recovery, and releases the weight once the caller
          says the requirement is met. Nothing about the calculator, the cart or
          the rate handling changes — Outward simply stopped being the caller
          that passed no gate.
        */}
        <MaterialEntry
          materials={materials}
          cart={cart}
          onCartChange={setCart}
          activeMaterialId={materialId}
          onPickMaterial={setMaterialId}
          handleRef={entryRef}
          gate={{
            message: "Upload Material images first",
            blocked: (skuId) => (materialImages[skuId] ?? []).length === 0,
            onBlocked: (skuId) => {
              setMaterialId(skuId);
              setMatCamOpen(true);
            },
          }}
          summaryTitle="Current Load"
          summarySubtitle="Materials loaded onto this vehicle"
          totalLabel="TOTAL DISPATCH"
          // The dispatch scores on completion, not per line — one vehicle is
          // one piece of work however many materials go on it.
          xpPerLine={0}
        />

        <button className="cta" disabled={saving || cart.length === 0} onClick={save}>
          {saving ? "SAVING…" : "UPDATE · CONTINUE TO TRANSIT"}
        </button>
      </div>

      {/* The material-image sheet, in `mode="materials"` — the identical
          component, mode and upload path Inward uses. When a weight is waiting
          on it, completing the sheet releases that weight to the entry card;
          closing it without images releases nothing and repeats the
          requirement. */}
      {matCamOpen && materialId && (
        <CameraSheet
          key={materialId}
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
            setMaterialImages((m) => ({ ...m, [materialId]: data.materialUrls }));
            setMatCamOpen(false);
            toast(`✓ ${data.materialUrls.length} image(s) attached to ${activeMaterial?.name ?? "material"}`);
            // The gate is satisfied: let the weight the operator already
            // entered through to the entry card.
            entryRef.current?.release();
          }}
        />
      )}
    </>
  );
}
