/**
 * "Enter Yard" — an ADMIN acting inside one yard's mobile UI.
 *
 * The acting yard lives in its own signed cookie rather than in the auth JWT,
 * for three reasons:
 *   1. Owner/Manager auth is untouched, so entering a yard cannot destabilise
 *      the normal login path.
 *   2. It can be revoked (or expire) on its own, without forcing a re-login.
 *   3. It carries the ImpersonationSession row id, so every write made while
 *      impersonating is attributable to a specific, time-bounded session.
 *
 * Signed with HMAC-SHA256 over AUTH_SECRET using Web Crypto, so the exact same
 * verification runs in the edge middleware and in Node route handlers.
 *
 * The cookie is httpOnly: the Owner/Manager UI has no way to observe it, which
 * is what keeps admin presence invisible to the yard's own users.
 */

export const IMPERSONATION_COOKIE = "sf_act_yard";

/** Sessions auto-expire; an admin who wanders off does not stay inside a yard. */
export const IMPERSONATION_TTL_SECONDS = 60 * 60; // 1 hour

export type ImpersonationClaims = {
  /** Yard being acted upon. */
  yardId: string;
  /** ImpersonationSession.id — the audit anchor. */
  sid: string;
  /** Admin user id; re-checked against the session so a stolen cookie is inert. */
  adminId: string;
  /** Issued-at / expiry, epoch seconds. */
  iat: number;
  exp: number;
};

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function secret(): string {
  const s = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is required to sign impersonation tokens");
  return s;
}

async function key(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** Constant-time-ish comparison — avoids leaking signature bytes via early exit. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signImpersonationToken(
  claims: Omit<ImpersonationClaims, "iat" | "exp">,
  ttlSeconds = IMPERSONATION_TTL_SECONDS
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const full: ImpersonationClaims = { ...claims, iat: now, exp: now + ttlSeconds };
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(full)));
  const sig = await crypto.subtle.sign("HMAC", await key(), new TextEncoder().encode(payload));
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * Verifies signature and expiry. Returns null on anything suspicious — never
 * throws, because a malformed cookie must degrade to "not impersonating"
 * rather than breaking the request.
 */
export async function verifyImpersonationToken(token: string | undefined | null): Promise<ImpersonationClaims | null> {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  try {
    const expected = b64urlEncode(
      new Uint8Array(await crypto.subtle.sign("HMAC", await key(), new TextEncoder().encode(payload)))
    );
    if (!safeEqual(sig, expected)) return null;

    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as ImpersonationClaims;
    if (!claims.yardId || !claims.sid || !claims.adminId) return null;
    if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Cookie attributes used for both set and clear, so they can never drift apart. */
export function impersonationCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
