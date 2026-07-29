# Scrap Flow · Veloce — Yard OS (multi-tenant SaaS)

A mobile-first, calculator-style scrap-dealer management platform. One company
operates many scrap yards across India; each yard runs the production
modules — **Stock, Inward, Sort, Sell, Outward** — with real auth, a Postgres database,
image uploads, ANPR/OCR, transactional inventory, invoice generation, and the
full gamified Veloce UI from the design prototype.

> The Owner/Manager UI is a faithful port of the approved HTML prototype (dark
> Veloce theme, phone frame, live-rates ticker, XP bar, LED keypad, celebration
> confetti) and must stay pixel-faithful. The Admin console is desktop-first and
> reuses the same design tokens, type and component vocabulary.

> **Project state lives in [`docs/PROJECT_PROGRESS.md`](docs/PROJECT_PROGRESS.md)** —
> completed phases and modules, locked business logic, verification milestones,
> known risks and the next continuation point. It is updated after every module
> or phase and is the single source of truth for where the build stands.

---

## Architecture

```
Super Admin (platform)
    │
    ├── Yard 1 (SFDY001) ── Owner ── Manager
    ├── Yard 2 ─────────── Owner ── Manager
    └── … thousands of yards
```

`Yard` is the tenant root. Every operational row carries a non-null `yardId`, and
all uniqueness that used to be global is scoped per yard, so two yards can each
own "MS Bazar" or lot `A-115` independently.

| Layer | Tech |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) · React 19 · TypeScript |
| Styling | Ported prototype CSS + Tailwind v4 · Poppins / JetBrains Mono |
| Data | PostgreSQL (Neon) · Prisma ORM |
| Auth | Auth.js v5 credentials · bcrypt · JWT carrying `role` + `yardId` |
| Tenancy | Prisma Client Extension closing over `yardId` (`src/lib/tenant.ts`) |
| Realtime | Server-Sent Events over an in-process bus (`src/lib/realtime.ts`) |
| State | TanStack Query · React context (XP/toast/celebration/realtime) |
| Storage | Vercel Blob (prod) · local `/public/uploads` (dev), yard-partitioned |
| ANPR/OCR | Python FastAPI · YOLOv8n + PaddleOCR (`/ocr-service`) |

### Tenant isolation — defence in depth

1. **Session** — `yardId` comes only from the signed JWT (or a signed
   impersonation cookie). It is *never* read from a body, query or header.
2. **Scoped Prisma client** — a per-request extension injects `where.yardId` on
   reads, sets `yardId` on creates, adds the yard predicate to single-record
   `update`/`delete` (extended where-unique, so a foreign id raises P2025), and
   post-filters `findUnique`. Fail-closed: an unhandled operation throws rather
   than widening scope.
3. **Explicit `yardId` on every write** — TypeScript enforces it; the extension
   is the backstop, not the only guard.
4. **Database** — per-yard composite uniques, yard-leading indexes, and `Restrict`
   foreign keys so a yard holding history cannot be deleted.

`ADMIN` uses the unscoped `adminDb` deliberately, and every admin mutation is
written to `AuditLog` with before/after values.

---

## Roles

| Capability | ADMIN | OWNER | MANAGER |
|---|:--:|:--:|:--:|
| Stock · Inward · Sort | ✅ any yard | ✅ own yard | ✅ own yard |
| **Sell / create sale** | ✅ any yard | ✅ | ❌ hidden |
| Reports · receivables | ✅ | ✅ | ❌ |
| Vendor / material writes | ✅ | ✅ | ❌ (read-only chips) |
| Create · edit · deactivate Yard | ✅ | ❌ | ❌ |
| Create users · reset passwords · reassign yards | ✅ | ❌ | ❌ |
| Edit existing records (any yard) | ✅ | ❌ | ❌ |
| Cross-yard analytics · audit log | ✅ | ❌ | ❌ |
| See another yard's data | ✅ | 🚫 never | 🚫 never |

The matrix lives in one place — `src/lib/permissions.ts` — and both the edge
middleware and the API guards derive from it, so they cannot drift apart.

---

## Local setup

```bash
npm install
cp .env.example .env          # DATABASE_URL + AUTH_SECRET (already set here)
npm run db:verify             # confirm tenancy integrity before anything else
npm run dev                   # http://localhost:3000
```

**Logins**

| Role | Email | Password | Lands on |
|---|---|---|---|
| Platform Admin | `admin@scrapflow.in` | `ScrapFlow@2026` | `/admin` (desktop console) |
| Owner (Yard 1) | `owner@veloce.in` | `owner123` | `/stock` (phone UI, 4 tabs) |
| Manager (Yard 1) | `manager@veloce.in` | `manager123` | `/stock` (phone UI, 3 tabs) |

