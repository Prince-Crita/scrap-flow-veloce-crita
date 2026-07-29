"use client";

import { useState } from "react";
import { sendJson, ApiError } from "@/lib/fetcher";
import { Modal, Field } from "@/components/admin/ui";

/**
 * Generic admin record editor.
 *
 * Field definitions are supplied by the caller and must match the per-entity
 * whitelist in src/lib/admin-records.ts — the server is the authority, this is
 * only the form. Ledger-derived quantities are absent by design; the API refuses
 * them with an explanation if one is ever sent.
 */
export type EditField =
  | { name: string; label: string; type: "text"; hint?: string; required?: boolean; wide?: boolean }
  | { name: string; label: string; type: "number"; hint?: string; min?: number; wide?: boolean }
  | { name: string; label: string; type: "checkbox"; hint?: string; wide?: boolean }
  | {
      name: string;
      label: string;
      type: "select";
      options: { value: string; label: string }[];
      hint?: string;
      wide?: boolean;
    };

export type EditableRecordKind =
  | "vendor"
  | "buyer"
  | "material"
  | "sku"
  | "inwardLoad"
  | "outwardLoad"
  | "sale"
  | "receivable";

export function RecordEditModal({
  entity,
  id,
  title,
  subtitle,
  fields,
  initial,
  onClose,
  onSaved,
}: {
  entity: EditableRecordKind;
  id: string;
  title: string;
  subtitle?: string;
  fields: EditField[];
  initial: Record<string, unknown>;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = initial[f.name];
      v[f.name] = f.type === "checkbox" ? Boolean(raw) : raw ?? (f.type === "number" ? 0 : "");
    }
    return v;
  });
  const [err, setErr] = useState("");
  const [fieldErrs, setFieldErrs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setFieldErrs({});
    setSaving(true);

    // Send only what actually changed, so the audit trail stays meaningful.
    const patch: Record<string, unknown> = {};
    for (const f of fields) {
      const next = values[f.name];
      const prev = initial[f.name] ?? (f.type === "checkbox" ? false : f.type === "number" ? 0 : "");
      const normalisedNext = f.type === "text" && next === "" ? null : next;
      const normalisedPrev = f.type === "text" && (prev === "" || prev === null) ? null : prev;
      if (normalisedNext !== normalisedPrev) patch[f.name] = normalisedNext;
    }

    if (Object.keys(patch).length === 0) {
      setSaving(false);
      onClose();
      return;
    }

    try {
      await sendJson(`/api/admin/records/${entity}/${id}`, patch, "PATCH");
      onSaved(`${title} updated.`);
    } catch (e) {
      if (e instanceof ApiError) {
        setErr(e.message);
        setFieldErrs(e.fields ?? {});
      } else setErr("Could not save changes.");
      setSaving(false);
    }
  }

  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose}>
      {err && <div className="aErr">{err}</div>}
      <form className="aForm" onSubmit={save}>
        {fields.map((f) => (
          <Field key={f.name} label={f.label} hint={f.hint} error={fieldErrs[f.name]} wide={f.wide}>
            {f.type === "text" && (
              <input
                value={String(values[f.name] ?? "")}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                required={f.required}
              />
            )}
            {f.type === "number" && (
              <input
                type="number"
                min={f.min}
                value={Number(values[f.name] ?? 0)}
                onChange={(e) => setValues({ ...values, [f.name]: Number(e.target.value) })}
              />
            )}
            {f.type === "checkbox" && (
              <label
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  fontSize: 13,
                  textTransform: "none",
                  letterSpacing: 0,
                }}
              >
                <input
                  type="checkbox"
                  checked={Boolean(values[f.name])}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })}
                  style={{ width: "auto" }}
                />
                {f.label}
              </label>
            )}
            {f.type === "select" && (
              <select
                value={String(values[f.name] ?? "")}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value || null })}
              >
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ))}
        <div className="aFormActions">
          <button type="button" className="aBtn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="aBtn primary" disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
