"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { getJson, sendJson, ApiError } from "@/frontend/lib/api-client";
import { compressImage } from "@/frontend/lib/image";
import { useUI } from "@/frontend/components/ui-provider";
import { usePhotoSource } from "@/frontend/components/photo-source";
import { useInvalidateChannels } from "@/frontend/components/realtime/provider";
import { DispatchStepHeader } from "@/frontend/components/dispatch-flow";
import type { DispatchProgress } from "@/shared/dispatch-stage";

type Detail = {
  id: string;
  ref: string;
  stage: DispatchProgress["stage"];
  state: DispatchProgress["state"];
  lineCount: number;
  hasTransit: boolean;
  hasProof: boolean;
  dispatchedAt: string | null;
  filledImageUrl: string | null;
  dcUrl: string | null;
};

/**
 * Local wall-clock time in the `datetime-local` shape (`YYYY-MM-DDTHH:mm`).
 *
 * Built from the parts rather than from `toISOString()`, which is UTC and would
 * hand the operator a time several hours from the one on the yard clock.
 */
function localNow(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * In Transit — step 3.
 *
 * This IS the screen that used to be called "Dispatch Proof": the same three
 * things in the same order, the same controls, the same uploads. It was never
 * proof of anything — it records the vehicle LEAVING, which is what In Transit
 * means, so the step was renamed and re-sequenced rather than rebuilt. Proof of
 * Dispatch is now its own step 4 and asks for the loaded weighbridge slip.
 *
 * Completing this does NOT complete the dispatch. It moves it to IN_TRANSIT and
 * hands over to step 4 — the transition the backend enforces, so no client can
 * jump from Materials straight to Completed.
 */
export default function DispatchTransitPage() {
  /**
   * `useParams()`, NOT `use(params)` — the latter suspends on a pending promise
   * and there is no Suspense boundary between here and the app shell. See the
   * materials page for the full reasoning.
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
  const detail = detailQ.data?.dispatch ?? null;

  const [when, setWhen] = useState<string>(() => localNow());
  const [filled, setFilled] = useState<string | null>(null);
  const [dc, setDc] = useState<string | null>(null);
  const [busy, setBusy] = useState<"filled" | "dc" | null>(null);
  const [saving, setSaving] = useState(false);
  const [seeded, setSeeded] = useState<string | null>(null);

  // Seeded from the server so reopening a dispatch shows what it already has.
  useEffect(() => {
    if (!detail || seeded === detail.id) return;
    setSeeded(detail.id);
    if (detail.dispatchedAt) setWhen(localNow(new Date(detail.dispatchedAt)));
    if (detail.filledImageUrl) setFilled(detail.filledImageUrl);
    if (detail.dcUrl) setDc(detail.dcUrl);
  }, [detail, seeded]);

  /** Both uploads use the SAME control and the SAME endpoint as everywhere else. */
  async function upload(file: File | undefined, kind: string, which: "filled" | "dc") {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast("That file must be an image");
      return;
    }
    setBusy(which);
    try {
      const dataUrl = await compressImage(file);
      const res = await sendJson<{ url: string }>("/api/uploads", { dataUrl, kind });
      if (which === "filled") setFilled(res.url);
      else setDc(res.url);
      toast(which === "filled" ? "📷 Loaded vehicle attached" : "🧾 DC attached");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not upload");
    } finally {
      setBusy(null);
    }
  }

  const filledPicker = usePhotoSource((f) => void upload(f, "material", "filled"), {
    title: "Materials filled vehicle",
  });
  const dcPicker = usePhotoSource((f) => void upload(f, "invoice", "dc"), { title: "Delivery challan" });

  async function submit() {
    if (!when) {
      toast("Choose the dispatch date and time");
      return;
    }
    if (!filled) {
      toast("📷 Add the loaded vehicle image");
      return;
    }
    setSaving(true);
    try {
      await sendJson(
        `/api/outward/dispatches/${id}`,
        {
          step: "TRANSIT",
          // `datetime-local` has no zone; the Date constructor reads it as local
          // wall-clock time, which is what the operator picked.
          dispatchedAt: new Date(when).toISOString(),
          filledImageUrl: filled,
          dcUrl: dc,
        },
        "PATCH"
      );
      invalidateChannels("outward");
      toast("🚚 In transit");
      router.push(`/outward/${id}/proof`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not mark this dispatch in transit");
      setSaving(false);
    }
  }

  if (detailQ.isLoading) {
    return (
      <>
        <div className="secTitle">In Transit</div>
        <div className="skel" style={{ height: 120, marginBottom: 12 }} />
      </>
    );
  }
  /**
   * A transport failure is NOT a missing dispatch. They are separate states,
   * and the recoverable one offers the recovery.
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
        <div className="secTitle">In Transit</div>
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
        <div className="secTitle">In Transit</div>
        <div className="lot">
          <h3>Dispatch not found</h3>
        </div>
      </>
    );
  }

  return (
    <>
      <DispatchStepHeader
        title="In Transit"
        step="TRANSIT"
        backHref={`/outward/${id}/materials`}
        refCode={detail.ref}
        progress={detail}
      />

      <div className="entryCard">
        <div className="field">
          <label>Date / Time</label>
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            aria-label="Dispatch date and time"
          />
        </div>

        <div className="pickField" style={{ marginTop: 4 }}>
          <label>Materials Filled Vehicle Image</label>
          <div className={`pickCtl${filled ? " filled" : ""}`} onClick={() => busy !== "filled" && filledPicker.pick()}>
            <span className="pickCtlVal">
              {busy === "filled" ? "Uploading…" : filled ? "✓ Loaded vehicle attached" : "Capture or upload"}
            </span>
            {filled && (
              <button
                className="pickClear"
                title="Remove image"
                onClick={(e) => {
                  e.stopPropagation();
                  setFilled(null);
                }}
              >
                ✕
              </button>
            )}
            <span className="pickCaret">›</span>
          </div>
        </div>

        <div className="pickField" style={{ marginTop: 14 }}>
          <label>DC Upload · Optional</label>
          <div className={`pickCtl${dc ? " filled" : ""}`} onClick={() => busy !== "dc" && dcPicker.pick()}>
            <span className="pickCtlVal">
              {busy === "dc" ? "Uploading…" : dc ? "✓ DC attached" : "Capture or upload (optional)"}
            </span>
            {dc && (
              <button
                className="pickClear"
                title="Remove DC"
                onClick={(e) => {
                  e.stopPropagation();
                  setDc(null);
                }}
              >
                ✕
              </button>
            )}
            <span className="pickCaret">›</span>
          </div>
          <p className="hint">A dispatch can move on without a delivery challan.</p>
        </div>

        <button className="cta" disabled={saving || !when || !filled} onClick={submit}>
          {saving ? "SAVING…" : "UPDATE · CONTINUE TO PROOF"}
        </button>
        {(!when || !filled) && (
          <p className="hint" style={{ color: "var(--orange)" }}>
            Date/time and the loaded vehicle image are both required.
          </p>
        )}
      </div>

      {filledPicker.node}
      {dcPicker.node}
    </>
  );
}
