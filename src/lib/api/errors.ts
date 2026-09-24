export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function assertRevision(header: string | null, revision: number) {
  if (!header) throw new ApiError(428, "PRECONDITION_REQUIRED", "Refresh this page before saving.");
  if (header !== `"r${revision}"`) throw new ApiError(412, "REVISION_MISMATCH", "This changed in another session. Refresh and try again.");
}

export function requireIdempotencyKey(request: Request) {
  const key = request.headers.get("Idempotency-Key");
  if (!key || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new ApiError(400, "MALFORMED_REQUEST", "A valid operation key is required.");
  return key;
}

export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ApiError(400, "MALFORMED_REQUEST", "Send a JSON request.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "MALFORMED_REQUEST", "A JSON body is required.");
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 256 * 1024) { await reader.cancel(); throw new ApiError(413, "PAYLOAD_TOO_LARGE", "The request is too large."); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError(400, "MALFORMED_REQUEST", "The request is not valid JSON."); }
}
