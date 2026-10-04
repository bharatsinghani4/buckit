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
  resolveArchiveExpense,
} from "@/features/expenses/service";
import {
  listInvitations,
  listMembers,
  removeMember,
  revokeInvitation,
} from "@/features/expenses/member-service";
import { optionKinds, type OptionKind } from "@/features/expenses/contracts";
import {
  changeBudget,
  createBudget,
  getBudget,
  getBudgetUsage,
  listBudgets,
} from "@/features/insights/budget-service";
import { dashboard, spendingReport } from "@/features/insights/report-service";
import {
  changeInstallment,
  changePlan,
  createPlan,
  getPlan,
  listInstallments,
  listPlans,
  listScheduled,
  previewPlan,
} from "@/features/scheduling/service";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from "@/features/notifications/preferences-service";
import {
  changeReminder,
  createReminder,
  listReminders,
} from "@/features/notifications/reminder-service";
import {
  fanoutPendingEvents,
  listNotifications,
  markNotificationsRead,
  unreadCount,
} from "@/features/notifications/inbox-service";
import {
  listPushInstallations,
  registerPushInstallation,
  revokePushInstallation,
} from "@/features/notifications/push-service";
import {
  changeContact,
  createContact,
  getContact,
  grantShares,
  hideContact,
  listContacts,
  listShares,
  revokeShare,
  shareCandidates,
} from "@/features/contacts/service";
import {
  completeExport,
  exportPage,
  exportPreview,
  startExport,
} from "@/features/csv/export-service";
import {
  cancelImport,
  commitNext,
  confirmImport,
  createImport,
  getImport,
  importGuidance,
  importTemplate,
  listImportRows,
  reopenImport,
  resolveImport,
  stageChunk,
  validateImport,
} from "@/features/csv/import-service";
import {
  accountDeletionPreview,
  bucketDeletionPreview,
  changeArchive,
  deleteAccount,
  deleteBucket,
  getBucketSettings,
  getOperation,
  leaveBucket,
  listBucketActivity,
  transferOwnership,
  updateBucketSettings,
} from "@/features/lifecycle/service";

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
    if (path === "contacts/share-candidates") await limit(identity, "contact-candidates", 30);
    if (path.includes("/imports/")) await limit(identity, "imports", 60);
    if (path !== "me/bootstrap" && path !== "me/deletion") await activeUser(identity);
    let data: unknown;
    let status = 200;
    let meta: Record<string, unknown> = { requestId };
    if (method === "GET" && path === "me/deletion-preview")
      data = await accountDeletionPreview(identity);
    else if (method === "GET" && /^operations\/[a-f\d]{24}$/i.test(path))
      data = await getOperation(identity, path.split("/")[1]);
    else if (method === "GET" && /^buckets\/[a-f\d]{24}\/settings$/i.test(path))
      data = await getBucketSettings(identity, path.split("/")[1]);
    else if (method === "GET" && /^buckets\/[a-f\d]{24}\/activity$/i.test(path)) {
      const result = await listBucketActivity(identity, path.split("/")[1], url.searchParams);
      data = result.data;
      meta = { ...meta, nextCursor: result.nextCursor, hasMore: result.hasMore };
    } else if (method === "GET" && /^buckets\/[a-f\d]{24}\/deletion-preview$/i.test(path))
      data = await bucketDeletionPreview(identity, path.split("/")[1]);
    else if (method === "POST" && path === "me/deletion") {
      const result = await deleteAccount(
        identity,
        await readJson(request),
        requireIdempotencyKey(request),
      );
      data = result.data;
      status = result.status;
    } else if (/^buckets\/[a-f\d]{24}\/deletion$/i.test(path) && method === "POST") {
      const result = await deleteBucket(
        identity,
        path.split("/")[1],
        await readJson(request),
        requireIdempotencyKey(request),
        request.headers.get("if-match"),
      );
      data = result.data;
      status = result.status;
    } else if (/^buckets\/[a-f\d]{24}\/ownership-transfer$/i.test(path) && method === "POST") {
      const result = await transferOwnership(
        identity,
        path.split("/")[1],
        await readJson(request),
        requireIdempotencyKey(request),
        request.headers.get("if-match"),
      );
      data = result.data;
      status = result.status;
    } else if (/^buckets\/[a-f\d]{24}\/leave$/i.test(path) && method === "POST") {
      const result = await leaveBucket(
        identity,
        path.split("/")[1],
        requireIdempotencyKey(request),
        request.headers.get("if-match"),
      );
      data = result.data;
      status = result.status;
    } else if (/^buckets\/[a-f\d]{24}\/(archive|restore)$/i.test(path) && method === "POST") {
      const result = await changeArchive(
        identity,
        path.split("/")[1],
        path.split("/")[2] as "archive" | "restore",
        requireIdempotencyKey(request),
        request.headers.get("if-match"),
      );
      data = result.data;
      status = result.status;
    } else if (/^buckets\/[a-f\d]{24}$/i.test(path) && method === "PATCH") {
      const result = await updateBucketSettings(
        identity,
        path.split("/")[1],
        await readJson(request),
        requireIdempotencyKey(request),
        request.headers.get("if-match"),
      );
      data = result.data;
      status = result.status;
    } else if (
      method === "GET" &&
      /^buckets\/[a-f\d]{24}\/imports\/(template|guidance)$/i.test(path)
    ) {
      data = path.endsWith("/template")
        ? await importTemplate(identity, path.split("/")[1])
        : await importGuidance(identity, path.split("/")[1]);
    } else if (method === "POST" && /^buckets\/[a-f\d]{24}\/imports$/i.test(path)) {
      const result = await createImport(
        identity,
        path.split("/")[1],
        await readJson(request),
        requireIdempotencyKey(request),
      );
      data = result.data;
      status = result.status;
      if ("location" in result && typeof result.location === "string")
        headers.set("Location", result.location);
    } else if (/^buckets\/[a-f\d]{24}\/imports\/[a-f\d]{24}$/i.test(path) && method === "GET")
      data = await getImport(identity, path.split("/")[1], path.split("/")[3]);
    else if (/^buckets\/[a-f\d]{24}\/imports\/[a-f\d]{24}\/rows$/i.test(path) && method === "GET") {
      const result = await listImportRows(
        identity,
        path.split("/")[1],
        path.split("/")[3],
        url.searchParams,
      );
      data = result.data;
      meta = { ...meta, nextCursor: result.nextCursor, hasMore: result.hasMore };
    } else if (
      /^buckets\/[a-f\d]{24}\/imports\/[a-f\d]{24}\/chunks\/\d+$/i.test(path) &&
      method === "PUT"
    ) {
      const result = await stageChunk(
        identity,
        path.split("/")[1],
        path.split("/")[3],
        Number(path.split("/")[5]),
        await readJson(request, 512 * 1024),
        requireIdempotencyKey(request),
        request.headers.get("if-match"),
      );
      data = result.data;
      status = result.status;
    } else if (
      /^buckets\/[a-f\d]{24}\/imports\/[a-f\d]{24}\/resolution$/i.test(path) &&
      method === "PATCH"
    ) {
      const result = await resolveImport(
        identity,
        path.split("/")[1],
        path.split("/")[3],
        await readJson(request),
        requireIdempotencyKey(request),
        request.headers.get("if-match"),
      );
      data = result.data;
      status = result.status;
    } else if (
      /^buckets\/[a-f\d]{24}\/imports\/[a-f\d]{24}\/validate$/i.test(path) &&
      method === "POST"
    )
      data = await validateImport(identity, path.split("/")[1], path.split("/")[3]);
    else if (
      /^buckets\/[a-f\d]{24}\/imports\/[a-f\d]{24}\/(confirm|commit-next|reopen|cancel)$/i.test(
        path,
      ) &&
      method === "POST"
    ) {
      const parts = path.split("/");
      const result =
        parts[4] === "confirm"
          ? await confirmImport(
              identity,
              parts[1],
              parts[3],
              await readJson(request),
              requireIdempotencyKey(request),
              request.headers.get("if-match"),
            )
          : parts[4] === "commit-next"
            ? await commitNext(identity, parts[1], parts[3], requireIdempotencyKey(request))
            : parts[4] === "reopen"
              ? await reopenImport(
                  identity,
                  parts[1],
                  parts[3],
                  requireIdempotencyKey(request),
                  request.headers.get("if-match"),
                )
              : await cancelImport(identity, parts[1], parts[3], requireIdempotencyKey(request));
      data = result.data;
      status = result.status;
    } else if (
      method === "POST" &&
      /^buckets\/[a-f\d]{24}\/exports\/(preview|start|page|complete)$/i.test(path)
    ) {
      const bucketId = path.split("/")[1];
      const operation = path.split("/")[3];
      const body = await readJson(request);
      data =
        operation === "preview"
          ? await exportPreview(identity, bucketId, body)
          : operation === "start"
            ? await startExport(identity, bucketId, body)
            : operation === "page"
              ? await exportPage(identity, bucketId, body)
              : await completeExport(identity, bucketId, body);
    } else if (method === "GET" && path === "contacts") {
      const result = await listContacts(identity, url.searchParams);
      data = result.data;
      meta = { ...meta, nextCursor: result.nextCursor, hasMore: result.hasMore };
    } else if (method === "GET" && path === "contacts/share-candidates") {
      const result = await shareCandidates(identity, url.searchParams);
      data = result.data;
      meta = { ...meta, nextCursor: result.nextCursor, hasMore: result.hasMore };
    } else if (method === "GET" && /^contacts\/[a-f\d]{24}$/i.test(path))
      data = await getContact(identity, path.split("/")[1]);
    else if (method === "GET" && /^contacts\/[a-f\d]{24}\/shares$/i.test(path))
      data = await listShares(identity, path.split("/")[1]);
    else if (method === "POST" && path === "contacts") {
      const result = await createContact(
        identity,
        await readJson(request),
        requireIdempotencyKey(request),
      );
      data = result.data;
      status = result.status;
      if ("location" in result && typeof result.location === "string")
        headers.set("Location", result.location);
    } else if (
      (method === "PATCH" || method === "DELETE") &&
      /^contacts\/[a-f\d]{24}$/i.test(path)
    ) {
      const result = await changeContact(
        identity,
        path.split("/")[1],
        method === "DELETE" ? "delete" : "edit",
        method === "DELETE" ? {} : await readJson(request),
        requireIdempotencyKey(request),
        request.headers.get("if-match"),
      );
      data = result.data;
      status = result.status;
    } else if (method === "POST" && /^contacts\/[a-f\d]{24}\/shares$/i.test(path)) {
      const result = await grantShares(
        identity,
        path.split("/")[1],
        await readJson(request),
        requireIdempotencyKey(request),
      );
      data = result.data;
      status = result.status;
    } else if (method === "DELETE" && /^contacts\/[a-f\d]{24}\/shares\/[a-f\d]{24}$/i.test(path)) {
      const result = await revokeShare(
        identity,
        path.split("/")[1],
        path.split("/")[3],
        requireIdempotencyKey(request),
        request.headers.get("if-match"),
      );
      data = result.data;
      status = result.status;
    } else if (method === "POST" && /^contacts\/[a-f\d]{24}\/hide$/i.test(path)) {
      const result = await hideContact(
        identity,
        path.split("/")[1],
        requireIdempotencyKey(request),
        request.headers.get("if-match"),
      );
      data = result.data;
      status = result.status;
    } else if (method === "GET" && path === "me")
      data = await profileDto(await activeUser(identity), identity);
    else if (method === "GET" && path === "me/notification-preferences")
      data = await getNotificationPreferences(identity);
    else if (method === "GET" && path === "me/reminders") data = await listReminders(identity);
    else if (method === "GET" && path === "me/push-installations")
      data = await listPushInstallations(identity);
    else if (method === "PUT" && /^me\/push-installations\/[0-9a-f-]{36}$/i.test(path)) {
      const result = await registerPushInstallation(
        identity,
        path.split("/")[2],
        await readJson(request),
        requireIdempotencyKey(request),
        request.headers.get("if-match"),
      );
      data = result.data;
      status = result.status;
    } else if (method === "DELETE" && /^me\/push-installations\/[0-9a-f-]{36}$/i.test(path)) {
      const result = await revokePushInstallation(
        identity,
        path.split("/")[2],
        requireIdempotencyKey(request),
        request.headers.get("if-match"),
      );
      data = result.data;
      status = result.status;
    } else if (method === "GET" && path === "notifications/unread-count")
      data = await unreadCount(identity);
    else if (method === "GET" && path === "notifications") {
      await fanoutPendingEvents(5);
      const result = await listNotifications(
        identity,
        url.searchParams.get("filter") === "unread",
        url.searchParams.get("cursor"),
      );
      data = result.data;
      meta = { ...meta, nextCursor: result.nextCursor, hasMore: result.hasMore };
    } else if (method === "POST" && path === "notifications/read") {
      const result = await markNotificationsRead(
        identity,
        await readJson(request),
        requireIdempotencyKey(request),
      );
      data = result.data;
      status = result.status;
    } else if (method === "POST" && path === "me/reminders") {
      const result = await createReminder(
        identity,
        await readJson(request),
        requireIdempotencyKey(request),
      );
      data = result.data;
      status = result.status;
      if ("location" in result && result.location) headers.set("Location", result.location);
    } else if (
      (method === "PATCH" || method === "DELETE") &&
      /^me\/reminders\/[a-f\d]{24}$/i.test(path)
    ) {
      const result = await changeReminder(
        identity,
        path.split("/")[2],
        method === "DELETE" ? "delete" : "edit",
        method === "DELETE" ? {} : await readJson(request),
        requireIdempotencyKey(request),
        request.headers.get("if-match"),
      );
      data = result.data;
      status = result.status;
    } else if (method === "PATCH" && path === "me/notification-preferences") {
      const result = await updateNotificationPreferences(
        identity,
        await readJson(request),
        request.headers.get("if-match"),
        requireIdempotencyKey(request),
      );
      data = result.data;
      status = result.status;
    } else if (method === "GET" && path === "buckets") {
      const result = await listBuckets(identity, url.searchParams.get("cursor"));
      data = result.data;
      meta = { ...meta, nextCursor: result.nextCursor, hasMore: result.hasMore };
    } else if (method === "GET" && /^buckets\/[a-f\d]{24}$/i.test(path))
      data = await bucketDto(path.split("/")[1], await activeUser(identity));
    else if (method === "GET" && path === "capabilities")
      data = {
        currencies: currencies.map((c) => ({ ...c, precision: c.code === "JPY" ? 0 : 2 })),
        phase: 7,
      };
    else if (method === "GET" && /^buckets\/[a-f\d]{24}\/dashboard$/i.test(path))
      data = await dashboard(identity, path.split("/")[1], url.searchParams);
    else if (method === "GET" && /^buckets\/[a-f\d]{24}\/reports\/spending$/i.test(path))
      data = await spendingReport(identity, path.split("/")[1], url.searchParams);
    else if (method === "GET" && /^buckets\/[a-f\d]{24}\/scheduled-expenses$/i.test(path))
      data = await listScheduled(identity, path.split("/")[1]);
    else if (method === "GET" && /^buckets\/[a-f\d]{24}\/emi-plans$/i.test(path))
      data = await listPlans(identity, path.split("/")[1], url.searchParams.get("state"));
    else if (method === "GET" && /^buckets\/[a-f\d]{24}\/emi-plans\/[a-f\d]{24}$/i.test(path))
      data = await getPlan(identity, path.split("/")[1], path.split("/")[3]);
    else if (
      method === "GET" &&
      /^buckets\/[a-f\d]{24}\/emi-plans\/[a-f\d]{24}\/installments$/i.test(path)
    ) {
      const result = await listInstallments(
        identity,
        path.split("/")[1],
        path.split("/")[3],
        url.searchParams.get("cursor"),
      );
      data = result.data;
      meta = { ...meta, nextCursor: result.nextCursor, hasMore: result.hasMore };
    } else if (method === "POST" && /^buckets\/[a-f\d]{24}\/emi-plans\/preview$/i.test(path))
      data = await previewPlan(identity, path.split("/")[1], await readJson(request));
    else if (method === "GET" && /^buckets\/[a-f\d]{24}\/budgets$/i.test(path))
      data = await listBudgets(
        identity,
        path.split("/")[1],
        url.searchParams.get("month") ?? "",
        url.searchParams.get("scope"),
        url.searchParams.get("state"),
      );
    else if (method === "GET" && /^buckets\/[a-f\d]{24}\/budgets\/[a-f\d]{24}$/i.test(path))
      data = await getBudget(identity, path.split("/")[1], path.split("/")[3]);
    else if (method === "GET" && /^buckets\/[a-f\d]{24}\/budgets\/[a-f\d]{24}\/usage$/i.test(path))
      data = await getBudgetUsage(
        identity,
        path.split("/")[1],
        path.split("/")[3],
        url.searchParams.get("month") ?? "",
      );
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
      data = await listMembers(identity, path.split("/")[1], url.searchParams.get("state"));
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
            /^buckets\/[a-f\d]{24}\/(invitations|expenses|budgets|emi-plans|options\/(accounts|categories|platforms))$/i.test(
              path,
            ) ||
            /^buckets\/[a-f\d]{24}\/emi-plans\/[a-f\d]{24}\/end$/i.test(path) ||
            /^buckets\/[a-f\d]{24}\/emi-plans\/[a-f\d]{24}\/installments\/[a-f\d]{24}\/(skip|reschedule)$/i.test(
              path,
            ) ||
            /^buckets\/[a-f\d]{24}\/expenses\/[a-f\d]{24}\/archive-resolution$/i.test(path) ||
            /^buckets\/[a-f\d]{24}\/expenses\/[a-f\d]{24}\/restore$/i.test(path) ||
            /^buckets\/[a-f\d]{24}\/expenses\/[a-f\d]{24}\/comments$/i.test(path) ||
            /^buckets\/[a-f\d]{24}\/options\/(accounts|categories|platforms)\/[a-f\d]{24}\/(archive|restore)$/i.test(
              path,
            ))) ||
        (method === "PATCH" &&
          (path === "me" ||
            /^buckets\/[a-f\d]{24}\/(budgets\/[a-f\d]{24}|emi-plans\/[a-f\d]{24}|expenses\/[a-f\d]{24}|expenses\/[a-f\d]{24}\/comments\/[a-f\d]{24}|options\/(accounts|categories|platforms)\/[a-f\d]{24})$/i.test(
              path,
            ))) ||
        (method === "DELETE" &&
          /^buckets\/[a-f\d]{24}\/(budgets\/[a-f\d]{24}|expenses\/[a-f\d]{24}|expenses\/[a-f\d]{24}\/comments\/[a-f\d]{24}|members\/[a-f\d]{24}|invitations\/[a-f\d]{24}|options\/(accounts|categories|platforms)\/[a-f\d]{24})$/i.test(
            path,
          )) ||
        (method === "PUT" &&
          /^buckets\/[a-f\d]{24}\/expenses\/[a-f\d]{24}\/conversion$/i.test(path));
      if (!supportedMutation)
        throw new ApiError(404, "RESOURCE_NOT_FOUND", "This endpoint is not available.");
      const key = requireIdempotencyKey(request);
      const body =
        method === "DELETE" ||
        path.endsWith("/archive") ||
        path.endsWith("/restore") ||
        path.endsWith("/end") ||
        path.endsWith("/skip")
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
      else if (parts[2] === "budgets" && parts.length === 3 && method === "POST")
        result = await createBudget(identity, bucketId, body, key);
      else if (parts[2] === "budgets" && parts.length === 4)
        result = await changeBudget(
          identity,
          bucketId,
          parts[3],
          method === "DELETE" ? "delete" : "edit",
          body,
          key,
          request.headers.get("if-match"),
        );
      else if (parts[2] === "emi-plans" && parts.length === 3 && method === "POST")
        result = await createPlan(identity, bucketId, body, key);
      else if (parts[2] === "emi-plans" && parts.length === 4 && method === "PATCH")
        result = await changePlan(
          identity,
          bucketId,
          parts[3],
          "edit",
          body,
          key,
          request.headers.get("if-match"),
        );
      else if (parts[2] === "emi-plans" && parts[4] === "end")
        result = await changePlan(
          identity,
          bucketId,
          parts[3],
          "end",
          body,
          key,
          request.headers.get("if-match"),
        );
      else if (parts[2] === "emi-plans" && parts[4] === "installments" && parts.length === 7)
        result = await changeInstallment(
          identity,
          bucketId,
          parts[3],
          parts[5],
          parts[6] as "skip" | "reschedule",
          body,
          key,
          request.headers.get("if-match"),
        );
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
      else if (parts[2] === "expenses" && parts[4] === "archive-resolution" && method === "POST")
        result = await resolveArchiveExpense(
          identity,
          bucketId,
          parts[3],
          body,
          key,
          request.headers.get("if-match"),
        );
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
      if ("location" in result && typeof result.location === "string")
        headers.set("Location", result.location);
    }
    if (data && typeof data === "object" && "revision" in data)
      headers.set("ETag", `"r${data.revision}"`);
    if (
      method !== "GET" &&
      ((path.startsWith("buckets/") &&
        !path.endsWith("/preview") &&
        !path.includes("/imports") &&
        !path.includes("/exports")) ||
        path.startsWith("contacts") ||
        path === "invitations/join")
    )
      await fanoutPendingEvents(5).catch(() => {
        // The event is durable; the daily worker retries delivery independently.
      });
    if (status === 204) return new Response(null, { status, headers });
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
