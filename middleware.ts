import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/backend/auth/auth.config";
import { blockedBy, homePathFor } from "@/shared/permissions";
import { IMPERSONATION_COOKIE, verifyImpersonationToken } from "@/backend/auth/impersonation";
import { rateLimit, clientIp, tooManyRequests } from "@/backend/http/rate-limit";
import { buildCsp, makeNonce, NONCE_HEADER, CSP_HEADER } from "@/backend/http/csp";
import { BASE_PATH } from "@/shared/config/paths";

const { auth } = NextAuth(authConfig);

/**
 * Edge routing guard. No database access — it decides purely from the signed
 * JWT plus the signed impersonation cookie. Data-level enforcement lives in the
 * API guards (src/backend/http/api.ts); this layer only keeps roles out of the wrong
 * *pages*, so the two must never disagree: both derive from src/shared/permissions.
 */
export default auth(async (req) => {
  const { nextUrl } = req;
  const session = req.auth;
  const isLoggedIn = !!session;
  const role = session?.user?.role;
  const method = req.method;

  /**
   * App-relative path — the deployment prefix removed.
   *
   * Every rule below (`/login`, `/api/*`, the permission matrix) is written
   * against the application's own routes, and `nextUrl.pathname` carries the
   * deployment prefix when one is configured. Verified against a real prefixed
   * build: without this, `path.startsWith("/api")` was false for an API request
   * and the guard fell through to the page redirect instead of answering 401.
   *
   * Stripping here rather than at each comparison keeps every rule below
   * unchanged, and is a no-op when no base path is set.
   */
  const path =
    BASE_PATH && nextUrl.pathname.startsWith(BASE_PATH)
      ? nextUrl.pathname.slice(BASE_PATH.length) || "/"
      : nextUrl.pathname;

  const isLogin = path === "/login";

  const isAuthApi = path.startsWith("/api/auth");
  /**
   * Icons and the manifest must be reachable WITHOUT a session.
   *
   * The browser fetches the favicon before (and independently of) any signed-in
   * document, so gating it behind auth returned a 307 to /login and the tab kept
   * whatever icon it had cached — including another localhost project's.
   */
  const isPublicAsset =
    path.startsWith("/_next") ||
    path === "/favicon.ico" ||
    // Prefix match, not equality: Next serves the file conventions at `/icon`
    // and `/apple-icon` (no extension), and may append a hash. Matching the
    // literal filenames let `/apple-icon` fall through to the auth redirect.
    path.startsWith("/icon") ||
    path.startsWith("/apple-icon") ||
    path.startsWith("/apple-touch-icon") ||
    path === "/manifest.webmanifest";

  /**
   * Tells the root layout which shell to render. The admin console needs
   * `data-shell="admin"` on <body> — that attribute is what activates
   * src/frontend/styles/admin.css — and <body> lives in the root layout, which cannot
   * otherwise know the route. Passing it as a request header makes the attribute
   * server-rendered: no flash of the phone-centred layout on first paint, and
   * the correct shell even with JavaScript disabled.
   */
  const shellHeaders = new Headers(req.headers);
  shellHeaders.set("x-sf-shell", path.startsWith("/admin") ? "admin" : "yard");

  /**
   * Per-request CSP nonce.
   *
   * Set on the REQUEST headers as well as every response: Next.js reads the
   * nonce out of the request's `Content-Security-Policy` header and stamps it
   * onto the script tags it emits. Response-only would block Next's own
   * hydration bundle. `x-nonce` is the documented handle for any server
   * component that needs the value itself.
   */
  const nonce = makeNonce();
  const csp = buildCsp(nonce);
  shellHeaders.set(NONCE_HEADER, nonce);
  shellHeaders.set(CSP_HEADER, csp);

  /** Every exit from this middleware carries the policy, not just the happy path. */
  const withCsp = <T extends NextResponse>(res: T): T => {
    res.headers.set(CSP_HEADER, csp);
    return res;
  };

  const pass = () => withCsp(NextResponse.next({ request: { headers: shellHeaders } }));

  /**
   * Build an in-app redirect target that survives a deployment base path.
   *
   * A middleware redirect is a raw `Location` header — Next.js does not add the
   * deployment prefix to it, and `new URL("/login", nextUrl)` actively removes
   * one, because a root-relative path replaces the whole path of the base URL.
   * Either way the browser lands outside the application. The prefix is
   * therefore applied explicitly, which is exactly what a prefixed build showed
   * to be necessary.
   *
   * Byte-for-byte the previous behaviour when no base path is configured.
   */
  const to = (pathname: string, params?: Record<string, string>) => {
    const url = nextUrl.clone();
    url.pathname = `${BASE_PATH}${pathname}`;
    url.search = "";
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    return url;
  };

  /**
   * Credential-stuffing defence. Keyed on IP rather than on the submitted
   * email, or an attacker would simply rotate addresses to get a fresh budget
   * for each account they try.
   *
   * Sits here because this is the only layer that sees the request before
   * Auth.js consumes it; `authorize()` never receives the client address. The
   * limiter is pure JS (a Map plus Date), so it runs on the edge runtime — but
   * it is per-instance, exactly like the SSE bus, and needs a shared store
   * before running multi-instance.
   */
  if (path === "/api/auth/callback/credentials" && method === "POST") {
    const authLimit = rateLimit("auth", clientIp(req));
    if (!authLimit.ok) return tooManyRequests(authLimit, "sign-in");
  }

  if (isAuthApi || isPublicAsset) return pass();

  // Unauthenticated → login
  if (!isLoggedIn) {
    if (isLogin) return pass();
    if (path.startsWith("/api")) {
      return withCsp(NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Login required" } }, { status: 401 }));
    }
    return withCsp(NextResponse.redirect(to("/login", { callbackUrl: path })));
  }

  if (!role) return pass();

  // Forced password change after an admin reset. Everything except the change
  // screen, its API, and sign-out is off limits until it is done.
  const mustChange = session?.user?.mustChangePassword;
  const isChangePw = path === "/change-password" || path === "/api/account/password";
  if (mustChange && !isChangePw) {
    if (path.startsWith("/api")) {
      return withCsp(NextResponse.json(
        { error: { code: "PASSWORD_CHANGE_REQUIRED", message: "Set a new password to continue" } },
        { status: 403 }
      ));
    }
    return withCsp(NextResponse.redirect(to("/change-password")));
  }
  if (!mustChange && path === "/change-password") {
    return withCsp(NextResponse.redirect(to(homePathFor(role))));
  }

  // Logged in but on /login → send to the role's home
  if (isLogin) return withCsp(NextResponse.redirect(to(homePathFor(role))));

  // An ADMIN reaches the yard (phone) UI only inside an active Enter Yard
  // session. Without one there is no yard to scope those screens to, so send
  // them back to the console rather than rendering an empty shell.
  const YARD_UI_PREFIXES = ["/stock", "/inward", "/sort", "/sell"];
  if (role === "ADMIN" && YARD_UI_PREFIXES.some((p) => path.startsWith(p))) {
    const claims = await verifyImpersonationToken(req.cookies.get(IMPERSONATION_COOKIE)?.value);
    if (!claims || claims.adminId !== session!.user!.id) {
      return withCsp(NextResponse.redirect(to("/admin/yards")));
    }
  }

  // Central permission matrix (pages + APIs, method-aware).
  const blocked = blockedBy(path, method, role);
  if (blocked) {
    if (path.startsWith("/api")) {
      return withCsp(NextResponse.json(
        { error: { code: "FORBIDDEN", message: "You do not have access to this action" } },
        { status: 403 }
      ));
    }
    return withCsp(NextResponse.redirect(to(homePathFor(role))));
  }

  return pass();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon|apple-icon|apple-touch-icon|manifest.webmanifest).*)"],
};
