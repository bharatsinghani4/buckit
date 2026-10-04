import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import mongoose, { type ClientSession, type Model } from "mongoose";
import type { DecodedIdToken } from "firebase-admin/auth";
import { z } from "zod";
import { ApiError, assertRevision } from "@/lib/api/errors";
import {
  ArchiveIntervalModel,
  AuditModel,
  BudgetModel,
  BudgetPeriodModel,
  BucketModel,
  CommentModel,
  ContactModel,
  ContactShareModel,
  DomainEventModel,
  EmiInstallmentModel,
  EmiPlanModel,
  ExpenseModel,
  ImportRowModel,
  ImportSessionModel,
  InvitationModel,
  LifecycleOperationModel,
  MembershipModel,
  NotificationModel,
  OptionModel,
  PushDeliveryModel,
  PushInstallationModel,
  ReceiptModel,
  ReminderModel,
  UserModel,
} from "@/lib/db/models";
import {
  activeUser,
  bucketDto,
  bucketForUser,
  mutate,
  requestHash,
} from "@/features/identity/service";
import { timezoneSchema, currencies } from "@/features/identity/contracts";
import { endMembership } from "@/features/expenses/member-service";
import { getFirebaseAdminAuth } from "@/lib/firebase/admin";
import { requireConfig } from "@/lib/config/required";

const bucketSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    timezone: timezoneSchema.optional(),
    primaryCurrency: z
      .string()
      .refine((code) => currencies.some((c) => c.code === code))
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const transferSchema = z.object({ newOwnerUserId: z.string().regex(/^[a-f\d]{24}$/i) }).strict();
const bucketDeletionSchema = z.object({ confirmationName: z.string() }).strict();
const accountDeletionSchema = z.object({ confirmation: z.literal("DELETE MY ACCOUNT") }).strict();

function requireRecentAuth(identity: DecodedIdToken) {
  const authTime = Number(identity.auth_time);
  if (
    !Number.isFinite(authTime) ||
    authTime > Date.now() / 1000 + 30 ||
    Date.now() / 1000 - authTime > 300
  )
    throw new ApiError(403, "REAUTHENTICATION_REQUIRED", "Sign in again to confirm this action.");
}

async function audit(
  session: ClientSession,
  bucketId: mongoose.Types.ObjectId,
  actorUserId: mongoose.Types.ObjectId,
  action: string,
  key: string,
  changedFields: string[] = [],
) {
  await AuditModel.create(
    [{ bucketId, actorUserId, action, entityId: bucketId, operationKey: key, changedFields }],
    { session },
  );
}

export async function getBucketSettings(identity: DecodedIdToken, bucketId: string) {
  const user = await activeUser(identity);
  const bucket = await bucketForUser(bucketId, user);
  const [members, expenses] = await Promise.all([
    MembershipModel.countDocuments({ bucketId, state: "active" }),
    ExpenseModel.countDocuments({ bucketId }),
  ]);
  return {
    ...(await bucketDto(bucketId, user)),
    currencyLocked: !!bucket.currencyLockedAt || expenses > 0,
    canLeave: String(bucket.ownerUserId) !== String(user._id),
    memberCount: members,
  };
}

export async function updateBucketSettings(
  identity: DecodedIdToken,
  bucketId: string,
  raw: unknown,
  key: string,
  etag: string | null,
) {
  const input = bucketSettingsSchema.parse(raw);
  return mutate(
    identity,
    `bucket:${bucketId}:settings`,
    key,
    { input, etag },
    async (session) => {
      const user = await activeUser(identity, session);
      const bucket = await bucketForUser(bucketId, user, session, true, true);
      assertRevision(etag, bucket.revision);
      if (
        input.primaryCurrency &&
        input.primaryCurrency !== bucket.primaryCurrency &&
        (bucket.currencyLockedAt || (await ExpenseModel.exists({ bucketId }).session(session)))
      )
        throw new ApiError(
          409,
          "CURRENCY_LOCKED",
          "The primary currency cannot change after the first expense.",
        );
      const updated = await BucketModel.findOneAndUpdate(
        { _id: bucket._id, revision: bucket.revision, status: { $in: ["active", "archived"] } },
        { $set: input, $inc: { revision: 1, exportRevision: 1, writeRevision: 1 } },
        { session, returnDocument: "after", runValidators: true },
      );
      if (!updated)
        throw new ApiError(412, "REVISION_MISMATCH", "Refresh the bucket and try again.");
      await audit(session, bucket._id, user._id, "bucket.updated", key, Object.keys(input));
      return {
        resourceId: bucketId,
        status: 200,
        data: await getBucketDtoInSession(bucketId, user, session),
      };
    },
    async (_id, session) =>
      getBucketDtoInSession(bucketId, await activeUser(identity, session), session),
  );
}

