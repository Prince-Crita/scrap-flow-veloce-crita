import type { NextConfig } from "next";

/**
 * Deployment shape — the only place these are decided.
 *
 * `NEXT_PUBLIC_BASE_PATH`
 *   The prefix the app is served under on the company server, e.g.
 *   `/client-trial/veloceinventory`. UNSET everywhere today, which is what keeps
 *   `http://localhost:3001/` and the current Vercel deployment working with no
 *   configuration. When the company supplies the real prefix it is set here via
 *   the environment and nothing else in the codebase changes — the same variable
 *   is read by `src/shared/config/paths.ts` for the calls Next does not prefix
 *   itself (fetch, EventSource, stored image URLs).
 *
 *   It must be `NEXT_PUBLIC_` because the browser bundle needs the same value;
 *   `basePath` is compiled in at build time, so this is a build/deploy input,
 *   not a runtime one.
 *
 * `NEXT_OUTPUT_STANDALONE`
 *   `1` emits `.next/standalone` — a self-contained Node server for the company
 *   box. Off by default so the Vercel build is byte-for-byte what it is today.
 */
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,

  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  experimental: {
    // Allow larger payloads for base64 image proxying to the OCR service.
    serverActions: { bodySizeLimit: "8mb" },
  },

  /**
   * `src/backend/ocr/ocr-supervisor.ts` resolves the OCR sidecar's path with
   * `join(process.cwd(), "ocr-service")`, which Turbopack's output file tracer
   * cannot statically resolve. Its fallback for an unresolvable path is to sweep
   * the whole project into every route that imports the module — verified by
   * inspecting the emitted `.nft.json` trace files: `/api/ocr`, `/api/admin/
   * ocr-status` and `/api/admin/dashboard` (which surfaces OCR status) each
   * carried 1,000+ files instead of the usual 100–250, including the entire
   * local `backups/` (DB dump) and `screenshots/` (Playwright test output)
   * directories and a full copy of `public/`, none of which any server function
   * ever reads at runtime — `public/` is served by Vercel's static layer, not
   * from function code. That multi-hundred-file bloat, repeated across three
   * functions, is what was failing Vercel at the "Deploying outputs" step.
   * Excluded here rather than relying on Turbopack's `turbopackIgnore` comment,
   * which did not change the trace output in two verified rebuilds.
   */
  outputFileTracingExcludes: {
    "*": ["./backups/**/*", "./screenshots/**/*", "./public/**/*"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.public.blob.vercel-storage.com" },
    ],
  },

  /**
   * Security response headers. The production audit found the app was serving
   * none of these — authentication and tenant isolation were solid, but a
   * response carried nothing to stop the browser-side attacks that do not need
   * a session: framing the app inside another page, or a MIME sniff turning an
   * upload into script.
   *
   * Applied to every route including uploads, which is the one that matters
   * most for `nosniff`.
   *
   * Deliberately NOT included: a strict Content-Security-Policy. Next.js needs
   * either 'unsafe-inline' for its hydration scripts — which buys very little —
   * or per-request nonce plumbing through every page and the middleware. The
   * latter is a change to every route in the app, which is not a hardening
   * tweak. Recorded as a known gap rather than half-done in a way that reads as
   * protection without being any.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // The app is never legitimately framed; DENY also covers same-origin.
          { key: "X-Frame-Options", value: "DENY" },
          // Stops an uploaded image being re-interpreted as script.
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Full URLs can carry yard and lot ids; send them same-origin only.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // `camera=(self)` NOT `camera=()` — the weighbridge flow photographs
          // the vehicle via <input capture="environment">, and locking the
          // camera down entirely risks breaking plate capture on mobile.
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=(), interest-cohort=()",
          },
          // Ignored by browsers over plain http, so this is inert in local dev
          // and takes effect once the app is behind TLS.
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
