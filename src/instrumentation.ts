/**
 * Next.js server startup hook — runs once per server process, before requests.
 *
 * This is where the app takes ownership of its sidecar services, so that
 * `npm run start` is the only command anyone ever has to run. Nothing in here may
 * block or throw: a failure to start OCR must degrade the ANPR feature, never the
 * yard.
 */
export async function register() {
  // Edge and browser bundles must not pull in child_process.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    // Eagerly, not lazily: an instance that only receives events would otherwise
    // never open its LISTEN connection and would miss every remote event.
    const { initRealtime } = await import("@/backend/realtime/realtime");
    initRealtime();
  } catch (e) {
    console.error("[startup] realtime transport could not be started:", e);
  }

  try {
    const { startOcrSupervisor } = await import("@/backend/ocr/ocr-supervisor");
    startOcrSupervisor();
  } catch (e) {
    // Deliberately swallowed. If supervision cannot even be set up, the OCR
    // route still works against a manually-run service and still falls back to
    // manual entry — the app must come up regardless.
    console.error("[startup] OCR supervisor could not be started:", e);
  }
}
