"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "@/frontend/lib/api-client";
import { fmt, fmtInr } from "@/shared/format";
import { roleLabel } from "@/shared/role-label";
import { PhonePortal } from "@/frontend/components/phone-portal";

type RecentLoad = {
  id: string;
  lotNumber: string;
  /** Platform-unique, human-readable — see src/shared/load-ref.ts. */
  loadRef: string;
  vendorName: string;
  vehicleNumber: string;
  vehicleType: string | null;
  driverName: string | null;
  driverPhone: string | null;
  totalKg: number;
  materials: { label: string; kg: number }[];
  /** One per "Add to Cart", with its own rate. Empty on pre-rate loads. */
  entries: { label: string; kg: number; ratePerKg: number | null }[];
  /** Tri-state: null means the question was never asked, not "No". */
  hasInvoice: boolean | null;
  invoiceNumber: string | null;
  invoiceUrl: string | null;
  slipUrl: string | null;
  capturedByName: string | null;
  capturedByRole: string | null;
  createdAt: string;
};

/** "Yes" only when the thing it claims exists; "—" when nothing was recorded. */
function yesNo(state: boolean | null): string {
  return state == null ? "—" : state ? "Yes" : "No";
}

/**
 * Read-only list of what was just saved, so the operator can confirm a load
 * without leaving Inward. It never mutates, and it reuses the page's existing
 * type and spacing vocabulary rather than introducing a new card style.
 *
 * `asModal` only changes where the SAME cards are drawn: Inward now reaches them
 * through one line instead of giving them permanent room on the page. The query,
 * its ordering and its realtime invalidation are untouched.
 */
export function RecentLoads({ asModal, onClose }: { asModal?: boolean; onClose?: () => void } = {}) {
  const [open, setOpen] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["recentLoads"],
    queryFn: () => getJson<{ loads: RecentLoad[] }>("/api/inward/recent"),
  });

  // No polling and no realtime code here: the realtime provider already
  // invalidates ["recentLoads"] on the `inward` channel.
  const loads = data?.loads ?? [];

  const body = (
    <>
      {!asModal && (
        <div className="secTitle" style={{ marginTop: 22 }}>
          Recent Load Details
        </div>
      )}

      {isLoading && <div className="skel" style={{ height: 56 }} />}

      {!isLoading && loads.length === 0 && (
        <div className="entry" style={{ borderBottom: "none" }}>
          <span>No loads saved yet</span>
        </div>
      )}

      {loads.map((l) => {
        const when = new Date(l.createdAt).toLocaleString("en-IN", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        });
        const isOpen = open === l.id;
        // Weighments carry their own rate; loads saved before rates existed have
        // none, and fall back to the grouped material lines they always showed.
        const rows =
          l.entries.length > 0
            ? l.entries.map((e) => ({ label: e.label, kg: e.kg, ratePerKg: e.ratePerKg }))
            : l.materials.map((m) => ({ label: m.label, kg: m.kg, ratePerKg: null as number | null }));
        const by = l.capturedByName ?? (l.capturedByRole ? roleLabel(l.capturedByRole) : null);
        return (
          <div key={l.id} className="rlCard">
            <button
              className="rlHead"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : l.id)}
            >
              <span className="rlLot">{l.loadRef}</span>
              <span className="rlKg">{fmt(l.totalKg)} kg</span>
              <span className="rlCaret">{isOpen ? "▾" : "▸"}</span>
            </button>

            <div className="rlMeta">
              {l.vendorName} · 🚚 {l.vehicleNumber} · {when}
            </div>

            {isOpen && (
              <div className="rlBody">
                <div className="rlRow">
                  <span>Load ID</span>
                  <b>{l.loadRef}</b>
                </div>
                <div className="rlRow">
                  <span>Lot</span>
                  <b>#{l.lotNumber}</b>
                </div>
                <div className="rlRow">
                  <span>Vendor</span>
                  <b>{l.vendorName}</b>
                </div>
                <div className="rlRow">
                  <span>Vehicle</span>
                  <b>
                    {l.vehicleNumber}
                    {l.vehicleType ? ` · ${l.vehicleType}` : ""}
                  </b>
                </div>
                <div className="rlRow">
                  <span>Driver</span>
                  <b>
                    {l.driverName ?? "—"}
                    {l.driverPhone ? ` · ${l.driverPhone}` : ""}
                  </b>
                </div>

                {rows.map((m, i) => (
                  <div key={`${l.id}-${i}`} className="rlRow">
                    <span>{i === 0 ? "Materials" : ""}</span>
                    <b>
                      {m.label} — {fmt(m.kg)} kg
                      {m.ratePerKg != null ? ` @ ${fmtInr(m.ratePerKg)}/kg` : ""}
                    </b>
                  </div>
                ))}

                <div className="rlRow">
                  <span>Invoice / Challan</span>
                  <b>
                    {yesNo(l.hasInvoice)}
                    {l.invoiceNumber ? ` · ${l.invoiceNumber}` : ""}
                    {l.invoiceUrl ? (
                      <>
                        {" · "}
                        <a href={l.invoiceUrl} target="_blank" rel="noreferrer" className="rlLink">
                          View
                        </a>
                      </>
                    ) : null}
                  </b>
                </div>
                <div className="rlRow">
                  <span>Slip</span>
                  <b>
                    {l.slipUrl ? (
                      <>
                        {"Yes · "}
                        <a href={l.slipUrl} target="_blank" rel="noreferrer" className="rlLink">
                          View slip
                        </a>
                      </>
                    ) : (
                      "No"
                    )}
                  </b>
                </div>
                <div className="rlRow">
                  <span>Entered by</span>
                  <b>
                    {by ?? "—"}
                    {l.capturedByName && l.capturedByRole ? ` · ${roleLabel(l.capturedByRole)}` : ""}
                  </b>
                </div>
                <div className="rlRow">
                  <span>Timestamp</span>
                  <b>{when}</b>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );

  if (!asModal) return body;

  return (
    <PhonePortal>
      <div className="sheetWrap" onClick={onClose}>
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <div className="sheetTitle">Recent Load Details</div>
          <div className="sheetStep">The last loads saved in this yard</div>
          {body}
          <button className="cta ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </PhonePortal>
  );
}
