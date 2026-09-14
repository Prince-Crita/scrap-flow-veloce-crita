"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJson, sendJson, ApiError } from "@/frontend/lib/api-client";
import { PhonePortal } from "@/frontend/components/phone-portal";
import { useUI } from "@/frontend/components/ui-provider";
import { useInvalidateChannels } from "@/frontend/components/realtime/provider";

/** A mixed bucket, as `/api/materials?all=1` returns it: the main categories. */
type MaterialRow = { id: string; name: string; active: boolean };

/** A main category from `/api/sort-types` — the real `Material` row. */
type ParentRow = { id: string; name: string; active: boolean };

export type MaterialLite = { id: string; code: string; name: string };

/**
 * Which kind of material is being created.
 *
 * MIXED  → POST /api/materials — creates the main category AND its unsorted
 *          bucket ("Copper" → "Mixed Copper"). Goes to Sort when inwarded.
 * DIRECT → POST /api/sort-types — creates a finished grade under an existing
 *          main category ("PET Blue" under "PET Plastic"). Bypasses Sort.
 *
 * BOTH endpoints already existed and are unchanged: `/api/sort-types` is the
 * "Manage Sort Types" flow, which has always been how a sub-material is added.
 * This sheet just makes the choice explicit at the point of creation instead of
 * sending the Owner to a second screen for half of it.
 */
type Kind = "MIXED" | "DIRECT";

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
  /** Mixed by default: that is what this sheet has always created. */
  const [kind, setKind] = useState<Kind>("MIXED");
  /** The main category a DIRECT sub-material hangs off. Required for DIRECT. */
  const [parentId, setParentId] = useState("");
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
   * The main categories a sub-material may be created under.
   *
   * Read from `/api/sort-types`, which is the existing endpoint for the
   * segregation tree and already returns `Material` rows by their own names
   * ("PET Plastic") — `?all=1` above returns the BUCKET names ("PET Mixed"),
   * which is the wrong label to offer as a parent. Same query key the sort-type
   * sheet uses, so opening both costs one fetch, not two.
   */
  const treeQ = useQuery({
    queryKey: ["sortTypesAll"],
    queryFn: () => getJson<{ materials: ParentRow[] }>("/api/sort-types"),
    enabled: open,
  });
  const parents = (treeQ.data?.materials ?? []).filter((m) => m.active !== false);

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
    // A sub-material without a main category has no place in the hierarchy and
    // nothing to be segregated out of. Refused here and, authoritatively, by
    // `/api/sort-types`, which 404s an unknown or out-of-yard materialId.
    if (kind === "DIRECT" && !parentId) {
      setErr("Choose the main category this sub-material belongs to");
      return;
    }
    setSaving(true);
    try {
      const res =
        kind === "MIXED"
          ? await sendJson<{ material: MaterialLite }>("/api/materials", {
              name,
              category: category || undefined,
              threshold: threshold ? Number(threshold) : undefined,
            })
          : // The EXISTING sort-type endpoint — the same one "Manage Sort Types"
            // calls. It creates the SKU and its Inventory row in one transaction
            // and publishes materials/stock/sort, so the new grade shows up in
            // the selector, the stock tree and the sort targets at once.
            await sendJson<{ sortType: MaterialLite }>("/api/sort-types", {
              materialId: parentId,
              name,
              saleThresholdKg: threshold ? Number(threshold) : undefined,
            }).then((r) => ({ material: r.sortType }));
      onCreated(res.material);
      /**
       * A new material creates its mixed-bucket SKU and a zero Inventory row, so
       * the API publishes BOTH `materials` and `stock`. This handler invalidated
       * nothing at all, and the provider drops the actor's own echo — which is why
       * the Stock page did not show the new bucket until something else happened
       * to refresh it.
       *
       * `sort` is included for the DIRECT branch: a new sub-material is a new
       * segregation target, so the Sort screen's target list changes too.
       */
      invalidateChannels("materials", "stock", "sort");
      setName("");
      setCategory("");
      setThreshold("");
      setParentId("");
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
        <div className="sheetStep">
          {kind === "MIXED"
            ? "Owner only · a main category and its unsorted bucket (e.g. Copper → Mixed Copper)"
            : "Owner only · a finished grade under an existing main category (e.g. PET Blue)"}
        </div>
        {err && <p className="hint" style={{ color: "var(--red)" }}>{err}</p>}

        {/* The configuration that decides the whole downstream workflow. */}
        <div className="field">
          <label>Mixed Material?</label>
          <div className="kindToggle" role="radiogroup" aria-label="Mixed material?">
            <button
              type="button"
              role="radio"
              aria-checked={kind === "MIXED"}
              className={`kindBtn${kind === "MIXED" ? " on" : ""}`}
              onClick={() => setKind("MIXED")}
            >
              YES
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={kind === "DIRECT"}
              className={`kindBtn${kind === "DIRECT" ? " on" : ""}`}
              onClick={() => setKind("DIRECT")}
            >
              NO
            </button>
          </div>
          <p className="hint">
            {kind === "MIXED"
              ? "Arrives unsorted · goes to Sort · segregated into its sub-materials."
              : "Arrives as one finished grade · skips Sort · goes straight to its own stock."}
          </p>
        </div>

        <div className="field">
          <label>Material Name *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === "MIXED" ? "Copper" : "PET Blue"}
          />
        </div>

        {kind === "DIRECT" ? (
          <div className="field">
            <label>Main Category *</label>
            <select value={parentId} onChange={(e) => setParentId(e.target.value)} aria-label="Main category">
              <option value="">Select main category…</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {parents.length === 0 && !treeQ.isLoading && (
              <p className="hint">No main category yet — create one with Mixed Material = YES first.</p>
            )}
          </div>
        ) : (
          <div className="field">
            <label>Category (optional)</label>
            <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Non-ferrous" />
          </div>
        )}

        <div className="field">
          <label>Threshold kg (optional)</label>
          <input
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            inputMode="numeric"
            placeholder="1000"
          />
        </div>
        <button
          className="cta"
          disabled={saving || name.trim().length < 2 || (kind === "DIRECT" && !parentId)}
          onClick={submit}
        >
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
