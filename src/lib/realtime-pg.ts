import { Client } from "pg";

/**
 * Cross-instance transport for the realtime bus, over Postgres LISTEN/NOTIFY.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * The in-process bus delivers only to listeners in the same Node process, so an
 * SSE client on instance A never saw an event published on instance B. The yard
 * showed stale stock with no error — the worst failure shape there is, because it
 * looks like a data bug.
 *
 * ── Why LISTEN/NOTIFY and not a table ─────────────────────────────────────────
 * Reading a table means polling, which is explicitly ruled out and would make SSE
 * latency equal to the poll interval. NOTIFY is genuinely push-based, and it needs
 * no new vendor: same database, just the unpooled endpoint.
 *
 * ── Why the unpooled endpoint ────────────────────────────────────────────────
 * LISTEN is session-scoped state. PgBouncer in transaction mode hands the
 * connection to someone else between statements, so a LISTEN registered through it
 * would be silently lost. `DIRECT_URL` is the same database on the unpooled host.
 * Application queries keep using the pooled URL — this is one long-lived
 * connection per instance, nothing more.
 *
 * ── Failure policy ────────────────────────────────────────────────────────────
 * Realtime is an optimisation over correct data that is already committed. Every
 * path here is non-fatal: if the listener cannot connect, the app keeps working
 * and degrades to same-instance delivery, exactly as it behaved before. It
 * reconnects with backoff and never throws into a business write.
 */

const CHANNEL = "sf_realtime";
/** Postgres caps a NOTIFY payload at 8000 bytes; stay well clear. */
const MAX_PAYLOAD = 7000;
const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Identifies this process, so we can ignore the echo of our own NOTIFY. */
export const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

export type Envelope = {
  /** Publishing instance. Used to drop our own echo — we delivered locally already. */
  i: string;
  /** Yard id. */
  y: string;
  /** The YardEvent, as-is. Event names and shape are unchanged. */
  e: unknown;
};

type Handler = (env: Envelope) => void;

type PgBusGlobal = {
  listener: Client | null;
  notifier: Client | null;
  handler: Handler | null;
  started: boolean;
  attempt: number;
  connected: boolean;
  lastError: string | null;
  received: number;
  sent: number;
  dropped: number;
  /** Set while a reconnect is already queued, so drops cannot multiply. */
  reconnectTimer: NodeJS.Timeout | null;
  /** In-flight notifier connect, shared by concurrent publishes. */
  notifierPending: Promise<Client | null> | null;
};

const g = globalThis as unknown as { __sfPgBus?: PgBusGlobal };

const S: PgBusGlobal = (g.__sfPgBus ??= {
  listener: null,
  notifier: null,
  handler: null,
  started: false,
  attempt: 0,
  connected: false,
  lastError: null,
  received: 0,
  sent: 0,
  dropped: 0,
  reconnectTimer: null,
  notifierPending: null,
});

function directUrl(): string | null {
  // Fall back to DATABASE_URL only so a misconfigured deployment degrades to
  // same-instance delivery rather than crashing. A pooled URL cannot hold a
  // LISTEN, so this will simply never receive — which is the old behaviour.
  return process.env.DIRECT_URL || process.env.DATABASE_URL || null;
}

/** Dedicated connection for NOTIFY. Cheap: one statement, no session state. */
async function notifier(): Promise<Client | null> {
  if (S.notifier) return S.notifier;
  /**
   * Share the in-flight connect.
   *
   * Publishes are fire-and-forget and can arrive in a burst, so without this
   * every event in the burst opened its OWN `Client` while the first was still
   * connecting. Only the last one was kept in `S.notifier`; the rest leaked an
   * open socket each, which is how the process ran out of handles.
   */
  if (S.notifierPending) return S.notifierPending;

  const url = directUrl();
  if (!url) return null;

  S.notifierPending = (async () => {
    try {
      const c = new Client({ connectionString: url, application_name: "scrapflow-notify" });
      c.on("error", (e) => {
        S.lastError = `notifier: ${e.message}`;
        // Drop it; the next publish reconnects. Never rethrow into a business write.
        if (S.notifier === c) S.notifier = null;
        // `end()` on an already-broken socket can itself reject — destroy is the
        // one that reliably releases the handle.
        try {
          void c.end().catch(() => {});
        } catch {
          /* already gone */
        }
      });
      await c.connect();
      S.notifier = c;
      return c;
    } catch (e) {
      S.lastError = `notifier connect: ${e instanceof Error ? e.message : String(e)}`;
      return null;
    } finally {
      S.notifierPending = null;
    }
  })();

  return S.notifierPending;
}

