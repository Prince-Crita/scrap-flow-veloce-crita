import { apiUrl } from "@/shared/config/paths";

/**
 * The frontend's single door to the backend.
 *
 * Every network call the UI makes goes through `getJson` / `sendJson` / `upload`
 * here, and every one of them resolves its URL through `apiUrl()` — so the API
 * base is configured in exactly one place (`src/shared/config/paths.ts`) and no
 * component ever writes an origin, a port or a base path.
 *
 * Call sites keep passing plain contract paths (`/api/stock`,
 * `/api/vendors/${id}`), which is what makes them readable and what keeps the
 * API contract visible at the call site. Only the resolution changes.
 *
 * `credentials` is deliberately not set: the default `same-origin` is what
 * carries the Auth.js session cookie, and it is exactly right while the API is
 * served from this application. If `NEXT_PUBLIC_API_ORIGIN` is ever pointed at a
 * different host, that is the one switch to revisit — see the note there.
 */

export class ApiError extends Error {
  code: string;
  fields?: Record<string, string>;
  constructor(code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.code = code;
    this.fields = fields;
  }
}

async function handle<T>(res: Response): Promise<T> {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; fields?: Record<string, string> } }).error;
    throw new ApiError(err?.code ?? "ERROR", err?.message ?? "Something went wrong", err?.fields);
  }
  return json as T;
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(apiUrl(url), { cache: "no-store" });
  return handle<T>(res);
}

export async function sendJson<T>(
  url: string,
  body?: unknown,
  method: "POST" | "PATCH" | "PUT" | "DELETE" = "POST"
): Promise<T> {
  const res = await fetch(apiUrl(url), {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handle<T>(res);
}

/**
 * A fresh idempotency key for one user-initiated write.
 *
 * Generate it ONCE when the operator starts the action and reuse it across
 * retries — that is what makes a retry idempotent. Generating a new key per
 * attempt would defeat the whole mechanism.
 */
export function newRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
