import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";

/**
 * Serves locally-stored upload bytes at the SAME URL shape they are saved under
 * (`/uploads/<yardId>/<date>/<lot>/<name>`), so nothing in the database changes
 * and old and new rows resolve identically.
 *
 * ── Why this route has to exist ──────────────────────────────────────────────
 * `next start` serves /public from a snapshot taken at BUILD time. Files written
 * there afterwards — which is every dispatch photo, since uploads happen at
 * runtime — are not in that snapshot and 404 with Next's "This page could not be
 * found" until the next build.
 *
 * That is why it looked yard-specific: the older yard's photos happened to
 * predate a build and the newer yard's did not. The same break applies to any
 * yard, including the oldest, for anything uploaded since the last build. Serving
 * the bytes from disk on request removes the dependency on build timing
 * altogether, for existing yards, new yards and future yards alike.
 *
 * `next dev` reads /public live, which is why this never showed up in dev.
 *
 * Production on Vercel stores to Blob and gets back an absolute URL, so this
 * route is simply never reached there — it backs the local/self-hosted path that
 * `storeImage` falls back to when BLOB_READ_WRITE_TOKEN is absent.
 *
 * Access is unchanged: middleware already requires a session for /uploads, and
 * this route deliberately adds no new policy of its own.
 */

export const dynamic = "force-dynamic";

const ROOT = path.join(process.cwd(), "public", "uploads");

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

const notFound = () => new NextResponse("Not found", { status: 404 });

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await ctx.params;
  if (!Array.isArray(parts) || parts.length === 0) return notFound();

  // Reject traversal before touching the filesystem, then re-check the resolved
  // path: a decoded segment must never be able to climb out of the upload root.
  for (const seg of parts) {
    if (!seg || seg === "." || seg === ".." || /[\\/\0]/.test(seg)) return notFound();
  }
  const target = path.resolve(ROOT, ...parts);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return notFound();

  const ext = path.extname(target).toLowerCase();
  const type = TYPES[ext];
  if (!type) return notFound();

  let bytes: Buffer;
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return notFound();
    bytes = await fs.readFile(target);
  } catch {
    return notFound();
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(bytes.byteLength),
      // Stored names carry a timestamp, so a given URL's bytes never change.
      // Private: these are a yard's own photographs, not public assets.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
