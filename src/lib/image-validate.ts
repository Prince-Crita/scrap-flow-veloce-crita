/**
 * Upload validation. Pure, dependency-free, and tested without a server.
 *
 * The threat this closes: `/api/uploads` accepted any string beginning
 * `data:image/`, with no length limit and no verification that the bytes were
 * actually an image. An authenticated yard user could post a multi-hundred-
 * megabyte payload, which was base64-decoded into a Buffer and written out —
 * a memory and storage abuse vector — and the stored file extension came from
 * the attacker's own MIME declaration.
 *
 * Two rules follow from that:
 *   1. Size is checked BEFORE decoding. Measuring the decoded length by
 *      decoding it first would be the abuse.
 *   2. The client's MIME type is never trusted for anything. The format comes
 *      from the file signature in the bytes, and so does the extension.
 */

/** Longest data URL accepted, characters. Base64 is ~4/3 of the byte count. */
export const MAX_DATA_URL_CHARS = 12_000_000; // ≈ 9 MB decoded
/** Hard ceiling on decoded image bytes. A phone photo is 2–5 MB. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Below this it cannot be a real photo; almost certainly a probe. */
export const MIN_IMAGE_BYTES = 64;

export type ImageFormat = "jpg" | "png" | "webp" | "gif" | "bmp";

export type ValidationOk = {
  ok: true;
  /** Detected from the file signature — never from the client's MIME type. */
  format: ImageFormat;
  bytes: Buffer;
  byteLength: number;
};
export type ValidationError = { ok: false; code: string; message: string };
export type ValidationResult = ValidationOk | ValidationError;

const err = (code: string, message: string): ValidationError => ({ ok: false, code, message });

/**
 * Decoded byte length of a base64 string, computed arithmetically.
 *
 * Deliberately does NOT decode: the whole point is to reject an oversized
 * payload before allocating memory for it.
 */
export function base64ByteLength(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (b64.charCodeAt(len - 1) === 61) padding++; // '='
  if (len > 1 && b64.charCodeAt(len - 2) === 61) padding++;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * File-signature ("magic number") detection.
 *
 * Returns null when the bytes are not a recognised image, which is the case
 * that matters: a renamed script, a zip, or an SVG (which can carry script and
 * is deliberately NOT accepted here) all land there.
 */
export function sniffFormat(bytes: Buffer): ImageFormat | null {
  if (bytes.length < 12) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }

  // GIF: "GIF87a" / "GIF89a"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";

  // BMP: "BM"
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";

  return null;
}

/** Formats the app actually stores. GIF and BMP are detected but refused. */
const ALLOWED: ReadonlySet<ImageFormat> = new Set<ImageFormat>(["jpg", "png", "webp"]);

/**
 * Validate a data URL and return the verified bytes.
 *
 * Order is deliberate and load-bearing: cheap string checks, then the
 * arithmetic size check, and only then any allocation.
 */
export function validateImageDataUrl(dataUrl: unknown): ValidationResult {
  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    return err("NOT_A_STRING", "Image payload missing");
  }
  if (dataUrl.length > MAX_DATA_URL_CHARS) {
    return err("TOO_LARGE", `Image exceeds the ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB limit`);
  }

  // Shape only — the declared type is parsed so a malformed URL is rejected,
  // but the value is never used to decide anything.
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,/.exec(dataUrl);
  if (!match) return err("BAD_DATA_URL", "Image must be a base64 data URL");

  const b64 = dataUrl.slice(match[0].length);
  if (b64.length === 0) return err("EMPTY", "Image payload is empty");
  // Reject stray characters before decoding: Buffer.from silently skips them,
  // which would let a payload smuggle bytes past the size arithmetic.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return err("BAD_BASE64", "Image payload is not valid base64");

  const declaredBytes = base64ByteLength(b64);
  if (declaredBytes > MAX_IMAGE_BYTES) {
    return err("TOO_LARGE", `Image exceeds the ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB limit`);
  }
  if (declaredBytes < MIN_IMAGE_BYTES) return err("TOO_SMALL", "Image is too small to be a photo");

  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, "base64");
  } catch {
    return err("BAD_BASE64", "Image payload could not be decoded");
  }

  // Belt and braces: the arithmetic and the actual decode must agree.
  if (bytes.length > MAX_IMAGE_BYTES) {
    return err("TOO_LARGE", `Image exceeds the ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB limit`);
  }

  const format = sniffFormat(bytes);
  if (!format) return err("NOT_AN_IMAGE", "File is not a recognised image");
  if (!ALLOWED.has(format)) return err("UNSUPPORTED_FORMAT", `${format.toUpperCase()} images are not accepted`);

  return { ok: true, format, bytes, byteLength: bytes.length };
}
