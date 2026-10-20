import type { DecodedIdToken } from "firebase-admin/auth";
import type { ClientSession } from "mongoose";
import { z } from "zod";
import { ApiError, assertRevision } from "@/lib/api/errors";
import {
  AuditModel,
  BucketModel,
  CommentModel,
  EmiInstallmentModel,
  EmiPlanModel,
  ExpenseModel,
  MembershipModel,
  OptionModel,
  RecurringPlanModel,
  UserModel,
} from "@/lib/db/models";
import { activeUser, bucketForUser, mutate } from "@/features/identity/service";
import { dueInstant } from "@/features/scheduling/dates";
import { paymentModeOptions } from "@/features/expenses/payment-modes";

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const kinds = ["expense", "emi-plan", "recurring-plan"] as const;
export type MoveKind = (typeof kinds)[number];
const moveInput = z
  .object({
    targetBucketId: objectId,
    referenceMap: z.record(objectId, objectId),
    payerMap: z.record(objectId, objectId),
    paymentModeMap: z.record(z.string(), z.string()).optional(),
  })
  .strict();

type MoveBundle = Awaited<ReturnType<typeof loadBundle>>;

function missing() {
  return new ApiError(404, "RESOURCE_NOT_FOUND", "This record is not available.");
}

async function loadBundle(bucketId: string, kind: MoveKind, id: string, session?: ClientSession) {
  const root =
    kind === "expense"
      ? await ExpenseModel.findOne({ _id: id, bucketId }).session(session ?? null)
      : kind === "emi-plan"
        ? await EmiPlanModel.findOne({ _id: id, bucketId }).session(session ?? null)
        : await RecurringPlanModel.findOne({ _id: id, bucketId }).session(session ?? null);
  if (!root) throw missing();
  if (kind === "expense" && (root as InstanceType<typeof ExpenseModel>).deletedAt)
    throw new ApiError(409, "DELETED_EXPENSE", "Restore this expense before moving it.");
  if (
    kind === "expense" &&
    ((root as InstanceType<typeof ExpenseModel>).source?.emiPlanId ||
      (root as InstanceType<typeof ExpenseModel>).source?.recurringPlanId)
  )
    throw new ApiError(409, "LINKED_RECORD", "Move the parent plan with its full history.");
  const expenses =
    kind === "expense"
      ? await ExpenseModel.find({ _id: id, bucketId }).session(session ?? null)
      : kind === "emi-plan"
        ? await ExpenseModel.find({ bucketId, "source.emiPlanId": id }).session(session ?? null)
        : await ExpenseModel.find({ bucketId, "source.recurringPlanId": id }).session(
            session ?? null,
          );
  if (kind === "expense" && (root as InstanceType<typeof ExpenseModel>).refundOfExpenseId)
    throw new ApiError(409, "LINKED_RECORD", "Move the original expense with its refunds.");
  const known = new Set(expenses.map((row) => String(row._id)));
  let frontier = expenses;
  while (frontier.length) {
    const refunds = await ExpenseModel.find({
      bucketId,
      refundOfExpenseId: { $in: frontier.map((row) => row._id) },
    }).session(session ?? null);
    frontier = refunds.filter((row) => !known.has(String(row._id)));
    for (const refund of frontier) known.add(String(refund._id));
    expenses.push(...frontier);
  }
  const installments =
    kind === "emi-plan"
      ? await EmiInstallmentModel.find({ bucketId, planId: id }).session(session ?? null)
      : [];
  return { root, expenses, installments };
}

function referenceIds(bundle: MoveBundle) {
  const refs = new Map<string, "category" | "account" | "platform">();
  const add = (id: unknown, type: "category" | "account" | "platform") => {
    if (id) refs.set(String(id), type);
  };
  const record = bundle.root as InstanceType<typeof ExpenseModel>;
  add(record.categoryId, "category");
  add(record.accountId, "account");
  add(record.platformId, "platform");
  for (const expense of bundle.expenses) {
    add(expense.categoryId, "category");
    add(expense.accountId, "account");
    add(expense.platformId, "platform");
  }
  return refs;
}

