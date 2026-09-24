import "server-only";
import { createHash, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import mongoose, { type ClientSession } from "mongoose";
import type { DecodedIdToken } from "firebase-admin/auth";
import { z } from "zod";
import { AuditModel, BucketModel, InvitationModel, MembershipModel, OptionModel, RateLimitModel, ReceiptModel, UserModel } from "@/lib/db/models";
import { ApiError, assertRevision } from "@/lib/api/errors";
import { requireConfig } from "@/lib/config/required";
import { bootstrapSchema, bucketSchema, invitationSchema, profileSchema, type Bucket, type Profile } from "./contracts";

type AppUser = { _id: mongoose.Types.ObjectId; status: string; displayName: string; email: string; timezone: string; theme: Profile["theme"]; lastBucketId?: mongoose.Types.ObjectId | null; tour: Profile["tour"]; revision: number };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",") + "}";
  return JSON.stringify(value);
}
export const requestHash = (body: unknown) => hash(canonical(body));
export const hashInvitation = hash;
const notFound = () => new ApiError(404, "RESOURCE_NOT_FOUND", "This resource is not available.");
const unavailableInvite = () => new ApiError(404, "INVITATION_UNAVAILABLE", "This invitation has expired or is no longer available.");

export async function activeUser(identity: DecodedIdToken, session?: ClientSession): Promise<AppUser> {
  const user = await UserModel.findOne({ firebaseUid: identity.uid }).session(session ?? null);
  if (!user) throw new ApiError(403, "ACCOUNT_NOT_READY", "Finish setting up your profile.");
  if (user.status !== "active") throw new ApiError(403, "ACCOUNT_INACTIVE", "This account is no longer active.");
  return user;
}

export async function profileDto(user: AppUser, identity: DecodedIdToken, session?: ClientSession): Promise<Profile> {
  let lastBucketId: string | null = null;
  if (user.lastBucketId) {
    const member = await MembershipModel.exists({ userId: user._id, bucketId: user.lastBucketId, state: "active" }).session(session ?? null);
    const bucket = member && await BucketModel.exists({ _id: user.lastBucketId, status: { $in: ["active", "archived"] } }).session(session ?? null);
    if (bucket) lastBucketId = String(user.lastBucketId);
  }
  return { id: String(user._id), displayName: user.displayName, email: identity.email ?? "", emailVerified: identity.email_verified === true, timezone: user.timezone, theme: user.theme, lastBucketId, tour: { version: 1, state: user.tour?.state ?? "not_started", lastStep: user.tour?.lastStep ?? 0 }, revision: user.revision };
}

export async function bucketForUser(id: string, user: AppUser, session?: ClientSession, write = false, owner = false) {
  if (!/^[a-f\d]{24}$/i.test(id)) throw notFound();
  const membership = await MembershipModel.findOne({ bucketId: id, userId: user._id, state: "active" }).session(session ?? null);
  const bucket = membership && await BucketModel.findOne({ _id: id, status: { $in: ["active", "archived"] } }).session(session ?? null);
  if (!bucket) throw notFound();
  if (owner && String(bucket.ownerUserId) !== String(user._id)) throw new ApiError(403, "FORBIDDEN", "Only the bucket owner can create invitations.");
  if (write) {
    if (bucket.status !== "active") throw new ApiError(409, "BUCKET_ARCHIVED", "This bucket is archived.");
    await BucketModel.updateOne({ _id: bucket._id, status: "active" }, { $inc: { writeRevision: 1 } }, { session });
  }
  return bucket;
}

export async function bucketDto(id: string, user: AppUser, session?: ClientSession): Promise<Bucket> {
  const b = await bucketForUser(id, user, session);
  const memberCount = await MembershipModel.countDocuments({ bucketId: b._id, state: "active" }).session(session ?? null);
  return { id: String(b._id), name: b.name, primaryCurrency: b.primaryCurrency, timezone: b.timezone, status: b.status, revision: b.revision, isOwner: String(b.ownerUserId) === String(user._id), memberCount };
}

/** Durable per-actor rate limit; no process-local counters. */
export async function limit(identity: DecodedIdToken, scope: string, max: number) {
  const window = Math.floor(Date.now() / 60_000);
  const id = hash(`${identity.uid}:${scope}:${window}`);
  let entry;
  try { entry = await RateLimitModel.findOneAndUpdate({ _id: id }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((window + 2) * 60_000) } }, { upsert: true, returnDocument: "after" }); }
  catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    entry = await RateLimitModel.findOneAndUpdate({ _id: id }, { $inc: { count: 1 } }, { returnDocument: "after" });
  }
  if (!entry || entry.count > max) throw new ApiError(429, "RATE_LIMITED", "Too many requests. Try again in a minute.");
}

