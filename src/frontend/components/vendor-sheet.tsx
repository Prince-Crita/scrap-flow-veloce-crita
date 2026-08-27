"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJson, sendJson, ApiError } from "@/frontend/lib/api-client";
import { PhonePortal } from "@/frontend/components/phone-portal";
import { useUI } from "@/frontend/components/ui-provider";
import { useInvalidateChannels } from "@/frontend/components/realtime/provider";

export type VendorLite = { id: string; name: string; gstNumber?: string | null; phone?: string | null; active?: boolean };

export function VendorSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (v: VendorLite) => void;
}) {
  const qc = useQueryClient();
  const invalidateChannels = useInvalidateChannels();
  const [name, setName] = useState("");
  const [gst, setGst] = useState("");
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState("");
  const [purgeErr, setPurgeErr] = useState("");
  const [saving, setSaving] = useState(false);
  const { confirm, toast } = useUI();

  const allQ = useQuery({
    queryKey: ["vendorsAll"],
    queryFn: () => getJson<{ vendors: VendorLite[] }>("/api/vendors?all=1"),
    enabled: open,
  });
  const inactive = (allQ.data?.vendors ?? []).filter((v) => v.active === false);

  if (!open) return null;

  async function submit() {
    setErr("");
    setSaving(true);
    try {
      const res = await sendJson<{ vendor: VendorLite }>("/api/vendors", { name, gstNumber: gst, phone });
      onCreated(res.vendor);
      /**
       * The API publishes a `vendors` event, but the provider suppresses the
       * actor's own echo — so this client has to invalidate what that channel
       * would have. It previously invalidated only `vendorsAll`, which is why the
       * new vendor appeared in the picker while every other view stayed stale.
       */
      invalidateChannels("vendors");
      setName("");
      setGst("");
      setPhone("");
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not save vendor");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Permanent delete. Allowed only when the vendor has zero references — the
   * server enforces that and returns a readable reason when it refuses, so no
   * reference counting is duplicated here.
   */
  async function purge(v: VendorLite) {
    setPurgeErr("");
    const yes = await confirm({
      title: "Delete permanently",
      message: `Permanently delete "${v.name}"? This cannot be undone. If any load or stock batch references this vendor, it will stay deactivated instead.`,
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!yes) return;
    try {
      await sendJson(`/api/vendors/${v.id}?permanent=1`, undefined, "DELETE");
      qc.invalidateQueries({ queryKey: ["vendors"] });
      qc.invalidateQueries({ queryKey: ["vendorsAll"] });
      toast(`Vendor "${v.name}" deleted`);
    } catch (e) {
      setPurgeErr(e instanceof ApiError ? e.message : "Could not delete vendor");
    }
  }

  async function restore(id: string) {
    try {
      await sendJson(`/api/vendors/${id}`, { active: true }, "PATCH");
      qc.invalidateQueries({ queryKey: ["vendors"] });
      qc.invalidateQueries({ queryKey: ["vendorsAll"] });
    } catch {
      /* ignore */
    }
  }

  return (
    <PhonePortal>
    <div className="sheetWrap" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" />
        <div className="sheetTitle">Add Vendor</div>
        <div className="sheetStep">Owner only · supplier directory</div>
        {err && <p className="hint" style={{ color: "var(--red)" }}>{err}</p>}
        <div className="field">
          <label>Vendor Name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Balaji Metals" />
        </div>
        <div className="field">
          <label>GST Number</label>
          <input value={gst} onChange={(e) => setGst(e.target.value.toUpperCase())} placeholder="27ABCDE1234F1Z5" />
        </div>
        <div className="field">
          <label>Phone</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="9876543210" />
        </div>
        <button className="cta" disabled={saving || name.trim().length < 2} onClick={submit}>
          {saving ? "SAVING…" : "SAVE VENDOR"}
        </button>

        {inactive.length > 0 && (
          <>
            <div className="secTitle" style={{ marginTop: 18 }}>
              Inactive Vendors
            </div>
            {inactive.map((v) => (
              <div key={v.id} className="recv">
                <span>{v.name}</span>
                <button className="sellBtn" onClick={() => restore(v.id)}>
                  RESTORE
                </button>
                {/* Only succeeds when nothing references the vendor; the server
                    refuses otherwise and says what is holding it. */}
                <button className="sellBtn danger" onClick={() => void purge(v)}>
                  DELETE
                </button>
              </div>
            ))}
            {purgeErr && <div className="purgeErr">{purgeErr}</div>}
          </>
        )}

        <button className="cta ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
    </PhonePortal>
  );
}
