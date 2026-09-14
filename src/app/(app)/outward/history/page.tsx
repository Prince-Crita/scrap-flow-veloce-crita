"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DispatchCard, useDispatches, matchesQuery } from "@/frontend/components/dispatch-list";

/**
 * Dispatch History — the completed record.
 *
 * The same query and the same card as Active Dispatch, pinned to the COMPLETED
 * filter. No second endpoint and no second row component: "history" is a view
 * of the dispatches, not a different kind of thing.
 */
export default function DispatchHistoryPage() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const { data, isLoading } = useDispatches("COMPLETED");
  const rows = (data?.dispatches ?? []).filter((d) => matchesQuery(d, q));

  return (
    <>
      <div className="dTopRow">
        <button type="button" className="dBack" aria-label="Back" onClick={() => router.push("/outward")}>
          ‹ Back
        </button>
      </div>
      <div className="secTitle">Dispatch History</div>

      <div className="field" style={{ marginTop: 4 }}>
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search vehicle, driver, dispatch ID…"
          aria-label="Search dispatch history"
          autoComplete="off"
        />
      </div>

      {isLoading && <div className="skel" style={{ height: 72 }} />}
      {!isLoading && rows.length === 0 && (
        <div className="lot">
          <h3>No completed dispatches</h3>
          <small style={{ fontFamily: "var(--mono)", color: "var(--muted)" }}>
            {q.trim() ? `Nothing matches “${q.trim()}”.` : "Completed dispatches appear here."}
          </small>
        </div>
      )}
      {rows.map((d) => (
        <DispatchCard key={d.id} d={d} />
      ))}
    </>
  );
}
