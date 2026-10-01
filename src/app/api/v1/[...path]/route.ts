import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { authenticate } from "@/lib/api/auth";
import { ApiError, readJson, requireIdempotencyKey } from "@/lib/api/errors";
import { connectDatabase } from "@/lib/db/mongoose";
import {
  activeUser,
  bootstrap,
  bucketDto,
  createBucket,
  createInvitation,
  joinInvitation,
  limit,
  listBuckets,
  previewInvitation,
  profileDto,
  updateProfile,
} from "@/features/identity/service";
import { currencies } from "@/features/identity/contracts";
import { changeOption, createOption, listOptions } from "@/features/expenses/reference-service";
import {
  changeComment,
  changeExpense,
  conversionPreview,
  createExpense,
  expenseActivity,
  expenseSummary,
  getExpense,
  linkedRefunds,
  listComments,
  listExpenses,
} from "@/features/expenses/service";
import {
  listInvitations,
  listMembers,
  removeMember,
  revokeInvitation,
} from "@/features/expenses/member-service";
import { optionKinds, type OptionKind } from "@/features/expenses/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const requestId = randomUUID();
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    Vary: "Authorization",
    "Referrer-Policy": "no-referrer",
  });
  try {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site")
      throw new ApiError(403, "FORBIDDEN", "Use Buckit to make this request.");
    const path = (await context.params).path
      .join("/")
      .replace(
        /^buckets\/([a-f\d]{24})\/(accounts|categories|platforms)(?=\/|$)/i,
        "buckets/$1/options/$2",
      );
    const method = request.method;
    const identity = await authenticate(request);
    await connectDatabase();
    await limit(
      identity,
      path.includes("invitations") ? "invitations" : "api",
      path.includes("invitations") ? 20 : 120,
    );
    if (path !== "me/bootstrap") await activeUser(identity);
    let data: unknown;
    let status = 200;
    let meta: Record<string, unknown> = { requestId };
    if (method === "GET" && path === "me")
      data = await profileDto(await activeUser(identity), identity);
    else if (method === "GET" && path === "buckets") {
      const result = await listBuckets(identity, url.searchParams.get("cursor"));
      data = result.data;
      meta = { ...meta, nextCursor: result.nextCursor, hasMore: result.hasMore };
    } else if (method === "GET" && /^buckets\/[a-f\d]{24}$/i.test(path))
      data = await bucketDto(path.split("/")[1], await activeUser(identity));
    else if (method === "GET" && path === "capabilities")
      data = {
        currencies: currencies.map((c) => ({ ...c, precision: c.code === "JPY" ? 0 : 2 })),
        phase: 2,
      };
    else if (
      /^buckets\/[a-f\d]{24}\/options\/(accounts|categories|platforms)$/i.test(path) &&
      method === "GET"
    )
      data = await listOptions(
        identity,
        path.split("/")[1],
        path.split("/")[3] as OptionKind,
        url.searchParams.get("state"),
      );
    else if (/^buckets\/[a-f\d]{24}\/expenses$/i.test(path) && method === "GET") {
      const result = await listExpenses(identity, path.split("/")[1], url.searchParams);
      data = result.data;
      meta = { ...meta, nextCursor: result.nextCursor, hasMore: result.hasMore };
    } else if (/^buckets\/[a-f\d]{24}\/expenses\/summary$/i.test(path) && method === "GET")
      data = await expenseSummary(identity, path.split("/")[1], url.searchParams.get("month"));
    else if (/^buckets\/[a-f\d]{24}\/expenses\/[a-f\d]{24}$/i.test(path) && method === "GET")
      data = await getExpense(identity, path.split("/")[1], path.split("/")[3]);
    else if (
      /^buckets\/[a-f\d]{24}\/expenses\/[a-f\d]{24}\/refunds$/i.test(path) &&
      method === "GET"
    )
      data = await linkedRefunds(identity, path.split("/")[1], path.split("/")[3]);
    else if (
      /^buckets\/[a-f\d]{24}\/expenses\/[a-f\d]{24}\/activity$/i.test(path) &&
      method === "GET"
    )
      data = await expenseActivity(identity, path.split("/")[1], path.split("/")[3]);
    else if (
      /^buckets\/[a-f\d]{24}\/expenses\/[a-f\d]{24}\/comments$/i.test(path) &&
      method === "GET"
    )
      data = await listComments(identity, path.split("/")[1], path.split("/")[3]);
    else if (/^buckets\/[a-f\d]{24}\/members$/i.test(path) && method === "GET")
      data = await listMembers(identity, path.split("/")[1]);
    else if (/^buckets\/[a-f\d]{24}\/invitations$/i.test(path) && method === "GET")
      data = await listInvitations(identity, path.split("/")[1]);
    else if (method === "POST" && path === "invitations/preview")
      data = await previewInvitation(identity, await readJson(request));
    else if (method === "POST" && /^buckets\/[a-f\d]{24}\/conversion-preview$/i.test(path)) {
      await limit(identity, "conversion-preview", 20);
      data = await conversionPreview(identity, path.split("/")[1], await readJson(request));
    } else {
      const parts = path.split("/");
      const bucketId = parts[0] === "buckets" ? parts[1] : "";
      const optionKind =
        parts[2] === "options" && parts[3] in optionKinds ? (parts[3] as OptionKind) : null;
      const supportedMutation =
        (method === "POST" &&
          (path === "me/bootstrap" ||
            path === "buckets" ||
            path === "invitations/join" ||
            /^buckets\/[a-f\d]{24}\/(invitations|expenses|options\/(accounts|categories|platforms))$/i.test(
              path,
            ) ||
            /^buckets\/[a-f\d]{24}\/expenses\/[a-f\d]{24}\/restore$/i.test(path) ||
            /^buckets\/[a-f\d]{24}\/expenses\/[a-f\d]{24}\/comments$/i.test(path) ||
            /^buckets\/[a-f\d]{24}\/options\/(accounts|categories|platforms)\/[a-f\d]{24}\/(archive|restore)$/i.test(
              path,
            ))) ||
        (method === "PATCH" &&
          (path === "me" ||
            /^buckets\/[a-f\d]{24}\/(expenses\/[a-f\d]{24}|expenses\/[a-f\d]{24}\/comments\/[a-f\d]{24}|options\/(accounts|categories|platforms)\/[a-f\d]{24})$/i.test(
              path,
            ))) ||
        (method === "DELETE" &&
          /^buckets\/[a-f\d]{24}\/(expenses\/[a-f\d]{24}|expenses\/[a-f\d]{24}\/comments\/[a-f\d]{24}|members\/[a-f\d]{24}|invitations\/[a-f\d]{24}|options\/(accounts|categories|platforms)\/[a-f\d]{24})$/i.test(
            path,
          )) ||
        (method === "PUT" &&
          /^buckets\/[a-f\d]{24}\/expenses\/[a-f\d]{24}\/conversion$/i.test(path));
      if (!supportedMutation)
        throw new ApiError(404, "RESOURCE_NOT_FOUND", "This endpoint is not available.");
      const key = requireIdempotencyKey(request);
      const body =
        method === "DELETE" || path.endsWith("/archive") || path.endsWith("/restore")
          ? {}
          : await readJson(request);
      let result;
      if (method === "POST" && path === "me/bootstrap")
        result = await bootstrap(identity, body, key);
      else if (method === "PATCH" && path === "me")
        result = await updateProfile(identity, body, key, request.headers.get("if-match"));
      else if (method === "POST" && path === "buckets")
        result = await createBucket(identity, body, key);
      else if (method === "POST" && /^buckets\/[a-f\d]{24}\/invitations$/i.test(path))
        result = await createInvitation(identity, path.split("/")[1], body, key, url.origin);
      else if (method === "POST" && path === "invitations/join")
        result = await joinInvitation(identity, body, key);
      else if (optionKind && parts.length === 4 && method === "POST")
        result = await createOption(identity, bucketId, optionKind, body, key);
      else if (optionKind && parts.length >= 5)
        result = await changeOption(
          identity,
          bucketId,
          optionKind,
          parts[4],
          method as "PATCH" | "POST" | "DELETE",
          method === "DELETE"
            ? "delete"
            : method === "PATCH"
              ? "edit"
              : (parts[5] as "archive" | "restore"),
          body,
          key,
          request.headers.get("if-match"),
        );
      else if (parts[2] === "expenses" && parts.length === 3 && method === "POST")
        result = await createExpense(identity, bucketId, body, key);
      else if (
        parts[2] === "expenses" &&
        parts[4] === "comments" &&
        parts.length === 5 &&
        method === "POST"
      )
        result = await changeComment(
          identity,
          bucketId,
          parts[3],
          null,
          "create",
          body,
          key,
          request.headers.get("if-match"),
        );
      else if (parts[2] === "expenses" && parts[4] === "comments" && parts.length === 6)
        result = await changeComment(
          identity,
          bucketId,
          parts[3],
          parts[5],
          method === "DELETE" ? "delete" : "edit",
          body,
          key,
          request.headers.get("if-match"),
        );
      else if (parts[2] === "expenses" && parts[4] === "conversion" && method === "PUT")
        result = await changeExpense(
          identity,
          bucketId,
          parts[3],
          "edit",
          { manualConversion: body },
          key,
          request.headers.get("if-match"),
        );
      else if (parts[2] === "expenses" && parts.length >= 4)
        result = await changeExpense(
          identity,
          bucketId,
          parts[3],
          method === "DELETE" ? "delete" : method === "PATCH" ? "edit" : "restore",
          body,
          key,
          request.headers.get("if-match"),
        );
      else if (parts[2] === "members" && parts.length === 4 && method === "DELETE")
        result = await removeMember(
          identity,
          bucketId,
          parts[3],
          key,
          request.headers.get("if-match"),
        );
      else if (parts[2] === "invitations" && parts.length === 4 && method === "DELETE")
        result = await revokeInvitation(
          identity,
          bucketId,
          parts[3],
          key,
          request.headers.get("if-match"),
        );
      else throw new ApiError(404, "RESOURCE_NOT_FOUND", "This endpoint is not available.");
      data = result.data;
      status = result.status;
      if ("location" in result && result.location) headers.set("Location", result.location);
    }
    if (data && typeof data === "object" && "revision" in data)
      headers.set("ETag", `"r${data.revision}"`);
    return Response.json({ data, meta }, { status, headers });
  } catch (error) {
    if (error instanceof ZodError)
      return Response.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            message: "Check the highlighted fields.",
            fieldErrors: error.issues.map((issue) => ({
              path: issue.path.join("."),
              code: issue.code,
              message: issue.message,
            })),
            retryable: false,
          },
          meta: { requestId },
        },
        { status: 422, headers },
      );
    let failure =
      error instanceof ApiError
        ? error
        : new ApiError(
            503,
            "SERVICE_UNAVAILABLE",
            "Buckit could not connect to its services. Please try again shortly.",
          );
    if ((error as { code?: number }).code === 11000)
      failure = new ApiError(
        409,
        "OPERATION_IN_PROGRESS",
        "Another request is finishing. Retry this operation.",
      );
    if ([429, 503, 409].includes(failure.status)) headers.set("Retry-After", "60");
    return Response.json(
      {
        error: {
          code: failure.code,
          message: failure.message,
          retryable:
            [429, 503].includes(failure.status) || failure.code === "OPERATION_IN_PROGRESS",
        },
        meta: { requestId },
      },
      { status: failure.status, headers },
    );
  }
}

export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
