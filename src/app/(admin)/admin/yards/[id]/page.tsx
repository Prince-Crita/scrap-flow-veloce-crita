"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJson, sendJson, ApiError } from "@/lib/fetcher";
import {
  PageHead,
  Card,
  Kpi,
  Pill,
  EmptyState,
  Crumbs,
  SubNav,
  SkeletonKpis,
  SkeletonRows,
  Modal,
  Field,
  inr,
  kg,
  num,
  when,
  pct,
} from "@/components/admin/ui";
import { EnterYardButton } from "@/components/admin/enter-yard-button";
import { RecordEditModal, type EditField, type EditableRecordKind } from "@/components/admin/record-edit";

type Detail = {
  yard: {
    id: string;
    yardCode: string;
    yardName: string;
    ownerName: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    timezone: string;
    contactNumber: string | null;
    gstNumber: string | null;
    active: boolean;
    deactivatedAt: string | null;
    createdAt: string;
  };
  users: {
    id: string;
    name: string;
    email: string;
    role: string;
    active: boolean;
    mustChangePassword: boolean;
    xp: number;
    level: number;
    streak: number;
    lastActiveDate: string | null;
  }[];
  stock: {
    id: string;
    code: string;
    name: string;
    icon: string;
    materialName: string | null;
    quantityKg: number;
    thresholdKg: number;
    isMixedBucket: boolean;
    visible: boolean;
  }[];
  loads: {
    id: string;
    lotNumber: string;
    materialLabel: string;
    totalKg: number;
    vendorId: string | null;
    vendorName: string;
    vehicleNumber: string | null;
    vehicleType: string | null;
    driverName: string | null;
    status: string;
    weighments: number;
    createdAt: string;
  }[];
  sales: {
    id: string;
    invoiceNumber: string;
    buyerName: string;
    skuName: string;
    quantityKg: number;
    ratePerKg: number;
    total: number;
    vehicleNumber: string | null;
    driverName: string | null;
    driverPhone: string | null;
    status: string;
    receivableId: string | null;
    paymentStatus: string;
    createdAt: string;
  }[];
  dispatches: {
    id: string;
    dispatchNumber: string;
    vehicleNumber: string | null;
    vehicleType: string | null;
    driverName: string | null;
    totalKg: number;
    ocrConfidence: number | null;
    dispatchedBy: string | null;
    createdAt: string;
    frontImageUrl: string | null;
    backImageUrl: string | null;
    materialImages: string[];
    lines: {
      id: string;
      sequence: number;
      skuName: string;
      skuIcon: string;
      quantityKg: number;
      saleId: string;
      invoiceNumber: string;
      buyerName: string;
      allocatedKg: number;
      dispatchedKg: number;
      remainingKg: number;
      dispatchStatus: string;
    }[];
    audit: {
      id: string;
      action: string;
      actorName: string;
      before: unknown;
      after: unknown;
      createdAt: string;
    }[];
  }[];
  vendors: {
    id: string;
    name: string;
    gstNumber: string | null;
    phone: string | null;
    address: string | null;
    active: boolean;
    _count: { loads: number };
  }[];
  materials: {
    id: string;
    name: string;
    code: string;
    category: string | null;
    active: boolean;
    _count: { skus: number; loads: number };
  }[];
  totals: {
    stockKg: number;
    salesValue: number;
    outstanding: number;
    outstandingCount: number;
    transactions: number;
    dispatchCount: number;
    dispatchKg: number;
  };
  adminInside: { adminName: string; adminEmail: string; startedAt: string } | null;
};

type TabKey = "stock" | "loads" | "outward" | "sales" | "vendors" | "materials" | "users";


type EditTarget = {
  entity: EditableRecordKind;
  id: string;
  title: string;
  subtitle?: string;
  fields: EditField[];
  initial: Record<string, unknown>;
};