---

## Database safety

This database holds a production baseline. The tooling is built to make
destructive mistakes hard:

| Command | What it does |
|---|---|
| `npm run db:backup` | Full logical JSON backup of every table → `backups/<timestamp>/` |
| `npm run db:diff` | Shows the SQL Prisma *would* run against the live schema |
| `npm run db:push` | **Guarded** push — computes the diff, refuses any `DROP`/`TRUNCATE`/`DELETE` |
| `npm run db:verify` | Read-only integrity check: orphans, cross-yard refs, uniqueness, ledger arithmetic |
| `npm run db:seed` | Idempotent, non-destructive. Never overwrites live stock/XP unless `--force-quantities` |
| `npm run db:reset` | Requires `--yard=<CODE> --confirm=<CODE> --yes`. No "all yards" mode exists |
| `npx tsx prisma/compare-baseline.ts <backupDir>` | Diffs Yard 1 against a backup, row by row |

`prisma/safe-push.ts` exists because `prisma db push` will silently drop columns
to make the database match `schema.prisma`. If the schema file ever drifts
*behind* the database, that is unrecoverable data loss — the guard catches it and
prints the offending SQL instead of running it.

`prisma/backfill-tenancy.ts` is historical (already applied) and excluded from
`tsconfig`. Do not run it again.

---

## Modules (Owner / Manager — unchanged)

- **Stock** — live SKU inventory, threshold meters, `READY TO SELL` badge,
  hide/show SKUs, per-vendor drill-down. Updates over realtime, no polling.
- **Inward** — vendor + material chips, LED keypad, multiple weighments, 3-step
  camera capture (vehicle front/back → ANPR plate → material images) gating
  `ADD WT`/`SAVE LOAD`. Saving creates a lot (`A-###`) and increments stock atomically.
- **Sort** — splits a pending mixed lot into finished SKUs + wastage with `+/−`
  steppers; blocked until remaining = 0, then applied in one transaction.
  Lots whose material has no sub-SKUs are shown as not-yet-sortable, not hidden.
