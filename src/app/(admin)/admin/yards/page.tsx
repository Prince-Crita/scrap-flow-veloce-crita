"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getJson, sendJson, ApiError } from "@/lib/fetcher";
import { PageHead, Card, Pill, Modal, Field, Empty, inr, kg, num, when } from "@/components/admin/ui";
import { EnterYardButton } from "@/components/admin/enter-yard-button";

type YardRow = {
  id: string;
  yardCode: string;
  yardName: string;
  ownerName: string | null;
  city: string | null;
  state: string | null;
  address: string | null;
  contactNumber: string | null;
  gstNumber: string | null;
  timezone: string;
  active: boolean;
  deactivatedAt: string | null;
  createdAt: string;
  stats: {
    owners: number;
    managers: number;
    users: number;
    vendors: number;
    loadsPending: number;
    loadsTotal: number;
    sales: number;
    salesValue: number;
    stockKg: number;
  };
  adminInside: boolean;
};

type FormState = {
  yardCode: string;
  yardName: string;
  ownerName: string;
  city: string;
  state: string;
  address: string;
  contactNumber: string;
  gstNumber: string;
  seedMaterials: boolean;
};

const EMPTY_FORM: FormState = {
  yardCode: "",
  yardName: "",
  ownerName: "",
  city: "",
  state: "",
  address: "",
  contactNumber: "",
  gstNumber: "",
  seedMaterials: true,
};

