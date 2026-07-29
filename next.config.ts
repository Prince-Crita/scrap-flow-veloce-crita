import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Allow larger payloads for base64 image proxying to the OCR service.
    serverActions: { bodySizeLimit: "8mb" },
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