async function getBucketDtoInSession(
  bucketId: string,
  user: Awaited<ReturnType<typeof activeUser>>,
  session: ClientSession,
) {
  return bucketDto(bucketId, user, session);
}

export async function changeArchive(
  identity: DecodedIdToken,
  bucketId: string,
  action: "archive" | "restore",
  key: string,
  etag: string | null,
) {
  return mutate(
    identity,
    `bucket:${bucketId}:${action}`,
    key,
    { etag },
    async (session) => {
      const user = await activeUser(identity, session);
      const bucket = await bucketForUser(bucketId, user, session, false, true);
      assertRevision(etag, bucket.revision);
      const required = action === "archive" ? "active" : "archived";
      if (bucket.status !== required)
        throw new ApiError(409, "INVALID_BUCKET_STATE", `This bucket is not ${required}.`);
      const now = new Date();
      const changed = await BucketModel.updateOne(
        { _id: bucket._id, status: required, revision: bucket.revision },
        {
          $set: { status: action === "archive" ? "archived" : "active" },
          $inc: { revision: 1, lifecycleVersion: 1, writeRevision: 1 },
        },
        { session },
      );
      if (!changed.matchedCount)
        throw new ApiError(412, "REVISION_MISMATCH", "Refresh the bucket and try again.");
      let pendingCreatorReview = 0;
      if (action === "archive") {
        await ArchiveIntervalModel.create(
          [{ bucketId: bucket._id, startedAt: now, startedByUserId: user._id }],
          { session },
        );
      } else {
        await ArchiveIntervalModel.updateOne(
          { bucketId: bucket._id, endedAt: null },
          { $set: { endedAt: now, endedByUserId: user._id } },
          { session },
        );
        const reviewed = await ExpenseModel.updateMany(
          {
            bucketId: bucket._id,
            postingState: "unposted",
            deletedAt: null,
            dueAt: { $lte: now },
            reviewState: "none",
          },
          { $set: { reviewState: "archive_review_required" }, $inc: { revision: 1 } },
          { session },
        );
        pendingCreatorReview = reviewed.modifiedCount;
        if (pendingCreatorReview)
          await BucketModel.updateOne(
            { _id: bucket._id },
            { $inc: { exportRevision: 1 } },
            { session },
          );
      }
      await audit(session, bucket._id, user._id, `bucket.${action}d`, key);
      return {
        resourceId: bucketId,
        status: 200,
        data: { ...(await bucketDto(bucketId, user, session)), pendingCreatorReview },
      };
    },
    async (_id, session) => ({
      ...(await bucketDto(bucketId, await activeUser(identity, session), session)),
      pendingCreatorReview: 0,
    }),
  );
}

export async function transferOwnership(
  identity: DecodedIdToken,
  bucketId: string,
  raw: unknown,
  key: string,
  etag: string | null,
) {
  requireRecentAuth(identity);
  const input = transferSchema.parse(raw);
  return mutate(
    identity,
    `bucket:${bucketId}:transfer`,
    key,
    { input, etag },
    async (session) => {
      const user = await activeUser(identity, session);
      const bucket = await bucketForUser(bucketId, user, session, false, true);
      assertRevision(etag, bucket.revision);
      if (input.newOwnerUserId === String(user._id))
        throw new ApiError(422, "INVALID_OWNER", "Choose another current member.");
      const recipient = await MembershipModel.exists({
        bucketId,
        userId: input.newOwnerUserId,
        state: "active",
      }).session(session);
      if (!recipient) throw new ApiError(422, "INVALID_OWNER", "Choose a current member.");
      const changed = await BucketModel.updateOne(
        { _id: bucket._id, ownerUserId: user._id, revision: bucket.revision },
        {
          $set: { ownerUserId: new mongoose.Types.ObjectId(input.newOwnerUserId) },
          $inc: { revision: 1, writeRevision: 1 },
        },
        { session },
      );
      if (!changed.matchedCount)
        throw new ApiError(412, "REVISION_MISMATCH", "Refresh the bucket and try again.");
      await audit(session, bucket._id, user._id, "bucket.ownership_transferred", key);
      return { resourceId: bucketId, status: 200, data: await bucketDto(bucketId, user, session) };
    },
    async (_id, session) => bucketDto(bucketId, await activeUser(identity, session), session),
  );
}