type MutationResult = { resourceId: string; status: number; data: unknown; location?: string };
export async function mutate(identity: DecodedIdToken, scope: string, key: string, input: unknown, perform: (session: ClientSession) => Promise<MutationResult>, replay: (id: string, session: ClientSession) => Promise<unknown>) {
  const digest = requestHash(input);
  return mongoose.connection.transaction(async (session) => {
    const receipt = await ReceiptModel.findOne({ actor: identity.uid, scope, key }).session(session);
    if (receipt) {
      if (receipt.requestHash !== digest) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This operation key was already used for different input.");
      return { data: await replay(receipt.resourceId, session), status: receipt.statusCode, resourceId: receipt.resourceId };
    }
    const result = await perform(session);
    await ReceiptModel.create([{ actor: identity.uid, scope, key, requestHash: digest, resourceId: result.resourceId, statusCode: result.status }], { session });
    return result;
  });
}

async function guardUser(identity: DecodedIdToken, session: ClientSession) {
  const user = await activeUser(identity, session);
  await UserModel.updateOne({ _id: user._id, status: "active" }, { $inc: { accessRevision: 1 } }, { session });
  return user;
}

export async function bootstrap(identity: DecodedIdToken, raw: unknown, key: string) {
  const input = bootstrapSchema.parse(raw);
  return mutate(identity, "bootstrap", key, input, async (session) => {
    let user = await UserModel.findOne({ firebaseUid: identity.uid }).session(session);
    const isNew = !user;
    if (user && user.status !== "active") throw new ApiError(403, "ACCOUNT_INACTIVE", "This account is no longer active.");
    if (!user) [user] = await UserModel.create([{ firebaseUid: identity.uid, email: identity.email?.trim().toLowerCase(), displayName: input.displayName ?? identity.name?.slice(0, 80) ?? "New member", timezone: input.timezone ?? "UTC" }], { session });
    await UserModel.updateOne({ _id: user._id, status: "active" }, { $inc: { accessRevision: 1 } }, { session });
    return { resourceId: String(user._id), status: isNew ? 201 : 200, data: await profileDto(user, identity, session), location: "/api/v1/me" };
  }, async (_id, session) => profileDto(await guardUser(identity, session), identity, session));
}

export async function updateProfile(identity: DecodedIdToken, raw: unknown, key: string, etag: string | null) {
  const input = profileSchema.parse(raw);
  return mutate(identity, "profile", key, input, async (session) => {
    const user = await guardUser(identity, session); assertRevision(etag, user.revision);
    if (input.lastBucketId) await bucketForUser(input.lastBucketId, user, session);
    const updated = await UserModel.findOneAndUpdate({ _id: user._id, revision: user.revision, status: "active" }, { $set: input, $inc: { revision: 1 } }, { session, returnDocument: "after", runValidators: true });
    if (!updated) throw new ApiError(412, "REVISION_MISMATCH", "Refresh your profile and try again.");
    return { resourceId: String(user._id), status: 200, data: await profileDto(updated, identity, session) };
  }, async (_id, session) => profileDto(await guardUser(identity, session), identity, session));
}

export async function createBucket(identity: DecodedIdToken, raw: unknown, key: string) {
  const input = bucketSchema.parse(raw);
  return mutate(identity, "create-bucket", key, input, async (session) => {
    const user = await guardUser(identity, session);
    const [bucket] = await BucketModel.create([{ ...input, ownerUserId: user._id }], { session });
    await MembershipModel.create([{ bucketId: bucket._id, userId: user._id }], { session });
    const defaults = ["Groceries", "Dining", "Transport", "Shopping", "Housing", "Utilities", "Health", "Entertainment", "Other"];
    await OptionModel.insertMany([...defaults.map((name) => ({ bucketId: bucket._id, kind: "category", name, nameKey: name.toLowerCase(), createdByUserId: user._id })), { bucketId: bucket._id, kind: "platform", name: "Other", nameKey: "other", systemKey: "other", createdByUserId: user._id }], { session });
    await UserModel.updateOne({ _id: user._id }, { $set: { lastBucketId: bucket._id }, $inc: { revision: 1 } }, { session });
    await AuditModel.create([{ bucketId: bucket._id, actorUserId: user._id, action: "bucket.created", entityId: bucket._id, operationKey: key }], { session });
    return { resourceId: String(bucket._id), status: 201, data: await bucketDto(String(bucket._id), user, session), location: `/api/v1/buckets/${bucket._id}` };
  }, async (id, session) => bucketDto(id, await guardUser(identity, session), session));
}

