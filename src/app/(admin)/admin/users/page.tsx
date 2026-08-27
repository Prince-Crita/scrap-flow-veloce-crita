"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getJson, sendJson, ApiError } from "@/frontend/lib/api-client";
import { PageHead, Card, Pill, Modal, Field, EmptyState, SkeletonRows, Kpi, num, when } from "@/frontend/components/admin/ui";
import { roleLabel } from "@/shared/role-label";

type UserRow = {
  id: string;
  name: string;
  email: string;
  role: "OWNER" | "MANAGER" | "ADMIN";
  active: boolean;
  mustChangePassword: boolean;
  xp: number;
  level: number;
  streak: number;
  lastActiveDate: string | null;
  createdAt: string;
  yard: { id: string; yardCode: string; yardName: string } | null;
};

type YardLite = { id: string; yardCode: string; yardName: string; active: boolean };

function UsersPage() {
  const qc = useQueryClient();
  const params = useSearchParams();
  const [yardFilter, setYardFilter] = useState(params.get("yardId") ?? "");
  const [roleFilter, setRoleFilter] = useState("");
  const [search, setSearch] = useState("");

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<UserRow | null>(null);
  const [err, setErr] = useState("");
  const [fieldErrs, setFieldErrs] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");

  const yardsQ = useQuery({
    queryKey: ["adminYards"],
    queryFn: () => getJson<{ yards: YardLite[] }>("/api/admin/yards"),
  });

  const qs = new URLSearchParams();
  if (yardFilter) qs.set("yardId", yardFilter);
  if (roleFilter) qs.set("role", roleFilter);
  if (search.trim()) qs.set("q", search.trim());

  const usersQ = useQuery({
    queryKey: ["adminUsers", yardFilter, roleFilter, search],
    queryFn: () => getJson<{ users: UserRow[] }>(`/api/admin/users?${qs.toString()}`),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["adminUsers"] });
    qc.invalidateQueries({ queryKey: ["adminYard"] });
    qc.invalidateQueries({ queryKey: ["adminOverview"] });
  };

  function handleErr(e: unknown) {
    if (e instanceof ApiError) {
      setErr(e.message);
      setFieldErrs(e.fields ?? {});
    } else setErr("Something went wrong.");
  }

  const createMut = useMutation({
    mutationFn: (body: Record<string, unknown>) => sendJson("/api/admin/users", body),
    onSuccess: () => {
      setCreating(false);
      setNotice("User created. They must set a new password on first sign-in.");
      refresh();
    },
    onError: handleErr,
  });

  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      sendJson(`/api/admin/users/${id}`, patch, "PATCH"),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
    onError: handleErr,
  });

  /**
   * Password change, now driven from the Edit dialog rather than its own button.
   *
   * The endpoint is unchanged — `mustChangePassword` was always part of its body,
   * it was simply hard-coded to `true` by the old standalone modal. It is now
   * passed through so the admin can either set a password the user keeps or force
   * a change at next sign-in; `true` remains the default, so the previous
   * behaviour is what you get unless you deliberately untick it.
   */
  const resetMut = useMutation({
    mutationFn: ({ id, newPassword, mustChange }: { id: string; newPassword: string; mustChange: boolean }) =>
      sendJson(`/api/admin/users/${id}/password`, { newPassword, mustChangePassword: mustChange }),
    onError: handleErr,
  });

  /**
   * Delete is refused server-side for anyone with history, so the failure it
   * returns is a normal outcome rather than an error: the dialog stays open and
   * shows why, with deactivation as the offered alternative.
   */
  const deleteMut = useMutation({
    mutationFn: (u: UserRow) => sendJson(`/api/admin/users/${u.id}`, undefined, "DELETE"),
    onSuccess: (_r, u) => {
      setConfirmDelete(null);
      setNotice(`${u.name} was deleted.`);
      refresh();
    },
    onError: handleErr,
  });

  const users = usersQ.data?.users ?? [];
  const yards = yardsQ.data?.yards ?? [];
  const activeYards = yards.filter((y) => y.active);

  const hasFilters = !!(yardFilter || roleFilter || search.trim());
  const clearFilters = () => {
    setYardFilter("");
    setRoleFilter("");
    setSearch("");
  };

  // Role visibility at a glance, computed from the rows already on screen so it
  // always agrees with the table below it.
  const counts = {
    owners: users.filter((u) => u.role === "OWNER").length,
    managers: users.filter((u) => u.role === "MANAGER").length,
    admins: users.filter((u) => u.role === "ADMIN").length,
    disabled: users.filter((u) => !u.active).length,
    resetPending: users.filter((u) => u.mustChangePassword).length,
  };

  return (
    <>
      <PageHead
        title="Users"
        subtitle={
          hasFilters
            ? `${users.length} ${users.length === 1 ? "user" : "users"} matching your filters`
            : `${users.length} ${users.length === 1 ? "user" : "users"} across ${yards.length} ${yards.length === 1 ? "yard" : "yards"}`
        }
      >
        <button
          className="aBtn primary"
          onClick={() => {
            setErr("");
            setFieldErrs({});
            setCreating(true);
          }}
          disabled={activeYards.length === 0}
          title={activeYards.length === 0 ? "Create an active yard first" : undefined}
        >
          + Create User
        </button>
      </PageHead>

      {notice && <div className="aOk">{notice}</div>}
      {err && !creating && !editing && <div className="aErr">{err}</div>}

      <div className="aGrid">
        <Kpi label="Owners" value={num(counts.owners)} foot="can sell in their yard" />
        <Kpi label="Supervisors" value={num(counts.managers)} foot="stock · inward · sort" />
        <Kpi label="Platform Admins" value={num(counts.admins)} foot="cross-yard access" />
        <Kpi
          label="Needs attention"
          value={num(counts.disabled + counts.resetPending)}
          foot={`${num(counts.disabled)} disabled · ${num(counts.resetPending)} reset pending`}
          accent={counts.disabled + counts.resetPending > 0}
        />
      </div>

      <div className="aSectionTitle">All users</div>
      <div className="aToolbar">
        <input
          placeholder="Search name or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search users"
        />
        <select value={yardFilter} onChange={(e) => setYardFilter(e.target.value)} aria-label="Filter by yard">
          <option value="">All yards</option>
          {yards.map((y) => (
            <option key={y.id} value={y.id}>
              {y.yardName} ({y.yardCode}){y.active ? "" : " · inactive"}
            </option>
          ))}
        </select>
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Filter by role">
          <option value="">All roles</option>
          <option value="OWNER">Owner</option>
          <option value="MANAGER">Supervisor</option>
          <option value="ADMIN">Admin</option>
        </select>
        {hasFilters && (
          <button className="aBtn sm ghost" onClick={clearFilters}>
            Clear filters
          </button>
        )}
        {hasFilters && (
          <span className="aTiny aMuted">
            {[
              search.trim() && `“${search.trim()}”`,
              roleFilter && roleFilter.toLowerCase(),
              yardFilter && (yards.find((y) => y.id === yardFilter)?.yardCode ?? "yard"),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
      </div>

      <Card>
        <div className="aTableWrap">
          <table className="aTable">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Yard</th>
                <th>Status</th>
                <th className="num">XP</th>
                <th className="num">Lvl</th>
                <th className="num">Streak</th>
                <th>Last active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <b>{u.name}</b>
                    <div className="aTiny aMuted">{u.email}</div>
                  </td>
                  <td>
                    <Pill tone="role">{roleLabel(u.role)}</Pill>
                  </td>
                  <td className="aTiny">
                    {u.yard ? (
                      <>
                        {u.yard.yardName}
                        <div className="aMuted aMono">{u.yard.yardCode}</div>
                      </>
                    ) : (
                      <span className="aMuted">Platform</span>
                    )}
                  </td>
                  <td>
                    {u.active ? <Pill tone="ok">Active</Pill> : <Pill tone="off">Disabled</Pill>}
                    {u.mustChangePassword && (
                      <div style={{ marginTop: 4 }}>
                        <Pill tone="warn">Reset pending</Pill>
                      </div>
                    )}
                  </td>
                  <td className="num">{num(u.xp)}</td>
                  <td className="num">{u.level}</td>
                  <td className="num">{u.streak}</td>
                  <td className="aTiny aMuted">{u.lastActiveDate ? when(u.lastActiveDate) : "—"}</td>
                  <td>
                    <div className="actions">
                      {u.role !== "ADMIN" && (
                        <>
                          <button
                            className="aBtn sm"
                            onClick={() => {
                              setErr("");
                              setFieldErrs({});
                              setEditing(u);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            className="aBtn sm danger"
                            onClick={() => {
                              setErr("");
                              setFieldErrs({});
                              setConfirmDelete(u);
                            }}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!usersQ.isLoading && users.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <EmptyState
                      icon="🔍"
                      title={hasFilters ? "No users match these filters" : "No users yet"}
                      hint={
                        hasFilters
                          ? "Try clearing the search or widening the yard and role filters."
                          : "Create an owner for a yard so it can operate and raise sales."
                      }
                      action={
                        hasFilters ? (
                          <button className="aBtn" onClick={clearFilters}>
                            Clear filters
                          </button>
                        ) : undefined
                      }
                    />
                  </td>
                </tr>
              )}
              {usersQ.isLoading && (
                <tr>
                  <td colSpan={9}>
                    <SkeletonRows rows={5} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {creating && (
        <CreateUserModal
          yards={activeYards}
          defaultYardId={yardFilter || activeYards[0]?.id || ""}
          err={err}
          fieldErrs={fieldErrs}
          pending={createMut.isPending}
          onClose={() => setCreating(false)}
          onSubmit={(body) => {
            setErr("");
            createMut.mutate(body);
          }}
        />
      )}

      {editing && (
        <EditUserModal
          user={editing}
          yards={yards}
          err={err}
          fieldErrs={fieldErrs}
          pending={updateMut.isPending || resetMut.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(patch, newPassword, mustChange) => {
            setErr("");
            const id = editing.id;
            /**
             * Password and profile are two endpoints, so they are sequenced rather
             * than fired together: if the password write fails validation, the
             * dialog must stay open with the error instead of having already
             * applied half the change and closed.
             */
            void (async () => {
              try {
                if (newPassword) {
                  await resetMut.mutateAsync({ id, newPassword, mustChange });
                }
                if (Object.keys(patch).length > 0) {
                  await updateMut.mutateAsync({ id, patch });
                } else {
                  setEditing(null);
                  setNotice(newPassword ? "Password updated." : "Nothing to change.");
                  refresh();
                  return;
                }
                setNotice(newPassword ? "User and password updated." : "User updated.");
              } catch {
                /* handleErr on the mutation already surfaced it; keep the dialog open. */
              }
            })();
          }}
        />
      )}

      {/* ---- Delete confirmation (in-app, same shape as Deactivate yard) ---- */}
      {confirmDelete && (
        <Modal
          title={`Delete ${confirmDelete.name}?`}
          subtitle={confirmDelete.email}
          onClose={() => setConfirmDelete(null)}
        >
          {err && <div className="aErr">{err}</div>}
          <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--muted)" }}>
            This removes the account permanently and{" "}
            <b style={{ color: "var(--text)" }}>cannot be undone</b>. It is refused if{" "}
            {confirmDelete.name.split(" ")[0]} has any loads, sorts, invoices, dispatches or audit
            entries recorded against them — that history has to stay attributable. To stop someone
            signing in while keeping their record, edit them and untick{" "}
            <b style={{ color: "var(--text)" }}>Active</b> instead.
          </p>
          <div className="aFormActions" style={{ marginTop: 18 }}>
            <button className="aBtn ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </button>
            <button
              className="aBtn danger"
              onClick={() => {
                setErr("");
                deleteMut.mutate(confirmDelete);
              }}
              disabled={deleteMut.isPending}
            >
              {deleteMut.isPending ? "Deleting…" : "Delete user"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function CreateUserModal({
  yards,
  defaultYardId,
  err,
  fieldErrs,
  pending,
  onClose,
  onSubmit,
}: {
  yards: YardLite[];
  defaultYardId: string;
  err: string;
  fieldErrs: Record<string, string>;
  pending: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"OWNER" | "MANAGER">("MANAGER");
  const [yardId, setYardId] = useState(defaultYardId);
  /**
   * Was hard-coded to `true`, so EVERY user an admin created was parked on
   * /change-password at first sign-in with no way to opt out. For a password
   * reset that is right; for handing over a freshly created yard it meant the
   * Owner and the Manager both had a manual step before the yard could be used
   * at all. The API has always accepted this flag — only the console never
   * offered it. Default stays `true`, so nothing changes unless it is unticked.
   */
  const [mustChange, setMustChange] = useState(true);

  return (
    <Modal
      title="Create User"
      subtitle="Owners get the full Stock → Inward → Sort → Sell flow. Supervisors get everything except Sell."
      onClose={onClose}
    >
      {err && <div className="aErr">{err}</div>}
      <form
        className="aForm"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ name, email, password, role, yardId, mustChangePassword: mustChange });
        }}
      >
        <Field label="Full name" error={fieldErrs.name}>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Email" error={fieldErrs.email}>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Role" error={fieldErrs.role}>
          <select value={role} onChange={(e) => setRole(e.target.value as "OWNER" | "MANAGER")}>
            <option value="MANAGER">Supervisor</option>
            <option value="OWNER">Owner</option>
          </select>
        </Field>
        <Field label="Yard" error={fieldErrs.yardId}>
          <select value={yardId} onChange={(e) => setYardId(e.target.value)} required>
            {yards.map((y) => (
              <option key={y.id} value={y.id}>
                {y.yardName} ({y.yardCode})
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Temporary password"
          wide
          hint={
            mustChange
              ? "At least 8 characters. The user must change it at first sign-in."
              : "At least 8 characters. The user signs straight in with this password."
          }
          error={fieldErrs.password}
        >
          <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
        </Field>
        <Field label="First sign-in" wide hint="Leave ticked unless you are handing over a ready-to-use account.">
          <label className="aCheck">
            <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} />
            <span>Require a password change at first sign-in</span>
          </label>
        </Field>
        <div className="aFormActions">
          <button type="button" className="aBtn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="aBtn primary" disabled={pending}>
            {pending ? "Creating…" : "Create user"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditUserModal({
  user,
  yards,
  err,
  fieldErrs,
  pending,
  onClose,
  onSubmit,
}: {
  user: UserRow;
  yards: YardLite[];
  err: string;
  fieldErrs: Record<string, string>;
  pending: boolean;
  onClose: () => void;
  onSubmit: (patch: Record<string, unknown>, newPassword: string, mustChange: boolean) => void;
}) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<"OWNER" | "MANAGER">(user.role === "OWNER" ? "OWNER" : "MANAGER");
  const [yardId, setYardId] = useState(user.yard?.id ?? "");
  const [active, setActive] = useState(user.active);
  /** Blank = leave the password alone. Nothing is sent unless something is typed. */
  const [newPassword, setNewPassword] = useState("");
  const [mustChange, setMustChange] = useState(true);
  const [showPw, setShowPw] = useState(false);

  return (
    <Modal title={`Edit ${user.name}`} subtitle="Changing the yard moves this user's access, not their history." onClose={onClose}>
      {err && <div className="aErr">{err}</div>}
      <form
        className="aForm"
        onSubmit={(e) => {
          e.preventDefault();
          const patch: Record<string, unknown> = {};
          if (name !== user.name) patch.name = name;
          if (email !== user.email) patch.email = email;
          if (role !== user.role) patch.role = role;
          if (yardId !== (user.yard?.id ?? "")) patch.yardId = yardId;
          if (active !== user.active) patch.active = active;
          onSubmit(patch, newPassword.trim(), mustChange);
        }}
      >
        <Field label="Full name" error={fieldErrs.name}>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Email" error={fieldErrs.email}>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Role" error={fieldErrs.role}>
          <select value={role} onChange={(e) => setRole(e.target.value as "OWNER" | "MANAGER")}>
            <option value="MANAGER">Supervisor</option>
            <option value="OWNER">Owner</option>
          </select>
        </Field>
        <Field label="Yard" error={fieldErrs.yardId}>
          <select value={yardId} onChange={(e) => setYardId(e.target.value)} required>
            {yards.map((y) => (
              <option key={y.id} value={y.id}>
                {y.yardName} ({y.yardCode})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Account active" wide hint="A disabled user cannot sign in. Their history is preserved.">
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, textTransform: "none", letterSpacing: 0 }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} style={{ width: "auto" }} />
            Can sign in
          </label>
        </Field>
        {/*
          Password, moved here from the standalone "Reset password" button.

          The existing password is never shown: it is stored as a one-way bcrypt
          hash, so there is nothing to display. The read-only "(hashed — not
          recoverable)" row that used to say so has been removed as noise — the
          field below is self-explanatory, and entering a value replaces the
          password outright without asking for the old one.
        */}
        <Field
          label="New password"
          wide
          error={fieldErrs.newPassword}
          hint="Leave blank to keep the current password. At least 8 characters; share it over a trusted channel."
        >
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type={showPw ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={8}
              autoComplete="new-password"
              placeholder="Leave blank to keep unchanged"
            />
            <button
              type="button"
              className="aBtn sm ghost"
              onClick={() => setShowPw((v) => !v)}
              aria-label={showPw ? "Hide password" : "Show password"}
              style={{ flex: "none" }}
            >
              {showPw ? "Hide" : "Show"}
            </button>
          </div>
        </Field>
        {newPassword.trim() !== "" && (
          <Field label="At next sign-in" wide hint="Ticked matches the old Reset password behaviour.">
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, textTransform: "none", letterSpacing: 0 }}>
              <input
                type="checkbox"
                checked={mustChange}
                onChange={(e) => setMustChange(e.target.checked)}
                style={{ width: "auto" }}
              />
              Require the user to choose their own password
            </label>
          </Field>
        )}
        <div className="aFormActions">
          <button type="button" className="aBtn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="aBtn primary" disabled={pending}>
            {pending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function AdminUsersPage() {
  return (
    <Suspense fallback={<PageHead title="Users" subtitle="Loading…" />}>
      <UsersPage />
    </Suspense>
  );
}
