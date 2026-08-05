# Deployment — Scrap Flow · Veloce

Operational runbook. Architecture and feature state live in
[`docs/PROJECT_PROGRESS.md`](docs/PROJECT_PROGRESS.md); this file is only what you
need to ship, verify, and recover.

**One PostgreSQL database. No Redis. No second datasource.** Everything below assumes
that and depends on it.

---

## 1. Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | **yes** | Neon **pooled** endpoint (host contains `-pooler`). Every application query. |
| `DIRECT_URL` | **yes** | Neon **unpooled** endpoint — *same database, same credentials*, host without `-pooler`. |
| `AUTH_SECRET` | **yes** | Auth.js JWT signing key. 32+ random bytes. |
| `NEXTAUTH_SECRET` | **yes** | Same value as `AUTH_SECRET`. |
| `NEXTAUTH_URL` | **yes** | Public origin, e.g. `https://yard.example.com`. |
| `BLOB_READ_WRITE_TOKEN` | prod | Vercel Blob token for weighbridge photo storage. |
| `OCR_SERVICE_URL` | prod | Where the ANPR sidecar listens. `http://localhost:8000` when co-located. |
| `OCR_SERVICE_SECRET` | prod | Shared secret between the app and the sidecar. **Change it.** |
| `OCR_AUTOSTART` | no | `0` disables the supervisor spawning the sidecar. |
| `OCR_PYTHON` | no | Interpreter to use, if not `python` on `PATH`. |
| `YOLO_MODEL` / `VEHICLE_MODEL` | no | Override the weight filenames. |
| `OCR_SKIP_MODEL_FETCH` | no | `1` never downloads a weight; use what is on disk. |
| `OCR_PLATE_MODEL_URL` / `OCR_PLATE_MODEL_SHA256` | no | Pin a different plate detector (e.g. an internal mirror, or a weight fine-tuned on your cameras). Both must be set together — the hash is enforced. |
| `OCR_MODEL_FETCH_TIMEOUT` | no | Seconds to wait for the weight fetch. Default `180`. |
| `LOGIN_LOCKOUT` | no | `0` disables per-account lockout (load tests only). |
| `LOGIN_LOCKOUT_THRESHOLD` | no | Consecutive failures before a lock. Default `5`. |
| `LOGIN_LOCKOUT_BASE_SECONDS` | no | First lock duration; doubles per prior lock. Default `60`. |
| `LOGIN_LOCKOUT_MAX_SECONDS` | no | Lock ceiling, so auto-unlock always arrives. Default `3600`. |
| `LOGIN_LOCKOUT_DECAY_SECONDS` | no | Idle window after which the failure streak resets. Default `900`. |
| `SF_REALTIME_PG` | no | `0` disables cross-instance realtime (degrades to per-instance). |

### Why two URLs for one database

`DATABASE_URL` is Neon's PgBouncer endpoint in **transaction** pooling mode. Two
things cannot work through it, both because they need a session they can hold:

- `prisma migrate` — takes an advisory lock for the duration of the migration;
- `LISTEN` — the cross-instance realtime bus; the subscription *is* session state,
  and transaction pooling would silently discard it.

So `DIRECT_URL` exists. It is not a second database and must never point at one.
Getting this wrong does not fail loudly: migrations hang, and realtime quietly
degrades to same-instance delivery.

### Pool tuning

`DATABASE_URL` carries `connection_limit=30&pool_timeout=20`. The admin dashboard
issues ~29 independent queries in one batch; at ~85 ms per round trip, a smaller pool
splits that into several serial waves. Do not lower it without re-measuring
`/api/admin/dashboard`.

---

## 2. Build

```bash
npm ci
npx prisma generate
npx prisma migrate deploy     # uses DIRECT_URL
npm run build
npm run start
```

On Vercel this is already wired — `vercel.json` sets
`buildCommand: "prisma generate && prisma migrate deploy && next build"`, so a deploy
applies pending migrations before the new code goes live.

`npm run build` alone runs `prisma generate && next build` and does **not** migrate.
That is deliberate: local builds must not touch the database.

**Windows:** stop the running server before building. `prisma generate` cannot
replace `query_engine-windows.dll.node` while a node process holds it (`EPERM`).

---

## 3. Migrations

```bash
npm run db:migrate-status   # what is applied, what is pending
npm run db:migrate          # author a new migration (development)
npm run db:deploy           # apply pending migrations (production)
npm run db:drift            # SQL diff: live database vs schema.prisma
```

