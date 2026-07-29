import type { NextAuthConfig } from "next-auth";
import type { Role } from "@prisma/client";

/**
 * Edge-safe auth config shared by middleware and the full Node auth instance.
 * Contains NO database or bcrypt imports so it can run in the edge middleware.
 *
 * `yardId` is carried in the signed JWT and is the ONLY source of tenancy for
 * OWNER/MANAGER requests — it is never read from a body, query or header.
 * ADMIN carries yardId = null; an admin's acting yard lives in a separate
 * signed cookie (src/lib/impersonation.ts) so it can be revoked independently
 * of the login session.
 */
export const authConfig = {
  trustHost: true,
  pages: { signIn: "/login" },
  session: { strategy: "jwt" },
  providers: [], // real providers are attached in src/auth.ts (Node runtime)
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
