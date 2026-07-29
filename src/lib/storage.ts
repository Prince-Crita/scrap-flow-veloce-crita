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

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    const { put } = await import("@vercel/blob");
    const res = await put(relPath, bytes, {
      access: "public",
      token,
      contentType: CONTENT_TYPE[ext],
    });
    return { url: res.url };
  }

  // Local dev fallback: write under /public and serve statically.
  const publicDir = path.join(process.cwd(), "public", "uploads", keyParts.yardId, date, folder);
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(path.join(publicDir, name), bytes);
  return { url: `/${relPath}` };
}
