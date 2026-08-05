import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { getUser } from "@/lib/api";
import { LOCAL_UPLOAD_DIR } from "@/lib/storage";

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
 * ── Access ───────────────────────────────────────────────────────────────────
 * Middleware requires a session for /uploads. That alone was not enough: every
 * stored path begins with the owning yard's id, so any signed-in operator who
 * learned (or guessed from an API response) another yard's URL could read that
 * yard's photographs — weighbridge slips, vehicles, number plates. The rest of
 * the app is scoped by `yardId` from the session and never from input; this
 * route now says the same thing. A platform ADMIN still reads any yard, because
 * the console renders those images by design.
 */

export const dynamic = "force-dynamic";

/**
 * Private store for locally-written uploads. Not under `public/`, so it is never
 * answered by Next's static handler and always passes through the yard check
 * above.
 */
const ROOT = path.join(process.cwd(), LOCAL_UPLOAD_DIR);
/**
 * Where uploads landed before they were moved out of `public/`. Read-only
 * fallback so historical rows keep resolving; nothing new is written here.
 */
const LEGACY_ROOT = path.join(process.cwd(), "public", "uploads");

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
  const legacyTarget = path.resolve(LEGACY_ROOT, ...parts);
  if (legacyTarget !== LEGACY_ROOT && !legacyTarget.startsWith(LEGACY_ROOT + path.sep)) return notFound();

  /**
   * Yard isolation. The first segment is the owning yard's id.
   *
   * 404 rather than 403 throughout: a "forbidden" answer confirms that the file
   * exists, which is itself a leak, and the rest of this route already answers
   * 404 for everything it will not serve.
   */
  const user = await getUser();
  if (!user) return notFound();
  if (user.role !== "ADMIN" && parts[0] !== user.yardId) return notFound();

  const ext = path.extname(target).toLowerCase();
  const type = TYPES[ext];
  if (!type) return notFound();

  /**
   * Blob-backed read, tried first whenever a token exists.
   *
   * Uploads go to a PRIVATE Blob store, so the stored bytes are not reachable by
   * URL — this route is the only way to see them, and middleware already
   * requires a session for /uploads, so the session check is not duplicated
   * here (same policy as the disk path below, deliberately unchanged).
   *
   * The blob's pathname is exactly this route's path minus the leading slash,
   * because `storeImage` writes `uploads/<yardId>/<date>/<lot>/<name>` and
   * returns `/<that>`. One key shape, one lookup.
   *
   * Falls through to disk on a miss rather than 404-ing, so a yard that has rows
   * from the local/self-hosted era keeps rendering them after Blob is switched on.
   */
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    try {
      const { get } = await import("@vercel/blob");
      const found = await get(["uploads", ...parts].join("/"), { access: "private", token });
      if (found && found.statusCode === 200) {
        return new NextResponse(found.stream, {
          headers: {
            "Content-Type": found.blob.contentType || type,
            "Cache-Control": "private, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
    } catch (e) {
      // A Blob outage must not take out images that also exist on disk.
      console.error("[uploads] blob read failed; falling back to disk", e);
    }
  }

  // Private store first, then the historical `public/uploads` location.
  let bytes: Buffer | null = null;
  for (const candidate of [target, legacyTarget]) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) continue;
      bytes = await fs.readFile(candidate);
      break;
    } catch {
      /* try the next location */
    }
  }
  if (!bytes) return notFound();

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
