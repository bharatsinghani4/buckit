import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { DecodedIdToken } from "firebase-admin/auth";
import mongoose, { type ClientSession } from "mongoose";
import { z } from "zod";
import { ApiError, assertRevision } from "@/lib/api/errors";
import {
  AuditModel,
  BucketModel,
  ExpenseModel,
  ImportRowModel,
  ImportSessionModel,
  MembershipModel,
  OptionModel,
  UserModel,
} from "@/lib/db/models";
import { activeUser, bucketForUser, mutate } from "@/features/identity/service";
import { expenseInput, type ExpenseInput } from "@/features/expenses/contracts";
import { conversionFor, validateReferences } from "@/features/expenses/service";
import { captureBudgetUsage, reconcileBudgetThresholds } from "@/features/insights/budget-service";
import { dueInstant, localDate } from "@/features/scheduling/dates";
import { csvColumns } from "./export-service";

const id = z.string().regex(/^[a-f\d]{24}$/i);
const metadata = z
  .object({
    fileName: z.string().min(1).max(255),
    fileHash: z.string().regex(/^[a-f\d]{64}$/i),
    fileSize: z
      .number()
      .int()
      .min(1)
      .max(5 * 1024 * 1024),
    rowCount: z.number().int().min(1).max(5000),
    headers: z.array(z.string().max(120)).min(1).max(50),
  })
  .strict();
const chunkInput = z
  .object({
    rows: z
      .array(
        z
          .object({
            rowNumber: z.number().int().min(1).max(5000),
            cells: z.array(z.string().max(4000)).max(50),
          })
          .strict(),
      )
      .min(1)
      .max(250),
  })
  .strict();
