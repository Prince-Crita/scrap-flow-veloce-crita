import type { NextAuthConfig } from "next-auth";
import type { Role } from "@prisma/client";
import { appUrl } from "@/shared/config/paths";

/**
 * Edge-safe auth config shared by middleware and the full Node auth instance.
 * Contains NO database or bcrypt imports so it can run in the edge middleware.
 *
 * `yardId` is carried in the signed JWT and is the ONLY source of tenancy for
 * OWNER/MANAGER requests — it is never read from a body, query or header.
 * ADMIN carries yardId = null; an admin's acting yard lives in a separate
 * signed cookie (src/backend/auth/impersonation.ts) so it can be revoked independently
 * of the login session.
 */
export const authConfig = {
  trustHost: true,
  /**
   * `basePath` is deliberately NOT set here, and the deployment prefix must NOT
   * be added to it.
   *
   * The prefix applies asymmetrically, which a prefixed build made concrete:
   *
   *   • Server — Next.js strips the deployment prefix before a Route Handler
   *     runs, so this handler sees `/api/auth/session`. Configuring the prefixed
   *     path here made Auth.js fail to parse the action and answer
   *     `400 "Bad request."` to every session call.
   *   • Browser — the fetch is a real network request to the real URL, so the
   *     CLIENT does need the prefix. That is `SessionProvider basePath` in
   *     `src/frontend/components/providers.tsx`, set from `AUTH_BASE_PATH`.
   *
   * Consequence for deployment: `NEXTAUTH_URL` / `AUTH_URL` must be the ORIGIN
   * ONLY (`https://host`), never origin + prefix — Auth.js would otherwise infer
   * its basePath from that URL and reintroduce the same 400.
   *
   * `signIn` is the opposite case: it is a Location header handed to the
   * browser, so it carries the prefix.
   */
  pages: { signIn: appUrl("/login") },
  session: { strategy: "jwt" },
  providers: [], // real providers are attached in src/backend/auth/auth.ts (Node runtime)
  callbacks: {
    jwt({ token, user, trigger, session }) {
      if (user) {
        token.uid = (user as { id: string }).id;
        token.role = (user as { role: Role }).role;
        token.yardId = (user as { yardId: string | null }).yardId ?? null;
        token.mustChangePassword = (user as { mustChangePassword?: boolean }).mustChangePassword ?? false;
      }
      // Lets the change-password screen clear the flag without a re-login.
      if (trigger === "update" && session && typeof session === "object") {
        const s = session as { mustChangePassword?: boolean };
        if (s.mustChangePassword === false) token.mustChangePassword = false;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.uid as string;
        session.user.role = token.role as Role;
        session.user.yardId = (token.yardId as string | null) ?? null;
        session.user.mustChangePassword = Boolean(token.mustChangePassword);
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
