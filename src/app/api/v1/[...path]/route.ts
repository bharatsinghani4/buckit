import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { authenticate } from "@/lib/api/auth";
import { ApiError, readJson, requireIdempotencyKey } from "@/lib/api/errors";
import { connectDatabase } from "@/lib/db/mongoose";
import { activeUser, bootstrap, bucketDto, createBucket, createInvitation, joinInvitation, limit, listBuckets, previewInvitation, profileDto, updateProfile } from "@/features/identity/service";
import { currencies } from "@/features/identity/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const requestId = randomUUID();
  const headers = new Headers({ "Cache-Control": "private, no-store", "Vary": "Authorization", "Referrer-Policy": "no-referrer" });
  try {
    const url = new URL(request.url); const origin = request.headers.get("origin");
    if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") throw new ApiError(403, "FORBIDDEN", "Use Buckit to make this request.");
    const path = (await context.params).path.join("/"); const method = request.method;
    const identity = await authenticate(request);
    await connectDatabase();
    await limit(identity, path.includes("invitations") ? "invitations" : "api", path.includes("invitations") ? 20 : 120);
    if (path !== "me/bootstrap") await activeUser(identity);
    let data: unknown; let status = 200;
    let meta: Record<string, unknown> = { requestId };
    if (method === "GET" && path === "me") data = await profileDto(await activeUser(identity), identity);
    else if (method === "GET" && path === "buckets") { const result = await listBuckets(identity, url.searchParams.get("cursor")); data = result.data; meta = { ...meta, nextCursor: result.nextCursor, hasMore: result.hasMore }; }
    else if (method === "GET" && /^buckets\/[a-f\d]{24}$/i.test(path)) data = await bucketDto(path.split("/")[1], await activeUser(identity));
    else if (method === "GET" && path === "capabilities") data = { currencies: currencies.map((c) => ({ ...c, precision: c.code === "JPY" ? 0 : 2 })), phase: 1 };
    else if (method === "POST" && path === "invitations/preview") data = await previewInvitation(identity, await readJson(request));
    else {
      const supportedMutation = (method === "POST" && (path === "me/bootstrap" || path === "buckets" || path === "invitations/join" || /^buckets\/[a-f\d]{24}\/invitations$/i.test(path))) || (method === "PATCH" && path === "me");
      if (!supportedMutation) throw new ApiError(404, "RESOURCE_NOT_FOUND", "This endpoint is not available.");
      const key = requireIdempotencyKey(request); const body = await readJson(request); let result;
      if (method === "POST" && path === "me/bootstrap") result = await bootstrap(identity, body, key);
      else if (method === "PATCH" && path === "me") result = await updateProfile(identity, body, key, request.headers.get("if-match"));
      else if (method === "POST" && path === "buckets") result = await createBucket(identity, body, key);
      else if (method === "POST" && /^buckets\/[a-f\d]{24}\/invitations$/i.test(path)) result = await createInvitation(identity, path.split("/")[1], body, key, url.origin);
      else if (method === "POST" && path === "invitations/join") result = await joinInvitation(identity, body, key);
      else throw new ApiError(404, "RESOURCE_NOT_FOUND", "This endpoint is not available.");
      data = result.data; status = result.status;
      if ("location" in result && result.location) headers.set("Location", result.location);
    }
    if (data && typeof data === "object" && "revision" in data) headers.set("ETag", `"r${data.revision}"`);
    return Response.json({ data, meta }, { status, headers });
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ error: { code: "VALIDATION_FAILED", message: "Check the highlighted fields.", fieldErrors: error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message })), retryable: false }, meta: { requestId } }, { status: 422, headers });
    let failure = error instanceof ApiError ? error : new ApiError(503, "SERVICE_UNAVAILABLE", "Buckit could not connect to its services. Please try again shortly.");
    if ((error as { code?: number }).code === 11000) failure = new ApiError(409, "OPERATION_IN_PROGRESS", "Another request is finishing. Retry this operation.");
    if ([429, 503, 409].includes(failure.status)) headers.set("Retry-After", "60");
    return Response.json({ error: { code: failure.code, message: failure.message, retryable: [429, 503].includes(failure.status) || failure.code === "OPERATION_IN_PROGRESS" }, meta: { requestId } }, { status: failure.status, headers });
  }
}

export { handle as GET, handle as POST, handle as PATCH };