Rules:

- **`prisma migrate deploy` is the only way schema changes reach production.**
  `db push` is retired.
- `npm run db:push` is a guarded wrapper (`prisma/safe-push.ts`) that refuses any
  destructive diff. Kept for emergencies; not part of deployment.
- **Never** `prisma migrate reset` or `db:reset` against production. They drop data.
- Run `npm run db:drift` before authoring a migration. An empty diff means
  `schema.prisma` describes the live database; a non-empty one means someone changed
  the database out of band and you must reconcile *before* adding to the history.
- After any migration: `npm run db:verify`.

---

## 4. Backup and restore

```bash
npm run db:backup                 # → backups/<timestamp>/
npm run db:backup -- /path/to/dir
```

A logical JSON dump of every table in `public`, read via `information_schema` rather
than the Prisma models — so it captures the database as it *actually is*, even when
`schema.prisma` has drifted. **Take one before every migration.**

For a byte-exact copy, use Neon's own facilities: a branch (instant, copy-on-write)
or `pg_dump` against `DIRECT_URL`. A Neon branch taken immediately before a deploy is
the cheapest rollback point available and is the recommended pre-migration step.

There is no `db:restore`. Restoring is a deliberate, supervised act: create a Neon
branch from the relevant point in time and repoint `DATABASE_URL`/`DIRECT_URL` at it.

---

## 5. OCR sidecar

The FastAPI ANPR service is **supervised by the Node process** — `npm run start` is
the whole story. `src/instrumentation.ts` starts the supervisor, which spawns
`python -m uvicorn main:app --host 127.0.0.1 --port 8000` with `cwd: ocr-service`,
health-checks it every 15 s, and restarts it with exponential backoff. An
already-listening service is adopted rather than duplicated.

Requirements on the host: Python 3.10+ with `ocr-service/requirements.txt`
installed. Nothing else. No Docker, no manual terminal.

```bash
pip install -r ocr-service/requirements.txt
```

**Model weights** go in `ocr-service/models/`:

- `yolov8n.pt` — vehicle localisation. Auto-downloaded by ultralytics on first use.
- `license_plate_detector.pt` — dedicated plate detector, **acquired automatically.**
  `run.py` calls `bootstrap_models.ensure_plate_model()` before uvicorn binds: it
  fetches the pinned weight, verifies a pinned SHA-256, and writes it atomically.
  Idempotent (~0.15 s once present) and **never fatal** — an offline, proxied or
  rate-limited host logs one line and starts with classical morphology instead.

  There is **nothing to place by hand.** To pin your own weight (e.g. one fine-tuned
  on your yard's cameras) set `OCR_PLATE_MODEL_URL` and `OCR_PLATE_MODEL_SHA256`, or
  set `OCR_SKIP_MODEL_FETCH=1` and manage `models/` yourself. The loaders also
  re-check on every request while unloaded, so a weight that arrives later is picked
  up with no restart.

  Confirm with `/health`: **`detector` must be `true`.** `status: ok` is returned in
  the degraded morphology mode too, so `status` alone tells you nothing about
  whether the trained detector is live.

If Python is missing, or the sidecar cannot start, the app still works: OCR returns
`fallback: true` and the operator types the plate. OCR is assistive and never blocks
the yard.

```bash
curl http://localhost:8000/health      # detector / vehicle_detector / ocr, models_dir
```

---

## 6. Health checks

| Check | What it proves |
|---|---|
| `GET /login` → 200 | The app is serving. |
| `GET /api/admin/ocr-status` (admin) | Supervisor state, restart count, last healthy time. |
| `GET http://<sidecar>/health` | Which OCR components loaded, and whether the plate weight was found. |
| `GET /api/realtime/stats` (any in-yard role) | `crossInstance.connected` must be `true` and `usingDirectUrl` must be `true`. |
| `GET /api/admin/login-locks` (admin) | Currently locked accounts; a high `lockCount` means one account is being targeted. |
| `npm run db:verify` | Tenant invariants + `Inventory.quantityKg === Σ InventoryLot.remainingKg` per SKU. |

**Post-deploy smoke sequence:** `/login` 200 → sign in → `/api/realtime/stats` shows
`crossInstance.connected: true` → `/api/admin/ocr-status` reports `ready` (or a stated
reason) → `npm run db:verify` passes.

---

## 7. Monitoring

Watch these, in priority order:

1. **`crossInstance.connected === false`** on any instance — realtime has degraded to
   same-instance delivery. Users see stale stock with no error. Silent by nature; this
   is the one that needs an alert.
2. **`/api/admin/ocr-status` restart count climbing** — the sidecar is crash-looping.
   Operators fall back to manual entry, so it is not an outage, but it is a regression.
3. **`attempts` in the `/api/ocr` response rising over time** — the pipeline is working
   harder for the same plates. In practice this means camera placement or lighting has
   drifted, not that the code changed.
4. **`LOGIN_LOCKED` audit entries** — credential-stuffing signal. Cross-check
   `/api/admin/login-locks`.
5. **`RateLimitCounter` row growth** — call `sweepSharedRateLimits()` if dead windows
   accumulate. Harmless, but unbounded.
6. **`/api/admin/dashboard` latency** — the canary for connection-pool problems.
   Expect ~330 ms. A jump to >1 s means duplicate Prisma pools or a shrunken
   `connection_limit`.
7. **Process RSS.** Expect ~105 MB idle and ~155 MB under load. **Alert on sustained
   growth.** During the final audit one server died with a JS heap OOM after a flood of
   `Error in PostgreSQL connection: Error { kind: Closed }`; it could not be reproduced
   (a fresh server stayed flat through the heaviest available workloads), but it
   happened once and is unexplained. If it recurs, **lower `connection_limit` first** —
   30 idle pooled connections being re-established is the prime suspect — and expect
   the dashboard to move from ~320 ms to ~400–500 ms, still inside target. Do not
   raise `--max-old-space-size` instead: that hides the signal.

Every mutation is written to `AuditLog` with actor, yard, before/after and IP.
`/admin/audit` is the operational view.

---

## 8. Rollback

Code and schema roll back separately. **Decide whether the schema changed.**

**No schema change** — redeploy the previous build (Vercel: promote the previous
deployment). Nothing else to do.

**Schema changed** — additive migrations (new tables/columns) are safe to leave in
place; the old code simply ignores them. Roll back the code only. This is the normal
case and the reason migrations should be written additively.

**Schema changed destructively** — do not attempt to reverse it with SQL under
pressure. Restore from the Neon branch taken before the deploy, then redeploy the
previous build. This is why §4 says to take the branch first.

Never run `prisma migrate reset` as part of a rollback. It is not a rollback; it drops
every row.

---

## 9. Scaling

Multi-instance safe as of 2026-07-26. What makes that true, and what to preserve:

- **Realtime** is Postgres `LISTEN`/`NOTIFY` (`src/lib/realtime-pg.ts`), so an event
  published on one instance reaches subscribers on every other. Verified live across
  two instances (`npm run test:realtime-multi`). The listener needs `DIRECT_URL`.
- **Rate limiting** for upload and OCR is a shared counter in `RateLimitCounter`, so
  the budget is the configured limit — not `limit × instances`. The Edge middleware's
  per-IP auth limiter stays in-process by design (Prisma cannot run on the Edge
  runtime); per-account lockout in `LoginAttempt` is the shared protection there.
- **Login lockout** is shared state, so an attacker does not get one budget per
  instance.
- **`PrismaClient` is pinned on `globalThis`** in every environment. Unpinning it in
  production creates a second client with its own pool.
- **The OCR supervisor** binds `127.0.0.1`. Each instance supervises its own sidecar
  and adopts an already-listening one, so co-located instances share it.

Scaling *up* the database matters more than scaling out the app: on Neon, query
latency is round-trip-dominated, so deploy the app in the same region as the database.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `prisma migrate` hangs | `DIRECT_URL` points at the pooled host | Remove `-pooler` from the host. |
| Realtime works in one browser, not another | `crossInstance` is null — the LISTEN connection never opened | Check `DIRECT_URL` and `/api/realtime/stats`. |
| `EPERM … query_engine-windows.dll.node` | A node process is holding the engine | Stop the server, then `prisma generate`. |
| OCR always returns `fallback: true` | Sidecar not running, or Python deps missing | `/api/admin/ocr-status` gives the reason; `pip install -r ocr-service/requirements.txt`. |
| `detector: false` on `/health` | The weight fetch failed (offline/proxied host), or `OCR_SKIP_MODEL_FETCH=1` | Look for the `[models]` line in the service log — it states the reason. Re-run `python ocr-service/bootstrap_models.py`, or set `OCR_PLATE_MODEL_URL` to an internally reachable mirror. Plate reading still works via morphology meanwhile. |
| A user cannot sign in with the right password | Account locked | `GET /api/admin/login-locks`; it auto-unlocks, or `POST` to release it. |
| Whole office locked out of login | Per-IP limiter — one NAT address | Raise the `auth` limit in `src/lib/rate-limit.ts`; per-account lockout is the real defence. |
| Dashboard suddenly >1 s | Duplicate Prisma pools, or `connection_limit` lowered | Verify `src/lib/prisma.ts` still pins on `globalThis`; check the URL. |
| `db:verify` reports a lot mismatch | Stock changed outside the app | Do **not** "fix" inventory directly. Investigate via `AuditLog`. |
| Admin sees a yard's data unexpectedly | An impersonation session is open | `/admin/audit`; sessions are first-class rows and revocable. |

---

## 11. Things that must not be done

These are load-bearing. Each one has already caused a real problem.

- Do not point `DIRECT_URL` at a different database. Same database, unpooled host.
- Do not introduce Redis, a second datasource, or the Neon serverless driver.
- Do not move authentication into `authorize()` beyond the lockout check, and do not
  change the Edge middleware limiter.
- Do not unpin `PrismaClient`, the realtime bus, or the OCR supervisor from
  `globalThis`. Next.js does not guarantee one module instance per process; this has
  bitten this codebase four times.
- Do not run `db:reset`, `prisma migrate reset`, or `db:seed` against production.
- Do not publish `crop` images or OCR payloads to any external service.

---

## 12. Android APK (Capacitor)

The APK is a **WebView onto the deployed site**, not a bundled copy of it. This app
is server-rendered with API routes, Auth.js sessions and Prisma; `next export` would
drop every endpoint the yard workflow runs on, so there is nothing to bundle. The
practical consequence is good: a fix ships by deploying, not by reinstalling an APK
on every phone in the yard.

### Layout

| Piece | Where |
|---|---|
| Capacitor config | `capacitor.config.ts` |
| Offline fallback page (the `webDir`) | `capacitor/www/index.html` |
| Android project | `android/` (committed; its build output is not) |
| App id / name | `in.crita.scrapflow` / **Scrap Flow** |
| Server the APK loads | `https://scrap-flow-veloce-crita.vercel.app` |

`server.url` is the production origin and `cleartext` is `false`, so a release build
cannot silently target `http://localhost`. To point a device at your own machine for
development, set `CAPACITOR_SERVER_URL` before syncing — never commit that.

### Build a release APK

```bash
npm run cap:sync          # copy webDir + config into android/
npm run cap:open          # opens the project in Android Studio
```

Then in Android Studio: **Build → Generate Signed App Bundle / APK → APK**, create or
select a keystore, choose the `release` variant. The keystore and `*.apk` are
gitignored deliberately — signing material never belongs in the repository.

Headless equivalent, if you prefer the command line:

```bash
cd android && ./gradlew assembleRelease     # unsigned APK in app/build/outputs/apk/release/
```

Requires **JDK 21** (Capacitor 8 compiles at Java 21) and the Android SDK with
platform 36 / build-tools 36. `android/local.properties` carries `sdk.dir` and is
machine-specific, so it is gitignored — Android Studio recreates it on first open.

### What was configured, and why

- `CAMERA` permission plus `uses-feature … required="false"`. The yard captures
  photographs through `<input type="file" accept="image/*" capture="environment">`;
  Capacitor's file chooser only offers the camera when the app declares the
  permission, and a phone without a camera must still be able to install the app.
- `allowBackup="false"` and `data_extraction_rules.xml` exclude everything from both
  cloud backup and device-to-device transfer. The WebView holds an authenticated
  session cookie for a yard.
- `usesCleartextTraffic="false"` and `allowMixedContent: false`. Weighbridge slips,
  vehicle plates and session cookies do not travel over plain HTTP.
- `allowNavigation` is limited to the production host, so an external link opens in
  the system browser rather than inside the WebView holding the session.
- Brand palette in `android/app/src/main/res/values/colors.xml` and a dark launch
  background, so the gap before the WebView paints is not a white flash.

### After changing anything

`npm run cap:sync` regenerates `android/app/src/main/assets/` from
`capacitor.config.ts` and `capacitor/www/`. Those generated assets are gitignored;
the rest of `android/` is committed because it is edited (manifest, resources).