export async function leaveBucket(
  identity: DecodedIdToken,
  bucketId: string,
  key: string,
  etag: string | null,
) {
  return mutate(
    identity,
    `bucket:${bucketId}:leave`,
    key,
    { etag },
    async (session) => {
      const user = await activeUser(identity, session);
      const bucket = await bucketForUser(bucketId, user, session);
      if (String(bucket.ownerUserId) === String(user._id))
        throw new ApiError(
          409,
          "TRANSFER_OWNERSHIP_FIRST",
          "Transfer ownership or delete this bucket before leaving.",
        );
      const member = await MembershipModel.findOne({
        bucketId,
        userId: user._id,
        state: "active",
      }).session(session);
      if (!member)
        throw new ApiError(404, "RESOURCE_NOT_FOUND", "This membership is not available.");
      assertRevision(etag, member.revision);
      await BucketModel.updateOne(
        { _id: bucket._id, status: bucket.status },
        { $inc: { writeRevision: 1 } },
        { session },
      );
      await endMembership(session, member, bucket, "left");
      await audit(session, bucket._id, user._id, "membership.left", key);
      return { resourceId: String(member._id), status: 200, data: { left: true, bucketId } };
    },
    async () => ({ left: true, bucketId }),
  );
}

function signActivity(payload: string) {
  return createHmac("sha256", requireConfig("API_CURSOR_SECRET", process.env.API_CURSOR_SECRET))
    .update(payload)
    .digest("base64url");
}

export async function listBucketActivity(
  identity: DecodedIdToken,
  bucketId: string,
  params: URLSearchParams,
) {
  const user = await activeUser(identity);
  await bucketForUser(bucketId, user);
  const entityId = params.get("entityId");
  if (entityId && !/^[a-f\d]{24}$/i.test(entityId))
    throw new ApiError(422, "INVALID_FILTER", "Choose a valid record.");
  const entityType = params.get("entityType");
  if (
    entityType &&
    !/^(bucket|membership|expense|budget|emi|invitation|option|scheduled|comment)$/.test(entityType)
  )
    throw new ApiError(422, "INVALID_FILTER", "Choose a valid activity type.");
  let after: { id: string; at: Date } | null = null;
  const cursor = params.get("cursor");
  if (cursor) {
    try {
      if (cursor.length > 1024) throw new Error();
      const [payload, signature, extra] = cursor.split(".");
      const expected = signActivity(payload);
      if (
        extra ||
        !signature ||
        expected.length !== signature.length ||
        !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
      )
        throw new Error();
      const value = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (
        value.uid !== identity.uid ||
        value.bucketId !== bucketId ||
        value.entityId !== entityId ||
        value.entityType !== entityType ||
        value.expires < Date.now() ||
        !/^[a-f\d]{24}$/i.test(value.id) ||
        !Number.isFinite(Date.parse(value.at))
      )
        throw new Error();
      after = { id: value.id, at: new Date(value.at) };
    } catch {
      throw new ApiError(400, "INVALID_CURSOR", "Refresh activity and try again.");
    }
  }
  const events = await AuditModel.find({
    bucketId,
    ...(entityId ? { entityId } : {}),
    ...(entityType ? { action: { $regex: `^${entityType}\\.` } } : {}),
    ...(after
      ? {
          $or: [
            { occurredAt: { $lt: after.at } },
            { occurredAt: after.at, _id: { $lt: after.id } },
          ],
        }
      : {}),
  })
    .sort({ occurredAt: -1, _id: -1 })
    .limit(26);
  const hasMore = events.length > 25;
  const data = events.slice(0, 25).map((event) => ({
    id: String(event._id),
    action: event.action,
    actorUserId: String(event.actorUserId),
    occurredAt: event.occurredAt.toISOString(),
    changedFields: event.changedFields ?? [],
  }));
  const last = events[24];
  const payload = last
    ? Buffer.from(
        JSON.stringify({
          uid: identity.uid,
          bucketId,
          entityId,
          entityType,
          id: String(last._id),
          at: last.occurredAt.toISOString(),
          expires: Date.now() + 30 * 60_000,
        }),
      ).toString("base64url")
    : null;
  return {
    data,
    hasMore,
    nextCursor: hasMore && payload ? `${payload}.${signActivity(payload)}` : null,
  };
}

