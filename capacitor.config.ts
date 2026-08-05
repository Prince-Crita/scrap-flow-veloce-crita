import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Android wrapper for Scrap Flow · Veloce.
 *
 * ── Why the APK points at a server and does not bundle the app ───────────────
 * This is a Next.js application with server-rendered routes, API handlers,
 * Auth.js sessions and Prisma. None of that can be exported to static files, so
 * there is nothing to bundle: `next export` would drop every API route the yard
 * workflow runs on. The APK is therefore a WebView onto the deployed
 * application, which is the supported pattern for a server-backed app and has
 * the operational advantage that a fix ships by deploying, not by reinstalling
 * an APK on every phone in the yard.
 *
 * `webDir` still has to exist — Capacitor copies it into the APK — so it holds a
 * single self-contained fallback page shown when the device is offline.
 *
 * ── Production, not localhost ────────────────────────────────────────────────
 * `server.url` is the deployed origin. `CAPACITOR_SERVER_URL` overrides it for a
 * developer pointing a device at their own machine; it is never the default, so
 * a release build cannot accidentally ship a localhost target.
 */

/** The deployed origin the APK loads. Overridable for local device testing. */
const SERVER_URL = process.env.CAPACITOR_SERVER_URL ?? "https://scrap-flow-veloce-crita.vercel.app";

const { hostname } = new URL(SERVER_URL);

const config: CapacitorConfig = {
  appId: "in.crita.scrapflow",
  appName: "Scrap Flow",
  webDir: "capacitor/www",

  server: {
    url: SERVER_URL,
    /**
     * HTTPS only. `cleartext: false` and `allowMixedContent: false` together
     * mean the WebView will refuse a plain-HTTP origin or sub-resource rather
     * than silently downgrading — the app carries weighbridge slips, vehicle
     * plates and session cookies.
     */
    androidScheme: "https",
    cleartext: false,
    /**
     * Navigation stays inside the app for our own origin. Anything else (a
     * mailto:, an external link) is handed to the system browser instead of
     * being loaded in a WebView that holds the session.
     */
    allowNavigation: [hostname],
  },

  android: {
    allowMixedContent: false,
    /**
     * Capacitor's default `captureInput` intercepts key events for hardware
     * keyboards. The yard UI is a touch keypad and text fields, so the default
     * (false) is correct and left alone.
     */
    webContentsDebuggingEnabled: false,
  },
};

export default config;
