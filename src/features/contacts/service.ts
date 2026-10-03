import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DecodedIdToken } from "firebase-admin/auth";
import mongoose, { type ClientSession } from "mongoose";
import { z } from "zod";
import { ApiError, assertRevision } from "@/lib/api/errors";
import { requireConfig } from "@/lib/config/required";
import {
  BucketModel,
  ContactModel,
  ContactShareModel,
  MembershipModel,
  UserModel,
} from "@/lib/db/models";
import { activeUser, mutate } from "@/features/identity/service";
import { recordDomainEvent } from "@/features/notifications/event-service";

const id = z.string().regex(/^[a-f\d]{24}$/i);
const fields = z
  .object({
    name: z.string().trim().min(1).max(120),
    serviceType: z.string().trim().min(1).max(80),
    phone: z.string().trim().min(3).max(40),
    email: z.union([z.email().max(254), z.literal("")]).optional(),
    address: z.string().trim().max(500).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();
const patch = fields.partial().refine((value) => Object.keys(value).length > 0);
const sharesInput = z.object({ recipientUserIds: z.array(id).min(1).max(50) }).strict();
const missing = () => new ApiError(404, "RESOURCE_NOT_FOUND", "This contact is unavailable.");

function signature(payload: string) {
  return createHmac("sha256", requireConfig("API_CURSOR_SECRET", process.env.API_CURSOR_SECRET))
    .update(payload)
    .digest("base64url");
}
function cursorValue(raw: string | null, userId: string, scope: string) {
  if (!raw) return null;
  try {
    if (raw.length > 512) throw new Error();
    const [payload, mac, extra] = raw.split(".");
    const expected = signature(payload);
    if (
      extra ||
      !mac ||
      mac.length !== expected.length ||
      !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
    )
      throw new Error();
    const value = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (value.userId !== userId || value.scope !== scope || !id.safeParse(value.id).success)
      throw new Error();
    return value.id as string;
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "Refresh this list and try again.");
  }
}
function nextCursor(userId: string, scope: string, lastId: string | null) {
  if (!lastId) return null;
  const payload = Buffer.from(JSON.stringify({ userId, scope, id: lastId })).toString("base64url");
  return `${payload}.${signature(payload)}`;
}
function dto(
  contact: InstanceType<typeof ContactModel>,
  userId: string,
  ownerName?: string,
  shareRevision?: number,
) {
  return {
    id: String(contact._id),
    ownerUserId: String(contact.ownerUserId),
    ownerName: ownerName ?? null,
    isOwner: String(contact.ownerUserId) === userId,
    name: contact.name,
    serviceType: contact.serviceType,
    phone: contact.phone,
    email: contact.email ?? "",
    address: contact.address ?? "",
    notes: contact.notes ?? "",
    revision: contact.revision,
    shareRevision: shareRevision ?? null,
  };
}
async function accessible(
  contactId: string,
  userId: mongoose.Types.ObjectId,
  session?: ClientSession,
) {
  if (!id.safeParse(contactId).success) throw missing();
  const contact = await ContactModel.findById(contactId).session(session ?? null);
  if (!contact) throw missing();
  if (String(contact.ownerUserId) === String(userId)) return contact;
  const share = await ContactShareModel.exists({
    contactId,
    recipientUserId: userId,
    state: "active",
    hiddenAt: null,
  }).session(session ?? null);
  if (!share) throw missing();
  return contact;
}
async function owned(contactId: string, userId: mongoose.Types.ObjectId, session: ClientSession) {
  if (!id.safeParse(contactId).success) throw missing();
  const contact = await ContactModel.findOne({ _id: contactId, ownerUserId: userId }).session(
    session,
  );
  if (!contact) throw missing();
  return contact;
}

export async function listContacts(identity: DecodedIdToken, search: URLSearchParams) {
  const user = await activeUser(identity);
  const view = search.get("view") ?? "all";
  if (!["all", "owned", "shared"].includes(view))
    throw new ApiError(400, "INVALID_FILTER", "Choose a valid contact view.");
  const q = (search.get("q") ?? "").trim().slice(0, 120);
  const scope = `${view}:${q}`;
  const after = cursorValue(search.get("cursor"), String(user._id), scope);
  const shared = await ContactShareModel.find({
    recipientUserId: user._id,
    state: "active",
    hiddenAt: null,
  }).select("contactId");
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filter = {
    $and: [
      view === "owned"
        ? { ownerUserId: user._id }
        : view === "shared"
          ? { _id: { $in: shared.map((row) => row.contactId) } }
          : {
              $or: [
                { ownerUserId: user._id },
                { _id: { $in: shared.map((row) => row.contactId) } },
              ],
            },
      ...(after ? [{ _id: { $lt: new mongoose.Types.ObjectId(after) } }] : []),
      ...(q
        ? [
            {
              $or: [
                { name: { $regex: escaped, $options: "i" } },
                { serviceType: { $regex: escaped, $options: "i" } },
              ],
            },
          ]
        : []),
    ],
  };
  const rows = await ContactModel.find(filter).sort({ _id: -1 }).limit(26);
  const items = rows.slice(0, 25);
  const owners = await UserModel.find({ _id: { $in: items.map((row) => row.ownerUserId) } }).select(
    "displayName",
  );
  const names = new Map(owners.map((row) => [String(row._id), row.displayName]));
  const shareRevisions = new Map(
    (
      await ContactShareModel.find({
        recipientUserId: user._id,
        contactId: { $in: items.map((row) => row._id) },
        state: "active",
      }).select("contactId revision")
    ).map((row) => [String(row.contactId), row.revision]),
  );
  return {
    data: items.map((row) =>
      dto(
        row,
        String(user._id),
        names.get(String(row.ownerUserId)),
        shareRevisions.get(String(row._id)),
      ),
    ),
    hasMore: rows.length > 25,
    nextCursor:
      rows.length > 25 ? nextCursor(String(user._id), scope, String(items.at(-1)?._id)) : null,
  };
}

export async function getContact(identity: DecodedIdToken, contactId: string) {
  const user = await activeUser(identity);
  const contact = await accessible(contactId, user._id);
  const owner = await UserModel.findById(contact.ownerUserId).select("displayName");
  const share =
    String(contact.ownerUserId) === String(user._id)
      ? null
      : await ContactShareModel.findOne({ contactId, recipientUserId: user._id, state: "active" });
  return dto(contact, String(user._id), owner?.displayName, share?.revision);
}

export async function createContact(identity: DecodedIdToken, raw: unknown, key: string) {
  const input = fields.parse(raw);
  return mutate(
    identity,
    "contacts/create",
    key,
    input,
    async (session) => {
      const user = await activeUser(identity, session);
      const [contact] = await ContactModel.create([{ ...input, ownerUserId: user._id }], {
        session,
      });
      return {
        resourceId: String(contact._id),
        status: 201,
        data: dto(contact, String(user._id), user.displayName),
        location: `/api/v1/contacts/${contact._id}`,
      };
    },
    async (contactId, session) => {
      const user = await activeUser(identity, session);
      return dto(await owned(contactId, user._id, session), String(user._id), user.displayName);
    },
  );
}

export async function changeContact(
  identity: DecodedIdToken,
  contactId: string,
  action: "edit" | "delete",
  raw: unknown,
  key: string,
  revision: string | null,
) {
  const input = action === "edit" ? patch.parse(raw) : {};
  return mutate(
    identity,
    `contacts/${contactId}/${action}`,
    key,
    { input, revision },
    async (session) => {
      const user = await activeUser(identity, session);
      const contact = await owned(contactId, user._id, session);
      assertRevision(revision, contact.revision);
      if (action === "delete") {
        const grants = await ContactShareModel.find({
          contactId: contact._id,
          state: "active",
        }).session(session);
        for (const grant of grants)
          await recordDomainEvent(session, {
            eventKey: `contact.share_revoked:${grant._id}:delete`,
            type: "contact.share_revoked",
            actorUserId: user._id,
            entityType: "contact",
            entityId: contact._id,
            recipientUserId: grant.recipientUserId,
          });
        await ContactShareModel.deleteMany({ contactId: contact._id }).session(session);
        await ContactModel.deleteOne({ _id: contact._id }).session(session);
        return { resourceId: contactId, status: 204, data: null };
      }
      Object.assign(contact, input);
      contact.revision += 1;
      await contact.save({ session });
      const grants = await ContactShareModel.find({
        contactId: contact._id,
        state: "active",
      }).session(session);
      for (const grant of grants)
        await recordDomainEvent(session, {
          eventKey: `contact.updated:${contactId}:${contact.revision}:${grant.recipientUserId}`,
          type: "contact.updated",
          actorUserId: user._id,
          entityType: "contact",
          entityId: contact._id,
          recipientUserId: grant.recipientUserId,
        });
      return {
        resourceId: contactId,
        status: 200,
        data: dto(contact, String(user._id), user.displayName),
      };
    },
    async (_, session) => {
      if (action === "delete") return null;
      const user = await activeUser(identity, session);
      return dto(await owned(contactId, user._id, session), String(user._id), user.displayName);
    },
  );
}

export async function shareCandidates(identity: DecodedIdToken, search: URLSearchParams) {
  const user = await activeUser(identity);
  const q = (search.get("q") ?? "").trim();
  if (!q || q.length > 120) return { data: [], hasMore: false, nextCursor: null };
  const mine = await MembershipModel.find({ userId: user._id, state: "active" }).select("bucketId");
  const buckets = await BucketModel.find({
    _id: { $in: mine.map((row) => row.bucketId) },
    status: "active",
  }).select("name");
  const memberships = await MembershipModel.find({
    bucketId: { $in: buckets.map((row) => row._id) },
    userId: { $ne: user._id },
    state: "active",
  }).select("userId bucketId");
  const userIds = [...new Set(memberships.map((row) => String(row.userId)))];
  const after = cursorValue(search.get("cursor"), String(user._id), q);
  const matches = await UserModel.find({
    _id: { $in: userIds, ...(after ? { $gt: new mongoose.Types.ObjectId(after) } : {}) },
    status: "active",
    displayName: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" },
  })
    .sort({ _id: 1 })
    .limit(26);
  const items = matches.slice(0, 25);
  const names = new Map(buckets.map((row) => [String(row._id), row.name]));
  return {
    data: items.map((row) => ({
      id: String(row._id),
      displayName: row.displayName,
      commonBuckets: [
        ...new Set(
          memberships
            .filter((member) => String(member.userId) === String(row._id))
            .map((member) => names.get(String(member.bucketId)))
            .filter(Boolean),
        ),
      ],
    })),
    hasMore: matches.length > 25,
    nextCursor:
      matches.length > 25 ? nextCursor(String(user._id), q, String(items.at(-1)?._id)) : null,
  };
}

export async function listShares(identity: DecodedIdToken, contactId: string) {
  const user = await activeUser(identity);
  const contact = await ContactModel.findOne({ _id: id.parse(contactId), ownerUserId: user._id });
  if (!contact) throw missing();
  const rows = await ContactShareModel.find({ contactId, state: "active" }).sort({ grantedAt: -1 });
  const recipients = await UserModel.find({
    _id: { $in: rows.map((row) => row.recipientUserId) },
  }).select("displayName");
  const names = new Map(recipients.map((row) => [String(row._id), row.displayName]));
  return rows.map((row) => ({
    id: String(row._id),
    recipientUserId: String(row.recipientUserId),
    displayName: names.get(String(row.recipientUserId)) ?? "Member",
    revision: row.revision,
  }));
}

export async function grantShares(
  identity: DecodedIdToken,
  contactId: string,
  raw: unknown,
  key: string,
) {
  const input = sharesInput.parse(raw);
  if (new Set(input.recipientUserIds).size !== input.recipientUserIds.length)
    throw new ApiError(422, "VALIDATION_FAILED", "Choose each recipient only once.");
  return mutate(
    identity,
    `contacts/${contactId}/shares`,
    key,
    input,
    async (session) => {
      const user = await activeUser(identity, session);
      const contact = await owned(contactId, user._id, session);
      const mine = await MembershipModel.find({ userId: user._id, state: "active" })
        .select("bucketId")
        .session(session);
      const buckets = await BucketModel.find({
        _id: { $in: mine.map((row) => row.bucketId) },
        status: "active",
      })
        .select("_id")
        .session(session);
      const candidates = await MembershipModel.find({
        bucketId: { $in: buckets.map((row) => row._id) },
        userId: { $in: input.recipientUserIds },
        state: "active",
      })
        .select("userId bucketId")
        .session(session);
      const associated = new Set(candidates.map((row) => String(row.userId)));
      const active = await UserModel.find({
        _id: { $in: input.recipientUserIds },
        status: "active",
      })
        .select("_id")
        .session(session);
      if (
        input.recipientUserIds.some(
          (recipient) =>
            recipient === String(user._id) ||
            !associated.has(recipient) ||
            !active.some((row) => String(row._id) === recipient),
        )
      )
        throw new ApiError(
          422,
          "INVALID_RECIPIENT",
          "Choose current members of a bucket you share.",
        );
      const locked = await UserModel.updateMany(
        { _id: { $in: [user._id, ...input.recipientUserIds] }, status: "active" },
        { $inc: { accessRevision: 1 } },
        { session },
      );
      if (locked.modifiedCount !== input.recipientUserIds.length + 1)
        throw new ApiError(409, "ACCESS_CHANGED", "Membership changed. Try sharing again.");
      await BucketModel.updateMany(
        { _id: { $in: candidates.map((row) => row.bucketId) }, status: "active" },
        { $inc: { writeRevision: 1 } },
        { session },
      );
      let granted = 0;
      for (const recipient of input.recipientUserIds) {
        const share = await ContactShareModel.findOne({
          contactId,
          recipientUserId: recipient,
        }).session(session);
        if (share?.state === "active") continue;
        if (share) {
          share.state = "active";
          share.grantedAt = new Date();
          share.revokedAt = undefined;
          share.hiddenAt = undefined;
          share.grantVersion += 1;
          share.revision += 1;
          await share.save({ session });
        } else
          await ContactShareModel.create(
            [{ contactId: contact._id, ownerUserId: user._id, recipientUserId: recipient }],
            { session },
          );
        granted += 1;
        await recordDomainEvent(session, {
          eventKey: `contact.shared:${contactId}:${recipient}:${share ? share.grantVersion : 1}`,
          type: "contact.shared",
          actorUserId: user._id,
          entityType: "contact",
          entityId: contact._id,
          recipientUserId: recipient,
        });
      }
      return { resourceId: contactId, status: 200, data: { granted } };
    },
    async () => ({ granted: 0 }),
  );
}

export async function revokeShare(
  identity: DecodedIdToken,
  contactId: string,
  shareId: string,
  key: string,
  revision: string | null,
) {
  return mutate(
    identity,
    `contacts/${contactId}/shares/${shareId}/revoke`,
    key,
    { revision },
    async (session) => {
      const user = await activeUser(identity, session);
      await owned(contactId, user._id, session);
      const share = await ContactShareModel.findOne({
        _id: id.parse(shareId),
        contactId,
        ownerUserId: user._id,
        state: "active",
      }).session(session);
      if (!share) throw missing();
      assertRevision(revision, share.revision);
      share.state = "revoked";
      share.revokedAt = new Date();
      share.revision += 1;
      await share.save({ session });
      await recordDomainEvent(session, {
        eventKey: `contact.share_revoked:${share._id}:${share.revision}`,
        type: "contact.share_revoked",
        actorUserId: user._id,
        entityType: "contact",
        entityId: share.contactId,
        recipientUserId: share.recipientUserId,
      });
      return { resourceId: shareId, status: 204, data: null };
    },
    async () => null,
  );
}

export async function hideContact(
  identity: DecodedIdToken,
  contactId: string,
  key: string,
  revision: string | null,
) {
  return mutate(
    identity,
    `contacts/${contactId}/hide`,
    key,
    { revision },
    async (session) => {
      const user = await activeUser(identity, session);
      const share = await ContactShareModel.findOne({
        contactId: id.parse(contactId),
        recipientUserId: user._id,
        state: "active",
        hiddenAt: null,
      }).session(session);
      if (!share) throw missing();
      assertRevision(revision, share.revision);
      share.hiddenAt = new Date();
      share.revision += 1;
      await share.save({ session });
      return { resourceId: contactId, status: 204, data: null };
    },
    async () => null,
  );
}
