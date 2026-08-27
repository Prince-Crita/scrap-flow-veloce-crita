/**
 * The ONE place the deployment's base path and API origin are defined.
 *
 * ── What this solves ─────────────────────────────────────────────────────────
 * The application will eventually move off Vercel onto a company server, where
 * it may be mounted under a project-specific prefix such as
 * `/client-trial/veloceinventory`. That prefix is NOT known yet, so nothing in
 * this codebase may contain it. It is supplied at build time through
 * `NEXT_PUBLIC_BASE_PATH` and read here; no route, component or fetch call
 * mentions it.
 *
 * ── What Next.js already handles, and what it does not ───────────────────────
 * Setting `basePath` in `next.config.ts` makes Next prefix the things it owns:
 * `<Link>`, `router.push`, server `redirect()`, `/_next/*` assets, `next/image`
 * and the metadata icons. It does NOT touch strings the app hands to the
 * browser's own APIs:
 *
 *   • `fetch("/api/…")`      → would hit the origin root and 404
 *   • `new EventSource(…)`   → same
 *   • `<img src="/uploads/…">` → same (these URLs come out of the database)
 *
 * Those three are exactly what the helpers below cover, which is why the API
 * client and the realtime provider route through them instead of writing raw
 * paths. Anything Next already prefixes is deliberately left alone — prefixing
 * it twice would produce `/base/base/…`.
 *
 * ── Build time, not request time ─────────────────────────────────────────────
 * `basePath` is a build-time setting in Next.js: the value is compiled into the
 * client bundle. So this is read from the environment at build time and cannot
 * change per request. Moving the app to a different prefix means rebuilding with
 * a different `NEXT_PUBLIC_BASE_PATH` — one variable, one rebuild, no code edit.
 */

/** Strips a trailing slash and guarantees a single leading one. `""` when unset. */
function normalize(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  if (!v || v === "/") return "";
  const withLead = v.startsWith("/") ? v : `/${v}`;
  return withLead.endsWith("/") ? withLead.slice(0, -1) : withLead;
}

/**
 * The path prefix the application is served under.
 *
 * Empty in local development and on Vercel today, so `http://localhost:3001/`
 * keeps working with no configuration at all. Set it only where the deployment
 * actually needs it.
 *
 * NOTE: referenced as the full `process.env.NEXT_PUBLIC_BASE_PATH` expression,
 * never destructured or read dynamically — Next.js inlines client-side env reads
 * by exact textual match, and a computed lookup would come back undefined in the
 * browser bundle.
 */
export const BASE_PATH = normalize(process.env.NEXT_PUBLIC_BASE_PATH);

/**
 * Absolute origin of the API, when it is NOT served from the same origin as the
 * pages.
 *
 * Empty by default, and that default is the one to keep: the API lives inside
 * this same Next.js application, so same-origin relative URLs are what make
 * session cookies, CSRF and the `connect-src 'self'` CSP work without any
 * cross-origin configuration. It exists for the case where the company server
 * fronts the API on a different host — set it there and every call moves with
 * it, still through one variable.
 */
export const API_ORIGIN = (process.env.NEXT_PUBLIC_API_ORIGIN ?? "").replace(/\/$/, "");

/** Joins a root-relative app path onto the base path. `/stock` → `/base/stock`. */
export function appUrl(path: string): string {
  if (!path.startsWith("/")) return path; // already absolute or relative — leave it
  return `${BASE_PATH}${path}`;
}

/**
 * The URL the browser should call for an API route.
 *
 * Used by the central API client and by the realtime `EventSource`, which are
 * the only two places in the frontend that talk to the network directly.
 */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path; // caller supplied a full URL
  const rel = path.startsWith("/") ? path : `/${path}`;
  return `${API_ORIGIN}${BASE_PATH}${rel}`;
}

/**
 * The URL for a stored upload.
 *
 * Upload URLs are persisted in the database as `/uploads/<yardId>/…` and are
 * rendered straight into `<img src>`, so they need the prefix applied at render
 * time. Applying it here rather than at write time is deliberate: the stored
 * value stays deployment-independent, so moving the app to a different base path
 * does not invalidate a single existing row.
 */
export function assetUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (/^(https?:|data:|blob:)/i.test(url)) return url; // absolute or in-memory preview
  return appUrl(url);
}

/**
 * Where the BROWSER reaches Auth.js — used by `SessionProvider`.
 *
 * Client-side only, on purpose. The server config must keep Auth.js's default
 * `/api/auth`, because Next.js strips the deployment prefix before a Route
 * Handler runs; see the note in `src/backend/auth/auth.config.ts`, which records
 * what setting the prefixed value there actually broke.
 */
export const AUTH_BASE_PATH = `${BASE_PATH}/api/auth`;
