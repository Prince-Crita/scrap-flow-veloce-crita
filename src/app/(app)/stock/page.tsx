"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { getJson, sendJson } from "@/lib/fetcher";
import { fmt } from "@/lib/format";
import { useUI } from "@/components/ui-provider";
import { StockDetailSheet } from "@/components/stock-detail-sheet";
import { useInvalidateChannels } from "@/components/realtime/provider";

type StockSku = {
  id: string;
  code: string;
  name: string;
  icon: string;
  quantityKg: number;
  thresholdKg: number;
  isMixedBucket: boolean;
  visible: boolean;
  ready: boolean;
  /** Last inventory movement. Used only to order ready cards; may be null. */
  updatedAt: string | null;
};

export default function StockPage() {
  const { toast } = useUI();
  const invalidateChannels = useInvalidateChannels();
  const [manage, setManage] = useState(false);
  const [detailSku, setDetailSku] = useState<string | null>(null);

  // No polling: RealtimeProvider invalidates ["stock"] on inward/sort/sale
  // events, so this list reflects the yard the moment it changes.
  const { data, isLoading } = useQuery({
    queryKey: ["stock"],
    queryFn: () => getJson<{ skus: StockSku[] }>("/api/stock"),
  });

  const toggleVis = useMutation({
    mutationFn: (s: StockSku) => sendJson(`/api/skus/${s.id}/visibility`, { visible: !s.visible }, "PATCH"),
    onSuccess: () => invalidateChannels("stock"),
  });

  /**
   * READY TO SELL cards float to the top, newest first.
   *
   * The point of this screen is "what can I sell right now", and a ready SKU sat
   * wherever `sortOrder` happened to put it — below three cards that are nowhere
   * near their threshold. Ready items lead, ordered by their most recent stock
   * movement so the one that just crossed the line is first; everything else keeps
   * the existing `sortOrder` sequence the API returns.
   *
   * Display only. Nothing here touches quantities, thresholds or the `ready` flag
   * itself — all three are computed server-side and used exactly as received.
   *
   * Manage mode is deliberately left in the API's order: reordering cards while
   * the operator is tapping them to hide and show would move the next target out
   * from under their finger.
   */
  const visible = (data?.skus ?? []).filter((s) => manage || s.visible);
  const skus = manage
    ? visible
    : [
        ...visible
          .filter((s) => s.ready)
          .sort((a, b) => {
            const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
            const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
            return bt - at; // newest ready first
          }),
        ...visible.filter((s) => !s.ready),
      ];

  return (
    <>
      <div className="secTitle">Live Stock · SKU-wise</div>

      {isLoading && (
        <>
          <div className="skel" style={{ height: 92, marginBottom: 10 }} />
          <div className="skel" style={{ height: 92, marginBottom: 10 }} />
          <div className="skel" style={{ height: 92, marginBottom: 10 }} />
        </>
      )}

      {skus.map((s) => {
        const showMeter = s.thresholdKg < 90000;
        const pct = Math.min(100, Math.round((s.quantityKg / s.thresholdKg) * 100));
        const barCol = s.ready ? "var(--led)" : pct > 70 ? "var(--mint)" : "var(--orange)";
        return (
          <div
            key={s.id}
            className={`sku${s.ready && !manage ? " isReady" : ""}`}
            style={{ opacity: !s.visible ? 0.45 : 1, cursor: "pointer" }}
            onClick={() => {
              if (manage) toggleVis.mutate(s);
              else setDetailSku(s.id);
            }}
          >
            {s.ready && !manage && <div className="ready">READY TO SELL</div>}
            {manage && (
              <div
                className="ready visBadge"
                style={{ animation: "none", color: s.visible ? "var(--led)" : "var(--muted)" }}
              >
                {s.visible ? "VISIBLE · TAP TO HIDE" : "HIDDEN · TAP TO SHOW"}
              </div>
            )}
            <div className="row">
              <div className="chipIcon">{s.icon}</div>
              <div>
                {/* The prototype's stock card labels the mixed bucket
                    "Mixed MS (unsorted)" while the inward chip and sort header
                    use the bare "Mixed MS". The suffix is display-only, applied
                    here, so the stored SKU name stays the one shared by all
                    three screens. */}
                <h3>
                  {s.name}
                  {s.isMixedBucket ? " (unsorted)" : ""}
                </h3>
                <small>{showMeter ? `sale threshold ${fmt(s.thresholdKg)} kg` : "awaiting segregation"}</small>
              </div>
              <div className="kg">
                <b>{fmt(s.quantityKg)}</b>
                <span> KG</span>
              </div>
            </div>
            {showMeter && (
              <>
                <div className="meter">
                  <i style={{ width: `${pct}%`, background: barCol }} />
                </div>
                <div className="meterLbl">
                  <span>{pct}% of threshold</span>
                  <span>{s.ready ? "🔔 buyer alert sent" : `${fmt(Math.max(0, s.thresholdKg - s.quantityKg))} kg to go`}</span>
                </div>
              </>
            )}
          </div>
        );
      })}

      <button
        className="cta ghost"
        onClick={() => {
          setManage((m) => !m);
          toast(manage ? "Visible SKUs saved" : "Tap a card to hide/show it");
        }}
      >
        {manage ? "✓ Done managing SKUs" : "+ Manage visible SKUs"}
      </button>

      <StockDetailSheet skuId={detailSku} onClose={() => setDetailSku(null)} />
    </>
  );
}
