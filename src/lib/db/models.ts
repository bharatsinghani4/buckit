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
    firebaseUid: String,
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
    notificationPreferences: {
      type: Map,
      of: new Schema(
        {
          inApp: { type: Boolean, required: true },
          push: { type: Boolean, required: true },
          inAppEnabledSince: Date,
          pushEnabledSince: Date,
        },
        { _id: false },
      ),
      default: {},
    },
    notificationPreferenceRevision: { type: Number, default: 1 },
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
    endedAt: Date,
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

const reminderSchema = new Schema(
  {
    userId: ref,
    bucketId: Schema.Types.ObjectId,
    membershipId: Schema.Types.ObjectId,
    enabled: { type: Boolean, default: true },
    timezone: { type: String, required: true },
    frequency: {
      type: String,
      enum: ["daily", "weekly", "twice_weekly", "fortnightly", "monthly"],
      required: true,
    },
    weekdays: [Number],
    anchorDate: String,
    dayOfMonth: Number,
    nextLocalDate: String,
    nextDueAt: Date,
    lastEmittedOccurrenceKey: String,
    deletedAt: Date,
    revision: { type: Number, default: 1 },
  },
  common,
);
reminderSchema.index({ enabled: 1, nextDueAt: 1 });
reminderSchema.index({ userId: 1, enabled: 1 });
reminderSchema.index({ bucketId: 1 });

const domainEventSchema = new Schema(
  {
    eventKey: { type: String, required: true },
    type: { type: String, required: true },
    actorUserId: Schema.Types.ObjectId,
    bucketId: Schema.Types.ObjectId,
    entityType: { type: String, required: true },
    entityId: Schema.Types.ObjectId,
    occurredAt: { type: Date, default: Date.now },
    context: { type: Schema.Types.Mixed, default: {} },
    notificationPolicy: { type: String, enum: ["eligible", "suppressed"], default: "eligible" },
    fanoutState: { type: String, enum: ["pending", "complete"], default: "pending" },
    fanoutCursor: String,
    completedAt: Date,
  },
  common,
);
domainEventSchema.index({ eventKey: 1 }, { unique: true });
domainEventSchema.index({ fanoutState: 1, createdAt: 1 });

const notificationSchema = new Schema(
  {
    eventId: ref,
    recipientUserId: ref,
    bucketId: Schema.Types.ObjectId,
    triggerType: { type: String, required: true },
    title: { type: String, required: true },
    target: { type: Schema.Types.Mixed, default: null },
    readAt: Date,
  },
  common,
);
notificationSchema.index({ eventId: 1, recipientUserId: 1 }, { unique: true });
notificationSchema.index({ recipientUserId: 1, createdAt: -1, _id: -1 });
notificationSchema.index({ recipientUserId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ bucketId: 1 });

const pushInstallationSchema = new Schema(
  {
    userId: ref,
    installationId: { type: String, required: true },
    encryptedToken: { type: String, required: true },
    tokenHash: { type: String, required: true },
    registrationVersion: { type: Number, default: 1 },
    state: { type: String, enum: ["active", "revoked", "invalid"], default: "active" },
    permission: { type: String, required: true },
    boundAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    revokedAt: Date,
  },
  common,
);
pushInstallationSchema.index(
  { tokenHash: 1 },
  { unique: true, partialFilterExpression: { state: "active" } },
);
pushInstallationSchema.index({ userId: 1, installationId: 1 }, { unique: true });
pushInstallationSchema.index({ userId: 1, state: 1 });

const pushDeliverySchema = new Schema(
  {
    eventId: ref,
    recipientUserId: ref,
    installationId: { type: String, required: true },
    registrationVersion: { type: Number, required: true },
    bucketId: Schema.Types.ObjectId,
    triggerType: { type: String, required: true },
    state: {
      type: String,
      enum: ["pending", "leased", "sent", "retry", "suppressed", "failed"],
      default: "pending",
    },
    attemptCount: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    leaseUntil: Date,
    leaseToken: String,
    providerMessageId: String,
    lastErrorCode: String,
  },
  common,
);
pushDeliverySchema.index({ eventId: 1, recipientUserId: 1, installationId: 1 }, { unique: true });
pushDeliverySchema.index({ state: 1, nextAttemptAt: 1 });
pushDeliverySchema.index({ state: 1, leaseUntil: 1 });
pushDeliverySchema.index({ recipientUserId: 1, state: 1 });

const contactSchema = new Schema(
  {
    ownerUserId: ref,
    name: { type: String, required: true },
    serviceType: { type: String, required: true },
    phone: { type: String, required: true },
    email: String,
    address: String,
    notes: String,
    revision: { type: Number, default: 1 },
  },
  common,
);
contactSchema.index({ ownerUserId: 1, name: 1, _id: 1 });

const contactShareSchema = new Schema(
  {
    contactId: ref,
    ownerUserId: ref,
    recipientUserId: ref,
    state: { type: String, enum: ["active", "revoked"], default: "active" },
    grantedAt: { type: Date, default: Date.now },
    revokedAt: Date,
    hiddenAt: Date,
    grantVersion: { type: Number, default: 1 },
    revision: { type: Number, default: 1 },
  },
  common,
);
contactShareSchema.index({ contactId: 1, recipientUserId: 1 }, { unique: true });
contactShareSchema.index({ recipientUserId: 1, state: 1, hiddenAt: 1 });
contactShareSchema.index({ ownerUserId: 1, state: 1 });