function payerIds(bundle: MoveBundle) {
  const payers = new Set<string>();
  const record = bundle.root as InstanceType<typeof ExpenseModel>;
  if (record.paidByUserId) payers.add(String(record.paidByUserId));
  bundle.expenses.forEach((expense) => payers.add(String(expense.paidByUserId)));
  return payers;
}

function customPaymentModes(bundle: MoveBundle) {
  const root = bundle.root as InstanceType<typeof ExpenseModel>;
  return [
    ...new Set([root.paymentMode, ...bundle.expenses.map((expense) => expense.paymentMode)]),
  ].filter((mode): mode is string => typeof mode === "string" && mode.startsWith("custom_"));
}

async function authorize(
  identity: DecodedIdToken,
  sourceBucketId: string,
  targetBucketId: string,
  kind: MoveKind,
  bundle: MoveBundle,
  session?: ClientSession,
  write = false,
) {
  if (sourceBucketId === targetBucketId)
    throw new ApiError(422, "SAME_BUCKET", "Choose another bucket.");
  const user = await activeUser(identity, session);
  const source = await bucketForUser(sourceBucketId, user, session, write);
  const target = await bucketForUser(targetBucketId, user, session, write);
  if (source.primaryCurrency !== target.primaryCurrency)
    throw new ApiError(
      409,
      "CURRENCY_MISMATCH",
      "These buckets use different base currencies. Move to a bucket with the same currency.",
    );
  const root = bundle.root;
  const creatorId = (root as InstanceType<typeof ExpenseModel>).actualCreatorUserId;
  if (String(creatorId) !== String(user._id))
    throw new ApiError(403, "FORBIDDEN", "Only the creator can move this record.");
  if (bundle.expenses.some((expense) => String(expense.actualCreatorUserId) !== String(user._id)))
    throw new ApiError(
      409,
      "LINKED_RECORD",
      "A linked expense belongs to another creator and cannot be moved with this record.",
    );
  const comments = await CommentModel.find({
    bucketId: sourceBucketId,
    expenseId: { $in: bundle.expenses.map((expense) => expense._id) },
  })
    .select("authorUserId")
    .session(session ?? null);
  const authors = [...new Set(comments.map((comment) => String(comment.authorUserId)))];
  for (const authorId of authors) {
    if (
      !(await MembershipModel.exists({
        bucketId: targetBucketId,
        userId: authorId,
        state: "active",
      }).session(session ?? null))
    )
      throw new ApiError(
        409,
        "COMMENT_AUTHOR_NOT_IN_BUCKET",
        "A commenter must join the destination bucket before this record can move.",
      );
  }
  const targetMembership = await MembershipModel.findOne({
    bucketId: targetBucketId,
    userId: user._id,
    state: "active",
  }).session(session ?? null);
  if (!targetMembership) throw missing();
  return { user, source, target, targetMembership };
}