async function connectListener() {
  const url = directUrl();
  if (!url) {
    S.lastError = "no DIRECT_URL or DATABASE_URL";
    return;
  }
  try {
    const c = new Client({ connectionString: url, application_name: "scrapflow-listen" });

    c.on("notification", (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      S.received++;
      try {
        const env = JSON.parse(msg.payload) as Envelope;
        // Our own echo: already delivered synchronously at publish time.
        if (env.i === INSTANCE_ID) return;
        S.handler?.(env);
      } catch (e) {
        S.lastError = `bad payload: ${e instanceof Error ? e.message : String(e)}`;
      }
    });

    /**
     * `error` and `end` BOTH fire when a connection drops — pg emits the error
     * and then closes the stream. Scheduling from each of them queued two
     * reconnects per drop, and each new client did the same on its next failure.
     * That doubling is what exhausted the socket handles (`ERR_NO_BUFFER_SPACE`),
     * filled the log with `PostgreSQL connection: Error { kind: Closed }`, and
     * grew the heap until the process died. `retire()` is idempotent.
     */
    let retired = false;
    const retire = (why: string) => {
      if (retired) return;
      retired = true;
      S.connected = false;
      if (why) S.lastError = `listener: ${why}`;
      if (S.listener === c) S.listener = null;
      try {
        void c.end().catch(() => {});
      } catch {
        /* already gone */
      }
      scheduleReconnect();
    };

    c.on("error", (e) => retire(e.message));
    c.on("end", () => retire(""));

    await c.connect();
    // Identifier is a constant, not interpolated input.
    await c.query(`LISTEN ${CHANNEL}`);
    S.listener = c;
    S.connected = true;
    S.attempt = 0;
    S.lastError = null;
    console.log(`[realtime] LISTEN ${CHANNEL} active (instance ${INSTANCE_ID})`);
  } catch (e) {
    S.connected = false;
    S.lastError = `listener connect: ${e instanceof Error ? e.message : String(e)}`;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  // At most one reconnect in flight. Without this guard the two drop events per
  // failure each queued a timer, and every generation doubled.
  if (S.reconnectTimer) return;
  const delay = RECONNECT_MS[Math.min(S.attempt, RECONNECT_MS.length - 1)];
  S.attempt++;
  S.reconnectTimer = setTimeout(() => {
    S.reconnectTimer = null;
    void connectListener();
  }, delay);
  // Never hold the process open for a reconnect timer.
  S.reconnectTimer.unref?.();
}

/**
 * Start listening. Idempotent, non-blocking, safe to call at module scope.
 * `handler` receives events published by OTHER instances only.
 */
export function startPgBus(handler: Handler): void {
  S.handler = handler;
  if (S.started) return;
  S.started = true;
  void connectListener();
}

/**
 * Fan an event out to other instances. Fire-and-forget by design: the caller has
 * already delivered locally and already committed its write, so nothing here may
 * block it or fail it.
 */
export function notifyPgBus(yardId: string, event: unknown): void {
  const payload = JSON.stringify({ i: INSTANCE_ID, y: yardId, e: event } satisfies Envelope);
  if (payload.length > MAX_PAYLOAD) {
    // Better to drop one fan-out than to throw: the publishing instance's own
    // clients are already updated, and events are small by construction, so this
    // means something unexpected got attached.
    S.dropped++;
    S.lastError = `payload too large (${payload.length}B)`;
    return;
  }
  void (async () => {
    try {
      const c = await notifier();
      if (!c) {
        S.dropped++;
        return;
      }
      await c.query("SELECT pg_notify($1, $2)", [CHANNEL, payload]);
      S.sent++;
    } catch (e) {
      S.dropped++;
      S.lastError = `notify: ${e instanceof Error ? e.message : String(e)}`;
      S.notifier = null;
    }
  })();
}

/** Diagnostics for the admin console and the test suite. */
export function pgBusStats() {
  return {
    instanceId: INSTANCE_ID,
    channel: CHANNEL,
    connected: S.connected,
    lastError: S.lastError,
    received: S.received,
    sent: S.sent,
    dropped: S.dropped,
    usingDirectUrl: !!process.env.DIRECT_URL,
  };
}
