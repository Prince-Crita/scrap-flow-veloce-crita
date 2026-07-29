"use client";

import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "@/lib/fetcher";
import { PageHead, Card, Pill, EmptyState, SkeletonRows, when, duration, num } from "@/components/admin/ui";

/**
 * Plain-English label for an audit action. The raw `action` string is still
 * shown underneath — the label is for scanning, the raw value for precision.
 * Unknown actions fall back to a de-camelised form rather than being hidden, so
 * a newly audited action never renders as blank.
 */
const ACTION_LABELS: Record<string, string> = {
  "yard.create": "Yard created",
  "yard.update": "Yard edited",
  "yard.deactivate": "Yard deactivated",
  "user.create": "User created",
  "user.update": "User edited",
  "user.reassign": "User moved to another yard",
  "user.delete": "User deleted",
  "user.passwordReset": "Password reset by admin",
  "password.change": "Password changed by user",
  "impersonation.enter": "Admin entered yard",
  "impersonation.exit": "Admin left yard",
  "vendor.adminEdit": "Vendor edited by admin",
  "buyer.adminEdit": "Buyer edited by admin",
  "material.adminEdit": "Material edited by admin",
  "sku.adminEdit": "SKU edited by admin",
  "inwardLoad.adminEdit": "Inward load edited by admin",
  "sale.adminEdit": "Sale edited by admin",
  "receivable.adminEdit": "Payment status edited by admin",
};

