import "server-only";
import type { DecodedIdToken } from "firebase-admin/auth";
import { z } from "zod";
import { ApiError, assertRevision } from "@/lib/api/errors";
import { UserModel } from "@/lib/db/models";
import { activeUser, mutate, type AppUser } from "@/features/identity/service";
import { notificationTriggers, type NotificationTrigger } from "./catalog";

const channelInput = z.object({ inApp: z.boolean(), push: z.boolean() }).strict();
const preferenceInput = z.record(z.string(), channelInput);
const storageKey = (trigger: string) => trigger.replaceAll(".", "_");

type Channel = {
  inApp: boolean;
  push: boolean;
  inAppEnabledSince: Date;
  pushEnabledSince?: Date;
};

export function channelFor(user: AppUser, trigger: NotificationTrigger): Channel {
  const stored = user.notificationPreferences?.get(storageKey(trigger));
  return {
    inApp: stored?.inApp ?? true,
    push: stored?.push ?? false,
    inAppEnabledSince: stored?.inAppEnabledSince ?? user.createdAt,
    pushEnabledSince: stored?.pushEnabledSince,
  };
}

function preferencesDto(user: AppUser) {
  return {
    revision: user.notificationPreferenceRevision ?? 1,
    triggers: Object.fromEntries(
      notificationTriggers.map((trigger) => {
        const { inApp, push } = channelFor(user, trigger);
        return [trigger, { inApp, push }];
      }),
    ),
  };
}

export async function getNotificationPreferences(identity: DecodedIdToken) {
  return preferencesDto(await activeUser(identity));
}

export async function updateNotificationPreferences(
  identity: DecodedIdToken,
  raw: unknown,
  revision: string | null,
  key: string,
) {
  const input = preferenceInput.parse(raw);
  if (!Object.keys(input).length)
    throw new ApiError(422, "EMPTY_UPDATE", "Choose at least one notification setting.");
  if (Object.keys(input).some((key) => !notificationTriggers.includes(key as NotificationTrigger)))
    throw new ApiError(422, "INVALID_TRIGGER", "Choose a supported notification trigger.");
  return mutate(
    identity,
    "me/notification-preferences",
    key,
    { input, revision },
    async (session) => {
      const user = await activeUser(identity, session);
      const currentRevision = user.notificationPreferenceRevision ?? 1;
      assertRevision(revision, currentRevision);
      const now = new Date();
      const changes: Record<string, unknown> = {};
      for (const [trigger, next] of Object.entries(input)) {
        const previous = channelFor(user, trigger as NotificationTrigger);
        changes[`notificationPreferences.${storageKey(trigger)}`] = {
          inApp: next.inApp,
          push: next.push,
          inAppEnabledSince: next.inApp
            ? previous.inApp
              ? previous.inAppEnabledSince
              : now
            : undefined,
          pushEnabledSince: next.push
            ? previous.push
              ? previous.pushEnabledSince
              : now
            : undefined,
        };
      }
      const result = await UserModel.updateOne(
        {
          _id: user._id,
          $or: [
            { notificationPreferenceRevision: currentRevision },
            ...(currentRevision === 1
              ? [{ notificationPreferenceRevision: { $exists: false } }]
              : []),
          ],
        },
        { $set: { ...changes, notificationPreferenceRevision: currentRevision + 1 } },
        { session },
      );
      if (!result.matchedCount)
        throw new ApiError(
          412,
          "REVISION_MISMATCH",
          "Notification settings changed. Refresh and retry.",
        );
      const updated = await UserModel.findById(user._id).session(session);
      if (!updated) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Your profile is unavailable.");
      return { resourceId: String(user._id), data: preferencesDto(updated), status: 200 };
    },
    async (id, session) => {
      const user = await UserModel.findById(id).session(session);
      if (!user) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Your profile is unavailable.");
      return preferencesDto(user);
    },
  );
}
