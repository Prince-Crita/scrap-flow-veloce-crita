"use client";

import { useQuery } from "@tanstack/react-query";
import { getJson } from "@/lib/fetcher";
import { fmt, fmtInr } from "@/lib/format";
import { PhonePortal } from "@/components/phone-portal";

type Sale = {
  id: string;
  invoiceNumber: string;
  buyerName: string;
  skuName: string;
  quantityKg: number;
  total: number;
  paymentStatus: string;
  createdAt: string;
};

const PAY_COLOR: Record<string, string> = {
  PAID: "var(--led)",
  PARTIAL: "var(--orange)",
  PENDING: "var(--muted)",
};

export function ReportsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["sales"],
    queryFn: () => getJson<{ sales: Sale[] }>("/api/sales"),
    enabled: open,
  });

  if (!open) return null;
  const sales = data?.sales ?? [];

  return (
    <PhonePortal>
    <div className="sheetWrap" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" />
        <div className="sheetTitle">Sales Reports</div>
        <div className="sheetStep">{sales.length} sale(s) · owner summary</div>

        {isLoading && <div className="skel" style={{ height: 70, marginBottom: 8 }} />}
        {!isLoading && sales.length === 0 && (
          <div className="recv">
            <span>No sales recorded yet</span>
          </div>
        )}

        {sales.map((s) => {
          const when = new Date(s.createdAt).toLocaleString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
          return (
            <div key={s.id} className="reportCard">
              <div className="reportTop">
                <b>{s.invoiceNumber}</b>
                <span className="pay" style={{ color: PAY_COLOR[s.paymentStatus] ?? "var(--muted)" }}>
                  {s.paymentStatus}
                </span>
              </div>
              <div className="reportBody">
                <span>{s.buyerName}</span>
                <span>
                  {s.skuName} · {fmt(s.quantityKg)} kg
                </span>
              </div>
              <div className="reportFoot">
                <span>{when}</span>
                <b>{fmtInr(s.total)}</b>
              </div>
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
