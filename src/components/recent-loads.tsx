"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "@/lib/fetcher";
import { fmt } from "@/lib/format";

type RecentLoad = {
  id: string;
  lotNumber: string;
  vendorName: string;
  vehicleNumber: string;
  vehicleType: string | null;
  driverName: string | null;
  totalKg: number;
  materials: { label: string; kg: number }[];
  slipUrl: string | null;
  createdAt: string;
};

/**
 * Read-only panel under the weighbridge-slip button. It exists so the operator
 * can confirm what was just saved without leaving Inward — it never mutates,
 * and it reuses the page's existing type and spacing vocabulary rather than
 * introducing a new card style.
 */
export function RecentLoads() {
  const [open, setOpen] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["recentLoads"],
    queryFn: () => getJson<{ loads: RecentLoad[] }>("/api/inward/recent"),
  });

  // No polling and no realtime code here: the realtime provider already
  // invalidates ["recentLoads"] on the `inward` channel.
  const loads = data?.loads ?? [];

  return (
    <>
      <div className="secTitle" style={{ marginTop: 22 }}>
        Recent Load Details
      </div>

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
        return (
          <div key={l.id} className="rlCard">
            <button
              className="rlHead"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : l.id)}
            >
              <span className="rlLot">Lot #{l.lotNumber}</span>
              <span className="rlKg">{fmt(l.totalKg)} kg</span>
              <span className="rlCaret">{isOpen ? "▾" : "▸"}</span>
            </button>

            <div className="rlMeta">
              {l.vendorName} · 🚚 {l.vehicleNumber} · {when}
            </div>

            {isOpen && (
              <div className="rlBody">
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
                  <b>{l.driverName ?? "—"}</b>
                </div>

                {l.materials.map((m, i) => (
                  <div key={`${l.id}-${i}`} className="rlRow">
                    <span>{i === 0 ? "Materials" : ""}</span>
                    <b>
                      {m.label} — {fmt(m.kg)} kg
                    </b>
                  </div>
                ))}

                <div className="rlRow">
                  <span>Slip</span>
                  <b>
                    {l.slipUrl ? (
                      <a href={l.slipUrl} target="_blank" rel="noreferrer" className="rlLink">
                        View slip
                      </a>
                    ) : (
                      "—"
                    )}
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
}
