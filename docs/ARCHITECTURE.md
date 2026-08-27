# Architecture — frontend / backend boundaries

Where code lives, who owns it, and where deployment is configured.
Operational runbook: [`DEPLOYMENT.md`](../DEPLOYMENT.md).

---

## 1. Shape of the application

One Next.js App Router application, one deployable, with the frontend, the
backend and the contracts between them in separate directories.

```text
src/
├── app/                    Next.js routing ONLY — the framework owns these paths
│   ├── (app)/              yard screens      → thin, render frontend components
│   ├── (admin)/            admin console     → thin, render frontend components
│   ├── api/**/route.ts     HTTP endpoints    → thin, delegate to backend/
│   └── uploads/[...path]/  gated file serving
│
├── backend/                SERVER ONLY. Never imported by a "use client" file.
│   ├── auth/               auth.ts, auth.config.ts, yard-context, impersonation,
│   │                       login-lockout
│   ├── db/                 prisma.ts (client), tenant.ts (yard scoping)
│   ├── http/               api.ts (route guards, ok/fail/parseBody), rate-limit,
│   │                       rate-limit-shared, csp
│   ├── services/           business logic: allocation, counters, audit, streak,
│   │                       admin-records, sku-references, active-yards,
│   │                       yard-provisioning, plate-match
│   ├── storage/            storage.ts (Blob / local disk), image-validate
│   ├── realtime/           realtime.ts (publish/subscribe), realtime-pg (LISTEN)
│   └── ocr/                ocr-supervisor.ts (ANPR sidecar lifecycle)
│
├── frontend/               BROWSER. No Prisma, no server imports.
│   ├── components/         every UI component, incl. admin/ and realtime/
│   ├── lib/                api-client.ts (the ONLY network layer), image, confetti
│   └── styles/             globals.css, admin.css
│
├── shared/                 Imported by both sides. Must stay dependency-free.
│   ├── config/paths.ts     base path + API base — the deployment seam
│   ├── permissions.ts      capability matrix (middleware + API + UI all derive)
│   ├── format.ts units.ts role-label.ts
│   └── types/
│
├── instrumentation.ts      server startup hook (Next convention — must stay here)
└── ../middleware.ts        edge routing guard (Next convention — must stay at root)
```

### Why this and not a monorepo or two applications

The backend is not reachable over HTTP from inside this app, and it should not be.
Server Components read the database directly — `src/app/(app)/layout.tsx` calls
`auth()` and Prisma with no request in between — and the route handlers are the
API for the *browser* only. Splitting the backend into a separate service would
mean turning every one of those direct reads into a network call, duplicating
authentication across two processes, and shipping two deployables where one is
required. That is a rewrite of working code with no benefit to this team.

Workspaces were rejected for the same reason plus one more: `src/app` cannot be
split across packages — Next.js owns that directory — so a workspace boundary
would cut through the routing layer rather than around it.

What the seniors asked for is a real boundary, and a real boundary is what this
is: `backend/` is server-only and the compiler enforces it (importing Prisma or
`next/server` into a `"use client"` file fails the build), `frontend/` never sees
a database type, and `shared/` is the only thing both may import.

---

## 2. Request paths

**Browser → API (client components, React Query):**

```text
component  →  getJson/sendJson        src/frontend/lib/api-client.ts
           →  apiUrl(path)            src/shared/config/paths.ts   ← base URL decided here
           →  /api/**/route.ts        src/app/api/…                ← HTTP boundary
           →  requireYard()           src/backend/http/api.ts      ← authn + tenancy
           →  scopedDb                src/backend/db/tenant.ts     ← yard-scoped Prisma
           →  PostgreSQL
```

No component contains an origin, a port or a base path. Call sites pass contract
paths (`/api/stock`); only `apiUrl()` decides what host and prefix they resolve
against.

**Browser → server-rendered page (Server Components):** no HTTP at all. The page
imports `backend/` directly. This is preserved deliberately — forcing these
through `fetch` would add a network hop and a second authentication path for no
gain.

**Server → browser (realtime):** SSE from `/api/realtime/stream`, opened by
`frontend/components/realtime/provider.tsx` through the same `apiUrl()`.

---

## 3. Deployment configuration

Everything deployment-shaped is read in one module, `src/shared/config/paths.ts`,
plus `next.config.ts` for the framework's own settings.

| Value | Variable | Local | Vercel today | Company server |
|---|---|---|---|---|
| Base path | `NEXT_PUBLIC_BASE_PATH` | unset | unset | the real prefix, **at build time** |
| API origin | `NEXT_PUBLIC_API_ORIGIN` | unset (same origin) | unset | unset unless the API moves hosts |
| Public origin | `NEXTAUTH_URL` | `http://localhost:3001` | deployment URL | company origin, **no prefix** |
| Database | `DATABASE_URL` / `DIRECT_URL` | Neon | Neon | company PostgreSQL |
| Uploads | `BLOB_READ_WRITE_TOKEN` | unset → `.uploads/` on disk | Blob token | unset → local disk (writable box) |
| Server output | `NEXT_OUTPUT_STANDALONE` | unset | unset | `1` for a self-contained Node server |

`/client-trial/veloceinventory` is a **placeholder** and appears in no source
file. Full base-path mechanics and the verified failure modes are in
[`DEPLOYMENT.md` §1.1](../DEPLOYMENT.md).

### What is still Vercel-specific, and what it costs to leave

Nothing here blocks a move; all three degrade gracefully by design.

- `backend/storage/storage.ts` — uses Vercel Blob when `BLOB_READ_WRITE_TOKEN` is
  set, otherwise writes to `.uploads/` and serves through the gated route. A
  company server with a writable disk needs no token and no code change.
- `backend/ocr/ocr-supervisor.ts` — checks `process.env.VERCEL` to skip spawning
  the Python sidecar where no Python runtime exists. False off Vercel, which is
  the wanted behaviour: the supervisor runs.
- `vercel.json` — Vercel-only; ignored elsewhere. Its build command
  (`prisma migrate deploy`) must be reproduced in the company pipeline.

---

## 4. Who works where

| Role | Directory | Owns |
|---|---|---|
| Frontend | `src/frontend/`, `src/app/(app)`, `src/app/(admin)` | pages, components, responsive design, client state, calling the API client |
| Backend | `src/backend/`, `src/app/api/` | endpoints, guards, business logic, services, storage, realtime, OCR |
| Shared | `src/shared/` | types, the capability matrix, formatting, deployment config |
| Database | `prisma/` | schema, migrations, seed and backup scripts |
| Deployment | `next.config.ts`, `vercel.json`, `.env*`, `DEPLOYMENT.md` | build settings, environment, base path |

Rules that keep the boundary real:

1. A frontend file never imports from `src/backend/`. It calls the API client.
2. A backend file never imports from `src/frontend/`.
3. `src/shared/` imports nothing but types — it is compiled into both bundles.
4. Files under `src/app/` stay thin: a page renders a component, a route handler
   guards the request and delegates to `backend/`. Logic added there is logic in
   the wrong place.
5. Anything that needs a URL, a base path or an origin goes through
   `src/shared/config/paths.ts`. Never write one inline.
6. A capability check derives from `src/shared/permissions.ts` — never a role
   comparison inline in a component or a handler.
