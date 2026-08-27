"use client";

import { useQuery } from "@tanstack/react-query";
import { getJson } from "@/frontend/lib/api-client";
import { fmt } from "@/shared/format";
import { PhonePortal } from "@/frontend/components/phone-portal";

type Sources = {
  sku: { id: string; name: string; icon: string; quantityKg: number; isMixedBucket: boolean };
  consumedLabel: string;
  sources: {
    vendorName: string;
    vehicleNumber: string;
    addedKg: number;
    remainingKg: number;
    consumedKg: number;
    createdAt: string;
  }[];
};

export function StockDetailSheet({ skuId, onClose }: { skuId: string | null; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["stockSources", skuId],
    queryFn: () => getJson<Sources>(`/api/stock/${skuId}/sources`),
    enabled: !!skuId,
  });

  if (!skuId) return null;

  return (
    <PhonePortal>
    <div className="sheetWrap" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" />
        <div className="sheetTitle">
          {data ? `${data.sku.icon} ${data.sku.name}` : "Stock sources"}
        </div>
        <div className="sheetStep">
          {data ? `${fmt(data.sku.quantityKg)} kg in yard · vendor traceability` : "Loading…"}
        </div>

        {isLoading && <div className="skel" style={{ height: 60, marginBottom: 8 }} />}

        {data && data.sources.length === 0 && (
          <div className="recv">
            <span>No source batches recorded yet</span>
          </div>
        )}

        {data?.sources.map((s, i) => {
          const when = new Date(s.createdAt).toLocaleString("en-IN", {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          });
          return (
            <div key={i} className="traceRow">
              <div className="traceHead">
                <b>{s.vendorName}</b>
                <span>🚚 {s.vehicleNumber}</span>
              </div>
              <div className="traceMeta">
                <span>Added {fmt(s.addedKg)} kg</span>
                <span>
                  {data.consumedLabel} {fmt(s.consumedKg)} kg
                </span>
                <span className="rem">Remaining {fmt(s.remainingKg)} kg</span>
              </div>
              <div className="traceWhen">{when}</div>
            </div>
          );
        })}

        <button className="cta ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
    </PhonePortal>
  );
}