- **Sell** (Owner only) — ready alerts, sale entry, sequential invoice
  (`INV-####`), **allocation** creation, receivable creation, invoice history.
  Since Phase 4 a sale *reserves* rather than deducts — see
  [Outward and dispatch](#outward-and-dispatch-phase-4).
- **Outward** (Manager only, Phase 4) — loads allocated material onto vehicles
  using the same chips, LED keypad, camera/OCR sheet and cart-then-commit rhythm
  as Inward. Capped by both the allocation balance and the physical stock.

Inward, Sort and Outward all offer a **KG / TON / TONNE** selector. The unit is a
display-and-entry concern only: `src/lib/units.ts` converts to kilograms before
anything reaches state, and **no ledger table ever stores a unit**.

Every stock mutation writes an `InventoryTransaction` ledger row and runs inside
a `prisma.$transaction`. Lot/invoice numbers use an atomic per-yard `Counter`
(`{yardId}:lot`), so concurrent writes never collide and yards never share a
sequence.

**Gamification** — XP (+5 weight, +50 load, +120 sort, +80 sale), level derived
from XP, streak, confetti. Persisted per user via `/api/xp`. An admin inspecting
a yard never accrues or alters that yard's XP.

---

## Admin console

Desktop-first, responsive, **no phone frame**. Activated by `data-shell="admin"`
on `<body>`, which the root layout renders from an `x-sf-shell` middleware header
— so the correct shell is server-rendered with no flash and no JS dependency.
Every rule in `src/styles/admin.css` is nested under that attribute, which is why
the Owner/Manager screens are untouched by its existence.

Sidebar navigation is grouped into three concerns — **Monitor** (Overview,
Analytics), **Manage** (Yards, Users), **Govern** (Audit Log) — so the console
reads as a hierarchy rather than a flat list.

- **Overview** (`/admin`) — headline KPIs, then *Needs attention* (alerts +
  pending actions), open admin sessions, the 30-day yard league table, and
  stock / sell / vendor / material / operations summaries, ending in tabbed
  recent activity. Backed by `/api/admin/dashboard` in one round trip.
- **Analytics** (`/admin/analytics`) — four sections (Overview, Yard comparison,
  Materials, Vendors) with a 7/30/90-day window and an all-yards-or-one scope
  selector. Backed by `/api/admin/analytics`.
- **Yards** — create (with the starter MS/PET/ALU material tree in one
  transaction), edit, deactivate/reactivate, Enter Yard.
- **Yard detail** — breadcrumbs, four KPIs, then a tab strip with per-tab counts
  over stock, inward, sales, vendors, materials and users, plus inline record
  editing.
- **Users** — role-count KPIs, search + yard/role filters, create Owner/Manager,
  edit, reassign yard, activate/deactivate, reset password.
- **Audit Log** — filterable, keyset-paginated trail with plain-English action
  labels beside the raw action string and before/after diffs, plus a second view
  listing every admin yard session with duration.

Loading states are skeletons shaped like the real content (so nothing jumps) and
every empty state explains itself and offers the next step — an empty screen must
never look like a broken screen.

### Alerts and pending actions

The dashboard computes these server-side rather than leaving an admin to notice
them: deactivated yards, **active yards with no owner** (nobody can sell there),
open admin impersonation sessions, yards with no sales for 7 days, lots awaiting
segregation with the oldest named, SKUs at their sale threshold, unpaid invoices,
and users stuck behind a forced password change. When nothing is wrong it says so
explicitly instead of rendering blank.

### Charts

**Hand-rolled inline SVG. No chart library, no CDN, no runtime dependency** —
the console must stay light and the pages run under a strict CSP. The suite
asserts that none of recharts/chart.js/d3/victory/nivo/apexcharts/echarts/
plotly/highcharts is present.

Primitives live in `src/components/admin/charts/` and are imported only through
its `index.ts`, so internals can move without touching a dashboard:

| Component | Used for |
|---|---|
| `LineChart` | sales trend, inward trend, throughput (in vs out) |
| `BarChart` | pending lots per yard, material volume ranking |
| `GroupedBarChart` | yard comparison (sales ₹ / inward kg / stock kg) |
| `StackedBarChart` | segregation: recovered vs wastage |
| `PieChart` / `DonutChart` | stock distribution, material mix, vendor share, collection status |
| `RankedBars` | vendor supply, stock by material, throughput ratio |
| `Sparkline` | dashboard 30-day trend strip |
| `ChartCard`, `Legend`, `EmptyChartState`, `LoadingChartState` | chrome and states |

`scale.ts` holds the pure geometry — `niceMax` (1/2/5 axis ladder), tick
spacing, band/line/area paths, arc maths, and `bucketBy` for weekly/monthly
roll-up. It has no React and no DOM, so it is unit-tested directly.

Decisions worth knowing:

- **Trend series are zero-filled per day.** A gap day renders as zero rather
  than being skipped — otherwise a line chart silently misreports the trend.
  Roll-up to weeks or months conserves the period total (asserted).
- **Bucketed in Asia/Kolkata**, so an 11pm IST sale belongs to that business day.
- **A full-circle slice is drawn as two arcs.** A single-category pie is one
  360° slice, and SVG cannot draw that with one arc command — start and end
  coincide, so it renders as nothing.
- **90-day windows default to weekly granularity**; 91 daily points on a 720px
  chart is unreadable.
- **Charts are `memo`-wrapped with geometry inside `useMemo`.** A realtime event
  landing on one card does not recompute paths anywhere else. The dashboard's
  trend strip is its own component for the same reason.
- **Zero timers and zero fetches inside chart components** (asserted). They are
  pure functions of their props; data arrives from the page.
- Each chart carries `role="img"` and a summarising `aria-label` — an SVG of
  unlabelled paths is otherwise silent to a screen reader.
- Under `@media (hover: none)` tooltips are hidden and hover-dimming is
  disabled, because neither works on a touch device.

Charts refresh through the existing SSE bus: `adminAnalytics` is in
`ADMIN_QUERY_KEYS`, so a yard-side write invalidates the query and the chart
re-renders. **No polling was introduced** — asserted against source, not the
bundle, since TanStack Query defines `refetchInterval` in its own code.

### Enter Yard (impersonation)

An admin can open any active yard in that yard's own mobile UI. The acting yard
lives in a signed, httpOnly cookie (`src/lib/impersonation.ts`) rather than the
auth JWT, so it expires and can be revoked independently of the login session.
Each session opens an `ImpersonationSession` row recording **admin, yard, start,
exit, duration and end reason**, plus `impersonation.enter`/`.exit` audit entries.
Only one session may be open per admin.

The yard's own Owner and Manager receive **no** signal: no realtime event is
published, no row they can read is written, the banner is rendered only for the
admin's own session, and the cookie is httpOnly.

### What an admin may edit — and what nothing may edit

`src/lib/admin-records.ts` whitelists editable fields per entity (vendor, buyer,
material, sku, inwardLoad, sale, receivable). Descriptive and administrative
fields are all editable, in any yard, fully audited.

Ledger-derived quantities are **refused with an explanation**:
`totalKg`, `kg`, `quantityKg`, `remainingKg`, `wastageKg`, `ratePerKg`,
`subtotal`, `gstAmount`, `total`, `amount`, `lotNumber`, `invoiceNumber`, `yardId`.
Those numbers are already reflected in `Inventory` running totals, `InventoryLot`
batch remainders and `InventoryTransaction` history; editing one column in place
would silently desynchronise the other three. Correcting a quantity is a business
event needing a compensating transaction, which is scoped as follow-on work — see
that file's header.

---

## Realtime

Server-Sent Events over an in-process pub/sub bus. Publishing happens **after**
the transaction commits, so a subscriber can never refetch pre-commit state.

- `GET /api/realtime/stream` — one yard, resolved from the session. There is no
  parameter to tamper with, so a client cannot subscribe to another yard.
- `GET /api/admin/realtime/stream` — ADMIN only; every yard, tagged with its
  `yardId`.

Clients use `useYardChannel()` / `useAdminRealtime()`; incoming events invalidate
the affected TanStack Query keys, so pages need no realtime code of their own.
Events carry `actorId` so a client skips its own echo.

**Swap point:** to move to Ably/Pusher/WebSockets, reimplement
`src/lib/realtime.ts` + the two stream routes + the two providers. No business
logic, route handler or component changes.

⚠️ The in-process bus assumes **one Node process**. Before running multiple
instances behind a load balancer, replace it with a real broker (Postgres
LISTEN/NOTIFY, Redis pub/sub, or a hosted provider) — subscribers on other
instances would otherwise miss events.

---

## API surface

### Yard-scoped (OWNER / MANAGER, or ADMIN inside an Enter Yard session)

| Method | Route | Access |
|---|---|---|
| GET | `/api/stock` · `/api/stock/:id/sources` | yard |
| PATCH | `/api/skus/:id/visibility` | owner |
| GET / POST | `/api/vendors` · `/api/vendors/:id` | GET yard · writes owner |
| GET / POST | `/api/materials` · `/api/materials/:id` | GET yard · writes owner |
| POST | `/api/inward/loads` | yard |
| POST | `/api/uploads` · `/api/ocr` | yard |
| GET / POST | `/api/sort/pending` · `/api/sort/complete` | yard |
| GET | `/api/sort-types` | yard (Manager read-only) |
| POST | `/api/sort-types` | owner |
| PATCH / DELETE | `/api/sort-types/:id` | owner (`?permanent=1` to erase) |
| GET | `/api/sell/ready` | owner |
| GET / POST | `/api/sales` | owner |
| GET | `/api/outward/queue` | manager |
| POST | `/api/outward/dispatch` | manager |
| POST | `/api/xp` | any |
| POST | `/api/account/password` | any (self) |
| GET | `/api/realtime/stream` | yard (SSE) |

### Platform (ADMIN only)

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/admin/dashboard` | everything the dashboard needs: KPIs, summaries, alerts, pending actions, recent activity |
| GET | `/api/admin/analytics` | trend/comparison/breakdown series (`?days=7\|30\|90&yardId=`) |
| GET | `/api/admin/overview` | cross-yard KPIs (grouped aggregates) |
| GET / POST | `/api/admin/yards` | list with rollups · create |
| GET / PATCH / DELETE | `/api/admin/yards/:id` | detail · edit · deactivate |
| GET / POST | `/api/admin/users` | list · create Owner/Manager |
| GET / PATCH | `/api/admin/users/:id` | detail · edit / reassign |
| POST | `/api/admin/users/:id/password` | reset (forces change) |
| PATCH | `/api/admin/records/:entity/:id` | edit any yard record |
| POST | `/api/admin/stock-adjustment` | the only sanctioned way to correct a quantity |
| GET / POST / DELETE | `/api/admin/impersonate` | current · enter · exit |
| GET | `/api/admin/impersonate/sessions` | who entered which yard, when, how long |
| GET | `/api/admin/audit` | keyset-paginated audit trail |
| GET | `/api/admin/realtime/stream` | platform SSE |

---

## Camera + ANPR workflow

Tap 📷 in the Inward keypad → capture front & back vehicle images → the front is
sent to `/api/ocr` → FastAPI (YOLOv8n + PaddleOCR) returns plate + confidence,
auto-filled and **editable** → capture material images → attach. **OCR is
assistive**: if the service is down or confidence is low, the flow degrades to
manual entry and is never blocked. See [`ocr-service/README.md`](ocr-service/README.md).

Stored images are yard-partitioned (`uploads/{yardId}/{date}/…`) so one yard's
assets can never be listed alongside another's.

---

## Tests

The suites write real data, so they run against a **disposable sandbox yard**
(`SFTEST01`), never Yard 1. `tests/fixtures.ts` creates, resets and purges it.

```bash
npm run build && npm run start     # tests exercise a running server
npm run test:all                   # resets the sandbox, runs everything, verifies integrity
```

| Command | Coverage |
|---|---|
| `npm run test:inward` | inward arithmetic + lot numbering (6) |
| `npm run test:inward-sort` | inward→sort handoff, new/existing vendor × material (24) |
| `npm run test:e2e` | full Owner+Manager workflow, 27 steps (35) |
| `npm run test:isolation` | two yards cannot see or touch each other; console closed to yard users; admin has no yard access until Enter Yard (56) |
| `npm run test:admin` | yard lifecycle, user guardrails, password reset flow, record editing, ledger protection, audit coverage (67) |
| `npm run test:realtime` | SSE delivery, cross-yard leak, auth on streams (18) |
| `npm run test:idempotency` | replayed + concurrent inward/sale writes, timezone-aware streak (44) |
| `npm run test:dashboard` | dashboard + analytics payload shape, figures reconciled against the DB, window/scope filters, reserved chart regions, ADMIN-only (163) |
| `npm run test:charts` | chart geometry (axes, paths, arcs, roll-up), shipped output, no chart library, empty-data safety, SSE propagation, CSS isolation (133) |
| `npm run test:prototype` | Yard 1 matches `scrapflow_veloce_v2-1.html` value by value (115) |
| `npm run test:ui` | CSS shell-scoping, phone frame intact, Manager has no SELL, admin console on every admin page, responsive containment (93) |
| `npm run test:responsive` | **real headless Chromium** at 390/768/1024/1440 — rendered overflow, clipping, card alignment, nav usability, chart scaling, typography floor, phone-UI isolation, admin yard detail across all seven tabs (592) |
| `npm run test:inward-multi` | multi-material load cart, per-line sorting, legacy-NULL loads (76) |
| `npm run test:outward` | allocation → dispatch, partial/complete status, over-dispatch refusal, FIFO lot consumption (71) |
| `npm run test:upload` | file-signature sniffing, size arithmetic before decode, SVG refusal, rate limiting (57) |
| `npm run test:admin-records` | every editable entity reachable, ledger fields refused, audit coverage (62) |
| `npm run test:admin-outward` | dashboard dispatch KPIs, analytics dispatch series, yard-detail Outward tab — all DB-derived (84) |
| `npm run test:units` | KG/TON/TONNE conversion, whole-kilogram guarantee, unknown-unit fallback (46) |
| `npm run test:sort-types` | sort-type CRUD, role boundaries, zero-reference delete rules, tenant isolation (68) |
| `npm run test:stock-adjust` | STOCK_ADJUSTMENT: mandatory reason, ledger entry, **lot reconciliation invariant**, admin-only (56) |
| `npm run test:ocr` | plate normalisation, positional repair, scoring (54, plain Python 3) |
| `npm run test:ocr-fallback` | `/api/ocr` against **real vehicle photographs** — graceful degradation, manual fallback preserved, SVG never processed (36) |
| `npm run test:ocr-supervisor` | auto-start with no manual command, health reporting, **automatic recovery** (kills the child to prove it) (25) |
| `npm run test:gamification` | XP, level ring, streak, profile popup (44) |
| `npm run db:verify` | orphans, cross-yard refs, per-yard uniqueness, inventory arithmetic |

`test:responsive` needs Playwright's browser once: `npx playwright install chromium`.
It writes evidence screenshots to `screenshots/` (gitignored) — 52 images covering
every page × viewport for Admin, Owner and Manager.

**Currently 2,024 assertions across 24 suites, all passing** (see
[`docs/PROJECT_PROGRESS.md`](docs/PROJECT_PROGRESS.md) for the running count — that
file is authoritative). The e2e suite is intentionally not idempotent (it sells
2000 kg), so `test:all` resets the sandbox before it runs.

⚠️ **A source edit plus a clean `tsc` does not mean the running server has your
change.** `npm run start` serves compiled output from `.next`, so every
HTTP-level verification must be preceded by `npm run build` and a restart. This
has cost real debugging time more than once — a route reported as broken turned
out to be a stale build. On Windows, stop the server before building: it holds
`query_engine-windows.dll.node` and `prisma generate` fails with `EPERM`.

⚠️ Assertions must never depend on their own run history. Two bugs of this shape
have been fixed: a test that PATCHed a constant value passed on the first run and
failed on the second (nothing changed, so nothing was audited), and several that
conflated "this suite didn't touch Yard 1" with "Yard 1 holds prototype values".
Derive expectations from the database, or vary the input per run.

⚠️ Two fixture rules learned the hard way, both now enforced in `tests/fixtures.ts`:
**never rewind a live counter** (`up` must not reset the lot sequence, or a
re-run collides with existing lot numbers), and **never use an hour offset as a
proxy for a calendar day** (26 hours is not reliably "yesterday" in a timezone —
build the IST day explicitly).

`test:dashboard`, `test:prototype` and `test:ui` are **read-only** and safe to run
against Yard 1 directly. `test:dashboard` derives its platform-wide expectations
from the database rather than hard-coding them, so it is correct whether or not
the sandbox yard exists.

Sandbox helpers: `npx tsx tests/fixtures.ts up|down|reset|purge|status`.

---

## Phase 3 — multi-material loads, OCR, gamification

**Multi-material loads.** Inward gained a **Load Cart** above `TOTAL LOAD`: each
`ADD TO LOAD` tap appends a material and weight, and only `SAVE LOAD` commits. The
schema addition is `InwardLoadLine` (one row per material on one vehicle), which
made Sort *line-aware* — a mixed load can now be segregated per line. Sort's
layout, components and styling were not touched.

**The legacy-NULL pattern.** An `InwardLoad` with no lines is a pre-feature row and
is read as single-material. This is used again in Phase 4 (`Sale.dispatchedKg ===
null`). The rule it encodes: **no historical row is ever rewritten to fit a new
feature** — the absence of data is itself the marker.

**Units.** `src/lib/units.ts` holds the KG/TON/TONNE table and `toKilograms`.
Inward, Outward and Sort all import it. TON is the US short ton (907 kg), *not* the
metric tonne (1000 kg) — conflating them would misreport every imported load by
~10%. Sort steps in the selected unit (±0.5 TONNE rather than ±50 kg), because
nudging a 20-tonne lot 50 kg at a time is unusable; KG stays the default because a
coarse unit cannot always land exactly on zero remaining.

**OCR improvements** (pipeline only — the UI is unchanged and manual editing is
never removed):
- front → rear → combined fallback
- positional repair by **minimum edit distance**, not first-valid-match; and it
  refuses to rewrite a read that is already a legal plate
- scoring both rewards a valid state code (+0.15) *and* penalises an invalid one
  (−0.25); a crisp fake state must not beat a blurred real one
- a read with no digits or no letters scores zero, so junk cannot win

**Gamification.** The level ring animates; clicking it **no longer signs out** — it
opens a profile popup (name, role, yard, owner, level, XP, XP-to-next, animated
bar, streak, achievements placeholder). Only the explicit **Sign Out** button
signs out.

---

## Outward and dispatch (Phase 4)

**The central rule: a sale reserves, a dispatch deducts.**

```
Sell  →  Sale (allocation)         stock unchanged, reserved += qty
Load  →  OutwardLoad + lines       stock -= loaded, FIFO lots consumed
         dispatchStatus: PENDING → PARTIAL → COMPLETED
```

`sellable = physical − reserved`. `src/lib/allocation.ts` is the shared vocabulary
(`remainingKg`, `dispatchStatusFor`, `reservedKg`, `sellableKg`, `validateDispatch`)
and is pure, so the rule is testable without a database. **`dispatchStatus` is
always derived from the quantities, never trusted from the stored column.**

- **Manager Outward** is the Inward workflow: same chips, LED, keypad, camera, OCR,
  gamification and idempotency key, plus a material selector and
  remaining/loaded/balance indicators. Loading beyond the allocation is refused.
- One vehicle may satisfy **several invoices** — `OutwardLoadLine` points at both
  the sale and the SKU, so every dispatched kilogram is attributable to the invoice
  it pays.
- `/api/outward/dispatch` validates **every** line before writing anything, so a
  vehicle is never half-recorded.
- **Owner Sell** shows dispatch status (Pending / Partial / Completed) with
  drill-down: vehicles, driver, plate, photos, weight loaded, remaining, and the
  dispatch history with timestamps and the manager who did it.
- Dispatch is deliberately **not** an Owner capability: the Owner sells, the Manager
  loads. This also keeps the Owner's bottom nav at the prototype's four tabs — a
  fifth tab was added by mistake once and caught by the browser suite.

**Admin visibility** (Phase 5 Module 2): dispatch KPIs and an `awaitingDispatchKg`
tile on the dashboard, a **Dispatch** section in Analytics (trend, volume, status
distribution, by material, by buyer, by yard), and an **Outward** tab on yard detail
showing each vehicle's allocations, evidence photos and audit history.

---

## Analytics and charts

Everything is **hand-built inline SVG** — no chart library, no CDN, no runtime
dependency. `src/components/admin/charts.tsx` provides `LineChart`, `BarChart`,
`GroupedBarChart`, `StackedBarChart`, `DonutChart`, `RankedBars`, `Legend` and
`ChartCard`, plus `bucketBy` / `bucketLabel` for day/week/month granularity.

Trends are computed in Postgres with `date_trunc` and **zero-filled** in
`Asia/Kolkata`, because:

- fetching every row to bucket in JS is unbounded as the platform grows;
- a gap day must render as **zero, not be skipped**, or the line lies about the trend;
- a sale booked at 11pm IST belongs to that business day, not the next UTC one.

By-material and by-buyer breakdowns group on the SKU **name** and join through the
sale, because the same material exists as a separate row per yard — grouping on
`skuId` would split one material across yards and read as several materials.

---

## Upload security and rate limiting (Phase 5 Module 1)

`src/lib/image-validate.ts`:

- **size is checked arithmetically before decoding** — decoding first to measure
  the payload *is* the abuse;
- stray non-base64 characters are rejected **before** decode, because
  `Buffer.from` silently skips them, which would smuggle bytes past that arithmetic;
- format comes from the **file signature** (magic number), never a client-supplied
  MIME type or extension; only JPEG/PNG/WebP pass, and **SVG is refused outright**
  (it is a script container, not an image);
- `storeImage` takes verified `Buffer` bytes plus a detected format, so an unverified
  data URL cannot reach storage.

`src/lib/rate-limit.ts` is a fixed-window in-process limiter — the same
single-process assumption as the SSE bus. Auth deliberately has the **loosest**
per-IP budget (60/min): a yard office behind one NAT address would otherwise lock
itself out at shift change. Per-account lockout belongs in Auth.js `authorize()`
and is **not built yet**.

---

## Sort types (Phase 5 Module 4)

A **sort type** *is* a non-mixed `Sku` under a `Material`: "Mixed MS" is the inward
bucket; "MS Sheet" and "MS Rod" are its sort types. There is deliberately no
separate table — a second tree would mean reconciling every finished kilogram
across both, and the segregation run already writes into SKU inventory.

Owner and Admin have full CRUD; **Manager is read-only**, because changing the tree
changes what every future run can produce. Deactivation is `Sku.visible = false`:
history and stock stay intact, the type simply stops being offered.

Permanent delete follows the same rules as Materials, and they are **shared, not
restated** — `src/lib/sku-references.ts` counts every table that can hold a `skuId`
so a refusal can name what is holding the row. Adding a table that references `Sku`
means adding it there; the count *is* the contract. (Extracting this found a real
gap: the material path was not counting `OutwardLoadLine`, so a material whose SKU
had been dispatched could previously be erased.)

---

## Stock adjustment (Phase 5 Module 5)

`POST /api/admin/stock-adjustment` — **the only sanctioned way to change a quantity
after the fact.** Admin only, mandatory reason (≥10 characters), actor recorded,
one transaction.

Every other quantity is derived, but physical yards drift: a weighbridge
miscalibrates, a bag splits, someone keys 1200 for 120. Without this the only
remedy is editing `Inventory` directly, which leaves the ledger disagreeing with
the stock it is supposed to explain. **So a correction is itself a ledger entry**,
typed `STOCK_ADJUSTMENT` so it is never mistaken for trade in any report.

`db:verify` asserts `Inventory.quantityKg === Σ InventoryLot.remainingKg` per SKU,
so an adjustment reconciles **both** sides:

- **increase** → a new lot carries the added kilograms (no vendor, no source load:
  the origin is genuinely unknown, and inventing one would be worse);
- **decrease** → FIFO-consume existing lots, exactly as a dispatch does.

If the batches cannot cover a decrease, the whole transaction rolls back with
`LOT_SHORTFALL` rather than leaving the database failing its own audit. The API
takes the **absolute** counted figure rather than a delta: an operator reads a
number off a scale, and asking for the difference invites arithmetic mistakes in
exactly the situation where the existing number is already known to be wrong.

---

## What the record editor will not touch

`src/lib/admin-records.ts` lets an admin correct clerical fields on any yard
record — vendor, buyer, material, sku, inwardLoad, **outwardLoad**, sale,
receivable. `LEDGER_FIELDS` are refused with `422 LEDGER_PROTECTED`: `totalKg`,
`quantityKg`, `dispatchedKg`, `dispatchStatus`, `dispatchNumber`, `lotNumber`,
`invoiceNumber`, `remainingKg` and the rest. Those are ledger-derived; changing one
in place would leave the transaction history unable to explain the balance.
Quantities change through a **stock adjustment**, which is auditable.

⚠️ `/api/admin/records/:entity/:id` answers **404 for both** `BAD_ENTITY` and
`NOT_FOUND`. Always read `error.code`, never the bare status — misreading this once
led to a working feature being reported as broken.

---

## Known risks

1. **The stale-build trap** (above). Documented, not enforced by tooling.
2. **Rate limiting and the SSE bus are per-process.** Both need a shared store
   (Redis/Upstash) before running more than one instance.
3. **No per-account auth lockout** — only per-IP.
4. **No migration history.** Schema changes have used guarded `db:push` because no
   `DIRECT_URL` is configured. A migration baseline is needed before production.
4a. **OCR accuracy is measurable but not yet quantified.** The service now starts
   itself (see below) and returns normalised, plausible plates from real
   photographs. What is missing is **ground truth**: the 74 front + 74 rear images
   in `public/uploads/**` are unlabelled, so accuracy / detection / recognition
   rates and false-positive counts cannot be computed. Labelling that corpus is
   the prerequisite for any accuracy claim. Also, `license_plate_detector.pt` is
   absent, so plate localisation uses the classical-morphology fallback — sourcing
   that weight is the single biggest accuracy lever available.

## OCR runs itself

`npm run start` is the only command. `src/lib/ocr-supervisor.ts` (invoked from
`src/instrumentation.ts`) spawns the Python ANPR service, health-checks it,
restarts it on crash and reports its state to the admin dashboard. It adopts an
already-listening service instead of spawning a rival, backs off up to 2 minutes
so a broken install is never hammered, and takes the child down with the app so a
restart cannot leak a model process. `OCR_AUTOSTART=0` disables spawning (use that
when OCR runs as its own service); `OCR_PYTHON` points at a specific interpreter.

Supervisor state lives on `globalThis`, not module scope — Next.js does not
guarantee the instrumentation hook and a route handler share a module instance,
and assuming they did made the route report "not initialised" while the service
was healthy.

**OCR never blocks a yard.** A request waits up to 8s for a service that is still
loading, then falls back to manual entry. Every failure path returns
`fallback: true` with a reason.
5. **Yard 1 has known drift** from the prototype values (lot A-115 was saved
   through the app). `test:prototype` is deliberately left strict and failing on
   those rows — detecting drift is its job. Remediation is deferred by explicit
   project decision; **Yard 1 is frozen: never reseed, restore, purge or modify.**

---

## Deployment

**Not deployed yet — local only** by current project decision. The runbook is ready:
see **[`DEPLOYMENT.md`](DEPLOYMENT.md)** for environment variables, build, migrations,
backup/restore, OCR deployment, health checks, monitoring, rollback, scaling and
troubleshooting.

Summary: **App → Vercel** — `vercel.json` runs
`prisma generate && prisma migrate deploy && next build`, so a deploy applies pending
migrations before the new code goes live. **DB → Neon**, one database, two endpoints
(`DATABASE_URL` pooled, `DIRECT_URL` unpooled). **OCR → co-located sidecar**, started
and supervised by the Node process; `ocr-service/Dockerfile` remains for a separate
host if wanted. Multi-instance is safe — realtime, rate limiting and login lockout all
use shared Postgres state.

## Migrations

**One database, two endpoints.** `DATABASE_URL` is Neon's pooled endpoint and
remains the only URL the running application uses for queries. `DIRECT_URL` is the
same database and credentials on the **unpooled** host (identical string without
`-pooler`), declared as `directUrl` in the datasource. `prisma migrate` needs it
because PgBouncer transaction pooling cannot hold the session advisory lock a
migration takes.

```bash
npm run db:migrate          # create + apply a migration in development
npm run db:deploy           # apply pending migrations (what the build runs)
npm run db:migrate-status   # what is applied
npm run db:drift            # empty output means schema matches the database
```

`prisma/migrations/0_init` is the baseline: generated with `migrate diff
--from-empty`, then adopted with `migrate resolve --applied`, which only records
the migration — **no DDL ran against the existing database and no row was
touched**. The deploy command is now `prisma migrate deploy`, not `db push`.

Roll back by applying a compensating migration, never by editing history. Check
`npm run db:drift` before writing a migration by hand; `npm run db:push`
(guarded, `prisma/safe-push.ts`) remains for local experiments only.

---

## Not in scope yet (frozen)

Finance dashboard, GST filing, E-Way API, labor/wages, transporter management,
bank reconciliation, refurbishment, offline write-queue, compensating stock
adjustments for quantity corrections, reserve-at-sale/finalize-at-dispatch
inventory. The schema, permission matrix and realtime abstraction are built to
extend into these without redesign.
#   s c r a p - f l o w - v e l o c e  
 