export async function createInvitation(identity: DecodedIdToken, bucketId: string, raw: unknown, key: string, origin: string) {
  z.object({}).strict().parse(raw);
  // Secret generated outside the retryable callback; never persisted in a receipt.
  const token = randomBytes(32).toString("base64url");
  return mutate(identity, `invite:${bucketId}`, key, {}, async (session) => {
    const user = await guardUser(identity, session); await bucketForUser(bucketId, user, session, true, true);
    const [invite] = await InvitationModel.create([{ bucketId, createdByUserId: user._id, tokenHash: hash(token), expiresAt: new Date(Date.now() + 7 * 86_400_000) }], { session });
    await AuditModel.create([{ bucketId, actorUserId: user._id, action: "invitation.created", entityId: invite._id, operationKey: key }], { session });
    return { resourceId: String(invite._id), status: 201, data: { id: String(invite._id), bucketId, expiresAt: invite.expiresAt.toISOString(), revision: invite.revision, shareUrl: `${origin}/join#${token}` }, location: `/api/v1/buckets/${bucketId}/invitations` };
  }, async (id, session) => {
    const user = await guardUser(identity, session); await bucketForUser(bucketId, user, session, false, true);
    const invite = await InvitationModel.findById(id).session(session); if (!invite) throw notFound();
    return { id, bucketId, expiresAt: invite.expiresAt.toISOString(), revision: invite.revision, secretUnavailable: true };
  });
}

async function validInvitation(token: string, session?: ClientSession) {
  const invite = await InvitationModel.findOne({ tokenHash: hash(token), revokedAt: null, expiresAt: { $gt: new Date() } }).session(session ?? null);
  if (!invite) throw unavailableInvite();
  const bucket = await BucketModel.findOne({ _id: invite.bucketId, status: "active" }).session(session ?? null);
  if (!bucket) throw unavailableInvite();
  return { invite, bucket };
}

export async function previewInvitation(identity: DecodedIdToken, raw: unknown) {
  const { token } = invitationSchema.parse(raw); const user = await activeUser(identity);
  const { invite, bucket } = await validInvitation(token);
  const member = await MembershipModel.exists({ bucketId: bucket._id, userId: user._id, state: "active" });
  return { bucketName: bucket.name, expiresAt: invite.expiresAt.toISOString(), alreadyMember: !!member };
}

export async function joinInvitation(identity: DecodedIdToken, raw: unknown, key: string) {
  const input = invitationSchema.parse(raw);
  return mutate(identity, "join", key, input, async (session) => {
    const user = await guardUser(identity, session); const { invite, bucket } = await validInvitation(input.token, session);
    await BucketModel.updateOne({ _id: bucket._id, status: "active" }, { $inc: { writeRevision: 1 } }, { session });
    // Conflict with revocation as well as bucket lifecycle changes.
    const guard = await InvitationModel.updateOne({ _id: invite._id, revokedAt: null, expiresAt: { $gt: new Date() } }, { $inc: { revision: 1 } }, { session });
    if (!guard.matchedCount) throw unavailableInvite();
    const existing = await MembershipModel.exists({ bucketId: bucket._id, userId: user._id, state: "active" }).session(session);
    if (!existing) {
      await MembershipModel.create([{ bucketId: bucket._id, userId: user._id }], { session });
      await AuditModel.create([{ bucketId: bucket._id, actorUserId: user._id, action: "membership.joined", entityId: bucket._id, operationKey: key }], { session });
    }
    await UserModel.updateOne({ _id: user._id }, { $set: { lastBucketId: bucket._id }, $inc: { revision: 1 } }, { session });
    return { resourceId: String(bucket._id), status: existing ? 200 : 201, data: await bucketDto(String(bucket._id), user, session), location: `/api/v1/buckets/${bucket._id}` };
  }, async (id, session) => bucketDto(id, await guardUser(identity, session), session));
}

function signCursor(payload: string) { return createHmac("sha256", requireConfig("API_CURSOR_SECRET", process.env.API_CURSOR_SECRET)).update(payload).digest("base64url"); }
export async function listBuckets(identity: DecodedIdToken, cursor: string | null) {
  const user = await activeUser(identity); let after: string | undefined;
  if (cursor) {
    try {
      const [payload, signature] = cursor.split("."); const expected = signCursor(payload);
      if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error();
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (parsed.user !== String(user._id) || parsed.route !== "buckets" || parsed.expires < Date.now() || !/^[a-f\d]{24}$/i.test(parsed.after)) throw new Error();
      after = parsed.after;
    } catch { throw new ApiError(400, "INVALID_CURSOR", "Refresh the bucket list."); }
  }
  const memberships = await MembershipModel.aggregate([
    { $match: { userId: user._id, state: "active", ...(after ? { bucketId: { $gt: new mongoose.Types.ObjectId(after) } } : {}) } },
    { $lookup: { from: "buckets", localField: "bucketId", foreignField: "_id", as: "bucket" } },
    { $unwind: "$bucket" }, { $match: { "bucket.status": { $in: ["active", "archived"] } } }, { $sort: { bucketId: 1 } }, { $limit: 26 },
  ]);
  const selected = memberships.slice(0, 25); const data: Bucket[] = [];
  for (const membership of selected) data.push(await bucketDto(String(membership.bucketId), user));
  let nextCursor = null;
  if (memberships.length > 25) { const payload = Buffer.from(JSON.stringify({ user: String(user._id), route: "buckets", after: String(selected.at(-1).bucketId), expires: Date.now() + 30 * 60_000 })).toString("base64url"); nextCursor = `${payload}.${signCursor(payload)}`; }
  return { data, nextCursor, hasMore: !!nextCursor };
}
