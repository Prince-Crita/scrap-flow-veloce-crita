"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJson, sendJson, ApiError } from "@/frontend/lib/api-client";
import { PhonePortal } from "@/frontend/components/phone-portal";
import { useUI } from "@/frontend/components/ui-provider";
import { useInvalidateChannels } from "@/frontend/components/realtime/provider";

/**
 * Sort-type management: the segregation categories a mixed lot sorts into.
 *
 * Deliberately the same sheet vocabulary as MaterialSheet — same portal, same
 * `sheet` / `field` / `recv` classes, same create-then-list-inactive rhythm, same
 * confirm-before-permanent-delete. An Owner who has added a material already
 * knows how to use this.
 *
 * Owner and Admin only. A Manager can read the tree (the Sort page's targets)
 * but is never shown this sheet, because changing the tree changes what every
 * future run can produce.
 */

type SortType = {
  id: string;
  name: string;
  code: string;
  icon: string;
  active: boolean;
  saleThresholdKg: number;
  stockKg: number;
};

type MaterialGroup = {
  id: string;
  name: string;
  code: string;
  active: boolean;
  sortTypes: SortType[];
};

export function SortTypeSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const invalidateChannels = useInvalidateChannels();
  const { confirm, toast } = useUI();

  const [materialId, setMaterialId] = useState("");
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [err, setErr] = useState("");
  const [rowErr, setRowErr] = useState("");
  const [saving, setSaving] = useState(false);
  /** Which row is being renamed, and to what. */
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  // `all=1` includes deactivated types so they can be restored or erased.
  const treeQ = useQuery({
    queryKey: ["sortTypesAll"],
    queryFn: () => getJson<{ materials: MaterialGroup[] }>("/api/sort-types?all=1"),
    enabled: open,
  });

  const groups = treeQ.data?.materials ?? [];
  const target = materialId || groups[0]?.id || "";

  function refresh() {
    // Matches what the sort-types API publishes.
    invalidateChannels("materials", "stock", "sort");
  }

  async function create() {
    setErr("");
    setSaving(true);
    try {
      await sendJson("/api/sort-types", {
        materialId: target,
        name: name.trim(),
        icon: icon.trim() || undefined,
      });
      setName("");
      setIcon("");
      refresh();
      toast(`Sort type "${name.trim()}" added`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not add sort type");
    } finally {
      setSaving(false);
    }
  }

  async function rename(t: SortType, value: string) {
    setRowErr("");
    const next = value.trim();
    if (next.length < 2 || next === t.name) {
      setRenaming(null);
      return;
    }
    try {
      await sendJson(`/api/sort-types/${t.id}`, { name: next }, "PATCH");
      setRenaming(null);
      refresh();
      toast(`Renamed to "${next}"`);
    } catch (e) {
      setRowErr(e instanceof ApiError ? e.message : "Could not rename");
    }
  }

  async function setActive(t: SortType, active: boolean) {
    setRowErr("");
    try {
      await sendJson(`/api/sort-types/${t.id}`, { active }, "PATCH");
      refresh();
    } catch (e) {
      setRowErr(e instanceof ApiError ? e.message : "Could not update");
    }
  }

  /**
   * Permanent delete. The server allows it only with zero references and zero
   * stock, and says what is holding it otherwise — erasing a sort type with
   * history would sever finished stock from the vendor lot it came from.
   */
  async function purge(t: SortType) {
    setRowErr("");
    const yes = await confirm({
      title: "Delete permanently",
      message: `Permanently delete "${t.name}"? This cannot be undone. If any load, sort run, sale or dispatch references it, it will stay deactivated instead.`,
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!yes) return;
    try {
      await sendJson(`/api/sort-types/${t.id}?permanent=1`, undefined, "DELETE");
      refresh();
      toast(`Sort type "${t.name}" deleted`);
    } catch (e) {
      setRowErr(e instanceof ApiError ? e.message : "Could not delete sort type");
    }
  }

  if (!open) return null;

  return (
    <PhonePortal>
      <div className="sheetWrap" onClick={onClose}>
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <div className="sheetHandle" />
          <div className="sheetTitle">Sort Types</div>
          <div className="sheetStep">Owner only · the categories a mixed lot can be sorted into</div>

          {err && (
            <p className="hint" style={{ color: "var(--red)" }}>
              {err}
            </p>
          )}

          <div className="field">
            <label>Material *</label>
            <select value={target} onChange={(e) => setMaterialId(e.target.value)}>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                  {g.active ? "" : " (inactive)"}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Sort Type Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="MS Sheet" />
          </div>
          <div className="field">
            <label>Icon (optional)</label>
            <input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="📦" />
          </div>
          <button className="cta" disabled={saving || !target || name.trim().length < 2} onClick={() => void create()}>
            {saving ? "SAVING…" : "ADD SORT TYPE"}
          </button>

          {rowErr && <div className="purgeErr">{rowErr}</div>}

          {groups.map((g) => (
            <div key={g.id}>
              <div className="secTitle" style={{ marginTop: 18 }}>
                {g.name}
              </div>
              {g.sortTypes.length === 0 && (
                <div className="hint" style={{ color: "var(--muted)" }}>
                  No sort types yet — a mixed {g.name} lot cannot be segregated until one exists.
                </div>
              )}
              {g.sortTypes.map((t) => (
                <div key={t.id} className="recv">
                  {renaming?.id === t.id ? (
                    <input
                      autoFocus
                      value={renaming.value}
                      onChange={(e) => setRenaming({ id: t.id, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void rename(t, renaming.value);
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={() => void rename(t, renaming.value)}
                      aria-label={`Rename ${t.name}`}
                    />
                  ) : (
                    <span style={t.active ? undefined : { color: "var(--muted)" }}>
                      {t.icon} {t.name}
                      {t.stockKg > 0 && ` · ${t.stockKg} kg`}
                      {!t.active && " · inactive"}
                    </span>
                  )}
                  {renaming?.id !== t.id && (
                    <button className="sellBtn" onClick={() => setRenaming({ id: t.id, value: t.name })}>
                      RENAME
                    </button>
                  )}
                  {t.active ? (
                    <button className="sellBtn" onClick={() => void setActive(t, false)}>
                      DEACTIVATE
                    </button>
                  ) : (
                    <button className="sellBtn" onClick={() => void setActive(t, true)}>
                      RESTORE
                    </button>
                  )}
                  <button className="sellBtn danger" onClick={() => void purge(t)}>
                    DELETE
                  </button>
                </div>
              ))}
            </div>
          ))}

          <button className="cta ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </PhonePortal>
  );
}
