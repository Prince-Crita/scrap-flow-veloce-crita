import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { authConfig } from "./auth.config";
import { prisma } from "@/backend/db/prisma";
import { checkLock, recordFailure, recordSuccess } from "@/backend/auth/login-lockout";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (raw) => {
        const parsed = loginSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;

        /**
         * Per-account lockout, checked BEFORE bcrypt.
         *
         * Ahead of the hash comparison on purpose: bcrypt is intentionally slow,
         * so verifying a locked account's guesses would hand an attacker a cheap
         * way to burn CPU. Layered on top of — never instead of — the per-IP
         * limiter in the Edge middleware.
         */
        const lock = await checkLock(email);
        if (lock.locked) return null;

        const user = await prisma.user.findUnique({
          where: { email: email.toLowerCase() },
          include: { yard: { select: { id: true, active: true } } },
        });
        // An unknown email is deliberately not counted: otherwise anyone could
        // fill LoginAttempt with addresses that will never own an account.
        if (!user) return null;

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) {
          await recordFailure(email);
          return null;
        }

        // A deactivated user cannot log in. Not counted as a failed attempt —
        // the credentials were correct, so there is nothing to brute force.
        if (!user.active) return null;

        // A deactivated yard locks out its OWNER/MANAGER. ADMIN (yard = null)
        // is unaffected — someone has to be able to reactivate the yard.
        if (user.role !== "ADMIN" && (!user.yard || !user.yard.active)) return null;

        // Genuine sign-in — clear the streak. Awaited so a login immediately
        // following five typos cannot race the next attempt's counter.
        await recordSuccess(email);

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          yardId: user.yardId,
          mustChangePassword: user.mustChangePassword,
        };
      },
    }),
  ],
});
