/**
 * Content-Security-Policy, built per request around a fresh nonce.
 *
 * Why per request: a nonce is only worth anything if it is unguessable and used
 * once. That rules out a static policy in `next.config.ts` (where the other
 * security headers live, because they never change) and puts CSP in the
 * middleware, which is the only layer that runs per request on the edge.
 *
 * How Next.js picks the nonce up: the middleware sets `Content-Security-Policy`
 * on the *request* headers as well as the response. Next reads the nonce out of
 * that request header and stamps `nonce="…"` onto every script tag it emits —
 * framework chunks included. Setting only the response header produces a policy
 * that blocks Next's own hydration scripts, which looks like "CSP broke the app"
 * and is really "the nonce never reached the renderer".
 *
 * ── The two deliberate relaxations, and why each is unavoidable ──
 *
 * 1. `style-src-attr 'unsafe-inline'`.
 *    The app has ~106 `style={{…}}` attributes — chart bar widths, progress-fill
 *    percentages, XP bars. **CSP has no nonce mechanism for style ATTRIBUTES**;
 *    nonces apply to elements only. So the choice is this relaxation or
 *    rewriting every one of those call sites into generated CSS classes, which
 *    is a UI change. Note what is NOT relaxed: `style-src` (i.e. `<style>`
 *    elements) stays nonce-only, and `script-src` never permits inline anything.
 *    A style attribute cannot execute script, so this does not reopen XSS —
 *    the worst it allows is restyling, and `frame-ancestors 'none'` plus
 *    `X-Frame-Options: DENY` close the clickjacking path that would make
 *    restyling useful to an attacker.
 *
 * 2. `'unsafe-eval'` in development only.
 *    Turbopack's HMR runtime evaluates code. Production never gets it — the
 *    check is on `NODE_ENV`, so a production build cannot accidentally ship it.
 *
 * `'strict-dynamic'` is what makes the nonce approach work with Next's chunk
 * loader: a script that already passed the nonce check may inject further
 * scripts, so lazily-loaded route chunks load without needing to enumerate them.
 * In browsers that honour it, `'strict-dynamic'` also causes `'self'` in
 * `script-src` to be ignored, which is the desired hardening — host allow-lists
 * are the weak part of most policies. `'self'` is kept for older browsers.
 *
 * `upgrade-insecure-requests` is deliberately absent: development is served over
 * plain http on localhost:3001, and forcing an upgrade there breaks every asset.
 * Transport security is handled by TLS termination plus the HSTS header set in
 * `next.config.ts`.
 */

/** Blob storage host used for uploaded images in production. */
const BLOB_HOST = "https://*.public.blob.vercel-storage.com";

export function buildCsp(nonce: string, isDev = process.env.NODE_ENV !== "production"): string {
  const directives: string[] = [
    `default-src 'self'`,

    // Scripts: nonce + strict-dynamic. No inline, no eval in production.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,

    // <style> elements: nonce only.
    `style-src 'self' 'nonce-${nonce}'`,
    // style="" attributes: see note 1 above. No nonce mechanism exists.
    `style-src-attr 'unsafe-inline'`,

    // data: for the base64 previews the camera flow produces before upload;
    // blob: for object URLs; the blob host for stored uploads.
    `img-src 'self' data: blob: ${BLOB_HOST}`,
    `font-src 'self' data:`,
    `media-src 'self' blob: data:`,

    // Same-origin only. The OCR sidecar is called server-side, so the browser
    // never talks to :8000 — SSE (/api/realtime/stream) and uploads are 'self'.
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,

    `worker-src 'self' blob:`,
    `manifest-src 'self'`,

    // Nothing may embed us, and we embed nothing.
    `frame-ancestors 'none'`,
    `frame-src 'none'`,
    `object-src 'none'`,

    // Stops a <base> injection re-pointing every relative URL.
    `base-uri 'self'`,
    // Stops a form being retargeted at an attacker's collector.
    `form-action 'self'`,
  ];

  return directives.join("; ");
}

/** Cryptographically random, per request. Web Crypto — available on the edge. */
export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // base64 without Buffer, which does not exist in the edge runtime.
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export const NONCE_HEADER = "x-nonce";
export const CSP_HEADER = "Content-Security-Policy";