export async function previewMove(
  identity: DecodedIdToken,
  sourceBucketId: string,
  kind: MoveKind,
  id: string,
  targetBucketId: string,
) {
  objectId.parse(sourceBucketId);
  objectId.parse(id);
  objectId.parse(targetBucketId);
  if (!kinds.includes(kind)) throw missing();
  const bundle = await loadBundle(sourceBucketId, kind, id);
  const { source, target } = await authorize(
    identity,
    sourceBucketId,
    targetBucketId,
    kind,
    bundle,
  );
  const refs = referenceIds(bundle);
  const payers = payerIds(bundle);
  const [sourceOptions, targetOptions, users, members] = await Promise.all([
    OptionModel.find({ bucketId: sourceBucketId, _id: { $in: [...refs.keys()] } }),
    OptionModel.find({ bucketId: targetBucketId, state: "active" }),
    UserModel.find({ _id: { $in: [...payers] } }).select("displayName"),
    MembershipModel.find({ bucketId: targetBucketId, state: "active" }).select("userId"),
  ]);
  const targetUsers = await UserModel.find({
    _id: { $in: members.map((member) => member.userId) },
  }).select("displayName");
  return {
    kind,
    id,
    targetBucketId,
    targetBucketName: target.name,
    expenseCount: bundle.expenses.length,
    installmentCount: bundle.installments.length,
    revision: bundle.root.revision,
    references: [...refs].map(([sourceId, type]) => ({
      sourceId,
      kind: type,
      name:
        sourceOptions.find((option) => String(option._id) === sourceId)?.name ?? "Former option",
      choices: targetOptions
        .filter((option) => option.kind === type)
        .map((option) => ({ id: String(option._id), name: option.name })),
    })),
    payers: [...payers].map((sourceId) => ({
      sourceId,
      name: users.find((user) => String(user._id) === sourceId)?.displayName ?? "Former member",
      choices: targetUsers.map((user) => ({ id: String(user._id), name: user.displayName })),
    })),
    paymentModes: customPaymentModes(bundle).map((sourceId) => ({
      sourceId,
      name:
        paymentModeOptions(Object.fromEntries(source.paymentModeLabels ?? [])).find(
          (mode) => mode.value === sourceId,
        )?.label ?? "Former payment mode",
      choices: paymentModeOptions(Object.fromEntries(target.paymentModeLabels ?? [])).map(
        (mode) => ({ id: mode.value, name: mode.label }),
      ),
    })),
  };
}

