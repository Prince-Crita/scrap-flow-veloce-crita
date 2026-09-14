"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
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
  loadedSlipUrl: string | null;
  proofBy: string | null;
};

/**
 * Proof of Dispatch — step 4, and the one that completes the dispatch.
 *
 * Two things, and deliberately only two: WHO signed the dispatch off, and the
 * weighbridge slip for the LOADED vehicle. The departure time, the loaded
 * vehicle photograph and the delivery challan that used to live on this screen
 * have moved to In Transit (step 3), where they belong — this page is the
 * paperwork that closes the dispatch, not the record of it leaving.
 *
 * "Entered By" is read from the session for DISPLAY only. The server stamps
 * `proofById` from the authenticated user and ignores anything the client might
 * send, so the name on the record cannot be someone the operator typed.
 */
export default function DispatchProofPage() {
  /**
   * `useParams()`, NOT `use(params)` — the latter suspends on a pending promise
   * and there is no Suspense boundary between here and the app shell. See the
   * materials page for the full reasoning.
   */
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: session } = useSession();
  const { toast, party, bump } = useUI();
  const invalidateChannels = useInvalidateChannels();

  const detailQ = useQuery({
    queryKey: ["dispatch", id],
    queryFn: () => getJson<{ dispatch: Detail }>(`/api/outward/dispatches/${id}`),
    retry: (count, err) => !(err instanceof ApiError && err.code === "NOT_FOUND") && count < 2,
  });
  const detail = detailQ.data?.dispatch ?? null;

  const [slip, setSlip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [seeded, setSeeded] = useState<string | null>(null);

  // Seeded from the server so reopening a dispatch shows what it already has.
  useEffect(() => {
    if (!detail || seeded === detail.id) return;
    setSeeded(detail.id);
    if (detail.loadedSlipUrl) setSlip(detail.loadedSlipUrl);
  }, [detail, seeded]);

  /** The SAME upload control and endpoint every other slip in the app uses. */
  async function upload(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast("The weighbridge slip must be an image");
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await compressImage(file);
      const res = await sendJson<{ url: string }>("/api/uploads", { dataUrl, kind: "weighbridge-slip" });
      setSlip(res.url);
      toast("🧾 Loaded slip attached");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not upload the slip");
    } finally {
      setBusy(false);
    }
  }

  const slipPicker = usePhotoSource((f) => void upload(f), { title: "Loaded weighbridge slip" });

  /** Whoever is signed in. Recorded server-side; shown here so it is not a surprise. */
  const enteredBy = detail?.proofBy ?? session?.user?.name ?? "—";

  async function complete() {
    if (!slip) {
      toast("🧾 Add the loaded weighbridge slip");
      return;
    }
    setSaving(true);
    try {
      await sendJson(`/api/outward/dispatches/${id}`, { step: "PROOF", loadedSlipUrl: slip }, "PATCH");
      // Completing moves stock as well as status, so both channels refresh —
      // this is what drops a material out of Ready to Sell without a reload.
      invalidateChannels("outward", "stock");
      await bump(50);
      party("🏁", "DISPATCH COMPLETED!", detail?.ref ?? "", "+50 XP");
      router.replace("/outward");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not complete the dispatch");
      setSaving(false);
    }
  }

  if (detailQ.isLoading) {
    return (
      <>
        <div className="secTitle">Proof of Dispatch</div>
        <div className="skel" style={{ height: 120, marginBottom: 12 }} />
      </>
    );
  }
  if (detailQ.isError) {
    const missing = detailQ.error instanceof ApiError && detailQ.error.code === "NOT_FOUND";
    return (
      <>
        <div className="dTopRow">
          <button type="button" className="dBack" onClick={() => router.push("/outward")}>
            ‹ Back
          </button>
        </div>
        <div className="secTitle">Proof of Dispatch</div>
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
        <div className="secTitle">Proof of Dispatch</div>
        <div className="lot">
          <h3>Dispatch not found</h3>
        </div>
      </>
    );
  }

  /**
   * Arriving here with In Transit unfinished is a dead end, not a form: the API
   * refuses the write, so offering the button would only produce an error. The
   * screen says which step is outstanding and links to it instead.
   */
  if (!detail.hasTransit && detail.state !== "COMPLETED") {
    return (
      <>
        <DispatchStepHeader
          title="Proof of Dispatch"
          step="PROOF"
          backHref={`/outward/${id}/transit`}
          refCode={detail.ref}
          progress={detail}
        />
        <div className="lot">
          <h3>In Transit is not finished</h3>
          <small style={{ fontFamily: "var(--mono)", color: "var(--muted)", display: "block" }}>
            A dispatch has to leave the yard before its proof can be filed.
          </small>
          <button className="cta" onClick={() => router.push(`/outward/${id}/transit`)}>
            GO TO IN TRANSIT
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <DispatchStepHeader
        title="Proof of Dispatch"
        step="PROOF"
        backHref={`/outward/${id}/transit`}
        refCode={detail.ref}
        progress={detail}
      />

      <div className="entryCard">
        <div className="pickField">
          <label>Entered By</label>
          {/* Read-only: the server stamps the authenticated user, so an editable
              field here would be a box that cannot change the record. */}
          <div className="pickCtl filled" aria-readonly>
            <span className="pickCtlVal">{enteredBy}</span>
          </div>
          <p className="hint">Recorded automatically from your signed-in account.</p>
        </div>

        <div className="pickField" style={{ marginTop: 14 }}>
          <label>Loaded Weighbridge Slip *</label>
          <div className={`pickCtl${slip ? " filled" : ""}`} onClick={() => !busy && slipPicker.pick()}>
            <span className="pickCtlVal">
              {busy ? "Uploading…" : slip ? "✓ Loaded slip attached" : "Capture or upload"}
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

        <button className="cta" disabled={saving || !slip} onClick={complete}>
          {saving ? "COMPLETING…" : "COMPLETE DISPATCH · +50 XP"}
        </button>
        {!slip && (
          <p className="hint" style={{ color: "var(--orange)" }}>
            The loaded weighbridge slip is required to complete this dispatch.
          </p>
        )}
      </div>

      {slipPicker.node}
    </>
  );
}