export async function bucketDeletionPreview(identity: DecodedIdToken, bucketId: string) {
  const user = await activeUser(identity);
  const bucket = await bucketForUser(bucketId, user, undefined, false, true);
  const [expenses, members, budgets, plans, comments] = await Promise.all([
    ExpenseModel.countDocuments({ bucketId }),
    MembershipModel.countDocuments({ bucketId }),
    BudgetModel.countDocuments({ bucketId }),
    EmiPlanModel.countDocuments({ bucketId }),
    CommentModel.countDocuments({ bucketId }),
  ]);
  return {
    name: bucket.name,
    revision: bucket.revision,
    expenses,
    members,
    budgets,
    plans,
    comments,
  };
}

export async function accountDeletionPreview(identity: DecodedIdToken) {
  const user = await activeUser(identity);
  const owned = await BucketModel.find({
    ownerUserId: user._id,
    status: { $in: ["active", "archived"] },
  }).select("name _id");
  const bucketIds = owned.map((item) => item._id);
  const counts = await MembershipModel.aggregate([
    { $match: { bucketId: { $in: bucketIds }, state: "active" } },
    { $group: { _id: "$bucketId", count: { $sum: 1 } } },
  ]);
  const byId = new Map(counts.map((item) => [String(item._id), item.count as number]));
  return {
    sharedBuckets: owned
      .filter((item) => (byId.get(String(item._id)) ?? 0) > 1)
      .map((item) => ({ id: String(item._id), name: item.name })),
    soleOwnedBuckets: owned
      .filter((item) => (byId.get(String(item._id)) ?? 0) <= 1)
      .map((item) => ({ id: String(item._id), name: item.name })),
  };
}

