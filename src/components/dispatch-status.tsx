"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "@/lib/fetcher";
import { fmt } from "@/lib/format";

type Vehicle = {
  dispatchNumber: string;
  vehicleNumber: string | null;
  vehicleType: string | null;
  driverName: string | null;
  weightKg: number;
  frontImageUrl: string | null;
  backImageUrl: string | null;
  materialImages: string[];
  dispatchedBy: string | null;
  at: string;
};

type Row = {
  saleId: string;
  invoiceNumber: string;
  buyerName: string;
  skuName: string;
  icon: string;
  allocatedKg: number;
  dispatchedKg: number;
  remainingKg: number;
  status: "PENDING" | "PARTIAL" | "COMPLETED";
  legacy: boolean;
  createdAt: string;
  vehicles: Vehicle[];
};

const LABEL: Record<Row["status"], string> = {
  PENDING: "Pending",
  PARTIAL: "Partial",
  COMPLETED: "Completed",
};

/**
 * Owner's view of what has physically left the yard.
 *
 * Replaces the old Reports button: a sale is now an allocation, so the question
 * that matters is no longer "what did I invoice" but "how much of it is still
 * sitting in my yard". Read-only — only the Manager's Outward workflow moves
 * stock. Live via the existing SSE channels; no polling.
 */
export function DispatchStatus() {
  const [open, setOpen] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["dispatchStatus"],
    queryFn: () =>
      getJson<{ sales: Row[]; totals: { pending: number; partial: number; completed: number } }>(
        "/api/sell/dispatch"
      ),
  });

  const rows = data?.sales ?? [];
  const totals = data?.totals ?? { pending: 0, partial: 0, completed: 0 };

  return (
    <>
      <div className="secTitle" style={{ marginTop: 18 }}>
        Dispatch Status
      </div>

      {isLoading && <div className="skel" style={{ height: 56 }} />}

      {!isLoading && (
        <div className="dispTotals">
          <div className="dispTotal pending">
            <b>{totals.pending}</b>
            <span>PENDING</span>
          </div>
          <div className="dispTotal partial">
            <b>{totals.partial}</b>
            <span>PARTIAL</span>
          </div>
          <div className="dispTotal done">
            <b>{totals.completed}</b>
            <span>COMPLETED</span>
          </div>
        </div>
      )}

      {!isLoading && rows.length === 0 && (
        <div className="entry" style={{ borderBottom: "none" }}>
          <span>No sales yet</span>
        </div>
      )}

      {rows.map((r) => {
        const isOpen = open === r.saleId;
        const pct = r.allocatedKg > 0 ? Math.min(100, (r.dispatchedKg / r.allocatedKg) * 100) : 0;
        return (
          <div key={r.saleId} className="rlCard">
            <button className="rlHead" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.saleId)}>
              <span className="rlLot">
                {r.icon} {r.skuName} · {r.invoiceNumber}
              </span>
              <span className={`dispPill ${r.status.toLowerCase()}`}>{LABEL[r.status]}</span>
              <span className="rlCaret">{isOpen ? "▾" : "▸"}</span>
            </button>

            <div className="rlMeta">
              {r.buyerName} · {fmt(r.dispatchedKg)} / {fmt(r.allocatedKg)} kg dispatched
              {r.remainingKg > 0 && ` · ${fmt(r.remainingKg)} kg left`}
            </div>
            <div className="dispBar">
              <i style={{ width: `${pct}%` }} className={r.status.toLowerCase()} />
            </div>

            {isOpen && (
              <div className="rlBody">
                <div className="rlRow">
                  <span>Allocated</span>
                  <b>{fmt(r.allocatedKg)} kg</b>
                </div>
                <div className="rlRow">
                  <span>Dispatched</span>
                  <b>{fmt(r.dispatchedKg)} kg</b>
                </div>
                <div className="rlRow">
                  <span>Remaining</span>
                  <b>{fmt(r.remainingKg)} kg</b>
                </div>

                {r.legacy && (
                  <p className="hint" style={{ marginTop: 6 }}>
                    Recorded before dispatch tracking existed — stock left the yard at sale time.
                  </p>
                )}

                {!r.legacy && r.vehicles.length === 0 && (
                  <p className="hint" style={{ marginTop: 6 }}>
                    Waiting for the Manager to load a vehicle.
                  </p>
                )}

                {r.vehicles.map((v, i) => (
                  <div key={`${r.saleId}-${i}`} className="dispVeh">
                    <div className="rlRow">
                      <span>Vehicle</span>
                      <b>
                        {v.vehicleNumber ?? "—"}
                        {v.vehicleType ? ` · ${v.vehicleType}` : ""}
                      </b>
                    </div>
                    <div className="rlRow">
                      <span>Driver</span>
                      <b>{v.driverName ?? "—"}</b>
                    </div>
                    <div className="rlRow">
                      <span>Weight loaded</span>
                      <b>{fmt(v.weightKg)} kg</b>
                    </div>
                    <div className="rlRow">
                      <span>Dispatched by</span>
                      <b>{v.dispatchedBy ?? "—"}</b>
                    </div>
                    <div className="rlRow">
                      <span>When</span>
                      <b>
                        {new Date(v.at).toLocaleString("en-IN", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </b>
                    </div>
                    {(v.frontImageUrl || v.backImageUrl || v.materialImages.length > 0) && (
                      <div className="dispShots">
                        {[v.frontImageUrl, v.backImageUrl]
                          .filter((u): u is string => !!u)
                          .map((u, k) => (
                            <a key={`v${k}`} href={u} target="_blank" rel="noreferrer">
                              <img src={u} alt="vehicle" />
                            </a>
                          ))}
                        {v.materialImages.map((u, k) => (
                          <a key={`m${k}`} href={u} target="_blank" rel="noreferrer">
                            <img src={u} alt="material" />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
