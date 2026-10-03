import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DecodedIdToken } from "firebase-admin/auth";
import mongoose from "mongoose";
import { z } from "zod";
import { ApiError } from "@/lib/api/errors";
import { requireConfig } from "@/lib/config/required";
import {
  DomainEventModel,
  MembershipModel,
  NotificationModel,
  PushDeliveryModel,
  PushInstallationModel,
  UserModel,
} from "@/lib/db/models";
import { activeUser, mutate } from "@/features/identity/service";
import { notificationTriggers, triggerLabels, type NotificationTrigger } from "./catalog";
import { channelFor } from "./preferences-service";

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const readInput = z.object({ notificationIds: z.array(objectId).min(1).max(100) }).strict();

function sign(payload: string) {
  return createHmac("sha256", requireConfig("API_CURSOR_SECRET", process.env.API_CURSOR_SECRET))
    .update(payload)
    .digest("base64url");
}

function parseCursor(raw: string | null, owner: string, unreadOnly: boolean) {
  if (!raw) return null;
  try {
    if (raw.length > 512) throw new Error();
    const [payload, signature, extra] = raw.split(".");
    const expected = sign(payload);
    if (
      extra ||
      !signature ||
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      throw new Error();
    const value = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (
      value.owner !== owner ||
      value.unreadOnly !== unreadOnly ||
      !objectId.safeParse(value.id).success ||
      !Number.isFinite(Date.parse(value.createdAt))
    )
      throw new Error();
    return { id: value.id as string, createdAt: new Date(value.createdAt as string) };
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "Refresh notifications and try again.");
  }
}

async function visibleFilter(userId: mongoose.Types.ObjectId) {
  const memberships = await MembershipModel.find({ userId, state: "active" }).select("bucketId");
  return {
    recipientUserId: userId,
    $or: [
      { bucketId: { $exists: false } },
      { bucketId: null },
      { bucketId: { $in: memberships.map((member) => member.bucketId) } },
    ],
  };
}

function dto(item: InstanceType<typeof NotificationModel>) {
  return {
    id: String(item._id),
    trigger: item.triggerType,
    title: item.title,
    occurredAt: item.createdAt.toISOString(),
    readAt: item.readAt?.toISOString() ?? null,
    target: item.target ?? null,
  };
}

