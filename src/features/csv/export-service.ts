import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DecodedIdToken } from "firebase-admin/auth";
import mongoose from "mongoose";
import { z } from "zod";
import { ApiError } from "@/lib/api/errors";
import { requireConfig } from "@/lib/config/required";
import { CommentModel, ExpenseModel, UserModel } from "@/lib/db/models";
import { activeUser, bucketForUser } from "@/features/identity/service";
import { localDate } from "@/features/scheduling/dates";

export const csvColumns = [
  "Date",
  "Description",
  "PaidBy",
  "Category",
  "Platform",
  "Payment Mode",
  "Bank Account",
  "Amount",
  "Currency",
  "Added By",
  "Notes",
  "Comments",
  "Status",
] as const;
const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const filters = z
  .object({
    from: day.optional(),
    toExclusive: day.optional(),
    categoryId: objectId.optional(),
    accountId: objectId.optional(),
    platformId: objectId.optional(),
    paidByUserId: objectId.optional(),
    paymentMode: z.enum(["upi", "cash", "neft", "imps", "credit_card"]).optional(),
    q: z.string().trim().max(100).optional(),
    status: z
      .enum(["scheduled", "conversion_needed", "archive_review", "actual", "pending_processing"])
      .optional(),
  })
  .strict();
const selection = z
  .object({
    filters: filters.default({}),
    scope: z.enum(["filtered", "all"]),
    includeScheduled: z.boolean().default(false),
  })
  .strict();
const tokenInput = z
  .object({ exportToken: z.string().max(4096), cursor: z.string().max(4096).optional() })
  .strict();
const completeInput = z
  .object({ exportToken: z.string().max(4096), completionCursor: z.string().max(4096) })
  .strict();

function sign(payload: string) {
  return createHmac("sha256", requireConfig("API_CURSOR_SECRET", process.env.API_CURSOR_SECRET))
    .update(payload)
    .digest("base64url");
}
function seal(value: object) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function open(raw: string) {
  try {
    const [payload, mac, extra] = raw.split(".");
    const expected = sign(payload);
    if (
      extra ||
      !mac ||
      mac.length !== expected.length ||
      !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
    )
      throw new Error();
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "INVALID_EXPORT_TOKEN", "Start a new export.");
  }
}
function query(bucketId: string, input: z.infer<typeof selection>, today: string) {
  const f = input.scope === "all" ? {} : input.filters;
  const match: Record<string, unknown> = {
    bucketId,
    deletedAt: null,
    postingState: input.includeScheduled ? { $in: ["posted", "unposted"] } : "posted",
    ...(f.from || f.toExclusive
      ? {
          expenseDate: {
            ...(f.from ? { $gte: f.from } : {}),
            ...(f.toExclusive ? { $lt: f.toExclusive } : {}),
          },
        }
      : {}),
    ...Object.fromEntries(
      (["categoryId", "accountId", "platformId", "paidByUserId", "paymentMode"] as const)
        .filter((key) => f[key])
        .map((key) => [key, f[key]]),
    ),
  };
  const range = (match.expenseDate ?? {}) as Record<string, string>;
  if (f.status === "scheduled") match.expenseDate = { ...range, $gt: today };
  if (f.status === "conversion_needed") match["conversion.status"] = "missing";
  if (f.status === "archive_review") match.reviewState = "archive_review_required";
  if (f.status === "actual") {
    match.postingState = "posted";
    match.expenseDate = { ...range, $lte: today };
  }
  if (f.status === "pending_processing") {
    match.postingState = "unposted";
    match.expenseDate = { ...range, $lte: today };
    match["conversion.status"] = { $ne: "missing" };
  }
  if (f.q) {
    const expression = f.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    match.$or = ["description", "notes", "referenceLabels.platform"].map((field) => ({
      [field]: { $regex: expression, $options: "i" },
    }));
  }
  return match;
}
async function exportContext(identity: DecodedIdToken, bucketId: string) {
  const user = await activeUser(identity);
  const bucket = await bucketForUser(bucketId, user);
  return { user, bucket };
}
function status(expense: InstanceType<typeof ExpenseModel>, today: string) {
  if (expense.reviewState === "archive_review_required") return "Review required";
  if (expense.expenseDate > today) return "Scheduled";
  if (expense.conversion?.status === "missing") return "Conversion needed";
  if (expense.postingState === "unposted") return "Pending processing";
  return "Actual";
}

export async function exportPreview(identity: DecodedIdToken, bucketId: string, raw: unknown) {
  const input = selection.parse(raw);
  if (
    input.filters.from &&
    input.filters.toExclusive &&
    input.filters.from >= input.filters.toExclusive
  )
    throw new ApiError(422, "INVALID_RANGE", "The end date must be after the start date.");
  const { bucket } = await exportContext(identity, bucketId);
  const match = query(bucketId, input, localDate(new Date(), bucket.timezone));
  const [count, scheduledCount, conversionNeededCount] = await Promise.all([
    ExpenseModel.countDocuments(match),
    ExpenseModel.countDocuments({ ...match, postingState: "unposted" }),
    ExpenseModel.countDocuments({ ...match, "conversion.status": "missing" }),
  ]);
  return {
    columns: csvColumns,
    count,
    scheduledCount,
    conversionNeededCount,
    excludedDeleted: true,
    exportRevision: bucket.exportRevision,
    message: "CSV contains expense rows, not a full backup of plans or audit history.",
  };
}