export default function AdminYardsPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<YardRow | null>(null);
  const [confirmOff, setConfirmOff] = useState<YardRow | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [err, setErr] = useState("");
  const [fieldErrs, setFieldErrs] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["adminYards"],
    queryFn: () => getJson<{ yards: YardRow[] }>("/api/admin/yards"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["adminYards"] });
    qc.invalidateQueries({ queryKey: ["adminOverview"] });
  };

  const createMut = useMutation({
    mutationFn: (f: FormState) =>
      sendJson("/api/admin/yards", {
        yardCode: f.yardCode.trim().toUpperCase(),
        yardName: f.yardName.trim(),
        ownerName: f.ownerName.trim(),
        city: f.city.trim(),
        state: f.state.trim(),
        address: f.address.trim(),
        contactNumber: f.contactNumber.trim(),
        gstNumber: f.gstNumber.trim(),
        seedMaterials: f.seedMaterials,
      }),
    onSuccess: () => {
      setCreating(false);
      setForm(EMPTY_FORM);
      setNotice("Yard created with its starter material tree.");
      refresh();
    },
    onError: (e) => handleErr(e),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      sendJson(`/api/admin/yards/${id}`, patch, "PATCH"),
    onSuccess: () => {
      setEditing(null);
      setNotice("Yard updated.");
      refresh();
    },
    onError: (e) => handleErr(e),
  });

  const deactivateMut = useMutation({
    mutationFn: (id: string) => sendJson(`/api/admin/yards/${id}`, undefined, "DELETE"),
    onSuccess: () => {
      setConfirmOff(null);
      setNotice("Yard deactivated. No data was deleted.");
      refresh();
    },
    onError: (e) => handleErr(e),
  });

  function handleErr(e: unknown) {
    if (e instanceof ApiError) {
      setErr(e.message);
      setFieldErrs(e.fields ?? {});
    } else setErr("Something went wrong.");
  }

  function openEdit(y: YardRow) {
    setErr("");
    setFieldErrs({});
    setForm({
      yardCode: y.yardCode,
      yardName: y.yardName,
      ownerName: y.ownerName ?? "",
      city: y.city ?? "",
      state: y.state ?? "",
      address: y.address ?? "",
      contactNumber: y.contactNumber ?? "",
      gstNumber: y.gstNumber ?? "",
      seedMaterials: false,
    });
    setEditing(y);
  }

  const yards = data?.yards ?? [];

  return (
    <>
      <PageHead title="Yards" subtitle={`${yards.length} ${yards.length === 1 ? "yard" : "yards"} on the platform`}>
        <button
          className="aBtn primary"
          onClick={() => {
            setErr("");
            setFieldErrs({});
            setForm(EMPTY_FORM);
            setCreating(true);
          }}
        >
          + Create Yard
        </button>
      </PageHead>

      {notice && <div className="aOk">{notice}</div>}
      {err && !creating && !editing && <div className="aErr">{err}</div>}

      <Card>
        <div className="aTableWrap">
          <table className="aTable">
            <thead>
              <tr>
                <th>Yard</th>
                <th>Location</th>
                <th>Status</th>
                <th className="num">Users</th>
                <th className="num">Vendors</th>
                <th className="num">Stock</th>
                <th className="num">Pending</th>
                <th className="num">Sales</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {yards.map((y) => (
                <tr key={y.id}>
                  <td>
                    <Link href={`/admin/yards/${y.id}`}>
                      <b>{y.yardName}</b>
                    </Link>
                    <div className="aTiny aMuted aMono">{y.yardCode}</div>
                    {y.adminInside && (
                      <div style={{ marginTop: 4 }}>
                        <Pill tone="warn">Admin inside</Pill>
                      </div>
                    )}
                  </td>
                  <td className="aTiny">
                    {[y.city, y.state].filter(Boolean).join(", ") || "—"}
                    {y.ownerName && <div className="aMuted">{y.ownerName}</div>}
                  </td>
                  <td>
                    {y.active ? (
                      <Pill tone="ok">Active</Pill>
                    ) : (
                      <Pill tone="off">Inactive</Pill>
                    )}
                    {!y.active && y.deactivatedAt && (
                      <div className="aTiny aMuted" style={{ marginTop: 4 }}>
                        {when(y.deactivatedAt)}
                      </div>
                    )}
                  </td>
                  <td className="num">
                    {num(y.stats.users)}
                    <div className="aTiny aMuted">
                      {y.stats.owners}O · {y.stats.managers}M
                    </div>
                  </td>
                  <td className="num">{num(y.stats.vendors)}</td>
                  <td className="num">{kg(y.stats.stockKg)}</td>
                  <td className="num">{y.stats.loadsPending > 0 ? num(y.stats.loadsPending) : "—"}</td>
                  <td className="num">
                    {inr(y.stats.salesValue)}
                    <div className="aTiny aMuted">{num(y.stats.sales)} inv</div>
                  </td>
                  <td>
                    <div className="actions">
                      <Link className="aBtn sm ghost" href={`/admin/yards/${y.id}`}>
                        Open
                      </Link>
                      <button className="aBtn sm" onClick={() => openEdit(y)}>
                        Edit
                      </button>
                      <EnterYardButton
                        yardId={y.id}
                        yardName={y.yardName}
                        disabled={!y.active}
                        onError={setErr}
                      />
                      {y.active ? (
                        <button className="aBtn sm danger" onClick={() => setConfirmOff(y)}>
                          Deactivate
                        </button>
                      ) : (
                        <button
                          className="aBtn sm"
                          onClick={() => updateMut.mutate({ id: y.id, patch: { active: true } })}
                          disabled={updateMut.isPending}
                        >
                          Reactivate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!isLoading && yards.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <Empty>No yards yet. Create the first one.</Empty>
                  </td>
                </tr>
              )}
              {isLoading && (
                <tr>
                  <td colSpan={9}>
                    <Empty>Loading yards…</Empty>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ---- Create ---- */}
      {creating && (
        <Modal
          title="Create Yard"
          subtitle="A new yard starts with the standard MS / PET / Aluminum material tree so it can receive loads immediately."
          onClose={() => setCreating(false)}
        >
          {err && <div className="aErr">{err}</div>}
          <form
            className="aForm"
            onSubmit={(e) => {
              e.preventDefault();
              setErr("");
              createMut.mutate(form);
            }}
          >
            <Field label="Yard code" hint="Immutable business identifier, e.g. SFDY002" error={fieldErrs.yardCode}>
              <input
                value={form.yardCode}
                onChange={(e) => setForm({ ...form, yardCode: e.target.value.toUpperCase() })}
                placeholder="SFDY002"
                required
              />
            </Field>
            <Field label="Yard name" error={fieldErrs.yardName}>
              <input
                value={form.yardName}
                onChange={(e) => setForm({ ...form, yardName: e.target.value })}
                placeholder="Yard 2"
                required
              />
            </Field>
            <Field label="Owner name">
              <input value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} />
            </Field>
            <Field label="Contact number">
              <input value={form.contactNumber} onChange={(e) => setForm({ ...form, contactNumber: e.target.value })} />
            </Field>
            <Field label="City">
              <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </Field>
            <Field label="State">
              <input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
            </Field>
            <Field label="GSTIN">
              <input value={form.gstNumber} onChange={(e) => setForm({ ...form, gstNumber: e.target.value })} />
            </Field>
            <Field label="Address" wide>
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </Field>
            <Field label="Starter materials" wide hint="Uncheck only if this yard will be configured manually.">
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, textTransform: "none", letterSpacing: 0 }}>
                <input
                  type="checkbox"
                  checked={form.seedMaterials}
                  onChange={(e) => setForm({ ...form, seedMaterials: e.target.checked })}
                  style={{ width: "auto" }}
                />
                Create MS / PET / Aluminum with mixed buckets
              </label>
            </Field>
            <div className="aFormActions">
              <button type="button" className="aBtn ghost" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button type="submit" className="aBtn primary" disabled={createMut.isPending}>
                {createMut.isPending ? "Creating…" : "Create Yard"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ---- Edit ---- */}
      {editing && (
        <Modal
          title={`Edit ${editing.yardName}`}
          subtitle={`Code ${editing.yardCode} is immutable — it identifies this yard on paperwork and in stored files.`}
          onClose={() => setEditing(null)}
        >
          {err && <div className="aErr">{err}</div>}
          <form
            className="aForm"
            onSubmit={(e) => {
              e.preventDefault();
              setErr("");
              updateMut.mutate({
                id: editing.id,
                patch: {
                  yardName: form.yardName.trim(),
                  ownerName: form.ownerName.trim() || null,
                  city: form.city.trim() || null,
                  state: form.state.trim() || null,
                  address: form.address.trim() || null,
                  contactNumber: form.contactNumber.trim() || null,
                  gstNumber: form.gstNumber.trim() || null,
                },
              });
            }}
          >
            <Field label="Yard code">
              <input value={form.yardCode} disabled />
            </Field>
            <Field label="Yard name" error={fieldErrs.yardName}>
              <input value={form.yardName} onChange={(e) => setForm({ ...form, yardName: e.target.value })} required />
            </Field>
            <Field label="Owner name">
              <input value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} />
            </Field>
            <Field label="Contact number">
              <input value={form.contactNumber} onChange={(e) => setForm({ ...form, contactNumber: e.target.value })} />
            </Field>
            <Field label="City">
              <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </Field>
            <Field label="State">
              <input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
            </Field>
            <Field label="GSTIN">
              <input value={form.gstNumber} onChange={(e) => setForm({ ...form, gstNumber: e.target.value })} />
            </Field>
            <Field label="Address" wide>
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </Field>
            <div className="aFormActions">
              <button type="button" className="aBtn ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="aBtn primary" disabled={updateMut.isPending}>
                {updateMut.isPending ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ---- Deactivate confirmation (in-app, never window.confirm) ---- */}
      {confirmOff && (
        <Modal title={`Deactivate ${confirmOff.yardName}?`} onClose={() => setConfirmOff(null)}>
          {err && <div className="aErr">{err}</div>}
          <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--muted)" }}>
            Its owner and manager will no longer be able to sign in, and the yard disappears from
            operations. <b style={{ color: "var(--text)" }}>No data is deleted</b> — all{" "}
            {num(confirmOff.stats.loadsTotal)} loads, {num(confirmOff.stats.sales)} invoices and{" "}
            {kg(confirmOff.stats.stockKg)} of stock stay intact and auditable, and you can reactivate
            the yard at any time.
          </p>
          <div className="aFormActions" style={{ marginTop: 18 }}>
            <button className="aBtn ghost" onClick={() => setConfirmOff(null)}>
              Cancel
            </button>
            <button
              className="aBtn danger"
              onClick={() => deactivateMut.mutate(confirmOff.id)}
              disabled={deactivateMut.isPending}
            >
              {deactivateMut.isPending ? "Deactivating…" : "Deactivate yard"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