export async function deleteBucket(
  identity: DecodedIdToken,
  bucketId: string,
  raw: unknown,
  key: string,
  etag: string | null,
) {
  requireRecentAuth(identity);
  const { confirmationName } = bucketDeletionSchema.parse(raw);
  return mongoose.connection.transaction(async (session) => {
    const existing = await ReceiptModel.findOne({
      actor: identity.uid,
      scope: `bucket:${bucketId}:deletion`,
      key,
    }).session(session);
    if (existing) {
      if (existing.requestHash !== requestHash({ confirmationName, etag }))
        throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This operation key was already used.");
      return { status: 202, data: { operationId: existing.resourceId, state: "pending" } };
    }
    const user = await activeUser(identity, session);
    const bucket = await bucketForUser(bucketId, user, session, false, true);
    assertRevision(etag, bucket.revision);
    if (confirmationName !== bucket.name)
      throw new ApiError(422, "CONFIRMATION_MISMATCH", "Type the bucket name exactly as shown.");
    const changed = await BucketModel.updateOne(
      { _id: bucket._id, revision: bucket.revision, status: { $in: ["active", "archived"] } },
      {
        $set: { status: "deleting" },
        $inc: { revision: 1, lifecycleVersion: 1, writeRevision: 1 },
      },
      { session },
    );
    if (!changed.matchedCount)
      throw new ApiError(412, "REVISION_MISMATCH", "Refresh the bucket and try again.");
    await InvitationModel.updateMany(
      { bucketId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { session },
    );
    await ReminderModel.updateMany(
      { bucketId, enabled: true },
      { $set: { enabled: false } },
      { session },
    );
    await UserModel.updateMany(
      { lastBucketId: bucket._id },
      { $set: { lastBucketId: null }, $inc: { revision: 1 } },
      { session },
    );
    const [operation] = await LifecycleOperationModel.create(
      [{ kind: "bucket_deletion", bucketId: bucket._id, actorUserId: user._id }],
      { session },
    );
    await ReceiptModel.create(
      [
        {
          actor: identity.uid,
          scope: `bucket:${bucketId}:deletion`,
          key,
          requestHash: requestHash({ confirmationName, etag }),
          resourceId: String(operation._id),
          statusCode: 202,
        },
      ],
      { session },
    );
    return { status: 202, data: { operationId: String(operation._id), state: "pending" } };
  });
}

export async function deleteAccount(identity: DecodedIdToken, raw: unknown, key: string) {
  requireRecentAuth(identity);
  const input = accountDeletionSchema.parse(raw);
  return mongoose.connection.transaction(async (session) => {
    const existing = await ReceiptModel.findOne({
      actor: identity.uid,
      scope: "account:deletion",
      key,
    }).session(session);
    if (existing) {
      if (existing.requestHash !== requestHash(input))
        throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This operation key was already used.");
      return { status: 202, data: { operationId: existing.resourceId, state: "pending" } };
    }
    const user = await activeUser(identity, session);
    const owned = await BucketModel.findOne({
      ownerUserId: user._id,
      status: { $in: ["active", "archived"] },
    }).session(session);
    if (owned)
      throw new ApiError(
        409,
        "OWNED_BUCKETS_REMAIN",
        "Transfer or delete your owned buckets first.",
      );
    await UserModel.updateOne(
      { _id: user._id, status: "active" },
      {
        $set: {
          status: "deleting",
          displayName: "Deleted user",
          lastBucketId: null,
          notificationPreferences: {},
        },
        $unset: { email: "" },
        $inc: { accessRevision: 1, revision: 1 },
      },
      { session },
    );
    const allMemberships = await MembershipModel.find({ userId: user._id })
      .select("bucketId")
      .session(session);
    await BucketModel.updateMany(
      { _id: { $in: allMemberships.map((member) => member.bucketId) } },
      { $inc: { exportRevision: 1 } },
      { session },
    );
    await ContactShareModel.updateMany(
      { ownerUserId: user._id, state: "active" },
      { $set: { state: "revoked", revokedAt: new Date() }, $inc: { revision: 1 } },
      { session },
    );
    const memberships = await MembershipModel.find({ userId: user._id, state: "active" }).session(
      session,
    );
    for (const member of memberships) {
      const bucket = await BucketModel.findById(member.bucketId).session(session);
      if (bucket && bucket.status !== "deleting")
        await endMembership(session, member, bucket, "account_deleted");
      else
        await MembershipModel.updateOne(
          { _id: member._id },
          { $set: { state: "account_deleted", endedAt: new Date() }, $inc: { revision: 1 } },
          { session },
        );
    }
    const [operation] = await LifecycleOperationModel.create(
      [
        {
          kind: "account_deletion",
          userId: user._id,
          firebaseUid: identity.uid,
          actorUserId: user._id,
        },
      ],
      { session },
    );
    await ReceiptModel.create(
      [
        {
          actor: identity.uid,
          scope: "account:deletion",
          key,
          requestHash: requestHash(input),
          resourceId: String(operation._id),
          statusCode: 202,
        },
      ],
      { session },
    );
    return { status: 202, data: { operationId: String(operation._id), state: "pending" } };
  });
}

export async function getOperation(identity: DecodedIdToken, operationId: string) {
  const user = await activeUser(identity);
  if (!/^[a-f\d]{24}$/i.test(operationId))
    throw new ApiError(404, "RESOURCE_NOT_FOUND", "Operation not found.");
  const operation = await LifecycleOperationModel.findOne({
    _id: operationId,
    actorUserId: user._id,
    kind: "bucket_deletion",
  });
  if (!operation) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Operation not found.");
  return { id: operationId, state: operation.state, processedCount: operation.processedCount };
}

const bucketCollections: Model<unknown>[] = [
  ExpenseModel,
  CommentModel,
  BudgetPeriodModel,
  BudgetModel,
  EmiInstallmentModel,
  EmiPlanModel,
  ImportRowModel,
  ImportSessionModel,
  OptionModel,
  InvitationModel,
  ReminderModel,
  NotificationModel,
  PushDeliveryModel,
  DomainEventModel,
  AuditModel,
  ArchiveIntervalModel,
  MembershipModel,
];

async function deleteBatch(model: Model<unknown>, field: string, id: mongoose.Types.ObjectId) {
  const ids = await model
    .find({ [field]: id })
    .select("_id")
    .limit(100)
    .lean();
  if (!ids.length) return 0;
  await model.deleteMany({ _id: { $in: ids.map((item) => item._id) } });
  return ids.length;
}

/** Bounded, resumable cleanup. The daily cron lease serializes workers. */
export async function processLifecycleCleanup(deadline = Date.now() + 8_000) {
  let processed = 0;
  while (Date.now() < deadline && processed < 8) {
    const operation = await LifecycleOperationModel.findOne({
      $or: [
        { state: { $in: ["pending", "running"] } },
        { state: "retry", nextAttemptAt: { $lte: new Date() } },
      ],
    }).sort({ createdAt: 1 });
    if (!operation) break;
    try {
      operation.state = "running";
      await operation.save();
      if (operation.kind === "bucket_deletion") {
        if (operation.stage < bucketCollections.length) {
          const deleted = await deleteBatch(
            bucketCollections[operation.stage],
            "bucketId",
            operation.bucketId,
          );
          if (deleted) operation.processedCount += deleted;
          else operation.stage += 1;
        } else {
          await ReceiptModel.deleteMany({
            $or: [
              { scope: { $regex: String(operation.bucketId) } },
              { resourceId: String(operation.bucketId) },
            ],
          });
          await BucketModel.deleteOne({ _id: operation.bucketId, status: "deleting" });
          operation.state = "completed";
          operation.completedAt = new Date();
        }
      } else if (operation.kind === "account_deletion") {
        if (operation.stage === 0) {
          try {
            await getFirebaseAdminAuth().deleteUser(operation.firebaseUid);
          } catch (error) {
            if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
          }
          operation.stage = 1;
        } else if (operation.stage === 1) {
          const contacts = await ContactModel.find({ ownerUserId: operation.userId })
            .select("_id")
            .limit(100)
            .lean();
          if (contacts.length) {
            await ContactShareModel.deleteMany({
              contactId: { $in: contacts.map((item) => item._id) },
            });
            await ContactModel.deleteMany({ _id: { $in: contacts.map((item) => item._id) } });
            operation.processedCount += contacts.length;
          } else operation.stage = 2;
        } else if (operation.stage === 2) {
          const personal: [Model<unknown>, string][] = [
            [ContactShareModel, "recipientUserId"],
            [ReminderModel, "userId"],
            [NotificationModel, "recipientUserId"],
            [PushDeliveryModel, "recipientUserId"],
            [PushInstallationModel, "userId"],
          ];
          const step = personal[operation.stageCursor];
          if (!step) operation.stage = 3;
          else {
            const deleted = await deleteBatch(step[0], step[1], operation.userId);
            if (deleted) operation.processedCount += deleted;
            else operation.stageCursor += 1;
          }
        } else {
          await UserModel.updateOne(
            { _id: operation.userId, status: "deleting" },
            {
              $set: {
                status: "deleted",
                displayName: "Deleted user",
                timezone: "UTC",
                theme: "system",
                notificationPreferences: {},
              },
              $unset: { firebaseUid: "", email: "", lastBucketId: "" },
              $inc: { revision: 1 },
            },
          );
          await ReceiptModel.deleteMany({ actor: operation.firebaseUid });
          operation.firebaseUid = undefined;
          operation.state = "completed";
          operation.completedAt = new Date();
        }
      }
      operation.lastError = undefined;
      operation.nextAttemptAt = undefined;
      await operation.save();
      processed += 1;
    } catch (error) {
      operation.state = "retry";
      operation.attemptCount += 1;
      operation.nextAttemptAt = new Date(
        Date.now() + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(operation.attemptCount, 7)),
      );
      operation.lastError = error instanceof Error ? error.message.slice(0, 200) : "Cleanup failed";
      await operation.save();
      processed += 1;
    }
  }
  return {
    processed,
    hasMore: !!(await LifecycleOperationModel.exists({
      state: { $in: ["pending", "retry", "running"] },
    })),
  };
}
