"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJson, sendJson, ApiError } from "@/lib/fetcher";
import { PhonePortal } from "@/components/phone-portal";
import { useUI } from "@/components/ui-provider";
import { useInvalidateChannels } from "@/components/realtime/provider";

type MaterialRow = { id: string; name: string; active: boolean };

export type MaterialLite = { id: string; code: string; name: string };

export function MaterialSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (m: MaterialLite) => void;
}) {
  const qc = useQueryClient();
  const invalidateChannels = useInvalidateChannels();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [threshold, setThreshold] = useState("");
  const [err, setErr] = useState("");
  const [purgeErr, setPurgeErr] = useState("");
  const [saving, setSaving] = useState(false);
  const { confirm, toast } = useUI();

  const allQ = useQuery({
    queryKey: ["materialsAll"],
    queryFn: () => getJson<{ materials: MaterialRow[] }>("/api/materials?all=1"),
    enabled: open,
  });
  const inactive = (allQ.data?.materials ?? []).filter((m) => m.active === false);

  /**
   * Permanent delete. The server allows it only when the material has zero
   * references and zero stock, and explains what is holding it otherwise —
   * erasing a material with history would break the traceability chain from
   * finished stock back to the vendor it came from.
   */
  async function purge(m: MaterialRow) {
    setPurgeErr("");
    const yes = await confirm({
      title: "Delete permanently",
      message: `Permanently delete "${m.name}"? This cannot be undone. If any load, stock batch or sale references it, it will stay deactivated instead.`,
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!yes) return;
    try {
      await sendJson(`/api/materials/${m.id}?permanent=1`, undefined, "DELETE");
      qc.invalidateQueries({ queryKey: ["materials"] });
      qc.invalidateQueries({ queryKey: ["materialsAll"] });
      qc.invalidateQueries({ queryKey: ["stock"] });
      toast(`Material "${m.name}" deleted`);
    } catch (e) {
      setPurgeErr(e instanceof ApiError ? e.message : "Could not delete material");
    }
  }

  async function restore(id: string) {
    try {
      await sendJson(`/api/materials/${id}`, { active: true }, "PATCH");
      qc.invalidateQueries({ queryKey: ["materials"] });
      qc.invalidateQueries({ queryKey: ["materialsAll"] });
    } catch {
      /* ignore */
    }
  }

  if (!open) return null;

  async function submit() {
    setErr("");
    setSaving(true);
    try {
      const res = await sendJson<{ material: MaterialLite }>("/api/materials", {
        name,
        category: category || undefined,
        threshold: threshold ? Number(threshold) : undefined,
      });
      onCreated(res.material);
      /**
       * A new material creates its mixed-bucket SKU and a zero Inventory row, so
       * the API publishes BOTH `materials` and `stock`. This handler invalidated
       * nothing at all, and the provider drops the actor's own echo — which is why
       * the Stock page did not show the new bucket until something else happened
       * to refresh it.
       */
      invalidateChannels("materials", "stock");
      setName("");
      setCategory("");
      setThreshold("");
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not add material");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PhonePortal>
    <div className="sheetWrap" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" />
        <div className="sheetTitle">Add Material</div>
        <div className="sheetStep">Owner only · creates a mixed bucket (e.g. Copper → Mixed Copper)</div>
        {err && <p className="hint" style={{ color: "var(--red)" }}>{err}</p>}
        <div className="field">
          <label>Material Name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Copper" />
        </div>
        <div className="field">
          <label>Category (optional)</label>
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Non-ferrous" />
        </div>
        <div className="field">
          <label>Threshold kg (optional)</label>
          <input
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            inputMode="numeric"
            placeholder="1000"
          />
        </div>
        <button className="cta" disabled={saving || name.trim().length < 2} onClick={submit}>
          {saving ? "SAVING…" : "SAVE MATERIAL"}
        </button>

        {inactive.length > 0 && (
          <>
            <div className="secTitle" style={{ marginTop: 18 }}>
              Inactive Materials
            </div>
            {inactive.map((m) => (
              <div key={m.id} className="recv">
                <span>{m.name}</span>
                <button className="sellBtn" onClick={() => restore(m.id)}>
                  RESTORE
                </button>
                <button className="sellBtn danger" onClick={() => void purge(m)}>
                  DELETE
                </button>
              </div>
            ))}
            {purgeErr && <div className="purgeErr">{purgeErr}</div>}
          </>
        )}

        <button className="cta ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
    </PhonePortal>
  );
}
