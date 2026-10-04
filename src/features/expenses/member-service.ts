import "server-only";
import type { DecodedIdToken } from "firebase-admin/auth";
import type { ClientSession } from "mongoose";
import { ApiError, assertRevision } from "@/lib/api/errors";
import {
  AuditModel,
  BudgetModel,
  BucketModel,
  EmiInstallmentModel,
  EmiPlanModel,
  ExpenseModel,
  InvitationModel,
  ImportSessionModel,
  MembershipModel,
  ReminderModel,
  UserModel,
} from "@/lib/db/models";
import { activeUser, bucketForUser, mutate } from "@/features/identity/service";
import { recordDomainEvent } from "@/features/notifications/event-service";
import { objectId } from "./contracts";
import { localDate } from "@/features/scheduling/dates";

/** One membership episode owns its future schedules, regardless of the displayed payer. */
export async function endMembership(
  session: ClientSession,
  member: InstanceType<typeof MembershipModel>,
  bucket: InstanceType<typeof BucketModel>,
  state: "left" | "removed" | "account_deleted",
) {
  const now = new Date();
  const today = localDate(now, bucket.timezone);
  member.state = state;
  member.endedAt = now;
  member.revision += 1;
  await member.save({ session });
  await BudgetModel.updateMany(
    { bucketId: bucket._id, creatorMembershipId: member._id, scope: "member", state: "active" },
    { $set: { state: "historical" }, $inc: { revision: 1 } },
    { session },
  );
  await EmiPlanModel.updateMany(
    { bucketId: bucket._id, creatorMembershipId: member._id, state: "active" },
    { $set: { state: "owner_departed" }, $inc: { revision: 1, generationVersion: 1 } },
    { session },
  );
  await EmiInstallmentModel.updateMany(
    {
      bucketId: bucket._id,
      creatorMembershipId: member._id,
      state: "scheduled",
      scheduledDate: { $gt: today },
    },
    { $set: { state: "canceled" }, $inc: { revision: 1 } },
    { session },
  );
  const canceled = await ExpenseModel.updateMany(
    {
      bucketId: bucket._id,
      creatorMembershipId: member._id,
      postingState: "unposted",
      deletedAt: null,
      expenseDate: { $gt: today },
    },
    { $set: { postingState: "canceled" }, $inc: { revision: 1 } },
    { session },
  );
  if (canceled.modifiedCount)
    await BucketModel.updateOne(
      { _id: bucket._id },
      { $inc: { financialRevision: 1, exportRevision: 1 } },
      { session },
    );
  await ReminderModel.updateMany(
    { bucketId: bucket._id, membershipId: member._id, enabled: true },
    { $set: { enabled: false } },
    { session },
  );
  await ImportSessionModel.updateMany(
    {
      bucketId: bucket._id,
      creatorMembershipId: member._id,
      state: { $in: ["preview", "ready", "committing"] },
    },
    { $set: { state: "canceled" }, $inc: { revision: 1 } },
    { session },
  );
  await UserModel.updateOne(
    { _id: member.userId, lastBucketId: bucket._id },
    { $set: { lastBucketId: null }, $inc: { revision: 1 } },
    { session },
  );
}

export async function listMembers(
  identity: DecodedIdToken,
  bucketId: string,
  state: string | null = null,
) {
  const user = await activeUser(identity);
  const bucket = await bucketForUser(bucketId, user);
  if (state && state !== "active" && state !== "all")
    throw new ApiError(422, "VALIDATION_FAILED", "Choose active or all members.");
  const memberships = await MembershipModel.find({
    bucketId,
    ...(state === "all" ? {} : { state: "active" }),
  }).sort({
    joinedAt: 1,
  });
  const users = await UserModel.find({
    _id: { $in: memberships.map((member) => member.userId) },
  });
  const names = new Map(users.map((person) => [String(person._id), person.displayName]));
  return memberships.map((member) => ({
    id: String(member.userId),
    membershipId: String(member._id),
    displayName: names.get(String(member.userId)) ?? "Former member",
    isOwner: String(bucket.ownerUserId) === String(member.userId),
    joinedAt: member.joinedAt.toISOString(),
    revision: member.revision,
    state: member.state,
    endedAt: member.endedAt?.toISOString() ?? null,
  }));
}