export async function moveRecord(
  identity: DecodedIdToken,
  sourceBucketId: string,
  kind: MoveKind,
  id: string,
  raw: unknown,
  key: string,
  revisionHeader: string | null,
) {
  objectId.parse(sourceBucketId);
  objectId.parse(id);
  if (!kinds.includes(kind)) throw missing();
  const input = moveInput.parse(raw);
  return mutate(
    identity,
    `move:${sourceBucketId}:${kind}:${id}`,
    key,
    { input, revisionHeader },
    async (session) => {
      const bundle = await loadBundle(sourceBucketId, kind, id, session);
      assertRevision(revisionHeader, bundle.root.revision);
      const { user, target, targetMembership } = await authorize(
        identity,
        sourceBucketId,
        input.targetBucketId,
        kind,
        bundle,
        session,
        true,
      );
      const refs = referenceIds(bundle);
      const payers = payerIds(bundle);
      const modes = customPaymentModes(bundle);
      const targetModes = paymentModeOptions(Object.fromEntries(target.paymentModeLabels ?? []));
      for (const sourceMode of modes) {
        if (!targetModes.some((mode) => mode.value === input.paymentModeMap?.[sourceMode]))
          throw new ApiError(
            422,
            "MAPPING_REQUIRED",
            "Map every custom payment mode before moving.",
          );
      }
      if (
        Object.keys(input.referenceMap).length !== refs.size ||
        Object.keys(input.payerMap).length !== payers.size
      )
        throw new ApiError(422, "MAPPING_REQUIRED", "Map every reference and payer before moving.");
      for (const [sourceId, type] of refs) {
        const destinationId = input.referenceMap[sourceId];
        if (
          !destinationId ||
          !(await OptionModel.exists({
            _id: destinationId,
            bucketId: input.targetBucketId,
            kind: type,
            state: "active",
          }).session(session))
        )
          throw new ApiError(422, "INVALID_MAPPING", "Choose active destination references.");
      }
      for (const sourceId of payers) {
        const destinationId = input.payerMap[sourceId];
        if (
          !destinationId ||
          !(await MembershipModel.exists({
            bucketId: input.targetBucketId,
            userId: destinationId,
            state: "active",
          }).session(session))
        )
          throw new ApiError(422, "INVALID_MAPPING", "Choose destination members.");
      }
      const destinationOptions = await OptionModel.find({
        bucketId: input.targetBucketId,
        _id: { $in: Object.values(input.referenceMap) },
      }).session(session);
      const optionName = (id: unknown) =>
        destinationOptions.find((option) => String(option._id) === String(id))?.name ?? "Other";
      const mapRef = (id: unknown) => (id ? input.referenceMap[String(id)] : id);
      const mapPayer = (id: unknown) => (id ? input.payerMap[String(id)] : id);
      const mapMode = (mode: string) => input.paymentModeMap?.[mode] ?? mode;
      const targetId = input.targetBucketId;
      const expenseIds = bundle.expenses.map((expense) => expense._id);
      for (const expense of bundle.expenses) {
        await ExpenseModel.updateOne(
          { _id: expense._id, bucketId: sourceBucketId, revision: expense.revision },
          {
            $set: {
              bucketId: targetId,
              creatorMembershipId: targetMembership._id,
              paidByUserId: mapPayer(expense.paidByUserId),
              paymentMode: mapMode(expense.paymentMode),
              categoryId: mapRef(expense.categoryId),
              accountId: mapRef(expense.accountId),
              platformId: mapRef(expense.platformId),
              referenceLabels: {
                category: optionName(mapRef(expense.categoryId)),
                account: optionName(mapRef(expense.accountId)),
                platform: optionName(mapRef(expense.platformId)),
              },
              scheduleTimezone: target.timezone,
              ...(expense.dueAt ? { dueAt: dueInstant(expense.expenseDate, target.timezone) } : {}),
            },
            $inc: { revision: 1 },
          },
          { session },
        );
      }
      if (expenseIds.length) {
        await CommentModel.updateMany(
          { bucketId: sourceBucketId, expenseId: { $in: expenseIds } },
          { $set: { bucketId: targetId } },
          { session },
        );
      }
      if (kind === "emi-plan") {
        await EmiInstallmentModel.updateMany(
          { bucketId: sourceBucketId, planId: id },
          {
            $set: { bucketId: targetId, creatorMembershipId: targetMembership._id },
            $inc: { revision: 1 },
          },
          { session },
        );
      }
      if (kind === "expense") {
        // The root expense is included in the expense bundle above.
      } else {
        const Model = kind === "emi-plan" ? EmiPlanModel : RecurringPlanModel;
        const plan = bundle.root as InstanceType<typeof EmiPlanModel>;
        await Model.updateOne(
          { _id: id, bucketId: sourceBucketId },
          {
            $set: {
              bucketId: targetId,
              creatorMembershipId: targetMembership._id,
              paidByUserId: mapPayer(plan.paidByUserId),
              paymentMode: mapMode(plan.paymentMode),
              categoryId: mapRef(plan.categoryId),
              accountId: mapRef(plan.accountId),
              platformId: mapRef(plan.platformId),
              referenceLabels: {
                category: optionName(mapRef(plan.categoryId)),
                account: optionName(mapRef(plan.accountId)),
                platform: optionName(mapRef(plan.platformId)),
              },
            },
            $inc: { revision: 1 },
          },
          { session },
        );
      }
      await AuditModel.updateMany(
        {
          bucketId: sourceBucketId,
          entityId: {
            $in: [bundle.root._id, ...expenseIds, ...bundle.installments.map((row) => row._id)],
          },
        },
        { $set: { bucketId: targetId } },
        { session },
      );
      for (const bucketId of [sourceBucketId, targetId])
        await BucketModel.updateOne(
          { _id: bucketId },
          { $inc: { financialRevision: 1, exportRevision: 1 } },
          { session },
        );
      await AuditModel.create(
        [
          {
            bucketId: targetId,
            actorUserId: user._id,
            action: `${kind}.moved`,
            changedFields: ["bucketId"],
            entityId: bundle.root._id,
            operationKey: key,
          },
        ],
        { session },
      );
      return {
        resourceId: id,
        status: 200,
        data: { id, kind, bucketId: targetId, moved: true },
      };
    },
    async (_id, session) => {
      const user = await activeUser(identity, session);
      await bucketForUser(input.targetBucketId, user, session);
      return { id, kind, bucketId: input.targetBucketId, moved: true };
    },
  );
}
