# Decision required — multi-instance readiness

**Status:** blocked pending your approval. Nothing has been changed.
**Date:** 2026-07-26

Priority 4 asked me to determine whether multi-instance support can be completed
on the existing PostgreSQL infrastructure, implement it if so, and stop and
document if not. The answer is **partly** — one of the three pieces can, two
cannot — so this document exists rather than a silent architecture change.

---

## What "multi-instance" needs, piece by piece

### 1 · Shared rate limiting — **CAN be done on the existing database**

`src/backend/http/rate-limit.ts` holds fixed-window counters in a process-local `Map`. Two
instances therefore grant two separate budgets, so the effective limit is
`configured × instances`.

A fixed-window counter is a single atomic `INSERT … ON CONFLICT DO UPDATE
… RETURNING count`. That needs no pub/sub, no listener, no session state, and
works perfectly over the pooled connection string already configured. Cost is one
extra round trip on rate-limited endpoints only (`/api/uploads`, `/api/ocr`, the
credentials callback).

**This is implementable today with no decision from you.** I did not implement it
because it would leave the realtime half inconsistent, and because it needs a
schema migration — which is itself blocked (see §3).

### 2 · Shared realtime event bus — **CANNOT, on the current connection**

`src/backend/realtime/realtime.ts` is an in-process pub/sub. An SSE client connected to
instance A never receives an event published on instance B, so a yard would see
stale stock with no error and no indication anything was wrong. **This is the
actual production blocker.** It is also the failure mode most likely to be
mistaken for a data bug.

Three candidate mechanisms, each blocked by a standing project rule:

| Mechanism | Blocked by |
|---|---|
| Postgres `LISTEN` / `NOTIFY` | Neon's pooled endpoint is PgBouncer in **transaction** pooling mode, which cannot hold a session-scoped `LISTEN`. No `DIRECT_URL` is configured, so no unpooled connection exists. |
| Postgres event table | Reading it requires polling. *"No polling"* is an explicit requirement, and SSE latency would become the poll interval. |
| Redis / Upstash / Ably | *"Use the existing DATABASE_URL only. Do not introduce another datasource."* |

### 3 · Production migrations (Priority 5) — **CANNOT, same root cause**

`prisma migrate` requires a direct, unpooled connection. `vercel.json` currently
runs `prisma db push` at build time, which has no history and no rollback. I will
not fabricate a migration directory that has never been applied — that would look
like safety while providing none.

### 4 · OCR supervision — **already multi-instance safe**

`src/backend/ocr/ocr-supervisor.ts` adopts a service that is already answering rather than
spawning a rival, so N instances on one host converge on one model process. For
instances on separate hosts, run OCR as its own service and set
`OCR_AUTOSTART=0`. No change needed.

---

## The options

### Option A — configure `DIRECT_URL` (recommended)

Add Neon's **unpooled** connection string as `DIRECT_URL`, and declare it in
`prisma/schema.prisma` as `directUrl`.

- **Unblocks realtime** via `LISTEN`/`NOTIFY` — genuinely push-based, no polling.
- **Unblocks migrations** — the same variable is what `prisma migrate` needs.
- **No new vendor, no new datasource.** Same database, second endpoint.
- Application queries keep using the pooled URL; only the listener and the
  migration tool use the direct one.
- Trade-off: one long-lived connection per instance against Neon's direct
  connection limit. At single-digit instance counts this is not a concern.
- **Cost: one environment variable.** This is the smallest change that removes
  both blockers.

### Option B — Redis / Upstash

- Standard, well-understood, best raw latency; Upstash is serverless-friendly.
- Requires overriding your "existing DATABASE_URL only" rule, adds a vendor, a
  second failure domain and a second secret to rotate.
- Does **not** solve migrations — you would still need `DIRECT_URL` for Priority 5.

### Option C — stay single-instance

- Zero work. Everything currently passing stays passing.
- Must be **enforced**, not assumed: pin `maxInstances: 1` (or the platform
  equivalent) in the deploy config, or the failure appears silently under load —
  exactly when you can least afford to debug it.
- Caps throughput and gives no failover.

---

## Recommendation

**Option A.** One environment variable unblocks both this and Priority 5, keeps
you on a single datasource, and needs no new vendor. Options B and C both leave
migrations unsolved.

If you choose A, the implementation order is:

1. Add `DIRECT_URL` to `.env`; add `directUrl = env("DIRECT_URL")` to the
   `datasource` block.
2. Baseline migrations — `prisma migrate diff --from-empty
   --to-schema-datamodel prisma/schema.prisma` into
   `prisma/migrations/0_init/migration.sql`, then `prisma migrate resolve
   --applied 0_init` to adopt the existing database **without touching data**.
   Remove `db push` from `vercel.json`.
3. Postgres-backed rate limiting (§1) — now that migrations exist.
4. `LISTEN`/`NOTIFY` behind the existing `publish()` / `subscribe()` interface in
   `src/backend/realtime/realtime.ts`. **The interface must not change** — the channel→queryKey
   invalidation table and every call site stay as they are, so this is a swap of
   the transport only, and `test:realtime` (18) plus `test:isolation` (59) remain
   the regression gate.
5. Verify with two instances on different ports: publish on one, assert the SSE
   client on the other receives it.

Until you decide, the honest deployment posture is **Option C, enforced** —
single instance, pinned in config.