export default function AdminYardDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>("stock");
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [notice, setNotice] = useState("");
  const [err, setErr] = useState("");
  /**
   * Which dispatch is expanded. A vehicle carries several invoices and its
   * evidence photos, which would make the table unreadable inline — so the row
   * stays a summary and the detail opens underneath it.
   */
  const [openDispatch, setOpenDispatch] = useState<string | null>(null);
  /**
   * The SKU being corrected. Stock adjustment is deliberately its own dialog
   * rather than a field in the record editor: `quantityKg` is ledger-derived and
   * the editor refuses it, precisely so a quantity can never be changed without a
   * reason and a matching ledger entry.
   */
  const [adjust, setAdjust] = useState<{ id: string; name: string; currentKg: number } | null>(null);
  const [adjustKg, setAdjustKg] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjustBusy, setAdjustBusy] = useState(false);
  const [adjustErr, setAdjustErr] = useState("");

  async function submitAdjustment() {
    if (!adjust) return;
    setAdjustErr("");
    setAdjustBusy(true);
    try {
      const res = await sendJson<{ adjustment: { changeKg: number; skuName: string } }>(
        "/api/admin/stock-adjustment",
        { yardId: id, skuId: adjust.id, actualKg: Number(adjustKg), reason: adjustReason.trim() }
      );
      const d = res.adjustment.changeKg;
      setAdjust(null);
      setAdjustKg("");
      setAdjustReason("");
      saved(`${res.adjustment.skuName} adjusted by ${d > 0 ? "+" : ""}${num(d)} kg`);
    } catch (e) {
      setAdjustErr(e instanceof ApiError ? e.message : "Could not adjust stock");
    } finally {
      setAdjustBusy(false);
    }
  }

  const { data, isLoading } = useQuery({
    queryKey: ["adminYard", id],
    queryFn: () => getJson<Detail>(`/api/admin/yards/${id}`),
  });

  function saved(msg: string) {
    setEdit(null);
    setNotice(msg);
    qc.invalidateQueries({ queryKey: ["adminYard", id] });
    qc.invalidateQueries({ queryKey: ["adminYards"] });
    qc.invalidateQueries({ queryKey: ["adminOverview"] });
  }

  if (isLoading) {
    return (
      <>
        <Crumbs items={[{ label: "Yards", href: "/admin/yards" }, { label: "Loading…" }]} />
        <PageHead title="Yard" subtitle="Loading yard data…" />
        <SkeletonKpis count={4} />
        <div className="aSectionTitle">Records</div>
        <Card>
          <SkeletonRows rows={6} />
        </Card>
      </>
    );
  }
  if (!data) {
    return (
      <>
        <Crumbs items={[{ label: "Yards", href: "/admin/yards" }, { label: "Not found" }]} />
        <PageHead title="Yard not found" />
        <Card>
          <EmptyState
            icon="🏭"
            title="This yard does not exist"
            hint="It may have been removed, or the link is stale."
            action={
              <Link className="aBtn primary" href="/admin/yards">
                Back to all yards
              </Link>
            }
          />
        </Card>
      </>
    );
  }

  const y = data.yard;

  return (
    <>
      <Crumbs items={[{ label: "Yards", href: "/admin/yards" }, { label: `${y.yardName} · ${y.yardCode}` }]} />
      <PageHead
        title={y.yardName}
        subtitle={`${y.yardCode} · ${[y.city, y.state].filter(Boolean).join(", ") || "location not set"} · created ${when(
          y.createdAt
        )}`}
      >
        <Link className="aBtn ghost" href="/admin/yards">
          ← All yards
        </Link>
        <EnterYardButton yardId={y.id} yardName={y.yardName} disabled={!y.active} size="md" onError={setErr} />
      </PageHead>

      {notice && <div className="aOk">{notice}</div>}
      {err && <div className="aErr">{err}</div>}
      {!y.active && (
        <div className="aErr">
          This yard is deactivated{y.deactivatedAt ? ` since ${when(y.deactivatedAt)}` : ""}. Its users cannot sign
          in. All data is intact — reactivate from the Yards list.
        </div>
      )}
      {data.adminInside && (
        <div className="aOk">
          {data.adminInside.adminName} is inside this yard right now (since {when(data.adminInside.startedAt)}).
        </div>
      )}

      <div className="aGrid">
        <Kpi
          label="Stock On Hand"
          value={kg(data.totals.stockKg)}
          foot={`${data.stock.length} SKUs · ${num(data.stock.filter((s) => s.isMixedBucket).reduce((a, s) => a + s.quantityKg, 0))} kg unsorted`}
        />
        <Kpi label="Sales Value" value={inr(data.totals.salesValue)} foot={`last ${data.sales.length} invoices`} />
        <Kpi
          label="Outstanding"
          value={inr(data.totals.outstanding)}
          foot={`${num(data.totals.outstandingCount)} unpaid${data.totals.salesValue > 0 ? ` · ${pct(data.totals.outstanding, data.totals.salesValue)}% of sales` : ""}`}
          accent={data.totals.outstanding > 0}
        />
        <Kpi
          label="Awaiting Sort"
          value={num(data.loads.filter((l) => l.status === "RECEIVED").length)}
          foot={`${num(data.totals.transactions)} ledger entries`}
          accent={data.loads.some((l) => l.status === "RECEIVED")}
        />
      </div>

      <div className="aSectionTitle">Yard details</div>
      <Card
        actions={
          <Link className="aBtn sm ghost" href="/admin/yards">
            Edit in Yards list
          </Link>
        }
      >
        <div className="aForm">
          <Detail label="Owner name" value={y.ownerName} />
          <Detail label="Contact" value={y.contactNumber} />
          <Detail label="GSTIN" value={y.gstNumber} />
          <Detail label="Timezone" value={y.timezone} />
          <Detail label="Address" value={y.address} wide />
        </div>
      </Card>

      <div className="aSectionTitle">Records</div>
      {/* Counts on the tab strip so an admin can see where the data is before
          clicking, rather than hunting through empty tabs. */}
      <SubNav<TabKey>
        items={[
          { key: "stock", label: "Stock", count: data.stock.length },
          { key: "loads", label: "Inward", count: data.loads.length },
          { key: "outward", label: "Outward", count: data.dispatches.length },
          { key: "sales", label: "Sales", count: data.sales.length },
          { key: "vendors", label: "Vendors", count: data.vendors.length },
          { key: "materials", label: "Materials", count: data.materials.length },
          { key: "users", label: "Users", count: data.users.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      <Card>
        {tab === "stock" && (
          <div className="aTableWrap">
            <table className="aTable">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Material</th>
                  <th>Type</th>
                  <th className="num">On Hand</th>
                  <th className="num">Sale Threshold</th>
                  <th>Visible</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.stock.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.icon} <b>{s.name}</b>
                      <div className="aTiny aMuted aMono">{s.code}</div>
                    </td>
                    <td className="aTiny">{s.materialName ?? "—"}</td>
                    <td>{s.isMixedBucket ? <Pill tone="warn">Mixed</Pill> : <Pill tone="role">Finished</Pill>}</td>
                    <td className="num">{num(s.quantityKg)}</td>
                    <td className="num">{s.isMixedBucket ? "—" : num(s.thresholdKg)}</td>
                    <td>{s.visible ? <Pill tone="ok">Yes</Pill> : <Pill tone="off">Hidden</Pill>}</td>
                    <td>
                      <div className="actions">
                        <button
                          className="aBtn sm"
                          onClick={() =>
                            setEdit({
                              entity: "sku",
                              id: s.id,
                              title: `Edit ${s.name}`,
                              subtitle:
                                "Quantity on hand is derived from the inventory ledger and is not editable here.",
                              fields: [
                                { name: "name", label: "SKU name", type: "text", required: true },
                                { name: "icon", label: "Icon", type: "text", hint: "A single emoji" },
                                {
                                  name: "saleThresholdKg",
                                  label: "Sale threshold (kg)",
                                  type: "number",
                                  min: 1,
                                  hint: "Ready-to-sell trigger",
                                },
                                { name: "visible", label: "Visible on the stock screen", type: "checkbox", wide: true },
                              ],
                              initial: s as unknown as Record<string, unknown>,
                            })
                          }
                        >
                          Edit
                        </button>
                        {/* The only sanctioned way to change a quantity: it
                            writes a STOCK_ADJUSTMENT ledger entry and reconciles
                            the batches, rather than editing inventory directly. */}
                        <button
                          className="aBtn sm"
                          onClick={() => {
                            setAdjust({ id: s.id, name: s.name, currentKg: s.quantityKg });
                            setAdjustKg(String(s.quantityKg));
                            setAdjustReason("");
                            setAdjustErr("");
                          }}
                        >
                          Adjust
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {data.stock.length === 0 && (
                  <tr>
                    <td colSpan={7}>
                      <EmptyState icon="📦" title="No SKUs configured" hint="This yard has no material tree yet, so it cannot receive a load. Create the yard again with starter materials, or add a material from the Owner app." />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "loads" && (
          <div className="aTableWrap">
            <table className="aTable">
              <thead>
                <tr>
                  <th>Lot</th>
                  <th>Vendor</th>
                  <th>Vehicle</th>
                  <th>Driver</th>
                  <th className="num">Kg</th>
                  <th>Status</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.loads.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <span className="aMono">
                        <b>{l.lotNumber}</b>
                      </span>
                      <div className="aTiny aMuted">
                        {l.materialLabel} · {l.weighments} weighments
                      </div>
                    </td>
                    <td className="aTiny">{l.vendorName}</td>
                    <td className="aTiny aMono">
                      {l.vehicleNumber ?? "—"}
                      {l.vehicleType && <div className="aMuted">{l.vehicleType}</div>}
                    </td>
                    <td className="aTiny">{l.driverName ?? "—"}</td>
                    <td className="num">{num(l.totalKg)}</td>
                    <td>
                      {l.status === "RECEIVED" ? <Pill tone="warn">Pending sort</Pill> : <Pill tone="ok">Segregated</Pill>}
                    </td>
                    <td className="aTiny aMuted">{when(l.createdAt)}</td>
                    <td>
                      <div className="actions">
                        <button
                          className="aBtn sm"
                          onClick={() =>
                            setEdit({
                              entity: "inwardLoad",
                              id: l.id,
                              title: `Edit lot ${l.lotNumber}`,
                              subtitle:
                                "Weight and lot number drive the inventory ledger and cannot be edited in place.",
                              fields: [
                                {
                                  name: "vendorId",
                                  label: "Vendor",
                                  type: "select",
                                  options: [
                                    { value: "", label: "Walk-in (no vendor)" },
                                    ...data.vendors.map((v) => ({ value: v.id, label: v.name })),
                                  ],
                                },
                                { name: "vehicleNumber", label: "Vehicle number", type: "text" },
                                { name: "vehicleType", label: "Vehicle type", type: "text" },
                                { name: "driverName", label: "Driver name", type: "text" },
                              ],
                              initial: l as unknown as Record<string, unknown>,
                            })
                          }
                        >
                          Edit
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {data.loads.length === 0 && (
                  <tr>
                    <td colSpan={8}>
                      <EmptyState icon="⚖️" title="No inward loads yet" hint="Loads appear here the moment the yard books one at the weighbridge." />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "outward" && (
          <div className="aTableWrap">
            <table className="aTable">
              <thead>
                <tr>
                  <th>Dispatch</th>
                  <th>Buyer &amp; invoice</th>
                  <th>Material</th>
                  <th>Vehicle</th>
                  <th>Driver</th>
                  <th className="num">Loaded</th>
                  <th className="num">Remaining</th>
                  <th>Status</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.dispatches.map((d) => {
                  const open = openDispatch === d.id;
                  const images = [d.frontImageUrl, d.backImageUrl, ...d.materialImages].filter(
                    (u): u is string => !!u
                  );
                  // A vehicle can satisfy several invoices, so the summary row
                  // names the first and counts the rest.
                  const first = d.lines[0];
                  const more = d.lines.length - 1;
                  const remaining = d.lines.reduce((a, l) => a + l.remainingKg, 0);
                  return (
                    <Fragment key={d.id}>
                      <tr>
                        <td>
                          <span className="aMono">
                            <b>{d.dispatchNumber}</b>
                          </span>
                          <div className="aTiny aMuted">
                            {d.lines.length} line{d.lines.length === 1 ? "" : "s"}
                            {d.dispatchedBy && ` · ${d.dispatchedBy}`}
                          </div>
                        </td>
                        <td className="aTiny">
                          {first?.buyerName ?? "—"}
                          {first && (
                            <div className="aMuted aMono">
                              {first.invoiceNumber}
                              {more > 0 && ` +${more}`}
                            </div>
                          )}
                        </td>
                        <td className="aTiny">
                          {first ? `${first.skuIcon} ${first.skuName}` : "—"}
                          {more > 0 && <div className="aMuted">+{more} more</div>}
                        </td>
                        <td className="aTiny aMono">
                          {d.vehicleNumber ?? "—"}
                          {d.vehicleType && <div className="aMuted">{d.vehicleType}</div>}
                        </td>
                        <td className="aTiny">{d.driverName ?? "—"}</td>
                        <td className="num">{num(d.totalKg)}</td>
                        <td className="num">{remaining > 0 ? num(remaining) : "—"}</td>
                        <td>
                          {remaining > 0 ? (
                            <Pill tone="warn">Partial</Pill>
                          ) : (
                            <Pill tone="ok">Completed</Pill>
                          )}
                        </td>
                        <td className="aTiny aMuted">{when(d.createdAt)}</td>
                        <td>
                          <div className="actions">
                            <button className="aBtn sm" onClick={() => setOpenDispatch(open ? null : d.id)}>
                              {open ? "Hide" : "Detail"}
                            </button>
                            <button
                              className="aBtn sm"
                              onClick={() =>
                                setEdit({
                                  entity: "outwardLoad",
                                  id: d.id,
                                  title: `Edit ${d.dispatchNumber}`,
                                  subtitle:
                                    "Dispatched weight and dispatch number drive the inventory ledger and the allocation balance, so they cannot be edited in place.",
                                  fields: [
                                    { name: "vehicleNumber", label: "Vehicle number", type: "text" },
                                    { name: "vehicleType", label: "Vehicle type", type: "text" },
                                    { name: "driverName", label: "Driver name", type: "text" },
                                  ],
                                  initial: d as unknown as Record<string, unknown>,
                                })
                              }
                            >
                              Edit
                            </button>
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={10}>
                            <div className="aSectionTitle">Allocations satisfied</div>
                            <table className="aTable">
                              <thead>
                                <tr>
                                  <th>Invoice</th>
                                  <th>Buyer</th>
                                  <th>Material</th>
                                  <th className="num">On this vehicle</th>
                                  <th className="num">Allocated</th>
                                  <th className="num">Dispatched</th>
                                  <th className="num">Remaining</th>
                                  <th>Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {d.lines.map((l) => (
                                  <tr key={l.id}>
                                    <td className="aTiny aMono">{l.invoiceNumber}</td>
                                    <td className="aTiny">{l.buyerName}</td>
                                    <td className="aTiny">
                                      {l.skuIcon} {l.skuName}
                                    </td>
                                    <td className="num">{num(l.quantityKg)}</td>
                                    <td className="num">{num(l.allocatedKg)}</td>
                                    <td className="num">{num(l.dispatchedKg)}</td>
                                    <td className="num">{l.remainingKg > 0 ? num(l.remainingKg) : "—"}</td>
                                    <td>
                                      {l.dispatchStatus === "COMPLETED" ? (
                                        <Pill tone="ok">Completed</Pill>
                                      ) : l.dispatchStatus === "PARTIAL" ? (
                                        <Pill tone="warn">Partial</Pill>
                                      ) : (
                                        <Pill tone="off">Pending</Pill>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>

                            <div className="aSectionTitle">Evidence</div>
                            {images.length > 0 ? (
                              <div className="aThumbs">
                                {images.map((u) => (
                                  /* eslint-disable-next-line @next/next/no-img-element */
                                  <a key={u} href={u} target="_blank" rel="noreferrer">
                                    <img src={u} alt="Dispatch photo" />
                                  </a>
                                ))}
                              </div>
                            ) : (
                              <div className="aTiny aMuted">
                                No photos captured for this dispatch.
                                {d.ocrConfidence !== null && ` Plate OCR confidence ${pct(d.ocrConfidence, 1)}%.`}
                              </div>
                            )}

                            <div className="aSectionTitle">Audit history</div>
                            {d.audit.length > 0 ? (
                              <table className="aTable">
                                <thead>
                                  <tr>
                                    <th>Action</th>
                                    <th>Actor</th>
                                    <th>Change</th>
                                    <th>When</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {d.audit.map((a) => (
                                    <tr key={a.id}>
                                      <td className="aTiny aMono">{a.action}</td>
                                      <td className="aTiny">{a.actorName}</td>
                                      <td className="aTiny aMuted">
                                        {a.before || a.after
                                          ? `${JSON.stringify(a.before ?? {})} → ${JSON.stringify(a.after ?? {})}`
                                          : "—"}
                                      </td>
                                      <td className="aTiny aMuted">{when(a.createdAt)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            ) : (
                              <div className="aTiny aMuted">
                                No edits since this vehicle was recorded. Creation itself is held in the inventory
                                ledger, not the audit log.
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {data.dispatches.length === 0 && (
                  <tr>
                    <td colSpan={10}>
                      <EmptyState
                        icon="🚛"
                        title="No dispatches yet"
                        hint="A sale allocates stock; a dispatch is the vehicle that carries it out. Rows appear here the moment a manager loads one."
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "sales" && (
          <div className="aTableWrap">
            <table className="aTable">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Buyer</th>
                  <th>SKU</th>
                  <th className="num">Kg</th>
                  <th className="num">Rate</th>
                  <th className="num">Total</th>
                  <th>Payment</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.sales.map((s) => (
                  <tr key={s.id}>
                    <td className="aMono">
                      <b>{s.invoiceNumber}</b>
                      {(s.vehicleNumber || s.driverName) && (
                        <div className="aTiny aMuted">{[s.vehicleNumber, s.driverName].filter(Boolean).join(" · ")}</div>
                      )}
                    </td>
                    <td className="aTiny">{s.buyerName}</td>
                    <td className="aTiny">{s.skuName}</td>
                    <td className="num">{num(s.quantityKg)}</td>
                    <td className="num">₹{s.ratePerKg}</td>
                    <td className="num">{inr(s.total)}</td>
                    <td>
                      {s.paymentStatus === "PAID" ? (
                        <Pill tone="ok">Paid</Pill>
                      ) : s.paymentStatus === "PARTIAL" ? (
                        <Pill tone="warn">Partial</Pill>
                      ) : (
                        <Pill tone="off">Pending</Pill>
                      )}
                    </td>
                    <td className="aTiny aMuted">{when(s.createdAt)}</td>
                    <td>
                      <div className="actions">
                        <button
                          className="aBtn sm"
                          onClick={() =>
                            setEdit({
                              entity: "sale",
                              id: s.id,
                              title: `Edit ${s.invoiceNumber}`,
                              subtitle:
                                "Quantity, rate and totals are ledger figures — correcting them needs a stock adjustment, not an edit.",
                              fields: [
                                { name: "vehicleNumber", label: "Vehicle number", type: "text" },
                                { name: "driverName", label: "Driver name", type: "text" },
                                { name: "driverPhone", label: "Driver phone", type: "text" },
                              ],
                              initial: s as unknown as Record<string, unknown>,
                            })
                          }
                        >
                          Edit
                        </button>
                        {s.receivableId && (
                          <button
                            className="aBtn sm"
                            onClick={() =>
                              setEdit({
                                entity: "receivable",
                                id: s.receivableId!,
                                title: `Payment · ${s.invoiceNumber}`,
                                subtitle: `${inr(s.total)} from ${s.buyerName}`,
                                fields: [
                                  {
                                    name: "status",
                                    label: "Payment status",
                                    type: "select",
                                    wide: true,
                                    options: [
                                      { value: "PENDING", label: "Pending" },
                                      { value: "PARTIAL", label: "Partial" },
                                      { value: "PAID", label: "Paid" },
                                    ],
                                  },
                                ],
                                initial: { status: s.paymentStatus },
                              })
                            }
                          >
                            Payment
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {data.sales.length === 0 && (
                  <tr>
                    <td colSpan={9}>
                      <EmptyState icon="🧾" title="No sales yet" hint="Invoices appear once the yard owner sells stock that has reached its sale threshold." />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "vendors" && (
          <div className="aTableWrap">
            <table className="aTable">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>GSTIN</th>
                  <th>Phone</th>
                  <th className="num">Loads</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.vendors.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <b>{v.name}</b>
                      {v.address && <div className="aTiny aMuted">{v.address}</div>}
                    </td>
                    <td className="aTiny aMono">{v.gstNumber ?? "—"}</td>
                    <td className="aTiny aMono">{v.phone ?? "—"}</td>
                    <td className="num">{num(v._count.loads)}</td>
                    <td>{v.active ? <Pill tone="ok">Active</Pill> : <Pill tone="off">Inactive</Pill>}</td>
                    <td>
                      <div className="actions">
                        <button
                          className="aBtn sm"
                          onClick={() =>
                            setEdit({
                              entity: "vendor",
                              id: v.id,
                              title: `Edit ${v.name}`,
                              fields: [
                                { name: "name", label: "Vendor name", type: "text", required: true },
                                { name: "gstNumber", label: "GSTIN", type: "text" },
                                { name: "phone", label: "Phone", type: "text" },
                                { name: "address", label: "Address", type: "text", wide: true },
                                { name: "active", label: "Active", type: "checkbox", wide: true },
                              ],
                              initial: v as unknown as Record<string, unknown>,
                            })
                          }
                        >
                          Edit
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {data.vendors.length === 0 && (
                  <tr>
                    <td colSpan={6}>
                      <EmptyState icon="🚚" title="No vendors yet" hint="The yard owner adds vendors from the Inward screen. Walk-in loads need no vendor." />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "materials" && (
          <div className="aTableWrap">
            <table className="aTable">
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Category</th>
                  <th className="num">SKUs</th>
                  <th className="num">Loads</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.materials.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <b>{m.name}</b>
                      <div className="aTiny aMuted aMono">{m.code}</div>
                    </td>
                    <td className="aTiny">{m.category ?? "—"}</td>
                    <td className="num">{num(m._count.skus)}</td>
                    <td className="num">{num(m._count.loads)}</td>
                    <td>{m.active ? <Pill tone="ok">Active</Pill> : <Pill tone="off">Inactive</Pill>}</td>
                    <td>
                      <div className="actions">
                        <button
                          className="aBtn sm"
                          onClick={() =>
                            setEdit({
                              entity: "material",
                              id: m.id,
                              title: `Edit ${m.name}`,
                              subtitle: "Material codes are referenced by history and are not editable.",
                              fields: [
                                { name: "name", label: "Material name", type: "text", required: true },
                                { name: "category", label: "Category", type: "text" },
                                { name: "active", label: "Active", type: "checkbox", wide: true },
                              ],
                              initial: m as unknown as Record<string, unknown>,
                            })
                          }
                        >
                          Edit
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {data.materials.length === 0 && (
                  <tr>
                    <td colSpan={6}>
                      <EmptyState icon="🧺" title="No materials configured" hint="Without a material and its mixed bucket, the yard cannot receive stock." />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "users" && (
          <>
            <div className="aTableWrap">
              <table className="aTable">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th className="num">XP</th>
                    <th className="num">Level</th>
                    <th className="num">Streak</th>
                    <th>Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <b>{u.name}</b>
                        <div className="aTiny aMuted">{u.email}</div>
                      </td>
                      <td>
                        <Pill tone="role">{u.role}</Pill>
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
                    </tr>
                  ))}
                  {data.users.length === 0 && (
                    <tr>
                      <td colSpan={7}>
                        <EmptyState icon="👤" title="No users assigned" hint="This yard has nobody who can operate it. Create an owner so sales can be raised." />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 14 }}>
              <Link className="aBtn sm" href={`/admin/users?yardId=${y.id}`}>
                Manage users in this yard →
              </Link>
            </div>
          </>
        )}
      </Card>

      {edit && (
        <RecordEditModal
          entity={edit.entity}
          id={edit.id}
          title={edit.title}
          subtitle={edit.subtitle}
          fields={edit.fields}
          initial={edit.initial}
          onClose={() => setEdit(null)}
          onSaved={saved}
        />
      )}

      {adjust && (
        <Modal
          title={`Adjust ${adjust.name}`}
          subtitle="Records a STOCK_ADJUSTMENT ledger entry and reconciles the stock batches. The reason is stored in the audit trail and cannot be left blank."
          onClose={() => setAdjust(null)}
        >
          {adjustErr && <div className="aErr">{adjustErr}</div>}
          <form
            className="aForm"
            onSubmit={(e) => {
              e.preventDefault();
              void submitAdjustment();
            }}
          >
            <Field label="Recorded now" hint="Derived from the inventory ledger">
              <input value={`${num(adjust.currentKg)} kg`} readOnly disabled />
            </Field>
            <Field
              label="Actual on the ground (kg)"
              hint="The counted figure, not the difference — the system works out the change."
            >
              <input
                value={adjustKg}
                onChange={(e) => setAdjustKg(e.target.value.replace(/[^0-9]/g, ""))}
                inputMode="numeric"
                required
              />
            </Field>
            <Field
              label="Reason"
              hint="At least 10 characters. This is the permanent explanation for the correction."
              wide
            >
              <textarea
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                rows={3}
                placeholder="Weighbridge recalibrated on 26 Jul; recount of bay 3 found 120 kg less than recorded."
                required
              />
            </Field>
            {adjustKg !== "" && Number(adjustKg) !== adjust.currentKg && (
              <div className="aTiny aMuted" style={{ gridColumn: "1 / -1" }}>
                Change: <b>{Number(adjustKg) > adjust.currentKg ? "+" : ""}{num(Number(adjustKg) - adjust.currentKg)} kg</b>
                {Number(adjustKg) > adjust.currentKg
                  ? " — a new untraced batch will carry the found stock."
                  : " — the oldest batches are consumed first, as a dispatch would."}
              </div>
            )}
            <div className="aFormActions">
              <button type="button" className="aBtn ghost" onClick={() => setAdjust(null)}>
                Cancel
              </button>
              <button
                type="submit"
                className="aBtn primary"
                disabled={
                  adjustBusy ||
                  adjustReason.trim().length < 10 ||
                  adjustKg === "" ||
                  Number(adjustKg) === adjust.currentKg
                }
              >
                {adjustBusy ? "Adjusting…" : "Record adjustment"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function Detail({ label, value, wide }: { label: string; value: string | null; wide?: boolean }) {
  return (
    <div className={`aField${wide ? " wide" : ""}`}>
      <label>{label}</label>
      <div style={{ fontSize: 13, padding: "4px 0" }}>{value || <span className="aMuted">Not set</span>}</div>
    </div>
  );
}