const importSessionSchema = new Schema(
  {
    bucketId: ref,
    importerUserId: ref,
    creatorMembershipId: ref,
    state: {
      type: String,
      enum: ["preview", "ready", "committing", "completed", "partial", "canceled", "expired"],
      default: "preview",
    },
    fileName: String,
    fileHash: { type: String, required: true },
    fileSize: { type: Number, required: true },
    rowCount: { type: Number, required: true },
    headers: { type: [String], required: true },
    mapping: { type: Map, of: Number, default: {} },
    proposedOptions: {
      type: [new Schema({ kind: String, name: String }, { _id: false })],
      default: [],
    },
    acknowledgments: { type: [String], default: [] },
    previewDigest: String,
    validatedExportRevision: Number,
    confirmedRevision: Number,
    revision: { type: Number, default: 1 },
    expiresAt: Date,
  },
  common,
);
importSessionSchema.index({ importerUserId: 1, createdAt: -1 });
importSessionSchema.index({ bucketId: 1, state: 1 });

const importRowSchema = new Schema(
  {
    sessionId: ref,
    bucketId: ref,
    rowNumber: { type: Number, required: true },
    chunkNumber: { type: Number, required: true },
    cells: { type: [String], required: true },
    corrections: { type: Map, of: String, default: {} },
    excluded: { type: Boolean, default: false },
    duplicateDecision: {
      type: String,
      enum: ["include", "skip", "undecided"],
      default: "undecided",
    },
    duplicateCandidates: { type: [String], default: [] },
    fingerprint: String,
    state: {
      type: String,
      enum: ["invalid", "ready", "excluded", "committed", "failed"],
      default: "invalid",
    },
    expenseId: Schema.Types.ObjectId,
    committedAt: Date,
    outcome: String,
  },
  common,
);
importRowSchema.index({ sessionId: 1, rowNumber: 1 }, { unique: true });
importRowSchema.index({ sessionId: 1, state: 1, rowNumber: 1 });
importRowSchema.index({ sessionId: 1, fingerprint: 1 });
importRowSchema.index({ bucketId: 1 });

const archiveIntervalSchema = new Schema(
  {
    bucketId: ref,
    startedAt: { type: Date, required: true },
    endedAt: Date,
    startedByUserId: ref,
    endedByUserId: Schema.Types.ObjectId,
  },
  common,
);
archiveIntervalSchema.index({ bucketId: 1, endedAt: 1 });

const lifecycleOperationSchema = new Schema(
  {
    kind: { type: String, enum: ["bucket_deletion", "account_deletion"], required: true },
    bucketId: Schema.Types.ObjectId,
    userId: Schema.Types.ObjectId,
    firebaseUid: String,
    actorUserId: ref,
    state: { type: String, enum: ["pending", "running", "completed", "retry"], default: "pending" },
    stage: { type: Number, default: 0 },
    stageCursor: { type: Number, default: 0 },
    processedCount: { type: Number, default: 0 },
    attemptCount: { type: Number, default: 0 },
    nextAttemptAt: Date,
    lastError: String,
    completedAt: Date,
  },
  common,
);
lifecycleOperationSchema.index({ state: 1, createdAt: 1 });
lifecycleOperationSchema.index({ state: 1, nextAttemptAt: 1 });
lifecycleOperationSchema.index({ bucketId: 1, kind: 1 });
lifecycleOperationSchema.index({ userId: 1, kind: 1 });

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
export const ReminderModel =
  mongoose.models.BuckitReminder || mongoose.model("BuckitReminder", reminderSchema, "reminders");
export const DomainEventModel =
  mongoose.models.BuckitDomainEvent ||
  mongoose.model("BuckitDomainEvent", domainEventSchema, "domain_events");
export const NotificationModel =
  mongoose.models.BuckitNotification ||
  mongoose.model("BuckitNotification", notificationSchema, "notifications");
export const PushInstallationModel =
  mongoose.models.BuckitPushInstallation ||
  mongoose.model("BuckitPushInstallation", pushInstallationSchema, "push_installations");
export const PushDeliveryModel =
  mongoose.models.BuckitPushDelivery ||
  mongoose.model("BuckitPushDelivery", pushDeliverySchema, "push_deliveries");
export const ContactModel =
  mongoose.models.BuckitContact || mongoose.model("BuckitContact", contactSchema, "contacts");
export const ContactShareModel =
  mongoose.models.BuckitContactShare ||
  mongoose.model("BuckitContactShare", contactShareSchema, "contact_shares");
export const ImportSessionModel =
  mongoose.models.BuckitImportSession ||
  mongoose.model("BuckitImportSession", importSessionSchema, "import_sessions");
export const ImportRowModel =
  mongoose.models.BuckitImportRow ||
  mongoose.model("BuckitImportRow", importRowSchema, "import_rows");
export const ArchiveIntervalModel =
  mongoose.models.BuckitArchiveInterval ||
  mongoose.model("BuckitArchiveInterval", archiveIntervalSchema, "bucket_archive_intervals");
export const LifecycleOperationModel =
  mongoose.models.BuckitLifecycleOperation ||
  mongoose.model("BuckitLifecycleOperation", lifecycleOperationSchema, "lifecycle_operations");
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
export const phaseFiveModels = [
  ...phaseFourModels,
  ReminderModel,
  DomainEventModel,
  NotificationModel,
  PushInstallationModel,
  PushDeliveryModel,
];
export const phaseSixModels = [
  ...phaseFiveModels,
  ContactModel,
  ContactShareModel,
  ImportSessionModel,
  ImportRowModel,
];
export const phaseSevenModels = [...phaseSixModels, ArchiveIntervalModel, LifecycleOperationModel];
