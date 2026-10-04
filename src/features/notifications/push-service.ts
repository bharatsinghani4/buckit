import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { DecodedIdToken } from "firebase-admin/auth";
import { z } from "zod";
import { ApiError, assertRevision } from "@/lib/api/errors";
import { requireConfig } from "@/lib/config/required";
import {
  BucketModel,
  ContactShareModel,
  DomainEventModel,
  MembershipModel,
  PushDeliveryModel,
  PushInstallationModel,
  UserModel,
} from "@/lib/db/models";
import { getFirebaseAdminMessaging } from "@/lib/firebase/admin";
import { activeUser, mutate } from "@/features/identity/service";
import { channelFor } from "./preferences-service";
import type { NotificationTrigger } from "./catalog";

const installationIdSchema = z.string().uuid();
const registrationInput = z
  .object({ token: z.string().min(20).max(4096), permission: z.literal("granted") })
  .strict();
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function encryptionKey() {
  const key = Buffer.from(
    requireConfig("PUSH_TOKEN_ENCRYPTION_KEY", process.env.PUSH_TOKEN_ENCRYPTION_KEY),
    "base64",
  );
  if (key.length !== 32)
    throw new Error("PUSH_TOKEN_ENCRYPTION_KEY must be base64-encoded 32 random bytes.");
  return key;
}

function encrypt(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

function decrypt(value: string) {
  const data = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
}

function dto(installation: InstanceType<typeof PushInstallationModel>) {
  return {
    installationId: installation.installationId,
    state: installation.state,
    permission: installation.permission,
    lastSeenAt: installation.lastSeenAt?.toISOString() ?? null,
    revision: installation.registrationVersion,
  };
}

export async function listPushInstallations(identity: DecodedIdToken) {
  const user = await activeUser(identity);
  return (await PushInstallationModel.find({ userId: user._id }).sort({ lastSeenAt: -1 })).map(dto);
}

export async function registerPushInstallation(
  identity: DecodedIdToken,
  installationId: string,
  raw: unknown,
  key: string,
  revision: string | null,
) {
  installationIdSchema.parse(installationId);
  const input = registrationInput.parse(raw);
  const tokenHash = hashToken(input.token);
  const encryptedToken = encrypt(input.token);
  return mutate(
    identity,
    `me/push-installations/${installationId}/register`,
    key,
    { tokenHash, permission: input.permission, revision },
    async (session) => {
      const user = await activeUser(identity, session);
      const existing = await PushInstallationModel.findOne({
        userId: user._id,
        installationId,
      }).session(session);
      if (existing) assertRevision(revision, existing.registrationVersion);
      else if (revision)
        throw new ApiError(
          412,
          "REVISION_MISMATCH",
          "This device registration changed. Refresh and retry.",
        );
      await PushInstallationModel.updateMany(
        { tokenHash, state: "active", ...(existing ? { _id: { $ne: existing._id } } : {}) },
        { $set: { state: "revoked", revokedAt: new Date() } },
        { session },
      );
      const now = new Date();
      const registration = existing
        ? await PushInstallationModel.findOneAndUpdate(
            { _id: existing._id, registrationVersion: existing.registrationVersion },
            {
              $set: {
                tokenHash,
                encryptedToken,
                permission: input.permission,
                state: "active",
                boundAt: now,
                lastSeenAt: now,
                revokedAt: null,
              },
              $inc: { registrationVersion: 1 },
            },
            { session, returnDocument: "after" },
          )
        : (
            await PushInstallationModel.create(
              [
                {
                  userId: user._id,
                  installationId,
                  tokenHash,
                  encryptedToken,
                  permission: input.permission,
                  boundAt: now,
                  lastSeenAt: now,
                },
              ],
              { session },
            )
          )[0];
      if (!registration)
        throw new ApiError(
          412,
          "REVISION_MISMATCH",
          "This device registration changed. Refresh and retry.",
        );
      return {
        resourceId: String(registration._id),
        status: existing ? 200 : 201,
        data: dto(registration),
      };
    },
    async (id, session) => {
      const user = await activeUser(identity, session);
      const row = await PushInstallationModel.findOne({ _id: id, userId: user._id }).session(
        session,
      );
      if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "This device is unavailable.");
      return dto(row);
    },
  );
}

export async function revokePushInstallation(
  identity: DecodedIdToken,
  installationId: string,
  key: string,
  revision: string | null,
) {
  installationIdSchema.parse(installationId);
  return mutate(
    identity,
    `me/push-installations/${installationId}/revoke`,
    key,
    { revision },
    async (session) => {
      const user = await activeUser(identity, session);
      const row = await PushInstallationModel.findOne({
        userId: user._id,
        installationId,
        state: "active",
      }).session(session);
      if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "This device is unavailable.");
      assertRevision(revision, row.registrationVersion);
      row.state = "revoked";
      row.revokedAt = new Date();
      row.registrationVersion += 1;
      await row.save({ session });
      await PushDeliveryModel.updateMany(
        { recipientUserId: user._id, installationId, state: { $in: ["pending", "retry"] } },
        { $set: { state: "suppressed" } },
        { session },
      );
      return { resourceId: String(row._id), status: 204, data: null };
    },
    async () => null,
  );
}

