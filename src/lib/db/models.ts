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
    source: {
      kind: { type: String, default: "manual" },
      emiPlanId: Schema.Types.ObjectId,
      emiInstallmentId: Schema.Types.ObjectId,
    },
    originKey: String,
    revision: { type: Number, default: 1 },
  },
  common,
);
expenseSchema.index({ bucketId: 1, expenseDate: -1, _id: -1 });
expenseSchema.index({ bucketId: 1, actualCreatorUserId: 1, deletedAt: -1 });
expenseSchema.index({ bucketId: 1, postingState: 1, deletedAt: 1, expenseDate: 1 });
expenseSchema.index({ bucketId: 1, categoryId: 1, expenseDate: -1 });
expenseSchema.index({ bucketId: 1, paidByUserId: 1, expenseDate: -1 });
expenseSchema.index({ postingState: 1, dueAt: 1, _id: 1 });
expenseSchema.index(
  { bucketId: 1, originKey: 1 },
  { unique: true, partialFilterExpression: { originKey: { $type: "string" } } },
);
expenseSchema.index(
  { "source.emiInstallmentId": 1 },
  { unique: true, partialFilterExpression: { "source.emiInstallmentId": { $type: "objectId" } } },
);

const emiPlanSchema = new Schema(
  {
    bucketId: ref,
    actualCreatorUserId: ref,
    creatorMembershipId: ref,
    title: { type: String, required: true },
    installmentAmount: { type: Schema.Types.Decimal128, required: true },
    currency: { type: String, required: true },
    totalInstallments: { type: Number, required: true },
    previouslyPaidCount: { type: Number, default: 0 },
    firstInstallmentDate: { type: String, required: true },
    anchorDay: { type: Number, required: true },
    categoryId: ref,
    accountId: ref,
    platformId: ref,
    referenceLabels: { category: String, account: String, platform: String },
    paymentMode: { type: String, required: true },
    paidByUserId: ref,
    state: {
      type: String,
      enum: ["active", "ended", "completed", "owner_departed"],
      default: "active",
    },
    generatedThroughNumber: { type: Number, default: 0 },
    generationVersion: { type: Number, default: 1 },
    endedAt: Date,
    revision: { type: Number, default: 1 },
  },
  common,
);
emiPlanSchema.index({ bucketId: 1, state: 1, createdAt: -1 });
emiPlanSchema.index({ creatorMembershipId: 1, state: 1 });

const emiInstallmentSchema = new Schema(
  {
    bucketId: ref,
    planId: ref,
    installmentNumber: { type: Number, required: true },
    actualCreatorUserId: ref,
    creatorMembershipId: ref,
    scheduledDate: { type: String, required: true },
    originalScheduledDate: { type: String, required: true },
    amount: { type: Schema.Types.Decimal128, required: true },
    currency: { type: String, required: true },
    state: {
      type: String,
      enum: ["scheduled", "recorded", "skipped", "unpaid", "canceled"],
      default: "scheduled",
    },
    expenseId: Schema.Types.ObjectId,
    generationVersion: { type: Number, required: true },
    revision: { type: Number, default: 1 },
  },
  common,
);
emiInstallmentSchema.index({ planId: 1, installmentNumber: 1 }, { unique: true });
emiInstallmentSchema.index({ bucketId: 1, state: 1, scheduledDate: 1 });
emiInstallmentSchema.index(
  { expenseId: 1 },
  { unique: true, partialFilterExpression: { expenseId: { $type: "objectId" } } },
);

const budgetSchema = new Schema(
  {
    bucketId: ref,
    name: { type: String, required: true },
    scope: { type: String, enum: ["shared", "member"], required: true },
    createdByUserId: ref,
    memberUserId: Schema.Types.ObjectId,
    creatorMembershipId: Schema.Types.ObjectId,
    categoryIds: { type: [Schema.Types.ObjectId], required: true },
    limitAmount: { type: Schema.Types.Decimal128, required: true },
    periodType: { type: String, enum: ["monthly", "custom"], required: true },
    startDate: String,
    endDateExclusive: String,
    thresholdPercentages: { type: [String], default: [] },
    state: { type: String, enum: ["active", "historical", "deleted"], default: "active" },
    revision: { type: Number, default: 1 },
  },
  common,
);
budgetSchema.index({ bucketId: 1, state: 1 });
budgetSchema.index({ creatorMembershipId: 1, state: 1 });

const budgetPeriodSchema = new Schema(
  {
    bucketId: ref,
    budgetId: ref,
    periodKey: { type: String, required: true },
    startDate: { type: String, required: true },
    endDateExclusive: { type: String, required: true },
    usedAmount: { type: Schema.Types.Decimal128, required: true },
    computedFinancialRevision: { type: Number, required: true },
    computedBudgetRevision: { type: Number, required: true },
    handledThresholds: [{ percentage: String, handledAt: Date, reason: String }],
  },
  common,
);
budgetPeriodSchema.index({ budgetId: 1, periodKey: 1 }, { unique: true });
budgetPeriodSchema.index({ bucketId: 1, budgetId: 1 });

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

const jobLeaseSchema = new Schema(
  { _id: String, ownerToken: String, expiresAt: Date, lastRunAt: Date },
  { versionKey: false, autoIndex: false, autoCreate: false },
);

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
export const EmiPlanModel =
  mongoose.models.BuckitEmiPlan || mongoose.model("BuckitEmiPlan", emiPlanSchema, "emi_plans");
export const EmiInstallmentModel =
  mongoose.models.BuckitEmiInstallment ||
  mongoose.model("BuckitEmiInstallment", emiInstallmentSchema, "emi_installments");
export const BudgetModel =
  mongoose.models.BuckitBudget || mongoose.model("BuckitBudget", budgetSchema, "budgets");
export const BudgetPeriodModel =
  mongoose.models.BuckitBudgetPeriod ||
  mongoose.model("BuckitBudgetPeriod", budgetPeriodSchema, "budget_periods");
export const CommentModel =
  mongoose.models.BuckitComment || mongoose.model("BuckitComment", commentSchema, "comments");
export const ReceiptModel =
  mongoose.models.BuckitReceipt ||
  mongoose.model("BuckitReceipt", receiptSchema, "operation_receipts");
export const AuditModel =
  mongoose.models.BuckitAudit || mongoose.model("BuckitAudit", auditSchema, "audit_events");
export const RateLimitModel =
  mongoose.models.BuckitRateLimit || mongoose.model("BuckitRateLimit", limitSchema, "rate_limits");
export const JobLeaseModel =
  mongoose.models.BuckitJobLease || mongoose.model("BuckitJobLease", jobLeaseSchema, "job_leases");
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
export const phaseThreeModels = [...phaseTwoModels, BudgetModel, BudgetPeriodModel];
export const phaseFourModels = [
  ...phaseThreeModels,
  EmiPlanModel,
  EmiInstallmentModel,
  JobLeaseModel,
];