function actionLabel(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  const tail = action.includes(".") ? action.slice(action.indexOf(".") + 1) : action;
  const words = tail.replace(/([A-Z])/g, " $1").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type AuditEntry = {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  actor: { id: string; name: string; email: string; role: string } | null;
  yard: { id: string; yardCode: string; yardName: string } | null;
};

type AuditResp = {
  entries: AuditEntry[];
  nextCursor: string | null;
  filters: { actions: string[]; entities: string[] };
};

type SessionRow = {
  id: string;
  adminName: string;
  adminEmail: string;
  yardCode: string;
  yardName: string;
  startedAt: string;
  endedAt: string | null;
  durationSec: number;
  open: boolean;
  endReason: string | null;
  ip: string | null;
};

type YardLite = { id: string; yardCode: string; yardName: string };

export default function AdminAuditPage() {
  const [yardId, setYardId] = useState("");
  const [action, setAction] = useState("");
  const [entity, setEntity] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [view, setView] = useState<"trail" | "sessions">("trail");

  const yardsQ = useQuery({
    queryKey: ["adminYards"],
    queryFn: () => getJson<{ yards: YardLite[] }>("/api/admin/yards"),
  });

  const qs = new URLSearchParams();
  if (yardId) qs.set("yardId", yardId);
  if (action) qs.set("action", action);
  if (entity) qs.set("entity", entity);
  if (cursor) qs.set("cursor", cursor);

  const auditQ = useQuery({
    queryKey: ["adminAudit", yardId, action, entity, cursor],
    queryFn: () => getJson<AuditResp>(`/api/admin/audit?${qs.toString()}`),
  });

  const sessQs = new URLSearchParams();
  if (yardId) sessQs.set("yardId", yardId);
  const sessionsQ = useQuery({
    queryKey: ["adminSessions", yardId],
    queryFn: () => getJson<{ sessions: SessionRow[] }>(`/api/admin/impersonate/sessions?${sessQs.toString()}`),
    enabled: view === "sessions",
  });

  const entries = auditQ.data?.entries ?? [];
  const yards = yardsQ.data?.yards ?? [];

  function resetPaging<T>(setter: (v: T) => void) {
    return (v: T) => {
      setCursor(null);
      setter(v);
    };
  }

  return (
    <>
      <PageHead
        title="Audit Log"
        subtitle="Append-only record of every privileged action and every admin yard session."
      >
        <button className={`aBtn sm${view === "trail" ? " primary" : " ghost"}`} onClick={() => setView("trail")}>
          Audit trail
        </button>
        <button className={`aBtn sm${view === "sessions" ? " primary" : " ghost"}`} onClick={() => setView("sessions")}>
          Yard sessions
        </button>
      </PageHead>

      <div className="aToolbar">
        <select value={yardId} onChange={(e) => resetPaging(setYardId)(e.target.value)}>
          <option value="">All yards</option>
          {yards.map((y) => (
            <option key={y.id} value={y.id}>
              {y.yardName} ({y.yardCode})
            </option>
          ))}
        </select>
        {view === "trail" && (
          <>
            <select value={action} onChange={(e) => resetPaging(setAction)(e.target.value)}>
              <option value="">All actions</option>
              {(auditQ.data?.filters.actions ?? []).map((a) => (
                <option key={a} value={a}>
                  {actionLabel(a)}
                </option>
              ))}
            </select>
            <select value={entity} onChange={(e) => resetPaging(setEntity)(e.target.value)}>
              <option value="">All entities</option>
              {(auditQ.data?.filters.entities ?? []).map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </>
        )}
        {(yardId || action || entity) && (
          <button
            className="aBtn sm ghost"
            onClick={() => {
              setYardId("");
              setAction("");
              setEntity("");
              setCursor(null);
            }}
          >
            Clear
          </button>
        )}
      </div>

      {view === "trail" ? (
        <Card>
          <div className="aTableWrap">
            <table className="aTable">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Yard</th>
                  <th>IP</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {/* Fragment carries the key: mapping to a bare <> left every row
                    keyless, which React warns about and which breaks row identity
                    when the list re-orders after a filter change. */}
                {entries.map((e) => (
                  <Fragment key={e.id}>
                    <tr>
                      <td className="aTiny aMuted">{when(e.createdAt)}</td>
                      <td className="aTiny">
                        {e.actor?.name ?? "system"}
                        {e.actor && <div className="aMuted">{e.actor.email}</div>}
                      </td>
                      <td className="aTiny">
                        <b>{actionLabel(e.action)}</b>
                        <div className="aMuted aMono">{e.action}</div>
                      </td>
                      <td className="aTiny">
                        {e.entity}
                        {e.entityId && <div className="aMuted aMono">{e.entityId.slice(-8)}</div>}
                      </td>
                      <td className="aTiny aMono">{e.yard?.yardCode ?? "—"}</td>
                      <td className="aTiny aMono aMuted">{e.ip ?? "—"}</td>
                      <td>
                        <div className="actions">
                          <button
                            className="aBtn sm ghost"
                            onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                            aria-expanded={expanded === e.id}
                          >
                            {expanded === e.id ? "Hide" : "Details"}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded === e.id && (
                      <tr>
                        <td colSpan={7} style={{ background: "var(--ink)" }}>
                          <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
                            <ChangeBlock label="Before" value={e.before} />
                            <ChangeBlock label="After" value={e.after} />
                          </div>
                          {e.userAgent && (
                            <div className="aTiny aMuted" style={{ marginTop: 10, wordBreak: "break-all" }}>
                              {e.userAgent}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {!auditQ.isLoading && entries.length === 0 && (
                  <tr>
                    <td colSpan={7}>
                      <EmptyState icon="🔍" title="No audit entries match" hint="Every privileged action is recorded. Widen the filters, or clear them to see the whole trail." />
                    </td>
                  </tr>
                )}
                {auditQ.isLoading && (
                  <tr>
                    <td colSpan={7}>
                      <SkeletonRows rows={6} />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {(cursor || auditQ.data?.nextCursor) && (
            <div className="aRowBetween" style={{ marginTop: 14 }}>
              <button className="aBtn sm ghost" onClick={() => setCursor(null)} disabled={!cursor}>
                ← Newest
              </button>
              <span className="aTiny aMuted">{num(entries.length)} entries on this page</span>
              <button
                className="aBtn sm"
                onClick={() => setCursor(auditQ.data?.nextCursor ?? null)}
                disabled={!auditQ.data?.nextCursor}
              >
                Older →
              </button>
            </div>
          )}
        </Card>
      ) : (
        <Card title="Admin yard sessions — who entered which yard, when, and for how long">
          <div className="aTableWrap">
            <table className="aTable">
              <thead>
                <tr>
                  <th>Admin</th>
                  <th>Yard</th>
                  <th>Entered</th>
                  <th>Exited</th>
                  <th className="num">Duration</th>
                  <th>Ended by</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {(sessionsQ.data?.sessions ?? []).map((s) => (
                  <tr key={s.id}>
                    <td>
                      <b>{s.adminName}</b>
                      <div className="aTiny aMuted">{s.adminEmail}</div>
                    </td>
                    <td className="aTiny">
                      {s.yardName}
                      <div className="aMuted aMono">{s.yardCode}</div>
                    </td>
                    <td className="aTiny aMuted">{when(s.startedAt)}</td>
                    <td className="aTiny aMuted">
                      {s.open ? <Pill tone="warn">In yard now</Pill> : when(s.endedAt)}
                    </td>
                    <td className="num">{duration(s.durationSec)}</td>
                    <td className="aTiny aMono aMuted">{s.endReason ?? "—"}</td>
                    <td className="aTiny aMono aMuted">{s.ip ?? "—"}</td>
                  </tr>
                ))}
                {!sessionsQ.isLoading && (sessionsQ.data?.sessions ?? []).length === 0 && (
                  <tr>
                    <td colSpan={7}>
                      <EmptyState icon="👁️" title="No yard sessions yet" hint="When an admin uses Enter Yard, the session is recorded here with its duration and exit time." />
                    </td>
                  </tr>
                )}
                {sessionsQ.isLoading && (
                  <tr>
                    <td colSpan={7}>
                      <SkeletonRows rows={4} />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function ChangeBlock({ label, value }: { label: string; value: unknown }) {
  const empty = value === null || value === undefined || (typeof value === "object" && Object.keys(value as object).length === 0);
  return (
    <div>
      <div className="aCardTitle" style={{ marginBottom: 6 }}>
        {label}
      </div>
      {empty ? (
        <div className="aTiny aMuted">—</div>
      ) : (
        <pre
          className="aMono aTiny"
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "var(--mint)",
            lineHeight: 1.6,
          }}
        >
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}