export async function removeMember(
  identity: DecodedIdToken,
  bucketId: string,
  memberId: string,
  key: string,
  revisionHeader: string | null,
) {
  objectId.parse(memberId);
  return mutate(
    identity,
    `member:${bucketId}:${memberId}:remove`,
    key,
    { revisionHeader },
    async (session) => {
      const user = await activeUser(identity, session);
      const bucket = await bucketForUser(bucketId, user, session, true, true);
      const member = await MembershipModel.findOne({
        bucketId,
        _id: memberId,
        state: "active",
      }).session(session);
      if (!member) throw new ApiError(404, "RESOURCE_NOT_FOUND", "This member is not available.");
      if (String(bucket.ownerUserId) === String(member.userId))
        throw new ApiError(403, "FORBIDDEN", "The bucket owner cannot be removed.");
      assertRevision(revisionHeader, member.revision);
      await endMembership(session, member, bucket, "removed");
      await recordDomainEvent(session, {
        eventKey: `membership:${member._id}:removed`,
        type: "membership.removed",
        actorUserId: user._id,
        bucketId: bucket._id,
        entityType: "membership",
        entityId: member._id,
      });
      await AuditModel.create(
        [
          {
            bucketId,
            actorUserId: user._id,
            action: "membership.removed",
            entityId: member._id,
            operationKey: key,
          },
        ],
        { session },
      );
      return { resourceId: memberId, status: 200, data: { id: memberId, removed: true } };
    },
    async (id, session) => {
      await bucketForUser(bucketId, await activeUser(identity, session), session, false, true);
      return { id, removed: true };
    },
  );
}

export async function listInvitations(identity: DecodedIdToken, bucketId: string) {
  const user = await activeUser(identity);
  await bucketForUser(bucketId, user, undefined, false, true);
  const invitations = await InvitationModel.find({ bucketId }).sort({ createdAt: -1 }).limit(100);
  const creators = await UserModel.find({
    _id: { $in: invitations.map((invitation) => invitation.createdByUserId) },
  });
  const creatorNames = new Map(creators.map((person) => [String(person._id), person.displayName]));
  return invitations.map((invitation) => ({
    id: String(invitation._id),
    createdByName: creatorNames.get(String(invitation.createdByUserId)) ?? "Former member",
    createdAt: invitation.createdAt.toISOString(),
    expiresAt: invitation.expiresAt.toISOString(),
    revokedAt: invitation.revokedAt?.toISOString() ?? null,
    status: invitation.revokedAt
      ? "revoked"
      : invitation.expiresAt < new Date()
        ? "expired"
        : "active",
    revision: invitation.revision,
  }));
}

export async function revokeInvitation(
  identity: DecodedIdToken,
  bucketId: string,
  invitationId: string,
  key: string,
  revisionHeader: string | null,
) {
  objectId.parse(invitationId);
  return mutate(
    identity,
    `invitation:${bucketId}:${invitationId}:revoke`,
    key,
    { revisionHeader },
    async (session) => {
      const user = await activeUser(identity, session);
      await bucketForUser(bucketId, user, session, true, true);
      const invitation = await InvitationModel.findOne({ _id: invitationId, bucketId }).session(
        session,
      );
      if (!invitation)
        throw new ApiError(404, "RESOURCE_NOT_FOUND", "This invitation is not available.");
      assertRevision(revisionHeader, invitation.revision);
      if (!invitation.revokedAt) {
        invitation.revokedAt = new Date();
        invitation.revision += 1;
        await invitation.save({ session });
      }
      await AuditModel.create(
        [
          {
            bucketId,
            actorUserId: user._id,
            action: "invitation.revoked",
            entityId: invitation._id,
            operationKey: key,
          },
        ],
        { session },
      );
      return { resourceId: invitationId, status: 200, data: { id: invitationId, revoked: true } };
    },
    async (id, session) => {
      await bucketForUser(bucketId, await activeUser(identity, session), session, false, true);
      return { id, revoked: true };
    },
  );
}
