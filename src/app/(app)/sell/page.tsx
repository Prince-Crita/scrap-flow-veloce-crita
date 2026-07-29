"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "@/lib/fetcher";
import { fmt, fmtInr } from "@/lib/format";
import { useUI } from "@/components/ui-provider";
import { SellSheet, type ReadySku } from "@/components/sell-sheet";
import { DispatchStatus } from "@/components/dispatch-status";
import { useInvalidateChannels } from "@/components/realtime/provider";

type ReadyResp = {
  ready: ReadySku[];
  receivables: { id: string; buyerName: string; invoiceNumber: string; amount: number }[];
};
type SalesResp = {
  sales: {
    id: string;
    invoiceNumber: string;
    buyerName: string;
    skuName: string;
    quantityKg: number;
    total: number;
    status: string;
    createdAt: string;
  }[];
};

export default function SellPage() {
  const { toast, party, bump } = useUI();
  const invalidateChannels = useInvalidateChannels();
  const [selling, setSelling] = useState<ReadySku | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // No polling: RealtimeProvider invalidates ["sellReady"] on stock/sort/sales
  // events, so this list updates the moment the yard changes.
  const readyQ = useQuery({ queryKey: ["sellReady"], queryFn: () => getJson<ReadyResp>("/api/sell/ready") });
  const salesQ = useQuery({ queryKey: ["sales"], queryFn: () => getJson<SalesResp>("/api/sales"), enabled: showHistory });

  const ready = readyQ.data?.ready ?? [];
  const receivables = readyQ.data?.receivables ?? [];

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
          <button className="sellBtn" onClick={() => setSelling(s)}>
            SELL
          </button>
        </div>
      ))}

      <div className="secTitle">Receivables</div>
      {receivables.length === 0 && (
        <div className="recv">
          <span>No pending receivables</span>
        </div>
      )}
      {receivables.map((r) => (
        <div key={r.id} className="recv">
          <span>
            {r.buyerName} · {r.invoiceNumber}
          </span>
          <b>{fmtInr(r.amount)}</b>
        </div>
      ))}

      <button className="cta ghost" onClick={() => toast("🧾 GST invoice + E-Way draft ready")}>
        Generate GST invoice / E-Way
      </button>
      <button className="cta ghost" onClick={() => setShowHistory((v) => !v)}>
        {showHistory ? "Hide invoice history" : "View invoice history"}
      </button>

      {/* Replaces the old Reports block: a sale is an allocation now, so what
          matters is how much of it has physically left the yard. */}
      <DispatchStatus />

      {showHistory && (
        <>
          <div className="secTitle">Invoice History</div>
          {salesQ.isLoading && <div className="skel" style={{ height: 40, marginBottom: 8 }} />}
          {(salesQ.data?.sales ?? []).map((s) => (
            <div key={s.id} className="recv">
              <span>
                {s.invoiceNumber} · {s.buyerName} · {s.skuName}
              </span>
              <b>{fmtInr(s.total)}</b>
            </div>
          ))}
        </>
      )}

      <SellSheet
        sku={selling}
        onClose={() => setSelling(null)}
        onSold={(r) => {
          // Matches what /api/sales publishes; the old list missed the
          // Manager-facing `outwardQueue` a new allocation creates.
          invalidateChannels("sales", "stock", "outward");
          void bump(80);
          party("💰", "SALE LOGGED!", `${fmt(r.quantityKg)} kg ${r.skuName} · ${r.invoiceNumber}`, "+80 XP");
        }}
      />
    </>
  );
}
