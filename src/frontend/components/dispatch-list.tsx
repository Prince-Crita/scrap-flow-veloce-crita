"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "@/frontend/lib/api-client";
import { fmt } from "@/shared/format";
import { loadRefDateTime } from "@/shared/load-ref";
import { nextStep, type DispatchFilter, type DispatchProgress, type DispatchStage, type DispatchState } from "@/shared/dispatch-stage";
import { DispatchRail, DispatchStatePill } from "@/frontend/components/dispatch-flow";

export type DispatchRow = {
  id: string;
  ref: string;
  vehicleNumber: string | null;
  vehicleType: string | null;
  driverName: string | null;
  driverPhone: string | null;
  totalKg: number;
  stage: DispatchStage;
  state: DispatchState;
  dispatchedAt: string | null;
  createdAt: string;
  dispatchedBy: string | null;
  lineCount: number;
  /** Departure recorded and loaded vehicle photographed — step 3 done. */
  hasTransit: boolean;
  /** Loaded weighbridge slip captured and signed off — step 4 done. */
  hasProof: boolean;
  /** Owner paperwork filed after completion. Drives Ready to Invoice. */
  invoiceUrl: string | null;
  materials: { label: string; kg: number; ratePerKg: number | null }[];
};

/** Everything typed at the search box is matched against this. */
function haystack(d: DispatchRow): string {
  return [d.ref, d.vehicleNumber, d.driverName, d.driverPhone, d.vehicleType, ...d.materials.map((m) => m.label)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function matchesQuery(d: DispatchRow, q: string): boolean {
  const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = haystack(d);
  return tokens.every((t) => hay.includes(t));
}

/**
 * @param opts.enabled  Defaults to true. Passed by a caller that must not even
 *                      REQUEST the list — the Owner-only Ready to Invoice
 *                      section, which should make no call at all for a role it
 *                      does not render for.
 */
export function useDispatches(filter: DispatchFilter, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["dispatches", filter],
    queryFn: () => getJson<{ dispatches: DispatchRow[] }>(`/api/outward/dispatches?filter=${filter}`),
    enabled: opts?.enabled ?? true,
  });
}

/**
 * One dispatch as a row: what it is, where it has got to, and — when it is not
 * finished — the one action that continues it.
 *
 * Expanding shows the detail rather than navigating to it, so a Supervisor
 * checking a vehicle's status does not lose the list they were scanning.
 */
export function DispatchCard({ d, defaultOpen = false }: { d: DispatchRow; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const progress: DispatchProgress = {
    id: d.id,
    stage: d.stage,
    state: d.state,
    lineCount: d.lineCount,
    hasTransit: d.hasTransit,
    hasProof: d.hasProof,
  };
  const next = nextStep(progress);

  return (
    <div className="rlCard">
      <button className="rlHead" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="rlLot">{d.ref}</span>
        <span className="rlKg">{fmt(d.totalKg)} kg</span>
        <span className="rlCaret">{open ? "▾" : "▸"}</span>
      </button>

      <div className="rlMeta">
        🚚 {d.vehicleNumber ?? "—"} · {d.driverName ?? "—"} · <DispatchStatePill state={d.state} />
      </div>

      {open && (
        <div className="rlBody">
          <DispatchRail progress={progress} />

          <div className="rlRow">
            <span>Dispatch ID</span>
            <b>{d.ref}</b>
          </div>
          <div className="rlRow">
            <span>Vehicle</span>
            <b>
              {d.vehicleNumber ?? "—"}
              {d.vehicleType ? ` · ${d.vehicleType}` : ""}
            </b>
          </div>
          <div className="rlRow">
            <span>Driver</span>
            <b>
              {d.driverName ?? "—"}
              {d.driverPhone ? ` · ${d.driverPhone}` : ""}
            </b>
          </div>
          {d.materials.length === 0 ? (
            <div className="rlRow">
              <span>Materials</span>
              <b>Not loaded yet</b>
            </div>
          ) : (
            d.materials.map((m, i) => (
              <div key={`${d.id}-${i}`} className="rlRow">
                <span>{i === 0 ? "Materials" : ""}</span>
                <b>
                  {m.label} — {fmt(m.kg)} kg
                  {m.ratePerKg != null ? ` @ ₹ ${m.ratePerKg}/kg` : ""}
                </b>
              </div>
            ))
          )}
          <div className="rlRow">
            <span>Status</span>
            <b>
              <DispatchStatePill state={d.state} />
            </b>
          </div>
          <div className="rlRow">
            <span>Created</span>
            <b>{loadRefDateTime(d.createdAt)}</b>
          </div>
          {d.dispatchedAt && (
            <div className="rlRow">
              <span>Dispatched</span>
              <b>{loadRefDateTime(d.dispatchedAt)}</b>
            </div>
          )}
          <div className="rlRow">
            <span>Entered by</span>
            <b>{d.dispatchedBy ?? "—"}</b>
          </div>

          {/* Only when there is genuinely something left to do — a completed
              dispatch must never offer a misleading Continue. */}
          {next && (
            <Link className="cta" href={next.href} style={{ display: "block", textAlign: "center" }}>
              CONTINUE DISPATCH · {next.label.toUpperCase()}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
