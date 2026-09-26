import "server-only";
import mongoose, { Schema } from "mongoose";

const common = {
  timestamps: true,
  strict: "throw",
  versionKey: false,
  autoIndex: false,
  autoCreate: false,
} as const;
const ref = { type: Schema.Types.ObjectId, required: true };
const userSchema = new Schema(
  {
    firebaseUid: { type: String, required: true },
    email: String,
    status: { type: String, enum: ["active", "deleting", "deleted"], default: "active" },
    displayName: { type: String, required: true },
    timezone: { type: String, default: "UTC" },
    theme: { type: String, enum: ["light", "dark", "system"], default: "system" },
    lastBucketId: { type: Schema.Types.ObjectId, default: null },
    tour: {
      version: { type: Number, default: 1 },
      state: { type: String, default: "not_started" },
      lastStep: { type: Number, default: 0 },
    },
    revision: { type: Number, default: 1 },
    accessRevision: { type: Number, default: 0 },
  },
  common,
);
userSchema.index(
  { firebaseUid: 1 },
  { unique: true, partialFilterExpression: { firebaseUid: { $type: "string" } } },
);

const bucketSchema = new Schema(
  {
    name: { type: String, required: true },
    ownerUserId: ref,
    primaryCurrency: { type: String, required: true },
    timezone: { type: String, required: true },
    status: { type: String, enum: ["active", "archived", "deleting"], default: "active" },
    currencyLockedAt: Date,
    revision: { type: Number, default: 1 },
    lifecycleVersion: { type: Number, default: 0 },
    writeRevision: { type: Number, default: 0 },
    exportRevision: { type: Number, default: 0 },
    financialRevision: { type: Number, default: 0 },
  },
  common,
);
bucketSchema.index({ ownerUserId: 1, status: 1 });

const membershipSchema = new Schema(
  {
    bucketId: ref,
    userId: ref,
    state: {
      type: String,
      enum: ["active", "left", "removed", "account_deleted"],
      default: "active",
    },
    joinedAt: { type: Date, default: Date.now },
    revision: { type: Number, default: 1 },
  },
  common,
);
membershipSchema.index(
  { bucketId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { state: "active" } },
);
membershipSchema.index({ userId: 1, state: 1, bucketId: 1 });

const optionSchema = new Schema(
  {
    bucketId: ref,
    kind: { type: String, enum: ["account", "category", "platform"], required: true },
    name: String,
    nameKey: String,
    iconKey: String,
    systemKey: String,
    state: { type: String, default: "active" },
    createdByUserId: ref,
    revision: { type: Number, default: 1 },
  },
  common,
);
optionSchema.index({ bucketId: 1, kind: 1, nameKey: 1 }, { unique: true });
optionSchema.index(
  { bucketId: 1, kind: 1, systemKey: 1 },
  { unique: true, partialFilterExpression: { systemKey: { $type: "string" } } },
);

const invitationSchema = new Schema(
  {
    bucketId: ref,
    createdByUserId: ref,
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revision: { type: Number, default: 1 },
  },
  common,
);
invitationSchema.index({ tokenHash: 1 }, { unique: true });
invitationSchema.index({ bucketId: 1, createdAt: -1 });

const receiptSchema = new Schema(
  {
    actor: { type: String, required: true },
    scope: String,
    key: String,
    requestHash: String,
    resourceId: String,
    statusCode: Number,
  },
  common,
);
receiptSchema.index({ actor: 1, scope: 1, key: 1 }, { unique: true });

const auditSchema = new Schema(
  {
    bucketId: Schema.Types.ObjectId,
    actorUserId: ref,
    actorKind: { type: String, default: "user" },
    action: String,
    entityId: Schema.Types.ObjectId,
    occurredAt: { type: Date, default: Date.now },
    operationKey: String,
  },
  common,
);
const limitSchema = new Schema(
  { _id: String, count: Number, expiresAt: Date },
  { versionKey: false, autoIndex: false, autoCreate: false },
);
limitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const UserModel =
  mongoose.models.BuckitUser || mongoose.model("BuckitUser", userSchema, "users");
export const BucketModel =
  mongoose.models.BuckitBucket || mongoose.model("BuckitBucket", bucketSchema, "buckets");
export const MembershipModel =
  mongoose.models.BuckitMembership ||
  mongoose.model("BuckitMembership", membershipSchema, "bucket_memberships");
export const OptionModel =
  mongoose.models.BuckitOption || mongoose.model("BuckitOption", optionSchema, "bucket_options");
export const InvitationModel =
  mongoose.models.BuckitInvitation ||
  mongoose.model("BuckitInvitation", invitationSchema, "invitations");
export const ReceiptModel =
  mongoose.models.BuckitReceipt ||
  mongoose.model("BuckitReceipt", receiptSchema, "operation_receipts");
export const AuditModel =
  mongoose.models.BuckitAudit || mongoose.model("BuckitAudit", auditSchema, "audit_events");
export const RateLimitModel =
  mongoose.models.BuckitRateLimit || mongoose.model("BuckitRateLimit", limitSchema, "rate_limits");
export const phaseOneModels = [
  UserModel,
  BucketModel,
  MembershipModel,
  OptionModel,
  InvitationModel,
  ReceiptModel,
  AuditModel,
  RateLimitModel,
];
