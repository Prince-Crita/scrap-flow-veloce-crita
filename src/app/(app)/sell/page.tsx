"use client";

import { useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { getJson, sendJson, ApiError } from "@/frontend/lib/api-client";
import { compressImage } from "@/frontend/lib/image";
import { fmt } from "@/shared/format";
import { useUI } from "@/frontend/components/ui-provider";
import { usePhotoSource } from "@/frontend/components/photo-source";
import { OutwardPickups } from "@/frontend/components/outward-pickups";
import { useDispatches, type DispatchRow } from "@/frontend/components/dispatch-list";
import { useInvalidateChannels } from "@/frontend/components/realtime/provider";
import { loadRefDateTime } from "@/shared/load-ref";

type ReadySku = { skuId: string; name: string; icon: string; quantityKg: number; thresholdKg: number };
type ReadyResp = {
  ready: ReadySku[];
  receivables: { id: string; buyerName: string; invoiceNumber: string; amount: number }[];
};

/**
 * Ready to Invoice — OWNER only.
 *
 * A dispatch appears here the moment it is COMPLETED and not before: the filter
 * is the persisted dispatch state, so nothing can show up until Fleet →
 * Materials → In Transit → Proof of Dispatch have all been satisfied. Once an
 * invoice is attached the row leaves, because the paperwork it was asking for
 * is done.
 *
 * The card is the SAME `.alert` block Ready to Sell uses — same chip, same
 * heading, same small line, same right-hand `.sellBtn`. Only the button's word
 * differs, which is the whole of the design difference between the two
 * sections.
 */
function ReadyToInvoice() {
  const { data: session } = useSession();
  const { toast } = useUI();
  const invalidateChannels = useInvalidateChannels();
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * Which dispatch the picker is collecting an invoice for.
   *
   * A REF, not state: the file input fires long after the tap that opened the
   * picker, and reading the target through a ref means the handler cannot be
   * left holding a value from an earlier render. Same reason `MaterialEntry`
   * reads its parked weight through one.
   */
  const target = useRef<DispatchRow | null>(null);

  /**
   * OWNER (and an ADMIN inside a yard) only.
   *
   * `/sell` is already an Owner route in the permission matrix, so this is a
   * second lock on the same door rather than the only one — but a Supervisor
   * must not see this section under any circumstances, and the data behind it
   * (`/api/outward/dispatches`) is readable by a Supervisor because they run
   * the dispatch workflow. Gating the render is what makes the rule hold
   * independently of how the page was reached.
   */
  const role = session?.user?.role;
  const allowed = role === "OWNER" || role === "ADMIN";

  // Server-side filter — the same query the Dispatch History card reads, so
  // there is no second definition of "completed" anywhere in the app.
  const { data, isLoading } = useDispatches("COMPLETED", { enabled: allowed });
  const pending = (data?.dispatches ?? []).filter((d) => !d.invoiceUrl);

  async function upload(file: File | undefined) {
    const d = target.current;
    if (!file || !d) return;
    if (!file.type.startsWith("image/")) {
      toast("The invoice must be an image");
      return;
    }
    setBusyId(d.id);
    try {
      // The SAME compress → /api/uploads → store-the-url path every other
      // document in the app uses. No second upload system.
      const dataUrl = await compressImage(file);
      const res = await sendJson<{ url: string }>("/api/uploads", { dataUrl, kind: "invoice" });
      await sendJson(`/api/outward/dispatches/${d.id}`, { step: "INVOICE", invoiceUrl: res.url }, "PATCH");
      invalidateChannels("outward");
      toast(`🧾 Invoice attached to ${d.ref}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not upload the invoice");
    } finally {
      setBusyId(null);
      target.current = null;
    }
  }

  const picker = usePhotoSource((f) => void upload(f), { title: "Sale invoice" });

  if (!allowed) return null;

  return (
    <>
      <div className="secTitle">Ready to Invoice</div>

      {isLoading && <div className="skel" style={{ height: 76, marginBottom: 10 }} />}

      {!isLoading && pending.length === 0 && (
        <div className="recv">
          <span>No completed dispatch waiting for an invoice</span>
        </div>
      )}

      {pending.map((d) => (
        <div key={d.id} className="alert">
          <div className="chipIcon">🧾</div>
          <div>
            <h3>
              {d.ref} · {fmt(d.totalKg)} kg dispatched
            </h3>
            <small>
              🚚 {d.vehicleNumber ?? "—"} · {d.driverName ?? "—"} ·{" "}
              {d.dispatchedAt ? loadRefDateTime(d.dispatchedAt) : loadRefDateTime(d.createdAt)}
            </small>
          </div>
          <button
            className="sellBtn"
            disabled={busyId === d.id}
            onClick={() => {
              target.current = d;
              picker.pick();
            }}
          >
            {busyId === d.id ? "…" : "UPLOAD"}
          </button>
        </div>
      ))}

      {picker.node}
    </>
  );
}

/**
 * The Owner's Sell screen.
 *
 * Three sections, in the order the yard works in: what has reached its selling
 * threshold, the dispatch workflow, and what is waiting to be invoiced.
 */
export default function SellPage() {
  // No polling: RealtimeProvider invalidates ["sellReady"] on stock/sort/sales
  // events — and completing a dispatch now publishes `stock`, so a material
  // whose balance drops back under its threshold leaves this list on its own.
  const readyQ = useQuery({ queryKey: ["sellReady"], queryFn: () => getJson<ReadyResp>("/api/sell/ready") });
  const ready = readyQ.data?.ready ?? [];

  return (
    <>
      <div className="secTitle">Ready to Sell</div>

      {readyQ.isLoading && <div className="skel" style={{ height: 76, marginBottom: 10 }} />}

      {!readyQ.isLoading && ready.length === 0 && (
        <div className="recv">
          <span>No SKU at threshold yet — keep sorting 💪</span>
        </div>
      )}

      {ready.map((s) => (
        <div key={s.skuId} className="alert">
          <div className="chipIcon">{s.icon}</div>
          <div>
            <h3>
              {s.name} hit {fmt(s.thresholdKg)} kg
            </h3>
            <small>{fmt(s.quantityKg)} kg in yard · check live rate above</small>
          </div>
          {/*
            Ready to Sell is a READINESS NOTICE, not a transaction screen: it
            reports which materials have reached their configured threshold, and
            stock leaves the yard through the dispatch workflow below rather
            than from here. The button is kept exactly as it was — same class,
            same place, same label — deliberately without an action, so the
            section's appearance is unchanged while the selling itself lives in
            one place instead of two.
          */}
          <button className="sellBtn" type="button" aria-disabled>
            SELL
          </button>
        </div>
      ))}

      {/*
        Order: Ready to Sell → Ready to Invoice → Dispatch.

        It reads as the yard's own sequence — what has reached its threshold,
        what has gone out and still needs paperwork, and the workflow that moves
        material. Each section's own markup is untouched; only their order here
        changed.
      */}
      <ReadyToInvoice />

      {/*
        Dispatch — the SAME workflow the Supervisor runs from Outward.

        `<OutwardPickups />` is the Outward page's own body, rendered here
        unchanged: the same New / Active / History cards, the same
        `/api/outward/dispatches` records and the same dispatch IDs. There is
        one dispatch system and one set of rows; the Owner and the Supervisor
        are two doors into it, not two copies of it.
      */}
      <OutwardPickups title="Dispatch" />
    </>
  );
}