export async function startExport(identity: DecodedIdToken, bucketId: string, raw: unknown) {
  const input = selection.parse(raw);
  const preview = await exportPreview(identity, bucketId, input);
  const { user, bucket } = await exportContext(identity, bucketId);
  const expiresAt = Date.now() + 30 * 60_000;
  const exportToken = seal({
    kind: "export",
    bucketId,
    userId: String(user._id),
    input,
    revision: bucket.exportRevision,
    expiresAt,
  });
  return { exportToken, expiresAt: new Date(expiresAt).toISOString(), ...preview };
}

async function authorizedToken(identity: DecodedIdToken, bucketId: string, raw: string) {
  const token = open(raw);
  const { user, bucket } = await exportContext(identity, bucketId);
  if (
    token.kind !== "export" ||
    token.userId !== String(user._id) ||
    token.bucketId !== bucketId ||
    typeof token.expiresAt !== "number" ||
    token.expiresAt < Date.now()
  )
    throw new ApiError(403, "EXPORT_UNAVAILABLE", "Start a new export.");
  if (token.revision !== bucket.exportRevision)
    throw new ApiError(409, "EXPORT_CHANGED", "Expenses changed during export. Start again.");
  return { token, input: selection.parse(token.input), bucket };
}

export async function exportPage(identity: DecodedIdToken, bucketId: string, raw: unknown) {
  const request = tokenInput.parse(raw);
  const { token, input, bucket } = await authorizedToken(identity, bucketId, request.exportToken);
  const today = localDate(new Date(), bucket.timezone);
  let after: string | null = null;
  if (request.cursor) {
    const value = open(request.cursor);
    if (
      value.kind !== "page" ||
      value.exportToken !== request.exportToken ||
      !objectId.safeParse(value.after).success
    )
      throw new ApiError(400, "INVALID_CURSOR", "Restart export.");
    after = value.after as string;
  }
  const rows = await ExpenseModel.find({
    ...query(bucketId, input, today),
    ...(after ? { _id: { $gt: new mongoose.Types.ObjectId(after) } } : {}),
  })
    .sort({ _id: 1 })
    .limit(101);
  const page = rows.slice(0, 100);
  const comments = await CommentModel.find({
    expenseId: { $in: page.map((row) => row._id) },
    deletedAt: null,
  }).sort({ createdAt: 1 });
  const people = await UserModel.find({
    _id: {
      $in: [
        ...page.flatMap((row) => [row.paidByUserId, row.addedByUserId]),
        ...comments.map((row) => row.authorUserId),
      ],
    },
  }).select("displayName");
  const names = new Map(people.map((row) => [String(row._id), row.displayName]));
  const byExpense = new Map<string, string[]>();
  for (const comment of comments) {
    const expenseId = String(comment.expenseId);
    const list = byExpense.get(expenseId) ?? [];
    list.push(
      `${names.get(String(comment.authorUserId)) ?? "Former member"} (${comment.createdAt.toISOString()}): ${comment.body}`,
    );
    byExpense.set(expenseId, list);
  }
  const data = page.map((row) => ({
    id: String(row._id),
    cells: [
      `${row.expenseDate.slice(8, 10)}/${row.expenseDate.slice(5, 7)}/${row.expenseDate.slice(0, 4)}`,
      row.description,
      names.get(String(row.paidByUserId)) ?? "Former member",
      row.referenceLabels?.category ?? "Category",
      row.referenceLabels?.platform ?? "Other",
      row.paymentMode,
      row.referenceLabels?.account ?? "Account",
      row.originalAmount.toString(),
      row.originalCurrency,
      names.get(String(row.addedByUserId)) ?? "Former member",
      row.notes ?? "",
      (byExpense.get(String(row._id)) ?? []).join("\n"),
      status(row, today),
    ],
  }));
  const last = page.at(-1);
  const hasMore = rows.length > 100;
  const cursor =
    hasMore && last
      ? seal({ kind: "page", exportToken: request.exportToken, after: String(last._id) })
      : null;
  const completionCursor = !hasMore
    ? seal({
        kind: "complete",
        exportToken: request.exportToken,
        lastId: last ? String(last._id) : after,
      })
    : null;
  const { bucket: latestBucket } = await exportContext(identity, bucketId);
  if (latestBucket.exportRevision !== token.revision)
    throw new ApiError(409, "EXPORT_CHANGED", "Expenses changed during export. Start again.");
  return { rows: data, cursor, hasMore, completionCursor };
}

export async function completeExport(identity: DecodedIdToken, bucketId: string, raw: unknown) {
  const request = completeInput.parse(raw);
  const { input, bucket } = await authorizedToken(identity, bucketId, request.exportToken);
  const cursor = open(request.completionCursor);
  if (cursor.kind !== "complete" || cursor.exportToken !== request.exportToken)
    throw new ApiError(400, "INVALID_CURSOR", "Finish every export page before downloading.");
  const last = await ExpenseModel.findOne(
    query(bucketId, input, localDate(new Date(), bucket.timezone)),
  )
    .sort({ _id: -1 })
    .select("_id");
  if ((last ? String(last._id) : null) !== cursor.lastId)
    throw new ApiError(409, "EXPORT_CHANGED", "Expenses changed during export. Start again.");
  return { complete: true, columns: csvColumns };
}
