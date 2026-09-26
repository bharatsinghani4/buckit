import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { DecodedIdToken } from "firebase-admin/auth";
vi.mock("server-only", () => ({}));
import {
  phaseOneModels,
  UserModel,
  BucketModel,
  MembershipModel,
  OptionModel,
  InvitationModel,
  ReceiptModel,
  AuditModel,
} from "@/lib/db/models";
import {
  activeUser,
  bootstrap,
  createBucket,
  createInvitation,
  joinInvitation,
  previewInvitation,
  updateProfile,
  bucketDto,
  listBuckets,
  limit,
  requestHash,
} from "./service";
import type { Bucket, Invitation, Profile } from "./contracts";

let database: MongoMemoryReplSet;
const identity = (uid: string): DecodedIdToken => ({
  uid,
  sub: uid,
  aud: "buckit-test",
  iss: "https://securetoken.google.com/buckit-test",
  iat: 0,
  auth_time: 0,
  exp: 9999999999,
  firebase: { identities: {}, sign_in_provider: "password" },
  email: `${uid}@example.test`,
  email_verified: true,
  name: uid,
});
const owner = identity("owner");
const guest = identity("guest");
const stranger = identity("stranger");
const input = { name: "House Expenses", primaryCurrency: "INR", timezone: "Asia/Kolkata" };
async function bucket() {
  return (await createBucket(owner, input, randomUUID())).data as Bucket;
}
async function invite(bucketId: string) {
  return (await createInvitation(owner, bucketId, {}, randomUUID(), "http://localhost:3000"))
    .data as Invitation;
}
const tokenOf = (invitation: Invitation) => new URL(invitation.shareUrl!).hash.slice(1);

beforeAll(async () => {
  database = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.14" },
  });
  await mongoose.connect(database.getUri(), {
    dbName: "buckit_phase_one_tests",
    autoIndex: false,
    autoCreate: false,
  });
  for (const model of phaseOneModels) {
    await model.createCollection();
    await model.createIndexes();
  }
  process.env.API_CURSOR_SECRET = "integration-only-cursor-secret-not-for-production";
}, 180_000);
beforeEach(async () => {
  for (const model of phaseOneModels) await model.deleteMany({});
  for (const actor of [owner, guest, stranger]) await bootstrap(actor, {}, randomUUID());
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
  delete process.env.API_CURSOR_SECRET;
});

