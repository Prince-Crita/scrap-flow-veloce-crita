/**
 * Prisma configuration.
 *
 * Replaces the `package.json#prisma` block, which Prisma 6.19 deprecates and
 * Prisma 7 removes. Behaviour is unchanged: same schema path, same seed command.
 *
 * CONFIGURATION ONLY — this file must never import application runtime code.
 * `prisma/config` is Prisma's own typed config helper, not app code, so the
 * declaration stays statically analysable and carries no side effects.
 *
 * `seed` moved under `migrations` in the config-file format (it was top-level in
 * the package.json block). It is consumed by `prisma db seed` only, so it plays
 * no part in `prisma generate`, `prisma migrate deploy`, or the Vercel build.
 */
/**
 * Loading `.env` explicitly is REQUIRED, not incidental. Prisma auto-loaded
 * `.env` for the `package.json#prisma` format, but stops doing so as soon as a
 * `prisma.config.ts` exists — so without this line `schema.prisma`'s
 * `env("DATABASE_URL")` / `env("DIRECT_URL")` resolve to nothing and every local
 * `prisma` command fails with P1012. Verified: removing it reproduces
 * "Environment variable not found: DIRECT_URL".
 *
 * On Vercel there is no `.env` file — the variables are injected into the real
 * process environment — so dotenv finds nothing to do and the injected values
 * are used unchanged. Same behaviour in both places.
 */
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});
