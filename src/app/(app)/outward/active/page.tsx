"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DispatchCard, useDispatches, matchesQuery } from "@/frontend/components/dispatch-list";
import type { DispatchFilter } from "@/shared/dispatch-stage";

const TABS: { key: DispatchFilter; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "ACTIVE", label: "Active" },
  { key: "IN_TRANSIT", label: "In Transit" },
  { key: "COMPLETED", label: "Completed" },
];

/**
 * Active Dispatch — the four status views.
 *
 * Filtered on the server (`?filter=`) rather than in the browser, so the phone
 * only downloads the tab it is showing. The search box then narrows what came
 * back, which is the part that has to feel instant.
 */
export default function ActiveDispatchPage() {
  const router = useRouter();
  const [tab, setTab] = useState<DispatchFilter>("ALL");
  const [q, setQ] = useState("");

  const { data, isLoading } = useDispatches(tab);
  const rows = (data?.dispatches ?? []).filter((d) => matchesQuery(d, q));

  return (
    <>
      <div className="dTopRow">
        <button type="button" className="dBack" aria-label="Back" onClick={() => router.push("/outward")}>
          ‹ Back
        </button>
      </div>
      <div className="secTitle">Active Dispatch</div>

      <div className="chips" role="tablist" aria-label="Dispatch status">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`chip${tab === t.key ? " on" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search vehicle, driver, dispatch ID…"
          aria-label="Search dispatches"
          autoComplete="off"
        />
      </div>

      {isLoading && <div className="skel" style={{ height: 72 }} />}
      {!isLoading && rows.length === 0 && (
        <div className="lot">
          <h3>Nothing here</h3>
          <small style={{ fontFamily: "var(--mono)", color: "var(--muted)" }}>
            {q.trim() ? `No dispatch matches “${q.trim()}”.` : "No dispatches in this view yet."}
          </small>
        </div>
      )}
      {rows.map((d) => (
        <DispatchCard key={d.id} d={d} />
      ))}
    </>
  );
}