describe("Phase 1 transactional workflows", () => {
  it("creates bucket, membership, defaults and audit exactly once across retries", async () => {
    const key = randomUUID();
    const first = await createBucket(owner, input, key);
    const second = await createBucket(owner, input, key);
    expect(second.resourceId).toBe(first.resourceId);
    expect(await BucketModel.countDocuments()).toBe(1);
    expect(await MembershipModel.countDocuments()).toBe(1);
    expect(await OptionModel.countDocuments({ kind: "category" })).toBe(9);
    expect(await OptionModel.countDocuments({ systemKey: "other" })).toBe(1);
    expect(await OptionModel.countDocuments({ kind: "account" })).toBe(0);
    expect(await AuditModel.countDocuments({ action: "bucket.created" })).toBe(1);
  });
  it("rolls back domain writes when the receipt cannot commit", async () => {
    const mock = vi
      .spyOn(ReceiptModel, "create")
      .mockRejectedValueOnce(new Error("receipt failure"));
    await expect(createBucket(owner, input, randomUUID())).rejects.toThrow("receipt failure");
    mock.mockRestore();
    expect(await BucketModel.countDocuments()).toBe(0);
    expect(await MembershipModel.countDocuments()).toBe(0);
    expect(await OptionModel.countDocuments()).toBe(0);
  });
  it("rejects a reused key with different input", async () => {
    const key = randomUUID();
    await createBucket(owner, input, key);
    await expect(createBucket(owner, { ...input, name: "Changed" }, key)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });
  it("enforces revisions, while allowing a successful original request to replay", async () => {
    const user = await activeUser(owner);
    const key = randomUUID();
    const etag = `"r${user.revision}"`;
    await updateProfile(owner, { displayName: "New name" }, key, etag);
    await expect(
      updateProfile(owner, { displayName: "New name" }, key, etag),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      updateProfile(owner, { displayName: "Stale" }, randomUUID(), etag),
    ).rejects.toMatchObject({ status: 412 });
    await expect(
      updateProfile(owner, { displayName: "Missing" }, randomUUID(), null),
    ).rejects.toMatchObject({ status: 428 });
  });
  it("never reactivates an inactive identity through bootstrap", async () => {
    await UserModel.updateOne({ firebaseUid: owner.uid }, { $set: { status: "deleting" } });
    await expect(bootstrap(owner, {}, randomUUID())).rejects.toMatchObject({
      code: "ACCOUNT_INACTIVE",
    });
  });
  it("checks membership for bucket reads and selected bucket writes", async () => {
    const b = await bucket();
    const user = await activeUser(stranger);
    await expect(bucketDto(b.id, user)).rejects.toMatchObject({ status: 404 });
    await expect(
      updateProfile(stranger, { lastBucketId: b.id }, randomUUID(), `"r${user.revision}"`),
    ).rejects.toMatchObject({ status: 404 });
    expect((await listBuckets(stranger, null)).data).toEqual([]);
  });
  it("stores only token hashes and never replays one-time secrets", async () => {
    const b = await bucket();
    const key = randomUUID();
    const first = (await createInvitation(owner, b.id, {}, key, "http://localhost:3000"))
      .data as Invitation;
    const second = (await createInvitation(owner, b.id, {}, key, "http://localhost:3000"))
      .data as Invitation;
    expect(second.secretUnavailable).toBe(true);
    expect(second.shareUrl).toBeUndefined();
    expect(JSON.stringify(await InvitationModel.find().lean())).not.toContain(tokenOf(first));
    expect(JSON.stringify(await ReceiptModel.find().lean())).not.toContain(tokenOf(first));
    expect(await InvitationModel.countDocuments()).toBe(1);
  });
  it("previews without joining; multiple people can deliberately join once each", async () => {
    const b = await bucket();
    const invitation = await invite(b.id);
    const token = tokenOf(invitation);
    expect(await previewInvitation(guest, { token })).toMatchObject({
      bucketName: input.name,
      alreadyMember: false,
    });
    expect(await MembershipModel.countDocuments()).toBe(1);
    const key = randomUUID();
    await joinInvitation(guest, { token }, key);
    await joinInvitation(guest, { token }, key);
    await joinInvitation(stranger, { token }, randomUUID());
    expect(await MembershipModel.countDocuments({ bucketId: b.id })).toBe(3);
    expect(await previewInvitation(guest, { token })).toMatchObject({ alreadyMember: true });
  });
  it("blocks member invitation creation and archived bucket joins", async () => {
    const b = await bucket();
    const invitation = await invite(b.id);
    const token = tokenOf(invitation);
    await joinInvitation(guest, { token }, randomUUID());
    await expect(
      createInvitation(guest, b.id, {}, randomUUID(), "http://localhost:3000"),
    ).rejects.toMatchObject({ status: 403 });
    await BucketModel.updateOne({ _id: b.id }, { $set: { status: "archived" } });
    await expect(joinInvitation(stranger, { token }, randomUUID())).rejects.toMatchObject({
      code: "INVITATION_UNAVAILABLE",
    });
    await expect(
      createInvitation(owner, b.id, {}, randomUUID(), "http://localhost:3000"),
    ).rejects.toMatchObject({ code: "BUCKET_ARCHIVED" });
  });
  it.each(["expired", "revoked"])(
    "returns the same unavailable outcome for %s invitations",
    async (state) => {
      const b = await bucket();
      const invitation = await invite(b.id);
      await InvitationModel.updateOne(
        { _id: invitation.id },
        { $set: state === "expired" ? { expiresAt: new Date(0) } : { revokedAt: new Date() } },
      );
      await expect(
        joinInvitation(guest, { token: tokenOf(invitation) }, randomUUID()),
      ).rejects.toMatchObject({ code: "INVITATION_UNAVAILABLE" });
      expect(await MembershipModel.countDocuments()).toBe(1);
    },
  );
  it("does not let receipt replay restore revoked membership", async () => {
    const b = await bucket();
    const invitation = await invite(b.id);
    const key = randomUUID();
    const token = tokenOf(invitation);
    await joinInvitation(guest, { token }, key);
    const user = await activeUser(guest);
    await MembershipModel.updateOne(
      { bucketId: b.id, userId: user._id },
      { $set: { state: "removed" } },
    );
    await expect(joinInvitation(guest, { token }, key)).rejects.toMatchObject({ status: 404 });
  });
  it("persists profile tour and theme preferences", async () => {
    const user = await activeUser(owner);
    const result = await updateProfile(
      owner,
      { theme: "dark", tour: { version: 1, state: "skipped", lastStep: 1 } },
      randomUUID(),
      `"r${user.revision}"`,
    );
    expect(result.data as Profile).toMatchObject({ theme: "dark", tour: { state: "skipped" } });
  });
  it("coordinates rate limits in the database", async () => {
    await limit(owner, "test", 1);
    await expect(limit(owner, "test", 1)).rejects.toMatchObject({ status: 429 });
  });
  it("normalizes request hashes independent of object key order", () => {
    expect(requestHash({ name: "House", timezone: "UTC" })).toBe(
      requestHash({ timezone: "UTC", name: "House" }),
    );
  });
});
