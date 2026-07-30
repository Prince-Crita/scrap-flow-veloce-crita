import { promises as fs } from "fs";
import path from "path";
import type { ImageFormat } from "@/lib/image-validate";

/**
 * Storage abstraction. Production (Vercel) uses Vercel Blob; local dev writes
 * to /public/uploads so the app is fully functional without a Blob token.
 *
 * Takes VERIFIED bytes and a VERIFIED format, never a data URL. Size checking
 * and file-signature detection happen at the API boundary
 * (`src/lib/image-validate.ts`), so nothing here has to decide whether it is
 * looking at an image — and the stored extension can never be derived from a
 * client-supplied MIME type, which is how it used to work.
 */
export interface StoredFile {
  url: string;
}

/**
 * Thrown when there is nowhere durable to put the bytes.
 *
 * A distinct type rather than a generic Error so the API boundary can answer
 * with an actionable message and a 503 (temporarily misconfigured) instead of a
 * blanket 500 (we broke). The upload route already wraps `storeImage` in
 * try/catch, so this degrades to a clean JSON error — it never crashes a
 * request or the process.
 */
export class StorageNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageNotConfiguredError";
  }
}

const CONTENT_TYPE: Record<ImageFormat, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
};

export async function storeImage(
  bytes: Buffer,
  keyParts: {
    yardId: string;
    lotNumber?: string;
    kind: string;
    index?: number;
    /** Detected from the file signature, not declared by the client. */
    format: ImageFormat;
  }
): Promise<StoredFile> {
  const date = new Date().toISOString().slice(0, 10);
  const ext = keyParts.format;
  const folder = keyParts.lotNumber ?? "misc";
  const name = `${keyParts.kind}${keyParts.index != null ? `-${keyParts.index}` : ""}-${Date.now()}.${ext}`;
  // Yard-partitioned key space: one yard's assets can never be listed, guessed,
  // or bulk-exported alongside another's, and per-yard storage is measurable.
  const relPath = `uploads/${keyParts.yardId}/${date}/${folder}/${name}`;

  /**
   * Read at call time, never captured at module scope. That is what makes the
   * token hot-swappable: add BLOB_READ_WRITE_TOKEN in the Vercel dashboard and
   * the next upload picks it up on the new deployment with no code change.
   */
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    const { put } = await import("@vercel/blob");
    /**
     * `access: "private"` — the store is a PRIVATE Blob store, and it rejects a
     * public write outright ("Cannot use public access on a private store"),
     * which is what every production upload was failing on.
     *
     * Private is also the correct policy here: these are weighbridge slips and
     * vehicle plates belonging to one yard, never public assets. It matches the
     * `Cache-Control: private` the local serving route already sets.
     */
    await put(relPath, bytes, {
      access: "private",
      token,
      contentType: CONTENT_TYPE[ext],
    });
    /**
     * Return the RELATIVE path, not the absolute blob URL.
     *
     * A private blob is not fetchable by URL, so handing one to an <img> would
     * render a broken image. `/uploads/...` is served by
     * `src/app/uploads/[...path]/route.ts`, which is session-gated by middleware
     * and now reads through to Blob — so the browser gets the bytes only with a
     * valid session.
     *
     * This is also the shape already in the database (verified: all 22 existing
     * image rows are relative `/uploads/...`), so old and new rows resolve
     * through exactly the same path and no schema or data migration is needed.
     */
    return { url: `/${relPath}` };
  }

  /**
   * No token. On Vercel the filesystem is READ-ONLY, so the fallback below
   * cannot work there — it would throw EROFS from deep inside `fs.writeFile`
   * and surface as an opaque "Could not store image". Fail fast instead, with a
   * message that names the missing variable, so the cause is obvious in the
   * response and in the logs rather than something to be reverse-engineered.
   *
   * Deliberately keyed on `process.env.VERCEL` and not on NODE_ENV: a
   * self-hosted production deployment has a writable disk and is *meant* to use
   * the fallback (that is what `src/app/uploads/[...path]/route.ts` serves).
   * Only Vercel is excluded, and only because of the read-only disk.
   */
  if (process.env.VERCEL) {
    throw new StorageNotConfiguredError(
      "Image storage is not configured. BLOB_READ_WRITE_TOKEN is missing, and Vercel's filesystem is read-only so there is no local fallback. Add the token in the Vercel dashboard (Storage → Blob store), then redeploy — uploads resume immediately, no code change needed."
    );
  }

  // Local / self-hosted fallback: write under /public and serve via the
  // /uploads/[...path] route.
  const publicDir = path.join(process.cwd(), "public", "uploads", keyParts.yardId, date, folder);
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(path.join(publicDir, name), bytes);
  return { url: `/${relPath}` };
}