const column = z.enum(csvColumns);
const resolutionInput = z
  .object({
    mapping: z.partialRecord(column, z.number().int().min(0).max(49)).optional(),
    rows: z
      .array(
        z
          .object({
            rowNumber: z.number().int().min(1).max(5000),
            corrections: z.partialRecord(column, z.string().max(4000)).optional(),
            excluded: z.boolean().optional(),
            duplicateDecision: z.enum(["include", "skip", "undecided"]).optional(),
          })
          .strict(),
      )
      .max(250)
      .optional(),
    proposedOptions: z
      .array(
        z
          .object({
            kind: z.enum(["category", "account", "platform"]),
            name: z.string().trim().min(1).max(80),
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict();
const confirmInput = z
  .object({
    previewDigest: z.string().min(32).max(128),
    acknowledgments: z
      .array(z.enum(["defaults", "ignored_comments", "duplicates", "conversion"]))
      .min(1),
  })
  .strict();
const missing = () => new ApiError(404, "RESOURCE_NOT_FOUND", "This import is unavailable.");
const stale = () =>
  new ApiError(409, "PREVIEW_STALE", "The import preview changed. Validate it again.");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const decimal = (value: string) => mongoose.Types.Decimal128.fromString(value);
const requiredColumns = [
  "Date",
  "Description",
  "PaidBy",
  "Category",
  "Payment Mode",
  "Bank Account",
  "Amount",
] as const;

function initialMapping(headers: string[]) {
  return Object.fromEntries(
    csvColumns.flatMap((name) => {
      const index = headers.findIndex(
        (header) => header.trim().toLowerCase() === name.toLowerCase(),
      );
      return index < 0 ? [] : [[name, index]];
    }),
  );
}
function strictDate(value: string) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}
function sessionDto(
  item: InstanceType<typeof ImportSessionModel>,
  counts?: Record<string, number>,
) {
  return {
    id: String(item._id),
    state: item.state,
    fileName: item.fileName,
    rowCount: item.rowCount,
    headers: item.headers,
    mapping: Object.fromEntries(item.mapping ?? []),
    proposedOptions: item.proposedOptions ?? [],
    revision: item.revision,
    previewDigest: item.previewDigest ?? null,
    counts: counts ?? null,
  };
}
async function authorized(
  identity: DecodedIdToken,
  bucketId: string,
  sessionId: string,
  dbSession?: ClientSession,
) {
  const user = await activeUser(identity, dbSession);
  await bucketForUser(bucketId, user, dbSession);
  if (!id.safeParse(sessionId).success) throw missing();
  const item = await ImportSessionModel.findOne({
    _id: sessionId,
    bucketId,
    importerUserId: user._id,
  }).session(dbSession ?? null);
  if (!item) throw missing();
  return { user, item };
}
async function counts(sessionId: string) {
  const rows = await ImportRowModel.aggregate([
    { $match: { sessionId: new mongoose.Types.ObjectId(sessionId) } },
    { $group: { _id: "$state", count: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((row) => [row._id, row.count])) as Record<string, number>;
}
export async function importTemplate(identity: DecodedIdToken, bucketId: string) {
  const user = await activeUser(identity);
  await bucketForUser(bucketId, user);
  return {
    fileName: "buckit-expenses-template.csv",
    columns: csvColumns,
    csv: `${csvColumns.join(",")}\r\n`,
  };
}
export async function importGuidance(identity: DecodedIdToken, bucketId: string) {
  const user = await activeUser(identity);
  await bucketForUser(bucketId, user);
  const choices = await context(bucketId, String(user._id), []);
  return {
    columns: csvColumns,
    maxBytes: 5 * 1024 * 1024,
    maxRows: 5000,
    chunkMaxBytes: 512 * 1024,
    dateFormat: "DD/MM/YYYY",
    acknowledgments: ["defaults", "ignored_comments", "duplicates", "conversion"],
    isOwner: choices.isOwner,
    currentMembers: choices.members,
    formerMembers: choices.formerMembers,
    options: choices.options,
    rules: [
      "Blank Currency uses the bucket currency; Platform uses Other; Added By uses you; Notes is empty.",
      "Date, Description and nonzero Amount are required. Resolve a current or former bucket payer, category, bank account and payment mode before import.",
      "Negative amounts are credits. Future dates become scheduled entries. Conversion may remain unresolved.",
      "Comments are ignored and Status is derived. You always own imported entries.",
      "Only bucket owners can attribute Added By to another current or former member or create reference options.",
      "Duplicate warnings require an explicit include or skip choice; import creates no notifications.",
    ],
  };
}
export async function createImport(
  identity: DecodedIdToken,
  bucketId: string,
  raw: unknown,
  key: string,
) {
  const input = metadata.parse(raw);
  return mutate(
    identity,
    `imports/${bucketId}/create`,
    key,
    input,
    async (session) => {
      const user = await activeUser(identity, session);
      await bucketForUser(bucketId, user, session, true);
      const membership = await MembershipModel.findOne({
        bucketId,
        userId: user._id,
        state: "active",
      }).session(session);
      if (!membership) throw missing();
      const [item] = await ImportSessionModel.create(
        [
          {
            bucketId,
            importerUserId: user._id,
            creatorMembershipId: membership._id,
            ...input,
            mapping: initialMapping(input.headers),
            expiresAt: new Date(Date.now() + 7 * 86_400_000),
          },
        ],
        { session },
      );
      return {
        resourceId: String(item._id),
        status: 201,
        data: sessionDto(item),
        location: `/api/v1/buckets/${bucketId}/imports/${item._id}`,
      };
    },
    async (sessionId, session) => {
      const { item } = await authorized(identity, bucketId, sessionId, session);
      return sessionDto(item);
    },
  );
}
export async function getImport(identity: DecodedIdToken, bucketId: string, sessionId: string) {
  const { item } = await authorized(identity, bucketId, sessionId);
  return sessionDto(item, await counts(sessionId));
}
export async function stageChunk(
  identity: DecodedIdToken,
  bucketId: string,
  sessionId: string,
  chunkNumber: number,
  raw: unknown,
  key: string,
  revision: string | null,
) {
  const input = chunkInput.parse(raw);
  if (Buffer.byteLength(JSON.stringify(input)) > 512 * 1024)
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Upload smaller chunks.");
  if (new Set(input.rows.map((row) => row.rowNumber)).size !== input.rows.length)
    throw new ApiError(422, "DUPLICATE_ROW", "A chunk contains the same row number twice.");
  return mutate(
    identity,
    `imports/${sessionId}/chunk/${chunkNumber}`,
    key,
    { input, revision },
    async (session) => {
      const { user, item } = await authorized(identity, bucketId, sessionId, session);
      await bucketForUser(bucketId, user, session, true);
      assertRevision(revision, item.revision);
      if (item.state !== "preview") throw stale();
      if (
        input.rows.some(
          (row) => row.rowNumber > item.rowCount || row.cells.length > item.headers.length,
        )
      )
        throw new ApiError(422, "INVALID_ROW", "A row exceeds the declared file shape.");
      const existing = await ImportRowModel.find({
        sessionId,
        $or: [{ chunkNumber }, { rowNumber: { $in: input.rows.map((row) => row.rowNumber) } }],
      }).session(session);
      if (existing.length)
        throw new ApiError(
          409,
          "CHUNK_EXISTS",
          "This chunk was already staged. Start a new import to replace it.",
        );
      await ImportRowModel.insertMany(
        input.rows.map((row) => ({ ...row, sessionId, bucketId, chunkNumber })),
        { session },
      );
      item.revision += 1;
      item.previewDigest = undefined;
      await item.save({ session });
      return { resourceId: sessionId, status: 200, data: sessionDto(item) };
    },
    async (_, session) =>
      sessionDto((await authorized(identity, bucketId, sessionId, session)).item),
  );
}
export async function resolveImport(
  identity: DecodedIdToken,
  bucketId: string,
  sessionId: string,
  raw: unknown,
  key: string,
  revision: string | null,
) {
  const input = resolutionInput.parse(raw);
  return mutate(
    identity,
    `imports/${sessionId}/resolution`,
    key,
    { input, revision },
    async (session) => {
      const { user, item } = await authorized(identity, bucketId, sessionId, session);
      await bucketForUser(bucketId, user, session, true);
      assertRevision(revision, item.revision);
      if (item.state !== "preview") throw stale();
      if (input.proposedOptions?.length) {
        const bucket = await BucketModel.findById(bucketId).session(session);
        if (String(bucket.ownerUserId) !== String(user._id))
          throw new ApiError(
            403,
            "FORBIDDEN",
            "Only the bucket owner can create reference options.",
          );
        item.proposedOptions = input.proposedOptions;
      }
      if (input.mapping) {
        if (new Set(Object.values(input.mapping)).size !== Object.values(input.mapping).length)
          throw new ApiError(422, "INVALID_MAPPING", "Map each column only once.");
        item.mapping = new Map(Object.entries(input.mapping));
      }
      for (const correction of input.rows ?? []) {
        const row = await ImportRowModel.findOne({
          sessionId,
          rowNumber: correction.rowNumber,
        }).session(session);
        if (!row) throw missing();
        if (row.state === "committed")
          throw new ApiError(409, "ROW_COMMITTED", "Committed rows cannot be changed.");
        if (correction.corrections)
          row.corrections = new Map([
            ...Object.entries(Object.fromEntries(row.corrections ?? [])),
            ...Object.entries(correction.corrections),
          ]);
        if (correction.excluded !== undefined) row.excluded = correction.excluded;
        if (correction.duplicateDecision) row.duplicateDecision = correction.duplicateDecision;
        await row.save({ session });
      }
      item.revision += 1;
      item.previewDigest = undefined;
      await item.save({ session });
      return { resourceId: sessionId, status: 200, data: sessionDto(item) };
    },
    async (_, session) =>
      sessionDto((await authorized(identity, bucketId, sessionId, session)).item),
  );
}

type ValidationContext = {
  userId: string;
  isOwner: boolean;
  bucketCurrency: string;
  members: { id: string; name: string }[];
  formerMembers: { id: string; name: string }[];
  options: { id: string; kind: string; name: string; systemKey?: string }[];
  proposed: { kind: string; name: string }[];
};
async function context(
  bucketId: string,
  userId: string,
  proposed: ValidationContext["proposed"],
  session?: ClientSession,
): Promise<ValidationContext> {
  const bucket = await BucketModel.findById(bucketId).session(session ?? null);
  const memberships = await MembershipModel.find({ bucketId }).session(session ?? null);
  const people = await UserModel.find({
    _id: { $in: [userId, ...memberships.map((row) => row.userId)] },
  }).session(session ?? null);
  const options = await OptionModel.find({ bucketId, state: "active" }).session(session ?? null);
  return {
    userId,
    isOwner: String(bucket.ownerUserId) === userId,
    bucketCurrency: bucket.primaryCurrency,
    members: people
      .filter((person) =>
        memberships.some(
          (membership) =>
            membership.state === "active" && String(membership.userId) === String(person._id),
        ),
      )
      .map((row) => ({ id: String(row._id), name: row.displayName })),
    formerMembers: people.map((row) => ({ id: String(row._id), name: row.displayName })),
    options: options.map((row) => ({
      id: String(row._id),
      kind: row.kind,
      name: row.name,
      systemKey: row.systemKey,
    })),
    proposed,
  };
}
function normalize(
  row: InstanceType<typeof ImportRowModel>,
  item: InstanceType<typeof ImportSessionModel>,
  ctx: ValidationContext,
) {
  const mapping = Object.fromEntries(item.mapping ?? []) as Record<string, number>;
  const cell = (name: string) =>
    (
      row.corrections?.get(name) ??
      (mapping[name] !== undefined ? row.cells[mapping[name]] : "") ??
      ""
    ).trim();
  const errors: string[] = [];
  const warnings: string[] = [];
  const defaults: string[] = [];
  const date = strictDate(cell("Date"));
  if (!date) errors.push("Date must be a real DD/MM/YYYY date.");
  const description = cell("Description");
  if (!description) errors.push("Description is required.");
  const amount = cell("Amount");
  if (!/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(amount) || Number(amount) === 0)
    errors.push("Amount must be a nonzero value with up to two decimals.");
  const currency = cell("Currency") || ctx.bucketCurrency;
  if (!cell("Currency")) defaults.push("Currency");
  const payerText = cell("PaidBy");
  const payerMatches = ctx.formerMembers.filter(
    (member) => member.id === payerText || member.name.toLowerCase() === payerText.toLowerCase(),
  );
  if (payerMatches.length !== 1)
    errors.push("Choose a current or former, unambiguous PaidBy member.");
  const reference = (kind: string, header: string, fallback?: string) => {
    const value = cell(header) || fallback || "";
    if (!cell(header) && fallback) defaults.push(header);
    const matches = ctx.options.filter(
      (option) =>
        option.kind === kind &&
        (option.id === value || option.name.toLowerCase() === value.toLowerCase()),
    );
    const proposed = ctx.proposed.some(
      (option) => option.kind === kind && option.name.toLowerCase() === value.toLowerCase(),
    );
    if (matches.length !== 1 && !proposed) errors.push(`Choose an active, unambiguous ${header}.`);
    return matches.length === 1
      ? matches[0].id
      : proposed
        ? digest(`${kind}:${value.toLowerCase()}`).slice(0, 24)
        : "";
  };
  const categoryId = reference("category", "Category");
  const accountId = reference("account", "Bank Account");
  const platformId = reference("platform", "Platform", "Other");
  const mode = cell("Payment Mode").toLowerCase().replace(/[ -]/g, "_");
  if (!["upi", "cash", "neft", "imps", "credit_card"].includes(mode))
    errors.push("Choose a valid Payment Mode.");
  const addedBy = cell("Added By");
  if (!addedBy) defaults.push("Added By");
  if (addedBy && addedBy !== ctx.userId && !ctx.isOwner)
    errors.push("Only the bucket owner can choose another Added By member.");
  if (
    addedBy &&
    ctx.isOwner &&
    !ctx.formerMembers.some(
      (person) => person.id === addedBy || person.name.toLowerCase() === addedBy.toLowerCase(),
    )
  )
    errors.push("Choose a current or former Added By member.");
  if (cell("Comments")) warnings.push("Comments are ignored.");
  if (cell("Status")) warnings.push("Status is derived from the expense state.");
  if (!cell("Notes")) defaults.push("Notes");
  const raw = {
    expenseDate: date ?? "",
    description,
    paidByUserId: payerMatches.length === 1 ? payerMatches[0].id : "",
    categoryId,
    accountId,
    platformId,
    paymentMode: mode,
    originalAmount: amount,
    originalCurrency: currency,
    notes: cell("Notes"),
  };
  const parsed = expenseInput.safeParse(raw);
  if (!parsed.success)
    errors.push(...parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  return {
    normalized: parsed.success ? (parsed.data as ExpenseInput) : null,
    errors: [...new Set(errors)],
    warnings,
    defaultsApplied: defaults,
    addedByUserId: addedBy
      ? (ctx.formerMembers.find(
          (person) => person.id === addedBy || person.name.toLowerCase() === addedBy.toLowerCase(),
        )?.id ?? ctx.userId)
      : ctx.userId,
  };
}
async function rowPreview(
  row: InstanceType<typeof ImportRowModel>,
  item: InstanceType<typeof ImportSessionModel>,
  ctx: ValidationContext,
  knownCandidates?: string[],
) {
  const resolved = normalize(row, item, ctx);
  const duplicateCandidates: string[] =
    knownCandidates ??
    (resolved.normalized
      ? await ExpenseModel.find({
          bucketId: item.bucketId,
          expenseDate: resolved.normalized.expenseDate,
          description: resolved.normalized.description,
          originalAmount: decimal(resolved.normalized.originalAmount),
          originalCurrency: resolved.normalized.originalCurrency,
          paidByUserId: resolved.normalized.paidByUserId,
          deletedAt: null,
        })
          .select("_id")
          .limit(3)
          .then((rows) => rows.map((candidate) => String(candidate._id)))
      : []);
  const candidates = duplicateCandidates;
  if (candidates.length && row.duplicateDecision === "undecided")
    resolved.errors.push("Choose include or skip for this possible duplicate.");
  const state =
    row.excluded || row.duplicateDecision === "skip"
      ? "excluded"
      : resolved.errors.length
        ? "invalid"
        : "ready";
  return {
    rowNumber: row.rowNumber,
    state: row.state === "committed" ? "committed" : state,
    normalized: resolved.normalized,
    defaultsApplied: resolved.defaultsApplied,
    warnings: resolved.warnings,
    fieldErrors: resolved.errors,
    duplicateCandidates: candidates,
    duplicateDecision: row.duplicateDecision,
    excluded: row.excluded,
    addedByUserId: resolved.addedByUserId,
    expenseId: row.expenseId ? String(row.expenseId) : null,
  };
}
function existingKey(input: ExpenseInput) {
  return JSON.stringify([
    input.expenseDate,
    input.description,
    input.originalAmount,
    input.originalCurrency,
    input.paidByUserId,
  ]);
}
async function existingDuplicates(bucketId: string, inputs: ExpenseInput[]) {
  const result = new Map<string, string[]>();
  const unique = [...new Map(inputs.map((input) => [existingKey(input), input])).values()];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const conditions = unique.slice(offset, offset + 100).map((input) => ({
      expenseDate: input.expenseDate,
      description: input.description,
      originalAmount: decimal(input.originalAmount),
      originalCurrency: input.originalCurrency,
      paidByUserId: new mongoose.Types.ObjectId(input.paidByUserId),
    }));
    const matches = await ExpenseModel.aggregate([
      {
        $match: {
          bucketId: new mongoose.Types.ObjectId(bucketId),
          deletedAt: null,
          $or: conditions,
        },
      },
      {
        $group: {
          _id: {
            expenseDate: "$expenseDate",
            description: "$description",
            originalAmount: "$originalAmount",
            originalCurrency: "$originalCurrency",
            paidByUserId: "$paidByUserId",
          },
          ids: { $push: "$_id" },
        },
      },
      { $project: { ids: { $slice: ["$ids", 3] } } },
    ]);
    for (const match of matches)
      result.set(
        JSON.stringify([
          match._id.expenseDate,
          match._id.description,
          match._id.originalAmount.toString(),
          match._id.originalCurrency,
          String(match._id.paidByUserId),
        ]),
        match.ids.map((id: mongoose.Types.ObjectId) => String(id)),
      );
  }
  return result;
}
export async function validateImport(
  identity: DecodedIdToken,
  bucketId: string,
  sessionId: string,
) {
  const { user, item } = await authorized(identity, bucketId, sessionId);
  if (item.state !== "preview") throw stale();
  const rows = await ImportRowModel.find({ sessionId }).sort({ rowNumber: 1 });
  if (
    rows.length !== item.rowCount ||
    requiredColumns.some((name) => item.mapping?.get(name) === undefined)
  )
    throw new ApiError(422, "IMPORT_INCOMPLETE", "Stage all rows and map every required column.");
  const ctx = await context(bucketId, String(user._id), item.proposedOptions ?? []);
  const normalized = rows
    .map((row) => normalize(row, item, ctx).normalized)
    .filter((value): value is ExpenseInput => Boolean(value));
  const existing = await existingDuplicates(bucketId, normalized);
  const previews: Awaited<ReturnType<typeof rowPreview>>[] = [];
  for (const row of rows) {
    const input = normalize(row, item, ctx).normalized;
    previews.push(
      await rowPreview(row, item, ctx, input ? (existing.get(existingKey(input)) ?? []) : []),
    );
  }
  const fingerprints = previews.map((preview) =>
    preview.normalized
      ? digest({
          date: preview.normalized.expenseDate,
          description: preview.normalized.description.toLowerCase(),
          amount: preview.normalized.originalAmount,
          currency: preview.normalized.originalCurrency,
          payer: preview.normalized.paidByUserId,
          account: preview.normalized.accountId,
        })
      : null,
  );
  const groups = new Map<string, number[]>();
  for (let index = 0; index < fingerprints.length; index++) {
    const fingerprint = fingerprints[index];
    if (!fingerprint || previews[index].excluded || previews[index].state === "committed") continue;
    groups.set(fingerprint, [...(groups.get(fingerprint) ?? []), index]);
  }
  for (let index = 0; index < previews.length; index++) {
    const preview = previews[index];
    if (!fingerprints[index] || preview.excluded || preview.state === "committed") continue;
    const duplicates = (groups.get(fingerprints[index]!) ?? [])
      .filter((otherIndex) => otherIndex !== index)
      .map((otherIndex) => `row:${previews[otherIndex].rowNumber}`);
    preview.duplicateCandidates.push(...duplicates);
    if (duplicates.length && preview.duplicateDecision === "undecided") {
      preview.fieldErrors.push("Choose include or skip for this repeated CSV row.");
      preview.state = "invalid";
    }
  }
  const states = { ready: 0, invalid: 0, excluded: 0, committed: 0 };
  for (const preview of previews) states[preview.state as keyof typeof states] += 1;
  const bucket = await BucketModel.findById(bucketId);
  const previewDigest = digest({
    revision: item.revision,
    exportRevision: bucket.exportRevision,
    rows: previews.map((row) => [
      row.rowNumber,
      row.state,
      row.normalized,
      row.addedByUserId,
      row.duplicateDecision,
      row.excluded,
    ]),
  });
  await ImportRowModel.bulkWrite(
    previews.map((preview, index) => ({
      updateOne: {
        filter: { sessionId, rowNumber: preview.rowNumber, state: { $ne: "committed" } },
        update: {
          $set: {
            state: preview.state,
            fingerprint: fingerprints[index],
            duplicateCandidates: preview.duplicateCandidates,
          },
        },
      },
    })),
  );
  item.previewDigest = previewDigest;
  item.validatedExportRevision = bucket.exportRevision;
  await item.save();
  return {
    previewDigest,
    revision: item.revision,
    counts: states,
    rows: previews.slice(0, 50),
    hasMore: previews.length > 50,
    warnings: ["Import creates no notifications, including budget threshold alerts."],
  };
}
export async function listImportRows(
  identity: DecodedIdToken,
  bucketId: string,
  sessionId: string,
  search: URLSearchParams,
) {
  const { user, item } = await authorized(identity, bucketId, sessionId);
  const after = Number(search.get("after") ?? 0);
  if (!Number.isInteger(after) || after < 0 || after > 5000)
    throw new ApiError(400, "INVALID_CURSOR", "Refresh the import rows.");
  const rows = await ImportRowModel.find({ sessionId, rowNumber: { $gt: after } })
    .sort({ rowNumber: 1 })
    .limit(51);
  const ctx = await context(bucketId, String(user._id), item.proposedOptions ?? []);
  const data = [];
  for (const row of rows.slice(0, 50))
    data.push(await rowPreview(row, item, ctx, row.duplicateCandidates ?? []));
  return {
    data,
    hasMore: rows.length > 50,
    nextCursor: rows.length > 50 ? String(data.at(-1)?.rowNumber) : null,
  };
}
export async function confirmImport(
  identity: DecodedIdToken,
  bucketId: string,
  sessionId: string,
  raw: unknown,
  key: string,
  revision: string | null,
) {
  const input = confirmInput.parse(raw);
  return mutate(
    identity,
    `imports/${sessionId}/confirm`,
    key,
    { input, revision },
    async (session) => {
      const { user, item } = await authorized(identity, bucketId, sessionId, session);
      const bucket = await bucketForUser(bucketId, user, session, true);
      assertRevision(revision, item.revision);
      if (
        item.state !== "preview" ||
        item.previewDigest !== input.previewDigest ||
        item.validatedExportRevision !== bucket.exportRevision
      )
        throw stale();
      const invalid = await ImportRowModel.exists({ sessionId, state: "invalid" }).session(session);
      if (invalid)
        throw new ApiError(422, "IMPORT_INVALID", "Resolve or exclude every invalid row.");
      const all = new Set(input.acknowledgments);
      if (
        ["defaults", "ignored_comments", "duplicates", "conversion"].some(
          (value) => !all.has(value as never),
        )
      )
        throw new ApiError(422, "ACKNOWLEDGMENT_REQUIRED", "Review all import disclosures.");
      item.state = "ready";
      item.acknowledgments = input.acknowledgments;
      item.confirmedRevision = item.revision;
      item.revision += 1;
      await item.save({ session });
      return { resourceId: sessionId, status: 200, data: sessionDto(item) };
    },
    async (_, session) =>
      sessionDto((await authorized(identity, bucketId, sessionId, session)).item),
  );
}

export async function reopenImport(
  identity: DecodedIdToken,
  bucketId: string,
  sessionId: string,
  key: string,
  revision: string | null,
) {
  return mutate(
    identity,
    `imports/${sessionId}/reopen`,
    key,
    { revision },
    async (session) => {
      const { user, item } = await authorized(identity, bucketId, sessionId, session);
      await bucketForUser(bucketId, user, session, true);
      assertRevision(revision, item.revision);
      if (!["ready", "committing", "partial"].includes(item.state)) throw stale();
      if (!(await ImportRowModel.exists({ sessionId, state: "ready" }).session(session)))
        throw stale();
      item.state = "preview";
      item.previewDigest = undefined;
      item.validatedExportRevision = undefined;
      item.revision += 1;
      await item.save({ session });
      return { resourceId: sessionId, status: 200, data: sessionDto(item) };
    },
    async (_, session) =>
      sessionDto((await authorized(identity, bucketId, sessionId, session)).item),
  );
}

export async function commitNext(
  identity: DecodedIdToken,
  bucketId: string,
  sessionId: string,
  key: string,
  rowLimit = 20,
) {
  const { user, item } = await authorized(identity, bucketId, sessionId);
  if (!["ready", "committing", "partial"].includes(item.state)) throw stale();
  const bucket = await bucketForUser(bucketId, user);
  if (bucket.exportRevision !== item.validatedExportRevision) throw stale();
  const rows = await ImportRowModel.find({ sessionId, state: "ready" })
    .sort({ rowNumber: 1 })
    .limit(Math.min(Math.max(rowLimit, 1), 20));
  const ctx = await context(bucketId, String(user._id), item.proposedOptions ?? []);
  const prepared: {
    row: InstanceType<typeof ImportRowModel>;
    input: ExpenseInput;
    conversion: Awaited<ReturnType<typeof conversionFor>>;
  }[] = [];
  for (const row of rows) {
    const normalized = normalize(row, item, ctx);
    if (normalized.errors.length || !normalized.normalized) throw stale();
    prepared.push({
      row,
      input: normalized.normalized,
      conversion: await conversionFor(
        normalized.normalized,
        bucket.primaryCurrency,
        bucket.timezone,
      ),
    });
  }
  return mutate(
    identity,
    `imports/${sessionId}/commit-next`,
    key,
    { rowNumbers: prepared.map((value) => value.row.rowNumber), revision: item.revision },
    async (session) => {
      const actor = await activeUser(identity, session);
      const target = await bucketForUser(bucketId, actor, session, true);
      const current = await ImportSessionModel.findOne({
        _id: sessionId,
        importerUserId: actor._id,
      }).session(session);
      if (
        !current ||
        current.revision !== item.revision ||
        current.validatedExportRevision !== target.exportRevision
      )
        throw stale();
      const membership = await MembershipModel.findOne({
        bucketId,
        userId: actor._id,
        state: "active",
        _id: current.creatorMembershipId,
      }).session(session);
      if (!membership) throw stale();
      if (prepared.length && current.proposedOptions?.length) {
        if (String(target.ownerUserId) !== String(actor._id)) throw stale();
        for (const proposal of current.proposedOptions) {
          const nameKey = proposal.name.trim().toLowerCase();
          const existing = await OptionModel.findOne({
            bucketId,
            kind: proposal.kind,
            nameKey,
          }).session(session);
          if (existing?.state === "archived") throw stale();
          if (!existing)
            await OptionModel.create(
              [
                {
                  bucketId,
                  kind: proposal.kind,
                  name: proposal.name.trim(),
                  nameKey,
                  createdByUserId: actor._id,
                },
              ],
              { session },
            );
        }
      }
      const commitContext = await context(bucketId, String(actor._id), [], session);
      const before = await captureBudgetUsage(
        bucketId,
        prepared.map((entry) => entry.input.expenseDate),
        session,
      );
      const outcomes = [];
      for (const { row, conversion } of prepared) {
        const fresh = await ImportRowModel.findOne({ _id: row._id, state: "ready" }).session(
          session,
        );
        if (!fresh) throw stale();
        const resolved = normalize(fresh, current, commitContext);
        if (resolved.errors.length || !resolved.normalized) throw stale();
        const input = resolved.normalized;
        const refs = await validateReferences(input, bucketId, session, undefined, true).catch(
          () => {
            throw stale();
          },
        );
        const future = input.expenseDate > localDate(new Date(), target.timezone);
        const originKey = `import:${sessionId}:${row.rowNumber}`;
        let expense = await ExpenseModel.findOne({ bucketId, originKey }).session(session);
        if (!expense) {
          [expense] = await ExpenseModel.create(
            [
              {
                bucketId,
                actualCreatorUserId: actor._id,
                creatorMembershipId: membership._id,
                paidByUserId: input.paidByUserId,
                addedByUserId: resolved.addedByUserId,
                expenseDate: input.expenseDate,
                description: input.description,
                notes: input.notes,
                categoryId: refs.category._id,
                accountId: refs.account._id,
                platformId: refs.platform?._id,
                referenceLabels: {
                  category: refs.category.name,
                  account: refs.account.name,
                  platform: refs.platform?.name ?? "Other",
                },
                paymentMode: input.paymentMode,
                originalAmount: decimal(input.originalAmount),
                originalCurrency: input.originalCurrency,
                bucketCurrency: target.primaryCurrency,
                conversion,
                postingState: future || conversion.status === "missing" ? "unposted" : "posted",
                postedAt: future || conversion.status === "missing" ? null : new Date(),
                dueAt: future ? dueInstant(input.expenseDate, target.timezone) : undefined,
                scheduleTimezone: target.timezone,
                source: { kind: "import" },
                originKey,
              },
            ],
            { session },
          );
          await AuditModel.create(
            [
              {
                bucketId,
                actorUserId: actor._id,
                action: "expense.imported",
                entityId: expense._id,
                operationKey: key,
              },
            ],
            { session },
          );
        }
        fresh.state = "committed";
        fresh.expenseId = expense._id;
        fresh.committedAt = new Date();
        fresh.outcome =
          conversion.status === "missing" ? "conversion_needed" : future ? "scheduled" : "actual";
        await fresh.save({ session });
        outcomes.push({
          rowNumber: row.rowNumber,
          expenseId: String(expense._id),
          status: fresh.outcome,
        });
      }
      if (outcomes.length) {
        await BucketModel.updateOne(
          { _id: target._id },
          {
            $set: { currencyLockedAt: target.currencyLockedAt ?? new Date() },
            $inc: { financialRevision: outcomes.length, exportRevision: 1 },
          },
          { session },
        );
        await reconcileBudgetThresholds(
          bucketId,
          prepared.map((entry) => entry.input.expenseDate),
          before,
          session,
          "import_suppressed",
        );
      }
      const pending = await ImportRowModel.countDocuments({ sessionId, state: "ready" }).session(
        session,
      );
      current.state = pending ? "committing" : "completed";
      current.validatedExportRevision = target.exportRevision + (outcomes.length ? 1 : 0);
      current.revision += 1;
      await current.save({ session });
      return {
        resourceId: sessionId,
        status: 200,
        data: {
          state: current.state,
          committed: await ImportRowModel.countDocuments({ sessionId, state: "committed" }).session(
            session,
          ),
          pending,
          outcomes,
          hasMore: pending > 0,
        },
      };
    },
    async (_, session) => {
      const current = (await authorized(identity, bucketId, sessionId, session)).item;
      const pending = await ImportRowModel.countDocuments({ sessionId, state: "ready" }).session(
        session,
      );
      return {
        state: current.state,
        committed: await ImportRowModel.countDocuments({ sessionId, state: "committed" }).session(
          session,
        ),
        pending,
        outcomes: [],
        hasMore: pending > 0,
      };
    },
  );
}

/** Bounded daily fallback for confirmed imports whose browser stopped committing. */
export async function continuePendingImports(deadline = Date.now() + 12_000) {
  const sessions = await ImportSessionModel.find({
    state: { $in: ["ready", "committing"] },
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: 1 })
    .limit(2);
  let committed = 0;
  let reviewed = 0;
  let failed = 0;
  let batches = 0;
  const pending = [...sessions];
  while (pending.length && Date.now() < deadline && batches < 3) {
    const item = pending.shift()!;
    const user = await UserModel.findById(item.importerUserId);
    if (!user || user.status !== "active") {
      failed++;
      continue;
    }
    try {
      const before = await ImportRowModel.countDocuments({
        sessionId: item._id,
        state: "committed",
      });
      const result = await commitNext(
        { uid: user.firebaseUid } as DecodedIdToken,
        String(item.bucketId),
        String(item._id),
        randomUUID(),
        5,
      );
      const progress = result.data as { committed: number; hasMore: boolean };
      committed += Math.max(0, progress.committed - before);
      batches++;
      if (progress.hasMore) pending.push(item);
    } catch (error) {
      if (error instanceof ApiError && error.code === "PREVIEW_STALE") {
        await ImportSessionModel.updateOne(
          { _id: item._id, state: { $in: ["ready", "committing"] } },
          { $set: { state: "partial" } },
        );
        reviewed++;
      } else failed++;
    }
  }
  return {
    committed,
    reviewed,
    failed,
    hasMore: Boolean(
      await ImportSessionModel.exists({
        state: { $in: ["ready", "committing"] },
        expiresAt: { $gt: new Date() },
      }),
    ),
  };
}
export async function cancelImport(
  identity: DecodedIdToken,
  bucketId: string,
  sessionId: string,
  key: string,
) {
  return mutate(
    identity,
    `imports/${sessionId}/cancel`,
    key,
    {},
    async (session) => {
      const { user, item } = await authorized(identity, bucketId, sessionId, session);
      await bucketForUser(bucketId, user, session);
      if (["completed", "canceled"].includes(item.state)) throw stale();
      item.state = "canceled";
      item.revision += 1;
      await item.save({ session });
      return { resourceId: sessionId, status: 200, data: sessionDto(item) };
    },
    async (_, session) =>
      sessionDto((await authorized(identity, bucketId, sessionId, session)).item),
  );
}