export async function listNotifications(
  identity: DecodedIdToken,
  unreadOnly: boolean,
  rawCursor: string | null,
) {
  const user = await activeUser(identity);
  const cursor = parseCursor(rawCursor, String(user._id), unreadOnly);
  const filter = await visibleFilter(user._id);
  const rows = await NotificationModel.find({
    ...filter,
    ...(unreadOnly ? { readAt: null } : {}),
    ...(cursor
      ? {
          $and: [
            {
              $or: [
                { createdAt: { $lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
              ],
            },
          ],
        }
      : {}),
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(26);
  const hasMore = rows.length > 25;
  const items = rows.slice(0, 25);
  const last = items.at(-1);
  const payload = last
    ? Buffer.from(
        JSON.stringify({
          owner: String(user._id),
          unreadOnly,
          id: String(last._id),
          createdAt: last.createdAt.toISOString(),
        }),
      ).toString("base64url")
    : null;
  return {
    data: items.map(dto),
    hasMore,
    nextCursor: hasMore && payload ? `${payload}.${sign(payload)}` : null,
  };
}

export async function unreadCount(identity: DecodedIdToken) {
  const user = await activeUser(identity);
  return {
    count: await NotificationModel.countDocuments({
      ...(await visibleFilter(user._id)),
      readAt: null,
    }),
  };
}

export async function markNotificationsRead(identity: DecodedIdToken, raw: unknown, key: string) {
  const input = readInput.parse(raw);
  return mutate(
    identity,
    "notifications/read",
    key,
    input,
    async (session) => {
      const user = await activeUser(identity, session);
      const filter = await visibleFilter(user._id);
      await NotificationModel.updateMany(
        { ...filter, _id: { $in: input.notificationIds }, readAt: null },
        { $set: { readAt: new Date() } },
        { session },
      );
      return {
        resourceId: String(user._id),
        status: 200,
        data: { marked: input.notificationIds.length },
      };
    },
    async () => ({ marked: input.notificationIds.length }),
  );
}

/** Durable, idempotent fan-out; new preferences never replay completed events. */
export async function fanoutPendingEvents(limit = 30) {
  const events = await DomainEventModel.find({ fanoutState: "pending" })
    .sort({ createdAt: 1, _id: 1 })
    .limit(limit);
  let completed = 0;
  for (const event of events) {
    await mongoose.connection.transaction(async (session) => {
      const current = await DomainEventModel.findOne({
        _id: event._id,
        fanoutState: "pending",
      }).session(session);
      if (!current) return;
      const trigger = current.type as NotificationTrigger;
      let hasRecipientPage = false;
      let lastRecipientId: string | null = null;
      if (current.notificationPolicy === "eligible" && notificationTriggers.includes(trigger)) {
        const recipientIds: mongoose.Types.ObjectId[] = [];
        if (current.context?.recipientUserId) {
          const recipientId = new mongoose.Types.ObjectId(current.context.recipientUserId);
          const entitled =
            !current.bucketId ||
            (await MembershipModel.exists({
              bucketId: current.bucketId,
              userId: recipientId,
              state: "active",
              joinedAt: { $lte: current.occurredAt },
            }).session(session));
          if (entitled) recipientIds.push(recipientId);
        } else if (current.bucketId) {
          const memberships = await MembershipModel.find({
            bucketId: current.bucketId,
            state: "active",
            joinedAt: { $lte: current.occurredAt },
            ...(current.fanoutCursor
              ? { userId: { $gt: new mongoose.Types.ObjectId(current.fanoutCursor) } }
              : {}),
          })
            .sort({ userId: 1 })
            .limit(26)
            .session(session);
          hasRecipientPage = memberships.length > 25;
          for (const membership of memberships.slice(0, 25)) {
            if (
              trigger === "comment.added" &&
              String(membership.userId) === String(current.actorUserId)
            )
              continue;
            recipientIds.push(membership.userId);
          }
          lastRecipientId = String(memberships[Math.min(24, memberships.length - 1)]?.userId ?? "");
        }
        for (const recipientId of recipientIds) {
          const user = await UserModel.findOne({ _id: recipientId, status: "active" }).session(
            session,
          );
          if (!user) continue;
          const channel = channelFor(user, trigger);
          const target = current.bucketId
            ? {
                kind: current.entityType,
                id: String(current.entityId),
                bucketId: String(current.bucketId),
              }
            : { kind: current.entityType, id: String(current.entityId) };
          if (channel.inApp && channel.inAppEnabledSince <= current.occurredAt)
            await NotificationModel.updateOne(
              { eventId: current._id, recipientUserId: recipientId },
              {
                $setOnInsert: {
                  eventId: current._id,
                  recipientUserId: recipientId,
                  bucketId: current.bucketId,
                  triggerType: trigger,
                  title: triggerLabels[trigger],
                  target,
                },
              },
              { session, upsert: true },
            );
          if (
            channel.push &&
            channel.pushEnabledSince &&
            channel.pushEnabledSince <= current.occurredAt
          ) {
            const installations = await PushInstallationModel.find({
              userId: recipientId,
              state: "active",
              boundAt: { $lte: current.occurredAt },
            }).session(session);
            for (const installation of installations)
              await PushDeliveryModel.updateOne(
                {
                  eventId: current._id,
                  recipientUserId: recipientId,
                  installationId: installation.installationId,
                },
                {
                  $setOnInsert: {
                    eventId: current._id,
                    recipientUserId: recipientId,
                    installationId: installation.installationId,
                    registrationVersion: installation.registrationVersion,
                    bucketId: current.bucketId,
                    triggerType: trigger,
                  },
                },
                { session, upsert: true },
              );
          }
        }
      }
      if (hasRecipientPage && lastRecipientId)
        await DomainEventModel.updateOne(
          { _id: current._id, fanoutState: "pending" },
          { $set: { fanoutCursor: lastRecipientId } },
          { session },
        );
      else {
        await DomainEventModel.updateOne(
          { _id: current._id, fanoutState: "pending" },
          { $set: { fanoutState: "complete", completedAt: new Date() } },
          { session },
        );
        completed += 1;
      }
    });
  }
  return { completed, hasMore: Boolean(await DomainEventModel.exists({ fanoutState: "pending" })) };
}
