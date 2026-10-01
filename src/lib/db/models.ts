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
    ownerLabel: String,
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

const expenseSchema = new Schema(
  {
    bucketId: ref,
    actualCreatorUserId: ref,
    creatorMembershipId: ref,
    paidByUserId: ref,
    addedByUserId: ref,
    expenseDate: { type: String, required: true },
    description: { type: String, required: true },
    notes: { type: String, default: "" },
    categoryId: ref,
    accountId: ref,
    platformId: ref,
    referenceLabels: {
      category: String,
      account: String,
      platform: String,
    },
    paymentMode: {
      type: String,
      enum: ["upi", "cash", "neft", "imps", "credit_card"],
      required: true,
    },
    originalAmount: { type: Schema.Types.Decimal128, required: true },
    originalCurrency: { type: String, required: true },
    bucketCurrency: { type: String, required: true },
    conversion: {
      status: { type: String, enum: ["estimated", "final", "missing"], required: true },
      method: { type: String, enum: ["identity", "provider", "manual_rate", "manual_amount"] },
      convertedAmount: Schema.Types.Decimal128,
      rate: Schema.Types.Decimal128,
      rateDate: String,
      provider: String,
      manualFixed: { type: Boolean, default: false },
    },
    postingState: { type: String, enum: ["unposted", "posted", "canceled"], required: true },
    reviewState: { type: String, enum: ["none", "archive_review_required"], default: "none" },
    dueAt: Date,
    scheduleTimezone: String,
    postedAt: Date,
    deletedAt: Date,
    restoreUntil: Date,
    deletedByUserId: Schema.Types.ObjectId,
    refundOfExpenseId: Schema.Types.ObjectId,
    source: { kind: { type: String, default: "manual" } },
    revision: { type: Number, default: 1 },
  },
  common,
);
expenseSchema.index({ bucketId: 1, expenseDate: -1, _id: -1 });
expenseSchema.index({ bucketId: 1, actualCreatorUserId: 1, deletedAt: -1 });
expenseSchema.index({ bucketId: 1, postingState: 1, deletedAt: 1, expenseDate: 1 });

const commentSchema = new Schema(
  {
    bucketId: ref,
    expenseId: ref,
    authorUserId: ref,
    body: { type: String, required: true },
    editedAt: Date,
    deletedAt: Date,
    revision: { type: Number, default: 1 },
  },
  common,
);
commentSchema.index({ expenseId: 1, createdAt: 1, _id: 1 });

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
    changedFields: [String],
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
export const ExpenseModel =
  mongoose.models.BuckitExpense || mongoose.model("BuckitExpense", expenseSchema, "expenses");
export const CommentModel =
  mongoose.models.BuckitComment || mongoose.model("BuckitComment", commentSchema, "comments");
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
export const phaseTwoModels = [...phaseOneModels, ExpenseModel, CommentModel];