/** FCM is outside transactions; every send rechecks ownership and current channel access. */
export async function sendPendingPush(limit = 20) {
  const now = new Date();
  const deliveries = await PushDeliveryModel.find({
    $or: [
      { state: { $in: ["pending", "retry"] }, nextAttemptAt: { $lte: now } },
      { state: "leased", leaseUntil: { $lte: now } },
    ],
  })
    .sort({ nextAttemptAt: 1, _id: 1 })
    .limit(limit);
  let sent = 0;
  let suppressed = 0;
  let retried = 0;
  for (const delivery of deliveries) {
    const leaseToken = randomUUID();
    const claimed = await PushDeliveryModel.findOneAndUpdate(
      {
        _id: delivery._id,
        $or: [
          { state: { $in: ["pending", "retry"] }, nextAttemptAt: { $lte: now } },
          { state: "leased", leaseUntil: { $lte: now } },
        ],
      },
      { $set: { state: "leased", leaseToken, leaseUntil: new Date(Date.now() + 60_000) } },
      { returnDocument: "after" },
    );
    if (!claimed) continue;
    const [user, installation, event] = await Promise.all([
      UserModel.findOne({ _id: claimed.recipientUserId, status: "active" }),
      PushInstallationModel.findOne({
        userId: claimed.recipientUserId,
        installationId: claimed.installationId,
        state: "active",
        registrationVersion: claimed.registrationVersion,
      }),
      DomainEventModel.findById(claimed.eventId),
    ]);
    const channel =
      user && event ? channelFor(user, claimed.triggerType as NotificationTrigger) : null;
    const membership =
      claimed.bucketId && event
        ? await MembershipModel.exists({
            bucketId: claimed.bucketId,
            userId: claimed.recipientUserId,
            state: "active",
            joinedAt: { $lte: event.occurredAt },
          })
        : true;
    const activeBucket = claimed.bucketId
      ? await BucketModel.exists({ _id: claimed.bucketId, status: "active" })
      : true;
    const contactAccess =
      event && ["contact.shared", "contact.updated"].includes(event.type)
        ? await ContactShareModel.exists({
            contactId: event.entityId,
            recipientUserId: claimed.recipientUserId,
            state: "active",
            hiddenAt: null,
          })
        : true;
    if (
      !user ||
      !installation ||
      !event ||
      !membership ||
      !activeBucket ||
      !contactAccess ||
      !channel?.push ||
      !channel.pushEnabledSince ||
      channel.pushEnabledSince > event.occurredAt ||
      installation.boundAt > event.occurredAt ||
      now.getTime() - event.occurredAt.getTime() > 30 * 24 * 60 * 60 * 1000
    ) {
      await PushDeliveryModel.updateOne(
        { _id: claimed._id, state: "leased", leaseToken },
        { $set: { state: "suppressed" } },
      );
      suppressed += 1;
      continue;
    }
    try {
      const messageId = await getFirebaseAdminMessaging().send({
        token: decrypt(installation.encryptedToken),
        data: {
          title: "Buckit",
          body: "You have a new update in Buckit.",
          eventId: String(event._id),
          url: "/workspace?view=notifications",
        },
        webpush: { headers: { Urgency: "normal" } },
      });
      await PushDeliveryModel.updateOne(
        { _id: claimed._id, state: "leased", leaseToken },
        { $set: { state: "sent", providerMessageId: messageId }, $inc: { attemptCount: 1 } },
      );
      sent += 1;
    } catch (error) {
      const code = (error as { code?: string }).code ?? "messaging/unknown";
      const invalid = [
        "messaging/registration-token-not-registered",
        "messaging/invalid-registration-token",
      ].includes(code);
      if (invalid)
        await PushInstallationModel.updateOne(
          { _id: installation._id, registrationVersion: installation.registrationVersion },
          { $set: { state: "invalid", revokedAt: new Date() } },
        );
      const attempts = claimed.attemptCount + 1;
      await PushDeliveryModel.updateOne(
        { _id: claimed._id, state: "leased", leaseToken },
        {
          $set: {
            state: invalid || attempts >= 5 ? "failed" : "retry",
            lastErrorCode: code,
            nextAttemptAt: new Date(
              Date.now() + Math.min(2 ** attempts * 60_000, 24 * 60 * 60 * 1000),
            ),
          },
          $inc: { attemptCount: 1 },
        },
      );
      retried += 1;
    }
  }
  return {
    checked: deliveries.length,
    sent,
    suppressed,
    retried,
    hasMore: deliveries.length === limit,
  };
}
