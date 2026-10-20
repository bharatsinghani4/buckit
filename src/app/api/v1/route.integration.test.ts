import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  AuditModel,
  ExpenseModel,
  EmiPlanModel,
  ReminderModel,
  UserModel,
  phaseSevenModels,
  ArchiveIntervalModel,
  BucketModel,
  ContactModel,
  ContactShareModel,
  LifecycleOperationModel,
  NotificationModel,
  OptionModel,
} from "@/lib/db/models";
import { generateInstallments, processDaily } from "@/features/scheduling/service";
import { processDueReminders } from "@/features/notifications/reminder-worker";
import { processAutomaticRecurring } from "@/features/scheduling/recurring-service";
import { processRecurringReminders } from "@/features/notifications/recurring-reminder-worker";
import { recurringDate } from "@/features/scheduling/recurring-dates";
import { fanoutPendingEvents } from "@/features/notifications/inbox-service";
import { localDate } from "@/features/scheduling/dates";
import { continuePendingImports } from "@/features/csv/import-service";
import { processLifecycleCleanup } from "@/features/lifecycle/service";
import { GET as dailyGET } from "../internal/jobs/daily/route";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/mongoose", () => ({ connectDatabase: async () => mongoose.connection }));
vi.mock("@/lib/firebase/admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/firebase/admin")>()),
  getFirebaseAdminAuth: () => ({ deleteUser: async () => undefined }),
}));
vi.mock("@/lib/api/auth", () => ({
  authenticate: async (request: Request) => {
    const uid = request.headers.get("authorization")?.replace("Bearer ", "");
    if (!uid) throw { status: 401, code: "AUTHENTICATION_REQUIRED" };
    return {
      uid,
      email: `${uid}@example.test`,
      email_verified: true,
      name: uid,
      auth_time: request.headers.get("x-test-old-auth") ? 1 : Math.floor(Date.now() / 1000),
    };
  },
}));
import { DELETE, GET, POST, PATCH, PUT } from "./[...path]/route";

let database: MongoMemoryReplSet;
beforeAll(async () => {
  database = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.14" },
  });
  await mongoose.connect(database.getUri(), {
    dbName: "buckit_route_tests",
    autoIndex: false,
    autoCreate: false,
  });
  for (const model of phaseSevenModels) {
    await model.createCollection();
    await model.createIndexes();
  }
  process.env.API_CURSOR_SECRET = "route-tests-only-secret-not-for-production";
  process.env.PUSH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
}, 180_000);
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
  delete process.env.API_CURSOR_SECRET;
  delete process.env.PUSH_TOKEN_ENCRYPTION_KEY;
});

describe("Phase 7 lifecycle", () => {
  it("archives atomically, preserves read access, and requires creator review after restoration", async () => {
    const actor = "phase7archiveowner";
    await request("POST", "me/bootstrap", actor, {});
    const created = await request("POST", "buckets", actor, {
      name: "Archive Flow",
      primaryCurrency: "INR",
      timezone: "UTC",
    });
    const root = `buckets/${created.payload.data.id}`;
    const category = (await request("GET", `${root}/options/categories`, actor)).payload.data[0].id;
    const account = (await request("POST", `${root}/options/accounts`, actor, { name: "Account" }))
      .payload.data.id;
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const expense = await request("POST", `${root}/expenses`, actor, {
      expenseDate: tomorrow,
      description: "Overdue while archived",
      paidByUserId: String((await UserModel.findOne({ firebaseUid: actor }))!._id),
      categoryId: category,
      accountId: account,
      paymentMode: "cash",
      originalAmount: "10.00",
    });
    expect(expense.response.status, JSON.stringify(expense.payload)).toBe(201);
    const lockedCurrency = await request(
      "PATCH",
      root,
      actor,
      { primaryCurrency: "USD" },
      { "If-Match": created.response.headers.get("ETag")! },
    );
    expect(lockedCurrency.payload.error.code).toBe("CURRENCY_LOCKED");
    const archived = await request("POST", `${root}/archive`, actor, undefined, {
      "If-Match": created.response.headers.get("ETag")!,
    });
    expect(archived.response.status, JSON.stringify(archived.payload)).toBe(200);
    expect((await request("GET", root, actor)).payload.data.status).toBe("archived");
    expect(
      (
        await request(
          "PATCH",
          root,
          actor,
          { name: "Read only" },
          { "If-Match": archived.response.headers.get("ETag")! },
        )
      ).payload.error.code,
    ).toBe("BUCKET_ARCHIVED");
    expect(
      (await request("POST", `${root}/options/accounts`, actor, { name: "Blocked" })).response
        .status,
    ).toBe(409);
    await ExpenseModel.updateOne(
      { _id: expense.payload.data.id },
      {
        $set: {
          dueAt: new Date(Date.now() - 60_000),
          expenseDate: new Date().toISOString().slice(0, 10),
        },
      },
    );
    const activeBucket = await request("POST", "buckets", actor, {
      name: "Still Active",
      primaryCurrency: "INR",
      timezone: "UTC",
    });
    const activeRoot = `buckets/${activeBucket.payload.data.id}`;
    const activeCategory = (await request("GET", `${activeRoot}/options/categories`, actor)).payload
      .data[0].id;
    const activeAccount = (
      await request("POST", `${activeRoot}/options/accounts`, actor, { name: "Active account" })
    ).payload.data.id;
    const activeExpense = await request("POST", `${activeRoot}/expenses`, actor, {
      expenseDate: tomorrow,
      description: "Should post",
      paidByUserId: String((await UserModel.findOne({ firebaseUid: actor }))!._id),
      categoryId: activeCategory,
      accountId: activeAccount,
      paymentMode: "cash",
      originalAmount: "11.00",
    });
    await ExpenseModel.updateOne(
      { _id: activeExpense.payload.data.id },
      {
        $set: {
          dueAt: new Date(Date.now() - 60_000),
          expenseDate: new Date().toISOString().slice(0, 10),
        },
      },
    );
    const daily = await processDaily(1);
    expect(daily.posted).toBe(1);
    expect((await ExpenseModel.findById(expense.payload.data.id))!.postingState).toBe("unposted");
    const restored = await request("POST", `${root}/restore`, actor, undefined, {
      "If-Match": archived.response.headers.get("ETag")!,
    });
    expect(restored.response.status, JSON.stringify(restored.payload)).toBe(200);
    expect(restored.payload.data.pendingCreatorReview).toBe(1);
    expect((await ExpenseModel.findById(expense.payload.data.id))!.reviewState).toBe(
      "archive_review_required",
    );
    expect(
      await ArchiveIntervalModel.countDocuments({
        bucketId: created.payload.data.id,
        endedAt: { $ne: null },
      }),
    ).toBe(1);
  });

  it("requires recent authentication, transfers ownership, and revokes access on departure", async () => {
    const owner = "phase7transferowner";
    const member = "phase7transfermember";
    await request("POST", "me/bootstrap", owner, {});
    await request("POST", "me/bootstrap", member, {});
    const created = await request("POST", "buckets", owner, {
      name: "Transfer Flow",
      primaryCurrency: "INR",
      timezone: "UTC",
    });
    const root = `buckets/${created.payload.data.id}`;
    const invite = await request("POST", `${root}/invitations`, owner, {});
    await request("POST", "invitations/join", member, {
      token: new URL(invite.payload.data.shareUrl).hash.slice(1),
    });
    const targetId = String((await UserModel.findOne({ firebaseUid: member }))!._id);
    const stale = await request(
      "POST",
      `${root}/ownership-transfer`,
      owner,
      { newOwnerUserId: targetId },
      { "If-Match": created.response.headers.get("ETag")!, "x-test-old-auth": "1" },
    );
    expect(stale.payload.error.code).toBe("REAUTHENTICATION_REQUIRED");
    const transferred = await request(
      "POST",
      `${root}/ownership-transfer`,
      owner,
      { newOwnerUserId: targetId },
      { "If-Match": created.response.headers.get("ETag")! },
    );
    expect(transferred.response.status, JSON.stringify(transferred.payload)).toBe(200);
    const membership = (await request("GET", `${root}/members`, owner)).payload.data.find(
      (item: { isOwner: boolean }) => !item.isOwner,
    );
    const left = await request("POST", `${root}/leave`, owner, undefined, {
      "If-Match": `"r${membership.revision}"`,
    });
    expect(left.response.status, JSON.stringify(left.payload)).toBe(200);
    expect((await request("GET", root, owner)).response.status).toBe(404);
    expect((await request("GET", root, member)).payload.data.isOwner).toBe(true);
    expect(
      (await request("GET", `${root}/members?state=all`, member)).payload.data.some(
        (item: { state: string }) => item.state === "left",
      ),
    ).toBe(true);
  });

  it("cancels only the departing creator's future expense, not someone else's expense they paid", async () => {
    const owner = "phase7cleanupowner";
    const member = "phase7cleanupmember";
    await request("POST", "me/bootstrap", owner, {});
    await request("POST", "me/bootstrap", member, {});
    const created = await request("POST", "buckets", owner, {
      name: "Creator Cleanup",
      primaryCurrency: "INR",
      timezone: "UTC",
    });
    const root = `buckets/${created.payload.data.id}`;
    const invite = await request("POST", `${root}/invitations`, owner, {});
    await request("POST", "invitations/join", member, {
      token: new URL(invite.payload.data.shareUrl).hash.slice(1),
    });
    const ownerId = String((await UserModel.findOne({ firebaseUid: owner }))!._id);
    const memberId = String((await UserModel.findOne({ firebaseUid: member }))!._id);
    const categoryId = (await request("GET", `${root}/options/categories`, owner)).payload.data[0]
      .id;
    const accountId = (
      await request("POST", `${root}/options/accounts`, owner, { name: "Shared account" })
    ).payload.data.id;
    const expenseDate = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const fields = {
      expenseDate,
      categoryId,
      accountId,
      paymentMode: "cash",
      originalAmount: "10.00",
    };
    const memberCreated = await request("POST", `${root}/expenses`, member, {
      ...fields,
      description: "Member created",
      paidByUserId: ownerId,
    });
    const ownerCreated = await request("POST", `${root}/expenses`, owner, {
      ...fields,
      description: "Owner created",
      paidByUserId: memberId,
    });
    expect(memberCreated.response.status).toBe(201);
    expect(ownerCreated.response.status).toBe(201);
    const membership = (await request("GET", `${root}/members`, owner)).payload.data.find(
      (item: { id: string }) => item.id === memberId,
    );
    const removed = await request(
      "DELETE",
      `${root}/members/${membership.membershipId}`,
      owner,
      undefined,
      { "If-Match": `"r${membership.revision}"` },
    );
    expect(removed.response.status).toBe(200);
    expect((await ExpenseModel.findById(memberCreated.payload.data.id))!.postingState).toBe(
      "canceled",
    );
    expect((await ExpenseModel.findById(ownerCreated.payload.data.id))!.postingState).toBe(
      "unposted",
    );
  });

  it("quarantines a confirmed bucket and purges it in resumable batches", async () => {
    const actor = "phase7deleteowner";
    await request("POST", "me/bootstrap", actor, {});
    const created = await request("POST", "buckets", actor, {
      name: "Purge Me",
      primaryCurrency: "INR",
      timezone: "UTC",
    });
    const root = `buckets/${created.payload.data.id}`;
    const globalContact = await request("POST", "contacts", actor, {
      name: "Keep globally",
      serviceType: "Other",
      phone: "+91 9111111111",
    });
    expect(globalContact.response.status).toBe(201);
    await NotificationModel.create({
      eventId: new mongoose.Types.ObjectId(),
      recipientUserId: (await UserModel.findOne({ firebaseUid: actor }))!._id,
      bucketId: created.payload.data.id,
      triggerType: "membership.joined",
      title: "Old bucket update",
    });
    expect((await request("GET", "notifications", actor)).payload.data.length).toBeGreaterThan(0);
    const wrong = await request(
      "POST",
      `${root}/deletion`,
      actor,
      { confirmationName: "wrong" },
      { "If-Match": created.response.headers.get("ETag")! },
    );
    expect(wrong.response.status).toBe(422);
    const deleted = await request(
      "POST",
      `${root}/deletion`,
      actor,
      { confirmationName: "Purge Me" },
      { "If-Match": created.response.headers.get("ETag")! },
    );
    expect(deleted.response.status, JSON.stringify(deleted.payload)).toBe(202);
    expect((await request("GET", root, actor)).response.status).toBe(404);
    expect((await request("GET", "notifications", actor)).payload.data).toHaveLength(0);
    expect(
      (await request("GET", `operations/${deleted.payload.data.operationId}`, actor)).response
        .status,
    ).toBe(200);
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await processLifecycleCleanup(Date.now() + 4_000);
      if (!state.hasMore) break;
    }
    expect(await BucketModel.findById(created.payload.data.id)).toBeNull();
    expect(await ContactModel.findById(globalContact.payload.data.id)).not.toBeNull();
    expect((await LifecycleOperationModel.findById(deleted.payload.data.operationId))!.state).toBe(
      "completed",
    );
  });

  it("blocks account deletion until ownership is resolved, then revokes access immediately", async () => {
    const owner = "phase7accountowner";
    const recipient = "phase7accountrecipient";
    await request("POST", "me/bootstrap", owner, {});
    await request("POST", "me/bootstrap", recipient, {});
    const created = await request("POST", "buckets", owner, {
      name: "Account Flow",
      primaryCurrency: "INR",
      timezone: "UTC",
    });
    const root = `buckets/${created.payload.data.id}`;
    const blocked = await request("POST", "me/deletion", owner, {
      confirmation: "DELETE MY ACCOUNT",
    });
    expect(blocked.payload.error.code).toBe("OWNED_BUCKETS_REMAIN");
    const invite = await request("POST", `${root}/invitations`, owner, {});
    await request("POST", "invitations/join", recipient, {
      token: new URL(invite.payload.data.shareUrl).hash.slice(1),
    });
    const newOwnerUserId = String((await UserModel.findOne({ firebaseUid: recipient }))!._id);
    const transfer = await request(
      "POST",
      `${root}/ownership-transfer`,
      owner,
      { newOwnerUserId },
      { "If-Match": created.response.headers.get("ETag")! },
    );
    expect(transfer.response.status).toBe(200);
    const contact = await request("POST", "contacts", owner, {
      name: "Private contact",
      serviceType: "Other",
      phone: "+91 9000000000",
    });
    expect(contact.response.status).toBe(201);
    await request("POST", `contacts/${contact.payload.data.id}/shares`, owner, {
      recipientUserIds: [newOwnerUserId],
    });
    const deletionKey = randomUUID();
    const deleted = await request(
      "POST",
      "me/deletion",
      owner,
      { confirmation: "DELETE MY ACCOUNT" },
      { "Idempotency-Key": deletionKey },
    );
    expect(deleted.response.status, JSON.stringify(deleted.payload)).toBe(202);
    const replay = await request(
      "POST",
      "me/deletion",
      owner,
      { confirmation: "DELETE MY ACCOUNT" },
      { "Idempotency-Key": deletionKey },
    );
    expect(replay.payload.data.operationId).toBe(deleted.payload.data.operationId);
    expect((await request("GET", "me", owner)).payload.error.code).toBe("ACCOUNT_INACTIVE");
    expect((await request("GET", root, recipient)).response.status).toBe(200);
    expect((await UserModel.findOne({ firebaseUid: owner }))!.status).toBe("deleting");
    expect((await UserModel.findOne({ firebaseUid: owner }))!.displayName).toBe("Deleted user");
    expect(
      (await request("GET", `contacts/${contact.payload.data.id}`, recipient)).response.status,
    ).toBe(404);
    expect(
      (await request("GET", `operations/${deleted.payload.data.operationId}`, owner)).response
        .status,
    ).toBe(403);
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await processLifecycleCleanup(Date.now() + 4_000);
      if (!state.hasMore) break;
    }
    const operation = await LifecycleOperationModel.findById(deleted.payload.data.operationId);
    const stub = await UserModel.findById(operation!.userId);
    expect(stub?.status).toBe("deleted");
    expect(stub?.displayName).toBe("Deleted user");
    expect(stub?.firebaseUid).toBeUndefined();
    expect(stub?.email).toBeUndefined();
    expect(await ContactModel.findById(contact.payload.data.id)).toBeNull();
    expect(await ContactShareModel.countDocuments({ contactId: contact.payload.data.id })).toBe(0);
  });
});

describe("Phase 6 contacts and CSV", () => {
  it("keeps contacts private, grants only associated users, and revokes access", async () => {
    const owner = "phase6contactowner";
    const member = "phase6contactmember";
    const stranger = "phase6contactstranger";
    await request("POST", "me/bootstrap", owner, {});
    await request("POST", "me/bootstrap", member, {});
    await request("POST", "me/bootstrap", stranger, {});
    const bucket = await request("POST", "buckets", owner, {
      name: "Contact Test",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const bucketId = bucket.payload.data.id;
    const invite = await request("POST", `buckets/${bucketId}/invitations`, owner, {});
    const token = new URL(invite.payload.data.shareUrl).hash.slice(1);
    const joined = await request("POST", "invitations/join", member, { token });
    expect(joined.response.status, JSON.stringify(joined.payload)).toBe(201);
    const created = await request("POST", "contacts", owner, {
      name: "Asha",
      serviceType: "Electrician",
      phone: "+91 9000000000",
    });
    expect(created.response.status, JSON.stringify(created.payload)).toBe(201);
    const contactId = created.payload.data.id;
    expect((await request("GET", "contacts", member)).payload.data).toHaveLength(0);
    expect((await request("GET", `contacts/${contactId}`, stranger)).response.status).toBe(404);
    const ownerId = (await UserModel.findOne({ firebaseUid: owner }))!._id;
    const memberId = (await UserModel.findOne({ firebaseUid: member }))!._id;
    const strangerId = (await UserModel.findOne({ firebaseUid: stranger }))!._id;
    expect(
      (
        await request("POST", `contacts/${contactId}/shares`, owner, {
          recipientUserIds: [String(strangerId)],
        })
      ).response.status,
    ).toBe(422);
    const candidates = await request("GET", "contacts/share-candidates?q=phase6contact", owner);
    expect(candidates.payload.data.some((row: { id: string }) => row.id === String(memberId))).toBe(
      true,
    );
    expect(
      candidates.payload.data.some((row: { id: string }) => row.id === String(strangerId)),
    ).toBe(false);
    const grant = await request("POST", `contacts/${contactId}/shares`, owner, {
      recipientUserIds: [String(memberId)],
    });
    expect(grant.response.status, JSON.stringify(grant.payload)).toBe(200);
    expect((await request("GET", `contacts/${contactId}`, member)).response.status).toBe(200);
    expect(
      (
        await request(
          "PATCH",
          `contacts/${contactId}`,
          member,
          { name: "Changed" },
          { "If-Match": created.response.headers.get("ETag")! },
        )
      ).response.status,
    ).toBe(404);
    const shares = await request("GET", `contacts/${contactId}/shares`, owner);
    const share = shares.payload.data[0];
    expect(
      (
        await request("DELETE", `contacts/${contactId}/shares/${share.id}`, owner, undefined, {
          "If-Match": `"r${share.revision}"`,
        })
      ).response.status,
    ).toBe(204);
    expect((await request("GET", `contacts/${contactId}`, member)).response.status).toBe(404);
    expect(String(ownerId)).not.toBe(String(memberId));
  });

  it("previews and creates CSV reference options while accepting source date, amount, member and mode", async () => {
    const actor = "csvautocreate";
    await request("POST", "me/bootstrap", actor, {});
    const user = (await UserModel.findOne({ firebaseUid: actor }))!;
    user.displayName = "Bharat Singhani";
    await user.save();
    const bucket = await request("POST", "buckets", actor, {
      name: "CSV Auto Create",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const root = `buckets/${bucket.payload.data.id}`;
    const headers = [
      "Date",
      "Description",
      "PaidBy",
      "Category",
      "Platform",
      "Payment Mode",
      "Bank Account",
      "Amount",
      "Currency",
      "Added By",
    ];
    const created = await request("POST", `${root}/imports`, actor, {
      fileName: "april.csv",
      fileHash: "d".repeat(64),
      fileSize: 300,
      rowCount: 1,
      headers,
    });
    const importId = created.payload.data.id;
    const staged = await request(
      "PUT",
      `${root}/imports/${importId}/chunks/0`,
      actor,
      {
        rows: [
          {
            rowNumber: 1,
            cells: [
              "1/4/2026",
              "April bill",
              "Bharat",
              "Bills",
              "Finance App",
              "Auto Debit",
              "ICICI",
              "5,522.77",
              "INR",
              "Bharat",
            ],
          },
        ],
      },
      { "If-Match": created.response.headers.get("ETag")! },
    );
    expect(staged.response.status, JSON.stringify(staged.payload)).toBe(200);
    const preview = await request("POST", `${root}/imports/${importId}/validate`, actor, {});
    expect(preview.response.status, JSON.stringify(preview.payload)).toBe(200);
    expect(preview.payload.data.counts.ready).toBe(1);
    expect(preview.payload.data.proposedOptions).toEqual([
      { kind: "category", name: "Bills" },
      { kind: "account", name: "ICICI" },
      { kind: "platform", name: "Finance App" },
    ]);
    expect(
      await OptionModel.countDocuments({
        bucketId: bucket.payload.data.id,
        name: { $in: ["Bills", "ICICI", "Finance App"] },
      }),
    ).toBe(0);
    const confirmed = await request(
      "POST",
      `${root}/imports/${importId}/confirm`,
      actor,
      {
        previewDigest: preview.payload.data.previewDigest,
        acknowledgments: ["defaults", "ignored_comments", "duplicates", "conversion"],
      },
      { "If-Match": staged.response.headers.get("ETag")! },
    );
    expect(confirmed.response.status, JSON.stringify(confirmed.payload)).toBe(200);
    const committed = await request("POST", `${root}/imports/${importId}/commit-next`, actor, {});
    expect(committed.response.status, JSON.stringify(committed.payload)).toBe(200);
    expect(committed.payload.data.committed).toBe(1);
    const expense = await ExpenseModel.findOne({ originKey: `import:${importId}:1` });
    expect(expense?.expenseDate).toBe("2026-04-01");
    expect(expense?.originalAmount.toString()).toBe("5522.77");
    expect(expense?.paymentMode).toBe("auto_debit");
    expect(String(expense?.paidByUserId)).toBe(String(user._id));
    expect(String(expense?.addedByUserId)).toBe(String(user._id));
    expect(
      await OptionModel.countDocuments({
        bucketId: bucket.payload.data.id,
        name: { $in: ["Bills", "ICICI", "Finance App"] },
      }),
    ).toBe(3);
  });

  it("stages and commits one CSV row, exports a completed snapshot, and rejects a changed revision", async () => {
    const actor = "phase6csv";
    await request("POST", "me/bootstrap", actor, {});
    const bucket = await request("POST", "buckets", actor, {
      name: "CSV Test",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const bucketId = bucket.payload.data.id;
    const root = `buckets/${bucketId}`;
    const actorId = String((await UserModel.findOne({ firebaseUid: actor }))!._id);
    const categories = await request("GET", `${root}/options/categories`, actor);
    const account = await request("POST", `${root}/options/accounts`, actor, { name: "Checking" });
    expect(account.response.status).toBe(201);
    const headers = [
      "Date",
      "Description",
      "PaidBy",
      "Category",
      "Platform",
      "Payment Mode",
      "Bank Account",
      "Amount",
      "Currency",
      "Added By",
      "Notes",
      "Comments",
      "Status",
    ];
    const created = await request("POST", `${root}/imports`, actor, {
      fileName: "expenses.csv",
      fileHash: "a".repeat(64),
      fileSize: 256,
      rowCount: 1,
      headers,
    });
    expect(created.response.status, JSON.stringify(created.payload)).toBe(201);
    const importId = created.payload.data.id;
    const staged = await request(
      "PUT",
      `${root}/imports/${importId}/chunks/0`,
      actor,
      {
        rows: [
          {
            rowNumber: 1,
            cells: [
              "02/01/2026",
              "Market",
              actorId,
              categories.payload.data[0].id,
              "",
              "UPI",
              account.payload.data.id,
              "250.00",
              "",
              "",
              "",
              "",
              "",
            ],
          },
        ],
      },
      { "If-Match": created.response.headers.get("ETag")! },
    );
    expect(staged.response.status, JSON.stringify(staged.payload)).toBe(200);
    const resolved = await request(
      "PATCH",
      `${root}/imports/${importId}/resolution`,
      actor,
      { rows: [{ rowNumber: 1, corrections: { Date: "02/01/2026" } }] },
      { "X-Buckit-Revision": staged.response.headers.get("ETag")! },
    );
    expect(resolved.response.status, JSON.stringify(resolved.payload)).toBe(200);
    const staleResolution = await request(
      "PATCH",
      `${root}/imports/${importId}/resolution`,
      actor,
      { rows: [{ rowNumber: 1, excluded: true }] },
      { "X-Buckit-Revision": staged.response.headers.get("ETag")! },
    );
    expect(staleResolution.response.status).toBe(412);
    expect(staleResolution.payload.error.code).toBe("REVISION_MISMATCH");
    const validation = await request("POST", `${root}/imports/${importId}/validate`, actor, {});
    expect(validation.response.status, JSON.stringify(validation.payload)).toBe(200);
    expect(validation.payload.data.counts.ready).toBe(1);
    const confirmed = await request(
      "POST",
      `${root}/imports/${importId}/confirm`,
      actor,
      {
        previewDigest: validation.payload.data.previewDigest,
        acknowledgments: ["defaults", "ignored_comments", "duplicates", "conversion"],
      },
      { "If-Match": resolved.response.headers.get("ETag")! },
    );
    expect(confirmed.response.status, JSON.stringify(confirmed.payload)).toBe(200);
    const committed = await request("POST", `${root}/imports/${importId}/commit-next`, actor, {});
    expect(committed.response.status, JSON.stringify(committed.payload)).toBe(200);
    expect(committed.payload.data.committed).toBe(1);
    const expense = await ExpenseModel.findOne({ bucketId, originKey: `import:${importId}:1` });
    expect(expense?.description).toBe("Market");
    const duplicate = await request("POST", `${root}/imports`, actor, {
      fileName: "again.csv",
      fileHash: "c".repeat(64),
      fileSize: 256,
      rowCount: 1,
      headers,
    });
    const duplicateId = duplicate.payload.data.id;
    const duplicateStage = await request(
      "PUT",
      `${root}/imports/${duplicateId}/chunks/0`,
      actor,
      {
        rows: [
          {
            rowNumber: 1,
            cells: [
              "02/01/2026",
              "Market",
              actorId,
              categories.payload.data[0].id,
              "",
              "UPI",
              account.payload.data.id,
              "250.00",
              "",
              "",
              "",
              "",
              "",
            ],
          },
        ],
      },
      { "If-Match": duplicate.response.headers.get("ETag")! },
    );
    expect(duplicateStage.response.status).toBe(200);
    const duplicatePreview = await request(
      "POST",
      `${root}/imports/${duplicateId}/validate`,
      actor,
      {},
    );
    expect(duplicatePreview.payload.data.rows[0].duplicateCandidates).toContain(
      String(expense!._id),
    );
    expect(duplicatePreview.payload.data.counts.invalid).toBe(1);
    const selection = { scope: "all", filters: {}, includeScheduled: false };
    const started = await request("POST", `${root}/exports/start`, actor, selection);
    expect(started.response.status, JSON.stringify(started.payload)).toBe(200);
    const exportToken = started.payload.data.exportToken;
    const page = await request("POST", `${root}/exports/page`, actor, { exportToken });
    expect(page.response.status, JSON.stringify(page.payload)).toBe(200);
    expect(page.payload.data.rows[0].cells[1]).toBe("Market");
    const complete = await request("POST", `${root}/exports/complete`, actor, {
      exportToken,
      completionCursor: page.payload.data.completionCursor,
    });
    expect(complete.response.status).toBe(200);
    await request("POST", `${root}/options/accounts`, actor, { name: "Another" });
    await request("POST", `${root}/expenses`, actor, {
      expenseDate: "2026-01-03",
      description: "Newer",
      paidByUserId: actorId,
      categoryId: categories.payload.data[0].id,
      accountId: account.payload.data.id,
      paymentMode: "upi",
      originalAmount: "10.00",
    });
    expect(
      (await request("POST", `${root}/exports/page`, actor, { exportToken })).payload.error.code,
    ).toBe("EXPORT_CHANGED");
  });

  it("requires an explicit decision for repeated rows in one CSV", async () => {
    const actor = "phase6duplicates";
    await request("POST", "me/bootstrap", actor, {});
    const bucket = await request("POST", "buckets", actor, {
      name: "Duplicate CSV",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const root = `buckets/${bucket.payload.data.id}`;
    const actorId = String((await UserModel.findOne({ firebaseUid: actor }))!._id);
    const category = (await request("GET", `${root}/options/categories`, actor)).payload.data[0].id;
    const account = (await request("POST", `${root}/options/accounts`, actor, { name: "Checking" }))
      .payload.data.id;
    const headers = [
      "Date",
      "Description",
      "PaidBy",
      "Category",
      "Payment Mode",
      "Bank Account",
      "Amount",
    ];
    const created = await request("POST", `${root}/imports`, actor, {
      fileName: "repeat.csv",
      fileHash: "b".repeat(64),
      fileSize: 200,
      rowCount: 2,
      headers,
    });
    const importId = created.payload.data.id;
    const cells = ["03/01/2026", "Repeated lunch", actorId, category, "UPI", account, "100.00"];
    const staged = await request(
      "PUT",
      `${root}/imports/${importId}/chunks/0`,
      actor,
      {
        rows: [
          { rowNumber: 1, cells },
          { rowNumber: 2, cells },
        ],
      },
      { "If-Match": created.response.headers.get("ETag")! },
    );
    expect(staged.response.status).toBe(200);
    const first = await request("POST", `${root}/imports/${importId}/validate`, actor, {});
    expect(first.payload.data.counts.invalid).toBe(2);
    expect(first.payload.data.rows[0].duplicateCandidates).toContain("row:2");
    const needsReview = await request(
      "GET",
      `${root}/imports/${importId}/rows?status=invalid`,
      actor,
    );
    expect(needsReview.payload.data.map((row: { rowNumber: number }) => row.rowNumber)).toEqual([
      1, 2,
    ]);
    const resolved = await request(
      "PATCH",
      `${root}/imports/${importId}/resolution`,
      actor,
      {
        rows: [
          { rowNumber: 1, duplicateDecision: "include" },
          { rowNumber: 2, duplicateDecision: "skip" },
        ],
      },
      { "If-Match": staged.response.headers.get("ETag")! },
    );
    expect(resolved.response.status, JSON.stringify(resolved.payload)).toBe(200);
    const second = await request("POST", `${root}/imports/${importId}/validate`, actor, {});
    expect(second.payload.data.counts.ready).toBe(1);
    expect(second.payload.data.counts.excluded).toBe(1);
    const readyRows = await request("GET", `${root}/imports/${importId}/rows?status=ready`, actor);
    expect(readyRows.payload.data.map((row: { rowNumber: number }) => row.rowNumber)).toEqual([1]);
    const excludedRows = await request(
      "GET",
      `${root}/imports/${importId}/rows?status=excluded&after=1`,
      actor,
    );
    expect(excludedRows.payload.data.map((row: { rowNumber: number }) => row.rowNumber)).toEqual([
      2,
    ]);
    expect(
      (await request("GET", `${root}/imports/${importId}/rows?status=invalid`, actor)).payload.data,
    ).toEqual([]);
    expect(
      (await request("GET", `${root}/imports/${importId}/rows?status=unknown`, actor)).response
        .status,
    ).toBe(400);
    const confirmed = await request(
      "POST",
      `${root}/imports/${importId}/confirm`,
      actor,
      {
        previewDigest: second.payload.data.previewDigest,
        acknowledgments: ["defaults", "ignored_comments", "duplicates", "conversion"],
      },
      { "If-Match": resolved.response.headers.get("ETag")! },
    );
    expect(confirmed.response.status).toBe(200);
    const committed = await request("POST", `${root}/imports/${importId}/commit-next`, actor, {});
    expect(committed.payload.data.committed).toBe(1);
  });

  it("finds review rows beyond the first page and paginates within a status", async () => {
    const actor = "phase6filteredrows";
    await request("POST", "me/bootstrap", actor, {});
    const bucket = await request("POST", "buckets", actor, {
      name: "Filtered CSV",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const root = `buckets/${bucket.payload.data.id}`;
    const actorId = String((await UserModel.findOne({ firebaseUid: actor }))!._id);
    const category = (await request("GET", `${root}/options/categories`, actor)).payload.data[0].id;
    const account = (await request("POST", `${root}/options/accounts`, actor, { name: "Checking" }))
      .payload.data.id;
    const created = await request("POST", `${root}/imports`, actor, {
      fileName: "filtered.csv",
      fileHash: "e".repeat(64),
      fileSize: 6000,
      rowCount: 52,
      headers: [
        "Date",
        "Description",
        "PaidBy",
        "Category",
        "Payment Mode",
        "Bank Account",
        "Amount",
      ],
    });
    const importId = created.payload.data.id;
    const staged = await request(
      "PUT",
      `${root}/imports/${importId}/chunks/0`,
      actor,
      {
        rows: Array.from({ length: 52 }, (_, index) => ({
          rowNumber: index + 1,
          cells: [
            "03/01/2026",
            `Purchase ${index + 1}`,
            actorId,
            category,
            "UPI",
            account,
            index === 51 ? "" : "100.00",
          ],
        })),
      },
      { "If-Match": created.response.headers.get("ETag")! },
    );
    expect(staged.response.status, JSON.stringify(staged.payload)).toBe(200);
    const validation = await request("POST", `${root}/imports/${importId}/validate`, actor, {});
    expect(validation.payload.data.counts).toMatchObject({ ready: 51, invalid: 1 });
    const invalid = await request("GET", `${root}/imports/${importId}/rows?status=invalid`, actor);
    expect(invalid.payload.data.map((row: { rowNumber: number }) => row.rowNumber)).toEqual([52]);
    const readyFirst = await request("GET", `${root}/imports/${importId}/rows?status=ready`, actor);
    expect(readyFirst.payload.data).toHaveLength(50);
    expect(readyFirst.payload.meta.nextCursor).toBe("50");
    const readyNext = await request(
      "GET",
      `${root}/imports/${importId}/rows?status=ready&after=50`,
      actor,
    );
    expect(readyNext.payload.data.map((row: { rowNumber: number }) => row.rowNumber)).toEqual([51]);
    const readyExpanded = await request(
      "GET",
      `${root}/imports/${importId}/rows?status=ready&limit=51`,
      actor,
    );
    expect(readyExpanded.payload.data).toHaveLength(51);
    expect(readyExpanded.payload.meta.nextCursor).toBeNull();
    expect(
      (await request("GET", `${root}/imports/${importId}/rows?limit=501`, actor)).response.status,
    ).toBe(400);
  });

  it("imports historical expenses paid by a former bucket member without restoring their access", async () => {
    const owner = "phase6formerowner";
    const former = "phase6formermember";
    await request("POST", "me/bootstrap", owner, {});
    await request("POST", "me/bootstrap", former, {});
    const bucket = await request("POST", "buckets", owner, {
      name: "Historical CSV",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const root = `buckets/${bucket.payload.data.id}`;
    const invite = await request("POST", `${root}/invitations`, owner, {});
    const token = new URL(invite.payload.data.shareUrl).hash.slice(1);
    expect((await request("POST", "invitations/join", former, { token })).response.status).toBe(
      201,
    );
    const formerId = String((await UserModel.findOne({ firebaseUid: former }))!._id);
    const membership = (await request("GET", `${root}/members`, owner)).payload.data.find(
      (person: { id: string }) => person.id === formerId,
    );
    expect(
      (
        await request("DELETE", `${root}/members/${membership.membershipId}`, owner, undefined, {
          "If-Match": `"r${membership.revision}"`,
        })
      ).response.status,
    ).toBe(200);
    const category = (await request("GET", `${root}/options/categories`, owner)).payload.data[0].id;
    const account = (
      await request("POST", `${root}/options/accounts`, owner, { name: "Historical account" })
    ).payload.data.id;
    const headers = [
      "Date",
      "Description",
      "PaidBy",
      "Category",
      "Payment Mode",
      "Bank Account",
      "Amount",
      "Added By",
    ];
    const created = await request("POST", `${root}/imports`, owner, {
      fileName: "history.csv",
      fileHash: "d".repeat(64),
      fileSize: 200,
      rowCount: 1,
      headers,
    });
    const importId = created.payload.data.id;
    const staged = await request(
      "PUT",
      `${root}/imports/${importId}/chunks/0`,
      owner,
      {
        rows: [
          {
            rowNumber: 1,
            cells: [
              "04/01/2026",
              "Old bill",
              formerId,
              category,
              "cash",
              account,
              "35.00",
              formerId,
            ],
          },
        ],
      },
      { "If-Match": created.response.headers.get("ETag")! },
    );
    expect(staged.response.status, JSON.stringify(staged.payload)).toBe(200);
    const preview = await request("POST", `${root}/imports/${importId}/validate`, owner, {});
    expect(preview.payload.data.counts.ready, JSON.stringify(preview.payload)).toBe(1);
    const confirmed = await request(
      "POST",
      `${root}/imports/${importId}/confirm`,
      owner,
      {
        previewDigest: preview.payload.data.previewDigest,
        acknowledgments: ["defaults", "ignored_comments", "duplicates", "conversion"],
      },
      { "If-Match": staged.response.headers.get("ETag")! },
    );
    expect(confirmed.response.status, JSON.stringify(confirmed.payload)).toBe(200);
    expect(
      (await request("POST", `${root}/imports/${importId}/commit-next`, owner, {})).response.status,
    ).toBe(200);
    const saved = await ExpenseModel.findOne({ originKey: `import:${importId}:1` });
    expect(String(saved?.paidByUserId)).toBe(formerId);
    expect(String(saved?.addedByUserId)).toBe(formerId);
    expect((await request("GET", `${root}/expenses`, former)).response.status).toBe(404);
  });

  it("revalidates only remaining rows after a partial import becomes stale", async () => {
    const actor = "phase6partial";
    await request("POST", "me/bootstrap", actor, {});
    const bucket = await request("POST", "buckets", actor, {
      name: "Partial CSV",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const root = `buckets/${bucket.payload.data.id}`;
    const actorId = String((await UserModel.findOne({ firebaseUid: actor }))!._id);
    const category = (await request("GET", `${root}/options/categories`, actor)).payload.data[0].id;
    const account = (await request("POST", `${root}/options/accounts`, actor, { name: "Checking" }))
      .payload.data.id;
    const created = await request("POST", `${root}/imports`, actor, {
      fileName: "partial.csv",
      fileHash: "e".repeat(64),
      fileSize: 2000,
      rowCount: 21,
      headers: [
        "Date",
        "Description",
        "PaidBy",
        "Category",
        "Payment Mode",
        "Bank Account",
        "Amount",
      ],
    });
    const importId = created.payload.data.id;
    const staged = await request(
      "PUT",
      `${root}/imports/${importId}/chunks/0`,
      actor,
      {
        rows: Array.from({ length: 21 }, (_, index) => ({
          rowNumber: index + 1,
          cells: [
            "05/01/2026",
            `Purchase ${index + 1}`,
            actorId,
            category,
            "cash",
            account,
            "10.00",
          ],
        })),
      },
      { "If-Match": created.response.headers.get("ETag")! },
    );
    expect(staged.response.status, JSON.stringify(staged.payload)).toBe(200);
    const preview = await request("POST", `${root}/imports/${importId}/validate`, actor, {});
    expect(preview.payload.data.counts.ready).toBe(21);
    const confirmed = await request(
      "POST",
      `${root}/imports/${importId}/confirm`,
      actor,
      {
        previewDigest: preview.payload.data.previewDigest,
        acknowledgments: ["defaults", "ignored_comments", "duplicates", "conversion"],
      },
      { "If-Match": staged.response.headers.get("ETag")! },
    );
    expect(confirmed.response.status).toBe(200);
    const first = await request("POST", `${root}/imports/${importId}/commit-next`, actor, {});
    expect(first.payload.data.committed).toBe(20);
    expect(first.payload.data.pending).toBe(1);
    expect(
      (
        await request("POST", `${root}/expenses`, actor, {
          expenseDate: "2026-01-06",
          description: "Outside edit",
          paidByUserId: actorId,
          categoryId: category,
          accountId: account,
          paymentMode: "cash",
          originalAmount: "9.00",
        })
      ).response.status,
    ).toBe(201);
    expect(
      (await request("POST", `${root}/imports/${importId}/commit-next`, actor, {})).payload.error
        .code,
    ).toBe("PREVIEW_STALE");
    const current = await request("GET", `${root}/imports/${importId}`, actor);
    const reopened = await request(
      "POST",
      `${root}/imports/${importId}/reopen`,
      actor,
      {},
      {
        "If-Match": current.response.headers.get("ETag")!,
      },
    );
    expect(reopened.response.status, JSON.stringify(reopened.payload)).toBe(200);
    const reviewed = await request("POST", `${root}/imports/${importId}/validate`, actor, {});
    expect(reviewed.payload.data.counts.committed).toBe(20);
    expect(reviewed.payload.data.counts.ready).toBe(1);
    const reconfirmed = await request(
      "POST",
      `${root}/imports/${importId}/confirm`,
      actor,
      {
        previewDigest: reviewed.payload.data.previewDigest,
        acknowledgments: ["defaults", "ignored_comments", "duplicates", "conversion"],
      },
      { "If-Match": reopened.response.headers.get("ETag")! },
    );
    expect(reconfirmed.response.status, JSON.stringify(reconfirmed.payload)).toBe(200);
    const continuation = await continuePendingImports();
    expect(continuation.committed).toBe(1);
    expect((await request("GET", `${root}/imports/${importId}`, actor)).payload.data.state).toBe(
      "completed",
    );
  });
});

describe("Phase 5 notification preferences", () => {
  it("defaults to inbox-only, updates selected triggers, and rejects stale revisions", async () => {
    const actor = "phase5prefs";
    await request("POST", "me/bootstrap", actor, {});
    const user = await UserModel.findOne({ firebaseUid: actor });
    await UserModel.collection.updateOne(
      { _id: user._id },
      { $unset: { notificationPreferenceRevision: "" } },
    );
    const initial = await request("GET", "me/notification-preferences", actor);
    expect(initial.response.status).toBe(200);
    expect(initial.payload.data.triggers["expense.added"]).toEqual({ inApp: true, push: false });
    const key = randomUUID();
    const changed = await request(
      "PATCH",
      "me/notification-preferences",
      actor,
      { "expense.added": { inApp: false, push: true } },
      { "If-Match": initial.response.headers.get("ETag")!, "Idempotency-Key": key },
    );
    expect(changed.response.status, JSON.stringify(changed.payload)).toBe(200);
    expect(changed.payload.data.triggers["expense.added"]).toEqual({ inApp: false, push: true });
    expect(changed.payload.data.triggers["expense.edited"]).toEqual({ inApp: true, push: false });
    const replay = await request(
      "PATCH",
      "me/notification-preferences",
      actor,
      { "expense.added": { inApp: false, push: true } },
      { "If-Match": initial.response.headers.get("ETag")!, "Idempotency-Key": key },
    );
    expect(replay.response.status).toBe(200);
    expect(
      (
        await request(
          "PATCH",
          "me/notification-preferences",
          actor,
          { "expense.added": { inApp: true, push: true } },
          { "If-Match": initial.response.headers.get("ETag")! },
        )
      ).response.status,
    ).toBe(412);
  });

  it("creates, edits, and removes a personal fixed-schedule reminder", async () => {
    const actor = "phase5reminder";
    await request("POST", "me/bootstrap", actor, { timezone: "Asia/Kolkata" });
    const created = await request("POST", "me/reminders", actor, {
      frequency: "weekly",
      weekdays: [1],
    });
    expect(created.response.status, JSON.stringify(created.payload)).toBe(201);
    expect(created.payload.data.frequency).toBe("weekly");
    expect(created.payload.data.timezone).toBe("Asia/Kolkata");
    const id = created.payload.data.id;
    const listed = await request("GET", "me/reminders", actor);
    expect(listed.payload.data.map((item: { id: string }) => item.id)).toContain(id);
    const edited = await request(
      "PATCH",
      `me/reminders/${id}`,
      actor,
      { frequency: "monthly", dayOfMonth: 31 },
      { "If-Match": created.response.headers.get("ETag")! },
    );
    expect(edited.response.status, JSON.stringify(edited.payload)).toBe(200);
    expect(edited.payload.data.frequency).toBe("monthly");
    expect(
      (
        await request(
          "PATCH",
          `me/reminders/${id}`,
          actor,
          { enabled: false },
          { "If-Match": created.response.headers.get("ETag")! },
        )
      ).response.status,
    ).toBe(412);
    const removed = await request("DELETE", `me/reminders/${id}`, actor, undefined, {
      "If-Match": edited.response.headers.get("ETag")!,
    });
    expect(removed.response.status).toBe(204);
    expect((await request("GET", "me/reminders", actor)).payload.data).toHaveLength(0);
  });

  it("delivers one due reminder to the inbox and marks it read", async () => {
    const actor = "phase5inbox";
    await request("POST", "me/bootstrap", actor, { timezone: "UTC" });
    const created = await request("POST", "me/reminders", actor, { frequency: "daily" });
    await ReminderModel.updateOne(
      { _id: created.payload.data.id },
      {
        $set: {
          nextLocalDate: localDate(new Date(), "UTC"),
          nextDueAt: new Date(Date.now() - 1000),
        },
      },
    );
    expect((await processDueReminders()).emitted).toBe(1);
    expect((await processDueReminders()).emitted).toBe(0);
    expect((await fanoutPendingEvents()).completed).toBeGreaterThanOrEqual(1);
    const inbox = await request("GET", "notifications?filter=unread", actor);
    expect(inbox.payload.data).toHaveLength(1);
    expect(inbox.payload.data[0].trigger).toBe("reminder.due");
    expect((await request("GET", "notifications/unread-count", actor)).payload.data.count).toBe(1);
    const read = await request("POST", "notifications/read", actor, {
      notificationIds: [inbox.payload.data[0].id],
    });
    expect(read.response.status).toBe(200);
    expect((await request("GET", "notifications/unread-count", actor)).payload.data.count).toBe(0);
  });

  it("binds and revokes a device without exposing its FCM token", async () => {
    const actor = "phase5push";
    await request("POST", "me/bootstrap", actor, {});
    const id = randomUUID();
    const token = "test-only-fcm-token-that-must-not-be-returned";
    const registered = await request("PUT", `me/push-installations/${id}`, actor, {
      token,
      permission: "granted",
    });
    expect(registered.response.status, JSON.stringify(registered.payload)).toBe(201);
    expect(JSON.stringify(registered.payload)).not.toContain(token);
    const listed = await request("GET", "me/push-installations", actor);
    expect(listed.payload.data).toHaveLength(1);
    expect(JSON.stringify(listed.payload)).not.toContain(token);
    const revoked = await request("DELETE", `me/push-installations/${id}`, actor, undefined, {
      "If-Match": registered.response.headers.get("ETag")!,
    });
    expect(revoked.response.status).toBe(204);
    const revokedList = await request("GET", "me/push-installations", actor);
    expect(revokedList.payload.data).toMatchObject([{ installationId: id, state: "revoked" }]);
    const reenabled = await request(
      "PUT",
      `me/push-installations/${id}`,
      actor,
      { token, permission: "granted" },
      { "If-Match": `"r${revokedList.payload.data[0].revision}"` },
    );
    expect(reenabled.response.status, JSON.stringify(reenabled.payload)).toBe(200);
    expect(reenabled.payload.data.state).toBe("active");
    expect(JSON.stringify(reenabled.payload)).not.toContain(token);
    const nextActor = "phase5pushother";
    await request("POST", "me/bootstrap", nextActor, {});
    const rebound = await request("PUT", `me/push-installations/${id}`, nextActor, {
      token,
      permission: "granted",
    });
    expect(rebound.response.status, JSON.stringify(rebound.payload)).toBe(201);
    expect((await request("GET", "me/push-installations", actor)).payload.data[0].state).toBe(
      "revoked",
    );
  });

  it("explains when push registration lacks its server encryption key", async () => {
    const actor = "phase5pushmissingkey";
    await request("POST", "me/bootstrap", actor, {});
    const configured = process.env.PUSH_TOKEN_ENCRYPTION_KEY;
    delete process.env.PUSH_TOKEN_ENCRYPTION_KEY;
    try {
      const response = await request("PUT", `me/push-installations/${randomUUID()}`, actor, {
        token: "test-only-fcm-token-that-must-not-be-returned",
        permission: "granted",
      });
      expect(response.response.status).toBe(503);
      expect(response.payload.error.code).toBe("PUSH_CONFIGURATION_MISSING");
      expect(JSON.stringify(response.payload)).not.toContain("test-only-fcm-token");
    } finally {
      process.env.PUSH_TOKEN_ENCRYPTION_KEY = configured;
    }
  });

  it("notifies current members when someone joins or is removed", async () => {
    const owner = "phase5memberowner";
    const guest = "phase5memberguest";
    await request("POST", "me/bootstrap", owner, {});
    await request("POST", "me/bootstrap", guest, {});
    const bucket = await request("POST", "buckets", owner, {
      name: "Notification membership test",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const root = `buckets/${bucket.payload.data.id}`;
    const invite = await request("POST", `${root}/invitations`, owner, {});
    const token = new URL(invite.payload.data.shareUrl).hash.slice(1);
    expect((await request("POST", "invitations/join", guest, { token })).response.status).toBe(201);
    const joined = await request("GET", "notifications", owner);
    expect(joined.payload.data.map((item: { trigger: string }) => item.trigger)).toContain(
      "membership.joined",
    );
    const members = await request("GET", `${root}/members`, owner);
    const guestMembership = members.payload.data.find(
      (member: { displayName: string }) => member.displayName === guest,
    );
    expect(guestMembership).toBeDefined();
    const removed = await request(
      "DELETE",
      `${root}/members/${guestMembership.membershipId}`,
      owner,
      undefined,
      { "If-Match": `"r${guestMembership.revision}"` },
    );
    expect(removed.response.status, JSON.stringify(removed.payload)).toBe(200);
    const inbox = await request("GET", "notifications", owner);
    expect(inbox.payload.data.map((item: { trigger: string }) => item.trigger)).toContain(
      "membership.removed",
    );
    expect((await request("GET", "notifications", guest)).payload.data).toHaveLength(0);
  });
});

describe("Phase 4 scheduled spending and EMI flows", () => {
  it("accepts a fully paid plan without creating expenses and hides orphaned future entries", async () => {
    const actor = "phase4historical";
    await request("POST", "me/bootstrap", actor, {});
    const bucket = await request("POST", "buckets", actor, {
      name: "Historical EMI plans",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const root = `buckets/${bucket.payload.data.id}`;
    const profile = (await request("GET", "me", actor)).payload.data;
    const account = await request("POST", `${root}/accounts`, actor, { name: "Card" });
    const category = (await request("GET", `${root}/categories`, actor)).payload.data[0];
    const platform = (await request("GET", `${root}/platforms`, actor)).payload.data[0];
    const definition = {
      title: "Past appliance EMI",
      installmentAmount: "100.00",
      currency: "INR",
      totalInstallments: 6,
      previouslyPaidCount: 6,
      firstInstallmentDate: "2026-01-06",
      categoryId: category.id,
      accountId: account.payload.data.id,
      platformId: platform.id,
      paymentMode: "credit_card",
      paidByUserId: profile.id,
    };
    const preview = await request("POST", `${root}/emi-plans/preview`, actor, definition);
    expect(preview.payload.data.dates).toEqual([]);
    const completed = await request("POST", `${root}/emi-plans`, actor, definition);
    expect(completed.response.status, JSON.stringify(completed.payload)).toBe(201);
    expect(completed.payload.data).toMatchObject({
      state: "completed",
      recordedCount: 6,
      upcomingCount: 0,
      nextDate: null,
    });
    expect(
      (await request("GET", `${root}/emi-plans/${completed.payload.data.id}/installments`, actor))
        .payload.data,
    ).toEqual([]);
    expect(
      await ExpenseModel.countDocuments({ "source.emiPlanId": completed.payload.data.id }),
    ).toBe(0);

    const future = await request("POST", `${root}/emi-plans`, actor, {
      ...definition,
      title: "Deleted outside Buckit",
      totalInstallments: 1,
      previouslyPaidCount: 0,
      firstInstallmentDate: "2099-01-15",
    });
    expect(future.response.status, JSON.stringify(future.payload)).toBe(201);
    const before = await request(
      "GET",
      `${root}/dashboard?period=month&anchorDate=2099-01-15`,
      actor,
    );
    expect(before.payload.data.scheduledCount).toBe(1);
    await EmiPlanModel.updateOne(
      { _id: future.payload.data.id },
      { $set: { state: "owner_departed" } },
    );
    const departed = await request(
      "GET",
      `${root}/dashboard?period=month&anchorDate=2099-01-15`,
      actor,
    );
    expect(departed.payload.data.emi.activePlans).toBe(0);
    expect(departed.payload.data.scheduledCount).toBe(1);
    await EmiPlanModel.deleteOne({ _id: future.payload.data.id });

    const overview = await request(
      "GET",
      `${root}/dashboard?period=month&anchorDate=2099-01-15`,
      actor,
    );
    expect(overview.payload.data.scheduledCount).toBe(0);
    expect(overview.payload.data.emi.upcomingInstallments).toBe(0);
    expect((await request("GET", `${root}/scheduled-expenses`, actor)).payload.data).toEqual([]);
    expect((await request("GET", `${root}/expenses?status=scheduled`, actor)).payload.data).toEqual(
      [],
    );
    const summary = await request("GET", `${root}/expenses/summary?month=2099-01`, actor);
    expect(summary.payload.data.scheduledCount).toBe(0);
    const exported = await request("POST", `${root}/exports/preview`, actor, {
      scope: "all",
      filters: {},
      includeScheduled: true,
    });
    expect(exported.payload.data.count).toBe(0);
  });

  it("paginates installment history and requires an exact correction preview", async () => {
    const actor = "phase4pagination";
    await request("POST", "me/bootstrap", actor, {});
    const bucket = await request("POST", "buckets", actor, {
      name: "Long EMI plan",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const root = `buckets/${bucket.payload.data.id}`;
    const profile = (await request("GET", "me", actor)).payload.data;
    const account = await request("POST", `${root}/accounts`, actor, { name: "Card" });
    const category = (await request("GET", `${root}/categories`, actor)).payload.data[0];
    const platform = (await request("GET", `${root}/platforms`, actor)).payload.data[0];
    const definition = {
      title: "Long plan",
      installmentAmount: "100.00",
      currency: "INR",
      totalInstallments: 30,
      previouslyPaidCount: 0,
      firstInstallmentDate: "2028-01-31",
      categoryId: category.id,
      accountId: account.payload.data.id,
      platformId: platform.id,
      paymentMode: "credit_card",
      paidByUserId: profile.id,
    };
    const created = await request("POST", `${root}/emi-plans`, actor, definition);
    const planId = created.payload.data.id;
    await generateInstallments(planId);
    await generateInstallments(planId);
    const first = await request("GET", `${root}/emi-plans/${planId}/installments`, actor);
    expect(first.payload.data).toHaveLength(24);
    expect(first.payload.meta.hasMore).toBe(true);
    const second = await request(
      "GET",
      `${root}/emi-plans/${planId}/installments?cursor=${first.payload.meta.nextCursor}`,
      actor,
    );
    expect(second.payload.data).toHaveLength(6);
    expect(second.payload.data[0].number).toBe(25);
    expect(second.payload.meta.hasMore).toBe(false);
    expect(
      (await request("GET", `${root}/emi-plans/${planId}/installments?cursor=wrong`, actor))
        .response.status,
    ).toBe(400);

    const plan = await request("GET", `${root}/emi-plans/${planId}`, actor);
    const edits = { title: "Corrected plan", installmentAmount: "125.00" };
    const preview = await request("POST", `${root}/emi-plans/preview`, actor, {
      planId,
      expectedRevision: plan.payload.data.revision,
      edits,
    });
    expect(preview.payload.data.affectedCount).toBe(30);
    expect(preview.payload.data.affected[0].number).toBe(1);
    expect(
      (
        await request(
          "PATCH",
          `${root}/emi-plans/${planId}`,
          actor,
          { ...edits, validationToken: "invalid" },
          { "If-Match": plan.response.headers.get("ETag")! },
        )
      ).response.status,
    ).toBe(412);
    const changed = await request(
      "PATCH",
      `${root}/emi-plans/${planId}`,
      actor,
      { ...edits, validationToken: preview.payload.data.validationToken },
      { "If-Match": plan.response.headers.get("ETag")! },
    );
    expect(changed.response.status, JSON.stringify(changed.payload)).toBe(200);
    expect(changed.payload.data.title).toBe("Corrected plan");
    const updated = await request("GET", `${root}/emi-plans/${planId}/installments`, actor);
    expect(updated.payload.data[0].amount).toBe("125.00");
    const nextPreview = await request("POST", `${root}/emi-plans/preview`, actor, {
      planId,
      expectedRevision: changed.payload.data.revision,
      edits: { title: "Another correction" },
    });
    await request(
      "POST",
      `${root}/emi-plans/${planId}/installments/${updated.payload.data[0].id}/skip`,
      actor,
      undefined,
      { "If-Match": `"r${updated.payload.data[0].expenseRevision}"` },
    );
    expect(
      (
        await request(
          "PATCH",
          `${root}/emi-plans/${planId}`,
          actor,
          {
            title: "Another correction",
            validationToken: nextPreview.payload.data.validationToken,
          },
          { "If-Match": changed.response.headers.get("ETag")! },
        )
      ).response.status,
    ).toBe(412);
  });

  it("generates a month-end plan, posts once, and keeps skipped installments unpaid", async () => {
    const actor = "phase4owner";
    await request("POST", "me/bootstrap", actor, {});
    const created = await request("POST", "buckets", actor, {
      name: "Phase 4 test",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const root = `buckets/${created.payload.data.id}`;
    const profile = (await request("GET", "me", actor)).payload.data;
    const account = await request("POST", `${root}/accounts`, actor, { name: "Installment card" });
    const category = (await request("GET", `${root}/categories`, actor)).payload.data[0];
    const platform = (await request("GET", `${root}/platforms`, actor)).payload.data[0];
    const definition = {
      title: "Air conditioner",
      installmentAmount: "5000.00",
      currency: "INR",
      totalInstallments: 4,
      previouslyPaidCount: 1,
      firstInstallmentDate: "2026-01-31",
      categoryId: category.id,
      accountId: account.payload.data.id,
      platformId: platform.id,
      paymentMode: "credit_card",
      paidByUserId: profile.id,
    };
    const preview = await request("POST", `${root}/emi-plans/preview`, actor, definition);
    expect(preview.payload.data.dates.map((item: { date: string }) => item.date)).toEqual([
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
    const plan = await request("POST", `${root}/emi-plans`, actor, definition);
    expect(plan.response.status).toBe(201);
    expect(plan.payload.data.generatedThroughNumber).toBe(4);
    expect(plan.payload.data.recordedCount).toBe(1);
    expect(
      (await request("GET", `${root}/dashboard?period=month&anchorDate=2026-03-15`, actor)).payload
        .data.emi.activePlans,
    ).toBe(1);
    const planId = plan.payload.data.id;
    const installments = await request("GET", `${root}/emi-plans/${planId}/installments`, actor);
    expect(installments.payload.data).toHaveLength(3);
    const first = installments.payload.data[0];
    expect(
      (
        await request(
          "POST",
          `${root}/emi-plans/${planId}/installments/${first.id}/skip`,
          actor,
          undefined,
          { "If-Match": `"r${first.expenseRevision}"` },
        )
      ).response.status,
    ).toBe(200);
    expect(
      (await request("GET", `${root}/expenses/summary?month=2026-02`, actor)).payload.data
        .scheduledCount,
    ).toBe(0);
    const processed = await processDaily();
    expect(processed.posted).toBeGreaterThanOrEqual(2);
    const after = await request("GET", `${root}/emi-plans/${planId}/installments`, actor);
    expect(after.payload.data.map((item: { state: string }) => item.state)).toEqual([
      "skipped",
      "recorded",
      "recorded",
    ]);
    const report = await request(
      "GET",
      `${root}/reports/spending?period=custom&from=2026-01-01&toExclusive=2026-05-01`,
      actor,
    );
    expect(report.payload.data.totalAmount).toBe("10000.00");
    await processDaily();
    const reportAgain = await request(
      "GET",
      `${root}/reports/spending?period=custom&from=2026-01-01&toExclusive=2026-05-01`,
      actor,
    );
    expect(reportAgain.payload.data.totalAmount).toBe("10000.00");
    const recorded = after.payload.data[1];
    expect(
      (
        await request("DELETE", `${root}/expenses/${recorded.expenseId}`, actor, undefined, {
          "If-Match": `"r${recorded.expenseRevision}"`,
        })
      ).response.status,
    ).toBe(200);
    expect(
      (await request("GET", `${root}/emi-plans/${planId}/installments`, actor)).payload.data[1]
        .state,
    ).toBe("unpaid");
    const deleted = await request("GET", `${root}/expenses/${recorded.expenseId}`, actor);
    expect(
      (
        await request("POST", `${root}/expenses/${recorded.expenseId}/restore`, actor, undefined, {
          "If-Match": deleted.response.headers.get("ETag")!,
        })
      ).response.status,
    ).toBe(200);
    expect(
      (await request("GET", `${root}/emi-plans/${planId}/installments`, actor)).payload.data[1]
        .state,
    ).toBe("recorded");
  });

  it("reschedules one installment, ends a future plan, and protects the daily job", async () => {
    const actor = "phase4future";
    await request("POST", "me/bootstrap", actor, {});
    const created = await request("POST", "buckets", actor, {
      name: "Future schedule",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const root = `buckets/${created.payload.data.id}`;
    const ownerId = (await request("GET", "me", actor)).payload.data.id;
    const account = await request("POST", `${root}/accounts`, actor, { name: "Card" });
    const category = (await request("GET", `${root}/categories`, actor)).payload.data[0];
    const platform = (await request("GET", `${root}/platforms`, actor)).payload.data[0];
    const plan = await request("POST", `${root}/emi-plans`, actor, {
      title: "Future purchase",
      installmentAmount: "100.00",
      currency: "INR",
      totalInstallments: 2,
      previouslyPaidCount: 0,
      firstInstallmentDate: "2028-01-31",
      categoryId: category.id,
      accountId: account.payload.data.id,
      platformId: platform.id,
      paymentMode: "credit_card",
      paidByUserId: ownerId,
    });
    expect(plan.response.status).toBe(201);
    const planId = plan.payload.data.id;
    const before = (await request("GET", `${root}/emi-plans/${planId}/installments`, actor)).payload
      .data;
    const changed = await request(
      "POST",
      `${root}/emi-plans/${planId}/installments/${before[0].id}/reschedule`,
      actor,
      { expenseDate: "2028-03-05" },
      { "If-Match": `"r${before[0].expenseRevision}"` },
    );
    expect(changed.response.status).toBe(200);
    const after = (await request("GET", `${root}/emi-plans/${planId}/installments`, actor)).payload
      .data;
    expect(after.map((item: { scheduledDate: string }) => item.scheduledDate)).toEqual([
      "2028-03-05",
      "2028-02-29",
    ]);
    expect(
      (
        await request(
          "POST",
          `${root}/emi-plans/${planId}/installments/${before[0].id}/skip`,
          actor,
          undefined,
          { "If-Match": `"r${before[0].expenseRevision}"` },
        )
      ).response.status,
    ).toBe(412);
    const latest = await request("GET", `${root}/emi-plans/${planId}`, actor);
    const ended = await request("POST", `${root}/emi-plans/${planId}/end`, actor, undefined, {
      "If-Match": latest.response.headers.get("ETag")!,
    });
    expect(ended.payload.data.state).toBe("ended");
    expect(
      (await request("GET", `${root}/emi-plans/${planId}/installments`, actor)).payload.data.every(
        (item: { state: string }) => item.state === "canceled",
      ),
    ).toBe(true);
    expect(
      (await request("GET", `${root}/expenses?from=2028-01-01&toExclusive=2028-05-01`, actor))
        .payload.data,
    ).toHaveLength(0);
    expect(
      (await dailyGET(new Request("http://localhost:3000/api/internal/jobs/daily"))).status,
    ).toBe(401);
  });

  it("keeps archive-review entries out of the daily run until their creator decides", async () => {
    const actor = "phase4review";
    await request("POST", "me/bootstrap", actor, {});
    const created = await request("POST", "buckets", actor, {
      name: "Review test",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const root = `buckets/${created.payload.data.id}`;
    const ownerId = (await request("GET", "me", actor)).payload.data.id;
    const account = await request("POST", `${root}/accounts`, actor, { name: "Card" });
    const category = (await request("GET", `${root}/categories`, actor)).payload.data[0];
    const platform = (await request("GET", `${root}/platforms`, actor)).payload.data[0];
    const expense = await request("POST", `${root}/expenses`, actor, {
      expenseDate: "2026-01-15",
      description: "Archive backlog",
      paidByUserId: ownerId,
      categoryId: category.id,
      accountId: account.payload.data.id,
      platformId: platform.id,
      paymentMode: "upi",
      originalAmount: "150.00",
      originalCurrency: "INR",
    });
    const expenseId = expense.payload.data.id;
    await ExpenseModel.updateOne(
      { _id: expenseId },
      {
        $set: {
          postingState: "unposted",
          reviewState: "archive_review_required",
          dueAt: new Date("2026-01-14T18:30:00Z"),
        },
        $unset: { postedAt: "" },
      },
    );
    const pending = await request("GET", `${root}/scheduled-expenses`, actor);
    expect(pending.payload.data[0].status).toBe("review_required");
    await processDaily();
    expect(
      (await request("GET", `${root}/expenses/${expenseId}`, actor)).payload.data.displayStatus,
    ).toBe("archive_review");
    const resolved = await request(
      "POST",
      `${root}/expenses/${expenseId}/archive-resolution`,
      actor,
      { decision: "post" },
      { "If-Match": expense.response.headers.get("ETag")! },
    );
    expect(resolved.payload.data.displayStatus).toBe("actual");
    expect((await request("GET", `${root}/scheduled-expenses`, actor)).payload.data).toHaveLength(
      0,
    );
    expect(
      (
        await request(
          "POST",
          `${root}/expenses/${expenseId}/archive-resolution`,
          actor,
          { decision: "post" },
          { "If-Match": expense.response.headers.get("ETag")! },
        )
      ).response.status,
    ).toBe(404);
  });

  it("cancels a removed creator's future installments without granting edit rights on rejoin", async () => {
    const owner = "phase4memberowner";
    const member = "phase4member";
    await request("POST", "me/bootstrap", owner, {});
    await request("POST", "me/bootstrap", member, {});
    const created = await request("POST", "buckets", owner, {
      name: "Member EMI",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const root = `buckets/${created.payload.data.id}`;
    const invite = await request("POST", `${root}/invitations`, owner, {});
    const token = new URL(invite.payload.data.shareUrl).hash.slice(1);
    await request("POST", "invitations/join", member, { token });
    const account = await request("POST", `${root}/accounts`, owner, { name: "Shared card" });
    const category = (await request("GET", `${root}/categories`, owner)).payload.data[0];
    const platform = (await request("GET", `${root}/platforms`, owner)).payload.data[0];
    const memberId = (await request("GET", "me", member)).payload.data.id;
    const plan = await request("POST", `${root}/emi-plans`, member, {
      title: "Member plan",
      installmentAmount: "75.00",
      currency: "INR",
      totalInstallments: 2,
      previouslyPaidCount: 0,
      firstInstallmentDate: "2028-01-15",
      categoryId: category.id,
      accountId: account.payload.data.id,
      platformId: platform.id,
      paymentMode: "credit_card",
      paidByUserId: memberId,
    });
    expect(plan.response.status).toBe(201);
    const membership = (await request("GET", `${root}/members`, owner)).payload.data.find(
      (item: { id: string }) => item.id === memberId,
    );
    expect(
      (
        await request("DELETE", `${root}/members/${membership.membershipId}`, owner, undefined, {
          "If-Match": `"r${membership.revision}"`,
        })
      ).response.status,
    ).toBe(200);
    const planId = plan.payload.data.id;
    expect((await request("GET", `${root}/emi-plans/${planId}`, owner)).payload.data.state).toBe(
      "owner_departed",
    );
    expect(
      (await request("GET", `${root}/emi-plans/${planId}/installments`, owner)).payload.data.every(
        (item: { state: string }) => item.state === "canceled",
      ),
    ).toBe(true);
    await request("POST", "invitations/join", member, { token });
    expect(
      (await request("GET", `${root}/emi-plans/${planId}`, member)).payload.data.isCreator,
    ).toBe(false);
    expect(
      (
        await request(
          "PATCH",
          `${root}/emi-plans/${planId}`,
          member,
          { title: "Reopened" },
          { "If-Match": plan.response.headers.get("ETag")! },
        )
      ).response.status,
    ).toBe(404);
  });
});

async function request(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  uid = "owner",
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const input = new Request(`http://localhost:3000/api/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${uid}`,
      ...(body === undefined
        ? method === "DELETE" || method === "POST"
          ? { "Idempotency-Key": randomUUID() }
          : {}
        : { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await { GET, POST, PATCH, PUT, DELETE }[method](input, {
    params: Promise.resolve({ path: path.split("?")[0].split("/") }),
  });
  return { response, payload: response.status === 204 ? null : await response.json() };
}

describe("Open-ended recurring payments and reminder messages", () => {
  it("skips one future payment without ending the plan, then ends remaining projections", async () => {
    const actor = "recurring-skip-owner";
    await request("POST", "me/bootstrap", actor, {});
    const bucket = await request("POST", "buckets", actor, {
      name: "Skip Test",
      primaryCurrency: "INR",
      timezone: "UTC",
    });
    const root = `buckets/${bucket.payload.data.id}`;
    const category = (await request("GET", `${root}/options/categories`, actor)).payload.data[0].id;
    const account = (await request("POST", `${root}/options/accounts`, actor, { name: "Account" }))
      .payload.data.id;
    const userId = String((await UserModel.findOne({ firebaseUid: actor }))!._id);
    const today = new Date().toISOString().slice(0, 10);
    const second = recurringDate(today, "monthly", 1);
    const third = recurringDate(today, "monthly", 2);
    const created = await request("POST", `${root}/recurring-plans`, actor, {
      title: "Investment",
      amount: "500.00",
      currency: "INR",
      frequency: "monthly",
      startDate: today,
      endDate: third,
      categoryId: category,
      accountId: account,
      paymentMode: "upi",
      paidByUserId: userId,
      recordingMode: "confirm",
    });
    expect(created.response.status, JSON.stringify(created.payload)).toBe(201);
    const planId = created.payload.data.id;
    const skipped = await request(
      "POST",
      `${root}/recurring-plans/${planId}/occurrences/${second}/skip`,
      actor,
      {},
      { "If-Match": `"r${created.payload.data.revision}"` },
    );
    expect(skipped.response.status, JSON.stringify(skipped.payload)).toBe(200);
    expect(skipped.payload.data.state).toBe("active");
    const confirmed = await request(
      "POST",
      `${root}/recurring-plans/${planId}/confirm`,
      actor,
      { paymentDate: today },
      { "If-Match": `"r${skipped.payload.data.revision}"` },
    );
    expect(confirmed.response.status, JSON.stringify(confirmed.payload)).toBe(201);
    const current = (await request("GET", `${root}/recurring-plans`, actor)).payload.data[0];
    expect(current.nextDate).toBe(third);
    const range = `from=${second}&toExclusive=${recurringDate(today, "monthly", 3)}`;
    const ledger = await request("GET", `${root}/expenses?status=scheduled&${range}`, actor);
    expect(ledger.payload.data.map((item: { expenseDate: string }) => item.expenseDate)).toEqual([
      third,
    ]);
    const summary = await request("GET", `${root}/expenses/summary?${range}`, actor);
    expect(summary.payload.data.scheduledCount).toBe(1);
    const ended = await request(
      "PATCH",
      `${root}/recurring-plans/${planId}`,
      actor,
      { state: "ended" },
      { "If-Match": `"r${current.revision}"` },
    );
    expect(ended.response.status, JSON.stringify(ended.payload)).toBe(200);
    expect(
      (await request("GET", `${root}/expenses?status=scheduled&${range}`, actor)).payload.data,
    ).toHaveLength(0);
    expect(await ExpenseModel.countDocuments({ "source.recurringPlanId": planId })).toBe(1);
  });

  it("records a confirmed SIP once and keeps future occurrences available", async () => {
    const actor = "recurring-confirm-owner";
    await request("POST", "me/bootstrap", actor, {});
    const bucket = await request("POST", "buckets", actor, {
      name: "SIP Test",
      primaryCurrency: "INR",
      timezone: "UTC",
    });
    const root = `buckets/${bucket.payload.data.id}`;
    const category = (await request("GET", `${root}/options/categories`, actor)).payload.data[0].id;
    const account = (
      await request("POST", `${root}/options/accounts`, actor, { name: "SIP account" })
    ).payload.data.id;
    const userId = String((await UserModel.findOne({ firebaseUid: actor }))!._id);
    const today = new Date().toISOString().slice(0, 10);
    const created = await request("POST", `${root}/recurring-plans`, actor, {
      title: "Monthly SIP",
      amount: "1250.00",
      currency: "INR",
      frequency: "monthly",
      startDate: today,
      categoryId: category,
      accountId: account,
      paymentMode: "upi",
      paidByUserId: userId,
      recordingMode: "confirm",
      reminderLeadDays: 1,
      reminderPurpose: "funds",
      reminderMessage: "Check the SIP account balance.",
    });
    expect(created.response.status, JSON.stringify(created.payload)).toBe(201);
    expect(created.payload.data.nextDate).toBe(today);
    const planId = created.payload.data.id;
    expect(
      (await request("GET", `${root}/scheduled-expenses`, actor)).payload.data.some(
        (item: { sourceKind: string; status: string }) =>
          item.sourceKind === "recurring" && item.status === "due_confirmation",
      ),
    ).toBe(true);
    const confirmed = await request(
      "POST",
      `${root}/recurring-plans/${planId}/confirm`,
      actor,
      { paymentDate: today },
      { "If-Match": `"r${created.payload.data.revision}"` },
    );
    expect(confirmed.response.status, JSON.stringify(confirmed.payload)).toBe(201);
    expect(confirmed.payload.data.status).toBe("recorded");
    const expense = await ExpenseModel.findById(confirmed.payload.data.id);
    expect(expense?.postingState).toBe("posted");
    expect(expense?.source?.kind).toBe("recurring");
    const nextDate = (await request("GET", `${root}/recurring-plans`, actor)).payload.data[0]
      .nextDate as string;
    expect(nextDate).not.toBe(today);
    expect(await ExpenseModel.countDocuments({ "source.recurringPlanId": planId })).toBe(1);
    const nextMonth = new Date(
      Date.UTC(Number(nextDate.slice(0, 4)), Number(nextDate.slice(5, 7)), 1),
    )
      .toISOString()
      .slice(0, 10);
    const summary = await request(
      "GET",
      `${root}/expenses/summary?from=${nextDate}&toExclusive=${nextMonth}`,
      actor,
    );
    expect(summary.payload.data.scheduledCount).toBe(1);
    expect(summary.payload.data.scheduledTotal).toBe("1250.00");
    const dashboard = await request(
      "GET",
      `${root}/dashboard?period=month&anchorDate=${nextDate}`,
      actor,
    );
    expect(dashboard.payload.data.scheduledCount).toBe(1);
    expect(dashboard.payload.data.scheduledAmount).toBe("1250.00");
    const report = await request(
      "GET",
      `${root}/reports/spending?period=custom&from=${nextDate}&toExclusive=${nextMonth}`,
      actor,
    );
    expect(report.payload.data.scheduledCount).toBe(1);
    expect(report.payload.data.scheduledAmount).toBe("1250.00");
    const ledger = await request(
      "GET",
      `${root}/expenses?status=scheduled&from=${nextDate}&toExclusive=${nextMonth}`,
      actor,
    );
    expect(ledger.payload.data).toHaveLength(1);
    expect(ledger.payload.data[0].source).toEqual({
      kind: "recurring_projection",
      planId,
      dueDate: nextDate,
    });
    expect(ledger.payload.data[0].permissions.canDelete).toBe(false);
    const searched = await request(
      "GET",
      `${root}/expenses?status=scheduled&from=${nextDate}&toExclusive=${nextMonth}&q=SIP`,
      actor,
    );
    expect(searched.payload.data).toHaveLength(1);
    const hidden = await request(
      "GET",
      `${root}/expenses?status=scheduled&from=${nextDate}&toExclusive=${nextMonth}&q=unrelated`,
      actor,
    );
    expect(hidden.payload.data).toHaveLength(0);
    const savedFuture = await request("POST", `${root}/expenses`, actor, {
      expenseDate: nextDate,
      description: "Other future expense",
      paidByUserId: userId,
      categoryId: category,
      accountId: account,
      paymentMode: "upi",
      originalAmount: "50.00",
    });
    expect(savedFuture.response.status).toBe(201);
    const firstPage = await request(
      "GET",
      `${root}/expenses?status=scheduled&from=${nextDate}&toExclusive=${nextMonth}&limit=1`,
      actor,
    );
    const secondPage = await request(
      "GET",
      `${root}/expenses?status=scheduled&from=${nextDate}&toExclusive=${nextMonth}&limit=1&cursor=${firstPage.payload.meta.nextCursor}`,
      actor,
    );
    expect([firstPage.payload.data[0].id, secondPage.payload.data[0].id].sort()).toEqual(
      [ledger.payload.data[0].id, savedFuture.payload.data.id].sort(),
    );
    expect(secondPage.payload.meta.nextCursor).toBeNull();
    const combinedSummary = await request(
      "GET",
      `${root}/expenses/summary?from=${nextDate}&toExclusive=${nextMonth}`,
      actor,
    );
    expect(combinedSummary.payload.data.scheduledCount).toBe(2);
    expect(combinedSummary.payload.data.scheduledTotal).toBe("1300.00");
  });

  it("automatically records a due premium only once", async () => {
    const actor = "recurring-auto-owner";
    await request("POST", "me/bootstrap", actor, {});
    const bucket = await request("POST", "buckets", actor, {
      name: "Premium Test",
      primaryCurrency: "INR",
      timezone: "UTC",
    });
    const root = `buckets/${bucket.payload.data.id}`;
    const category = (await request("GET", `${root}/options/categories`, actor)).payload.data[0].id;
    const account = (
      await request("POST", `${root}/options/accounts`, actor, { name: "Premium account" })
    ).payload.data.id;
    const userId = String((await UserModel.findOne({ firebaseUid: actor }))!._id);
    const today = new Date().toISOString().slice(0, 10);
    const created = await request("POST", `${root}/recurring-plans`, actor, {
      title: "Insurance",
      amount: "700.00",
      currency: "INR",
      frequency: "yearly",
      startDate: today,
      categoryId: category,
      accountId: account,
      paymentMode: "upi",
      paidByUserId: userId,
      recordingMode: "automatic",
      reminderLeadDays: 0,
      reminderPurpose: "pay",
      reminderMessage: "Pay the insurance premium.",
    });
    expect(created.response.status, JSON.stringify(created.payload)).toBe(201);
    await processRecurringReminders();
    await fanoutPendingEvents();
    const reminder = await NotificationModel.findOne({
      recipientUserId: userId,
      triggerType: "reminder.due",
      "target.id": created.payload.data.id,
    });
    expect(reminder?.title).toBe("Pay the insurance premium.");
    await processAutomaticRecurring();
    await processAutomaticRecurring();
    expect(
      await ExpenseModel.countDocuments({ "source.recurringPlanId": created.payload.data.id }),
    ).toBe(1);
  });

  it("uses a personal reminder's custom message in the inbox", async () => {
    const actor = "reminder-message-owner";
    await request("POST", "me/bootstrap", actor, {});
    const created = await request("POST", "me/reminders", actor, {
      purpose: "custom",
      message: "Check the EMI account balance.",
      timezone: "UTC",
      frequency: "daily",
    });
    expect(created.response.status, JSON.stringify(created.payload)).toBe(201);
    await ReminderModel.updateOne(
      { _id: created.payload.data.id },
      {
        $set: {
          nextLocalDate: new Date().toISOString().slice(0, 10),
          nextDueAt: new Date(Date.now() - 60_000),
        },
      },
    );
    await processDueReminders();
    await fanoutPendingEvents();
    const user = await UserModel.findOne({ firebaseUid: actor });
    const notification = await NotificationModel.findOne({
      recipientUserId: user?._id,
      triggerType: "reminder.due",
    });
    expect(notification?.title).toBe("Check the EMI account balance.");
  });
});

describe("Phase 1 HTTP API flows", () => {
  it("saves and clears a validated profile image", async () => {
    const actor = "profileavatarowner";
    await request("POST", "me/bootstrap", actor, {});
    const initial = await request("GET", "me", actor);
    const timings = initial.response.headers.get("Server-Timing");
    for (const phase of ["auth", "db", "guards"])
      expect(timings).toMatch(new RegExp(`${phase};dur=[\\d.]+`));
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
    const invalid = await request(
      "PATCH",
      "me",
      actor,
      { avatarDataUrl: png.replace("image/png", "image/webp") },
      { "If-Match": initial.response.headers.get("ETag")! },
    );
    expect(invalid.response.status).toBe(422);
    const saved = await request(
      "PATCH",
      "me",
      actor,
      { avatarDataUrl: png },
      { "If-Match": initial.response.headers.get("ETag")! },
    );
    expect(saved.response.status).toBe(200);
    expect(saved.payload.data.avatarDataUrl).toBe(png);
    expect((await request("GET", "me", actor)).payload.data.avatarDataUrl).toBe(png);
    const cleared = await request(
      "PATCH",
      "me",
      actor,
      { avatarDataUrl: null },
      { "If-Match": saved.response.headers.get("ETag")! },
    );
    expect(cleared.payload.data.avatarDataUrl).toBeNull();
  });

  it("handles bootstrap, profile, buckets, invitation and access errors", async () => {
    expect((await request("GET", "me")).response.status).toBe(403);
    const owner = await request("POST", "me/bootstrap", "owner", {});
    expect(owner.response.status).toBe(201);
    const profile = await request("GET", "me");
    expect(profile.response.status).toBe(200);
    expect(profile.response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(
      (
        await request(
          "PATCH",
          "me",
          "owner",
          { theme: "dark" },
          { "If-Match": profile.response.headers.get("ETag")! },
        )
      ).payload.data.theme,
    ).toBe("dark");
    expect(
      (
        await request(
          "PATCH",
          "me",
          "owner",
          { theme: "light" },
          { "If-Match": profile.response.headers.get("ETag")! },
        )
      ).response.status,
    ).toBe(412);
    const created = await request("POST", "buckets", "owner", {
      name: "Shared Living",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    expect(created.response.status).toBe(201);
    const id = created.payload.data.id;
    const refreshed = await request("GET", "me");
    expect(refreshed.payload.data.revision).toBeGreaterThan(profile.payload.data.revision);
    expect(
      (
        await request(
          "PATCH",
          "me",
          "owner",
          { theme: "light" },
          { "If-Match": refreshed.response.headers.get("ETag")! },
        )
      ).payload.data.theme,
    ).toBe("light");
    expect((await request("GET", `buckets/${id}`)).payload.data.name).toBe("Shared Living");
    expect((await request("GET", "buckets")).payload.data).toHaveLength(1);
    expect((await request("GET", "capabilities")).payload.data.phase).toBe(7);
    const invite = await request("POST", `buckets/${id}/invitations`, "owner", {});
    expect(invite.response.status).toBe(201);
    const token = new URL(invite.payload.data.shareUrl).hash.slice(1);
    expect((await request("POST", "me/bootstrap", "guest", {})).response.status).toBe(201);
    expect((await request("GET", `buckets/${id}`, "guest")).response.status).toBe(404);
    expect(
      (await request("POST", "invitations/preview", "guest", { token })).payload.data.alreadyMember,
    ).toBe(false);
    expect((await request("POST", "invitations/join", "guest", { token })).response.status).toBe(
      201,
    );
    expect((await request("GET", `buckets/${id}`, "guest")).response.status).toBe(200);
    expect((await request("POST", `buckets/${id}/invitations`, "guest", {})).response.status).toBe(
      403,
    );
    expect((await request("GET", "missing")).response.status).toBe(404);
  });
});

describe("Phase 2 HTTP API flows", () => {
  it("moves an expense only after destination references and payer are mapped", async () => {
    const actor = "move-expense-owner";
    await request("POST", "me/bootstrap", actor, {});
    const source = await request("POST", "buckets", actor, {
      name: "Move source",
      primaryCurrency: "INR",
      timezone: "UTC",
    });
    const target = await request("POST", "buckets", actor, {
      name: "Move target",
      primaryCurrency: "INR",
      timezone: "UTC",
    });
    const sourceRoot = `buckets/${source.payload.data.id}`;
    const targetRoot = `buckets/${target.payload.data.id}`;
    const sourceCategory = (await request("GET", `${sourceRoot}/categories`, actor)).payload
      .data[0];
    const targetCategory = (await request("GET", `${targetRoot}/categories`, actor)).payload
      .data[0];
    const sourceAccount = (
      await request("POST", `${sourceRoot}/accounts`, actor, { name: "Old account" })
    ).payload.data;
    const targetAccount = (
      await request("POST", `${targetRoot}/accounts`, actor, { name: "New account" })
    ).payload.data;
    const payerId = (await request("GET", "me", actor)).payload.data.id;
    const created = await request("POST", `${sourceRoot}/expenses`, actor, {
      expenseDate: "2026-10-12",
      description: "Move full history",
      paidByUserId: payerId,
      categoryId: sourceCategory.id,
      accountId: sourceAccount.id,
      paymentMode: "upi",
      originalAmount: "500.00",
      originalCurrency: "INR",
    });
    expect(created.response.status, JSON.stringify(created.payload)).toBe(201);
    const id = created.payload.data.id;
    const linkedIds = [id];
    for (let depth = 0; depth < 3; depth++) {
      const refund = await request("POST", `${sourceRoot}/expenses`, actor, {
        expenseDate: "2026-10-12",
        description: `Nested refund ${depth + 1}`,
        paidByUserId: payerId,
        categoryId: sourceCategory.id,
        accountId: sourceAccount.id,
        paymentMode: "upi",
        originalAmount: "-10.00",
        originalCurrency: "INR",
        refundOfExpenseId: linkedIds.at(-1),
      });
      expect(refund.response.status, JSON.stringify(refund.payload)).toBe(201);
      linkedIds.push(refund.payload.data.id);
    }
    const endpoint = `${sourceRoot}/moves/expense/${id}`;
    const preview = await request(
      "GET",
      `${endpoint}/preview?targetBucketId=${target.payload.data.id}`,
      actor,
    );
    expect(preview.response.status, JSON.stringify(preview.payload)).toBe(200);
    expect(preview.payload.data.expenseCount).toBe(4);
    const incomplete = await request(
      "POST",
      endpoint,
      actor,
      {
        targetBucketId: target.payload.data.id,
        referenceMap: {},
        payerMap: {},
      },
      { "If-Match": created.response.headers.get("ETag")! },
    );
    expect(incomplete.response.status).toBe(422);
    const moved = await request(
      "POST",
      endpoint,
      actor,
      {
        targetBucketId: target.payload.data.id,
        referenceMap: Object.fromEntries(
          preview.payload.data.references.map(
            (entry: { sourceId: string; kind: string; choices: { id: string }[] }) => [
              entry.sourceId,
              entry.kind === "category"
                ? targetCategory.id
                : entry.kind === "account"
                  ? targetAccount.id
                  : entry.choices[0].id,
            ],
          ),
        ),
        payerMap: { [payerId]: payerId },
      },
      { "If-Match": created.response.headers.get("ETag")! },
    );
    expect(moved.response.status, JSON.stringify(moved.payload)).toBe(200);
    expect(
      (await request("GET", `${sourceRoot}/expenses?from=2026-10-01&toExclusive=2026-11-01`, actor))
        .payload.data,
    ).toHaveLength(0);
    const destination = await request("GET", `${targetRoot}/expenses/${id}`, actor);
    expect(destination.payload.data.categoryId).toBe(targetCategory.id);
    expect(destination.payload.data.accountId).toBe(targetAccount.id);
    for (const linkedId of linkedIds)
      expect(
        (await request("GET", `${targetRoot}/expenses/${linkedId}`, actor)).response.status,
      ).toBe(200);
  });

  it("moves an EMI plan with its generated installments and expenses", async () => {
    const actor = "move-emi-owner";
    await request("POST", "me/bootstrap", actor, {});
    const source = await request("POST", "buckets", actor, {
      name: "EMI source",
      primaryCurrency: "INR",
      timezone: "UTC",
    });
    const target = await request("POST", "buckets", actor, {
      name: "EMI target",
      primaryCurrency: "INR",
      timezone: "UTC",
    });
    const sourceRoot = `buckets/${source.payload.data.id}`;
    const targetRoot = `buckets/${target.payload.data.id}`;
    const category = (await request("GET", `${sourceRoot}/categories`, actor)).payload.data[0];
    const account = (await request("POST", `${sourceRoot}/accounts`, actor, { name: "EMI bank" }))
      .payload.data;
    const targetAccount = (
      await request("POST", `${targetRoot}/accounts`, actor, { name: "New EMI bank" })
    ).payload.data;
    const payerId = (await request("GET", "me", actor)).payload.data.id;
    const created = await request("POST", `${sourceRoot}/emi-plans`, actor, {
      title: "Move all installments",
      installmentAmount: "500.00",
      currency: "INR",
      totalInstallments: 3,
      previouslyPaidCount: 0,
      firstInstallmentDate: "2099-01-15",
      categoryId: category.id,
      accountId: account.id,
      paymentMode: "upi",
      paidByUserId: payerId,
    });
    expect(created.response.status, JSON.stringify(created.payload)).toBe(201);
    const id = created.payload.data.id;
    await generateInstallments(id);
    const preview = await request(
      "GET",
      `${sourceRoot}/moves/emi-plan/${id}/preview?targetBucketId=${target.payload.data.id}`,
      actor,
    );
    expect(preview.response.status, JSON.stringify(preview.payload)).toBe(200);
    expect(preview.payload.data.installmentCount).toBe(3);
    const referenceMap = Object.fromEntries(
      preview.payload.data.references.map(
        (entry: { sourceId: string; kind: string; choices: { id: string }[] }) => [
          entry.sourceId,
          entry.kind === "account" ? targetAccount.id : entry.choices[0].id,
        ],
      ),
    );
    const moved = await request(
      "POST",
      `${sourceRoot}/moves/emi-plan/${id}`,
      actor,
      {
        targetBucketId: target.payload.data.id,
        referenceMap,
        payerMap: { [payerId]: payerId },
      },
      { "If-Match": created.response.headers.get("ETag")! },
    );
    expect(moved.response.status, JSON.stringify(moved.payload)).toBe(200);
    expect((await request("GET", `${sourceRoot}/emi-plans/${id}`, actor)).response.status).toBe(
      404,
    );
    expect((await request("GET", `${targetRoot}/emi-plans/${id}`, actor)).response.status).toBe(
      200,
    );
    expect(
      (await request("GET", `${targetRoot}/emi-plans/${id}/installments`, actor)).payload.data,
    ).toHaveLength(3);
    expect(
      (await request("GET", `${sourceRoot}/expenses?status=scheduled`, actor)).payload.data,
    ).toHaveLength(0);
    expect(
      (await request("GET", `${targetRoot}/expenses?status=scheduled`, actor)).payload.data,
    ).toHaveLength(3);
  });

  it("moves a recurring plan with a previously recorded payment", async () => {
    const actor = "move-recurring-owner";
    await request("POST", "me/bootstrap", actor, {});
    const source = await request("POST", "buckets", actor, {
      name: "Recurring source",
      primaryCurrency: "INR",
      timezone: "UTC",
    });
    const target = await request("POST", "buckets", actor, {
      name: "Recurring target",
      primaryCurrency: "INR",
      timezone: "UTC",
    });
    const sourceRoot = `buckets/${source.payload.data.id}`;
    const targetRoot = `buckets/${target.payload.data.id}`;
    const category = (await request("GET", `${sourceRoot}/categories`, actor)).payload.data[0];
    const account = (await request("POST", `${sourceRoot}/accounts`, actor, { name: "SIP source" }))
      .payload.data;
    const targetAccount = (
      await request("POST", `${targetRoot}/accounts`, actor, { name: "SIP target" })
    ).payload.data;
    const payerId = (await request("GET", "me", actor)).payload.data.id;
    const today = new Date().toISOString().slice(0, 10);
    const created = await request("POST", `${sourceRoot}/recurring-plans`, actor, {
      title: "Monthly SIP",
      amount: "1000.00",
      currency: "INR",
      frequency: "monthly",
      startDate: today,
      categoryId: category.id,
      accountId: account.id,
      paymentMode: "upi",
      paidByUserId: payerId,
      recordingMode: "confirm",
      reminderLeadDays: 0,
      reminderPurpose: "funds",
    });
    expect(created.response.status, JSON.stringify(created.payload)).toBe(201);
    const id = created.payload.data.id;
    const confirmed = await request(
      "POST",
      `${sourceRoot}/recurring-plans/${id}/confirm`,
      actor,
      {
        paymentDate: today,
      },
      { "If-Match": `"r${created.payload.data.revision}"` },
    );
    expect(confirmed.response.status, JSON.stringify(confirmed.payload)).toBe(201);
    const current = (
      await request("GET", `${sourceRoot}/recurring-plans`, actor)
    ).payload.data.find((plan: { id: string }) => plan.id === id);
    const preview = await request(
      "GET",
      `${sourceRoot}/moves/recurring-plan/${id}/preview?targetBucketId=${target.payload.data.id}`,
      actor,
    );
    expect(preview.payload.data.expenseCount).toBe(1);
    const referenceMap = Object.fromEntries(
      preview.payload.data.references.map(
        (entry: { sourceId: string; kind: string; choices: { id: string }[] }) => [
          entry.sourceId,
          entry.kind === "account" ? targetAccount.id : entry.choices[0].id,
        ],
      ),
    );
    const moved = await request(
      "POST",
      `${sourceRoot}/moves/recurring-plan/${id}`,
      actor,
      {
        targetBucketId: target.payload.data.id,
        referenceMap,
        payerMap: { [payerId]: payerId },
      },
      { "If-Match": `"r${current.revision}"` },
    );
    expect(moved.response.status, JSON.stringify(moved.payload)).toBe(200);
    expect(
      (await request("GET", `${sourceRoot}/recurring-plans`, actor)).payload.data.some(
        (plan: { id: string }) => plan.id === id,
      ),
    ).toBe(false);
    expect(
      (await request("GET", `${targetRoot}/recurring-plans`, actor)).payload.data.some(
        (plan: { id: string }) => plan.id === id,
      ),
    ).toBe(true);
    expect(
      (await request("GET", `${targetRoot}/expenses/${confirmed.payload.data.id}`, actor)).response
        .status,
    ).toBe(200);
  });

  it("keeps search and date boundaries across expense pages", async () => {
    const actor = "phase2searchpages";
    await request("POST", "me/bootstrap", actor, {});
    const bucket = await request("POST", "buckets", actor, {
      name: "Search page test",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const root = `buckets/${bucket.payload.data.id}`;
    const account = await request("POST", `${root}/accounts`, actor, { name: "Bank" });
    const category = (await request("GET", `${root}/categories`, actor)).payload.data[0];
    const payer = (await request("GET", "me", actor)).payload.data.id;
    for (const [expenseDate, description] of [
      ["2026-03-15", "Didi outside range"],
      ["2026-06-15", "Didi June"],
      ["2026-07-15", "Didi July"],
      ["2026-08-15", "Didi August"],
      ["2026-09-15", "Another payment"],
      ["2026-05-15", "Didi May"],
    ]) {
      const created = await request("POST", `${root}/expenses`, actor, {
        expenseDate,
        description,
        paidByUserId: payer,
        categoryId: category.id,
        accountId: account.payload.data.id,
        paymentMode: "upi",
        originalAmount: "100",
        originalCurrency: "INR",
      });
      expect(created.response.status).toBe(201);
    }
    const allDates = await request("GET", `${root}/expenses?limit=100`, actor);
    expect(allDates.response.status).toBe(200);
    expect(
      allDates.payload.data.map((expense: { description: string }) => expense.description),
    ).toEqual([
      "Another payment",
      "Didi August",
      "Didi July",
      "Didi June",
      "Didi May",
      "Didi outside range",
    ]);
    const firstPage = await request("GET", `${root}/expenses?limit=2`, actor);
    const secondPage = await request(
      "GET",
      `${root}/expenses?limit=2&cursor=${encodeURIComponent(firstPage.payload.meta.nextCursor)}`,
      actor,
    );
    expect(
      secondPage.payload.data.map((expense: { description: string }) => expense.description),
    ).toEqual(["Didi July", "Didi June"]);
    const filters = "from=2026-04-01&toExclusive=2026-10-21&q=didi&limit=1";
    const descriptions: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await request(
        "GET",
        `${root}/expenses?${filters}${cursor ? `&cursor=${cursor}` : ""}`,
        actor,
      );
      expect(page.response.status).toBe(200);
      descriptions.push(
        ...page.payload.data.map((expense: { description: string }) => expense.description),
      );
      cursor = page.payload.meta.nextCursor;
    } while (cursor);
    expect(descriptions.sort()).toEqual(["Didi August", "Didi July", "Didi June", "Didi May"]);
    const categoryRows = await request(
      "GET",
      `${root}/expenses?from=2026-04-01&toExclusive=2026-10-21&categoryIds=${category.id}&q=didi`,
      actor,
    );
    expect(categoryRows.response.status).toBe(200);
    expect(categoryRows.payload.data).toHaveLength(4);
    const otherCategoryRows = await request(
      "GET",
      `${root}/expenses?categoryIds=000000000000000000000001`,
      actor,
    );
    expect(otherCategoryRows.response.status).toBe(200);
    expect(otherCategoryRows.payload.data).toHaveLength(0);
    const summary = await request(
      "GET",
      `${root}/expenses/summary?from=2026-04-01&toExclusive=2026-10-21`,
      actor,
    );
    expect(summary.payload.data.actualCount).toBe(5);
    expect(Number(summary.payload.data.actualTotal)).toBe(500);
  });

  it("handles reference options, expenses, comments, deletion, restoration, members, and invitations", async () => {
    const actor = "phase2owner";
    expect((await request("POST", "me/bootstrap", actor, {})).response.status).toBe(201);
    const bucket = await request("POST", "buckets", actor, {
      name: "Phase 2 test",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const bucketId = bucket.payload.data.id;
    const root = `buckets/${bucketId}`;
    const accounts = await request("POST", `${root}/accounts`, actor, {
      name: "UPI account",
    });
    expect(accounts.response.status).toBe(201);
    expect((await request("GET", `${root}/accounts`, actor)).payload.data).toHaveLength(1);
    const unusedAccount = await request("POST", `${root}/accounts`, actor, {
      name: "Temporary account",
    });
    const deletedAccount = await request(
      "DELETE",
      `${root}/accounts/${unusedAccount.payload.data.id}`,
      actor,
      undefined,
      { "If-Match": unusedAccount.response.headers.get("ETag")! },
    );
    expect(deletedAccount.response.status).toBe(200);
    expect(deletedAccount.payload.data).toEqual({
      id: unusedAccount.payload.data.id,
      deleted: true,
    });
    expect((await request("GET", `${root}/accounts?state=all`, actor)).payload.data).toHaveLength(
      1,
    );
    const category = (await request("GET", `${root}/categories`, actor)).payload.data[0];
    const platform = (await request("GET", `${root}/platforms`, actor)).payload.data[0];
    const profile = (await request("GET", "me", actor)).payload.data;
    const preview = await request("POST", `${root}/conversion-preview`, actor, {
      expenseDate: "2026-01-15",
      originalAmount: "125.50",
      originalCurrency: "INR",
    });
    expect(preview.payload.data.convertedAmount).toBe("125.50");
    const expense = await request("POST", `${root}/expenses`, actor, {
      expenseDate: "2026-01-15",
      description: "Groceries",
      paidByUserId: profile.id,
      categoryId: category.id,
      accountId: accounts.payload.data.id,
      platformId: platform.id,
      paymentMode: "upi",
      originalAmount: "125.50",
      originalCurrency: "INR",
    });
    expect(expense.response.status).toBe(201);
    expect(expense.payload.data.displayStatus).toBe("actual");
    const expenseId = expense.payload.data.id;
    expect((await request("GET", `${root}/expenses`, actor)).payload.data).toHaveLength(1);
    expect((await request("GET", `${root}/expenses/summary`, actor)).payload.data.actualTotal).toBe(
      "125.50",
    );
    const comment = await request("POST", `${root}/expenses/${expenseId}/comments`, actor, {
      body: "Receipt saved",
    });
    expect(comment.response.status).toBe(201);
    expect(
      (await request("GET", `${root}/expenses/${expenseId}/comments`, actor)).payload.data,
    ).toHaveLength(1);
    const edited = await request(
      "PATCH",
      `${root}/expenses/${expenseId}`,
      actor,
      { description: "Weekly groceries" },
      { "If-Match": expense.response.headers.get("ETag")! },
    );
    expect(edited.payload.data.description).toBe("Weekly groceries");
    const deleted = await request("DELETE", `${root}/expenses/${expenseId}`, actor, undefined, {
      "If-Match": edited.response.headers.get("ETag")!,
    });
    expect(deleted.response.status).toBe(200);
    expect((await request("GET", `${root}/expenses`, actor)).payload.data).toHaveLength(0);
    expect(
      (await request("GET", `${root}/expenses?deleted=only`, actor)).payload.data,
    ).toHaveLength(1);
    const restored = await request(
      "POST",
      `${root}/expenses/${expenseId}/restore`,
      actor,
      undefined,
      { "If-Match": deleted.response.headers.get("ETag")! },
    );
    expect(restored.response.status).toBe(200);
    expect((await request("GET", `${root}/expenses`, actor)).payload.data).toHaveLength(1);
    const commentEdited = await request(
      "PATCH",
      `${root}/expenses/${expenseId}/comments/${comment.payload.data.id}`,
      actor,
      { body: "Receipt checked" },
      { "If-Match": comment.response.headers.get("ETag")! },
    );
    expect(commentEdited.payload.data.body).toBe("Receipt checked");
    expect(
      (
        await request(
          "DELETE",
          `${root}/expenses/${expenseId}/comments/${comment.payload.data.id}`,
          actor,
          undefined,
          { "If-Match": commentEdited.response.headers.get("ETag")! },
        )
      ).response.status,
    ).toBe(200);
    expect(
      (await request("GET", `${root}/expenses/${expenseId}/comments`, actor)).payload.data,
    ).toHaveLength(0);
    const refund = await request("POST", `${root}/expenses`, actor, {
      expenseDate: "2026-01-16",
      description: "Refund: Groceries",
      paidByUserId: profile.id,
      categoryId: category.id,
      accountId: accounts.payload.data.id,
      platformId: platform.id,
      paymentMode: "upi",
      originalAmount: "-25.50",
      originalCurrency: "INR",
      refundOfExpenseId: expenseId,
    });
    expect(refund.response.status).toBe(201);
    expect(refund.payload.data.refundOfExpenseId).toBe(expenseId);
    expect(
      (await request("GET", `${root}/expenses/${expenseId}/refunds`, actor)).payload.data,
    ).toHaveLength(1);
    expect(
      (await request("GET", `${root}/expenses/${expenseId}/activity`, actor)).payload.data.length,
    ).toBeGreaterThanOrEqual(3);
    const foreign = await request("POST", `${root}/expenses`, actor, {
      expenseDate: "2026-01-18",
      description: "Foreign purchase",
      paidByUserId: profile.id,
      categoryId: category.id,
      accountId: accounts.payload.data.id,
      paymentMode: "credit_card",
      originalAmount: "10.00",
      originalCurrency: "USD",
      manualConversion: { method: "manual_amount", convertedAmount: "840.00" },
    });
    expect(foreign.response.status).toBe(201);
    expect(foreign.payload.data.platformName).toBe("Other");
    expect(foreign.payload.data.rate).toBe("84.00000000");
    const reconverted = await request(
      "PUT",
      `${root}/expenses/${foreign.payload.data.id}/conversion`,
      actor,
      { method: "manual_rate", rate: "85.5" },
      { "If-Match": foreign.response.headers.get("ETag")! },
    );
    expect(reconverted.payload.data.convertedAmount).toBe("855.00");
    expect(
      (await request("GET", `${root}/expenses?categoryId=${category.id}&status=actual`, actor))
        .payload.data,
    ).toHaveLength(3);
    const archived = await request(
      "POST",
      `${root}/accounts/${accounts.payload.data.id}/archive`,
      actor,
      undefined,
      { "If-Match": accounts.response.headers.get("ETag")! },
    );
    expect(archived.payload.data.state).toBe("archived");
    expect((await request("GET", `${root}/accounts`, actor)).payload.data).toHaveLength(0);
    expect((await request("GET", `${root}/accounts?state=all`, actor)).payload.data).toHaveLength(
      1,
    );
    expect(
      (
        await request(
          "PATCH",
          `${root}/expenses/${expenseId}`,
          actor,
          { notes: "Receipt filed" },
          { "If-Match": restored.response.headers.get("ETag")! },
        )
      ).response.status,
    ).toBe(200);
    expect(
      (
        await request(
          "POST",
          `${root}/accounts/${accounts.payload.data.id}/restore`,
          actor,
          undefined,
          { "If-Match": archived.response.headers.get("ETag")! },
        )
      ).payload.data.state,
    ).toBe("active");
    const invitation = await request("POST", `${root}/invitations`, actor, {});
    const invitations = await request("GET", `${root}/invitations`, actor);
    expect(invitations.payload.data).toHaveLength(1);
    expect(invitations.payload.data[0].createdByName).toBe(profile.displayName);
    const revoked = await request(
      "DELETE",
      `${root}/invitations/${invitation.payload.data.id}`,
      actor,
      undefined,
      { "If-Match": invitation.response.headers.get("ETag")! },
    );
    expect(revoked.response.status).toBe(200);
    expect((await request("GET", `${root}/members`, actor)).payload.data).toHaveLength(1);
    const joinLink = await request("POST", `${root}/invitations`, actor, {});
    const joiner = "phase2member";
    await request("POST", "me/bootstrap", joiner, {});
    const token = new URL(joinLink.payload.data.shareUrl).hash.slice(1);
    expect((await request("POST", "invitations/join", joiner, { token })).response.status).toBe(
      201,
    );
    const member = (await request("GET", `${root}/members`, actor)).payload.data.find(
      (item: { displayName: string }) => item.displayName === joiner,
    );
    expect(member).toBeTruthy();
    const memberExpense = await request("POST", `${root}/expenses`, joiner, {
      expenseDate: "2026-01-17",
      description: "Member expense",
      paidByUserId: member.id,
      categoryId: category.id,
      accountId: accounts.payload.data.id,
      platformId: platform.id,
      paymentMode: "cash",
      originalAmount: "42.00",
      originalCurrency: "INR",
    });
    expect(memberExpense.response.status).toBe(201);
    expect(
      (
        await request("DELETE", `${root}/members/${member.membershipId}`, actor, undefined, {
          "If-Match": `"r${member.revision}"`,
        })
      ).response.status,
    ).toBe(200);
    expect((await request("GET", `${root}/expenses`, joiner)).response.status).toBe(404);
    expect((await request("POST", "invitations/join", joiner, { token })).response.status).toBe(
      201,
    );
    const reopened = await request(
      "GET",
      `${root}/expenses/${memberExpense.payload.data.id}`,
      joiner,
    );
    expect(reopened.payload.data.permissions.canDelete).toBe(false);
    expect(
      (
        await request(
          "DELETE",
          `${root}/expenses/${memberExpense.payload.data.id}`,
          joiner,
          undefined,
          { "If-Match": memberExpense.response.headers.get("ETag")! },
        )
      ).response.status,
    ).toBe(404);
  });
});

describe("Phase 3 spending insights", () => {
  it("keeps budget, dashboard, and report totals aligned through refunds and deletion", async () => {
    const actor = "phase3owner";
    await request("POST", "me/bootstrap", actor, {});
    const bucket = await request("POST", "buckets", actor, {
      name: "Insights test",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const root = `buckets/${bucket.payload.data.id}`;
    const category = (await request("GET", `${root}/categories`, actor)).payload.data[0];
    const platform = (await request("GET", `${root}/platforms`, actor)).payload.data[0];
    const account = await request("POST", `${root}/accounts`, actor, { name: "Checking" });
    const profile = await request("GET", "me", actor);
    const definition = {
      name: "Household",
      scope: "shared",
      categoryIds: [category.id],
      limitAmount: "100.00",
      periodType: "monthly",
      thresholdPercentages: ["50", "100"],
    };
    const budget = await request("POST", `${root}/budgets`, actor, definition);
    expect(budget.response.status).toBe(201);
    expect((await request("GET", `${root}/categories`, actor)).payload.data[0].budgetCount).toBe(1);
    expect(
      (
        await request("DELETE", `${root}/categories/${category.id}`, actor, undefined, {
          "If-Match": `"r${category.revision}"`,
        })
      ).response.status,
    ).toBe(409);
    expect(
      (await request("GET", `${root}/budgets/${budget.payload.data.id}`, actor)).payload.data.name,
    ).toBe("Household");
    const expenseBody = {
      expenseDate: "2026-01-15",
      description: "Groceries",
      paidByUserId: profile.payload.data.id,
      categoryId: category.id,
      accountId: account.payload.data.id,
      platformId: platform.id,
      paymentMode: "upi",
      originalAmount: "60.00",
      originalCurrency: "INR",
    };
    const expense = await request("POST", `${root}/expenses`, actor, expenseBody);
    expect(expense.response.status).toBe(201);
    const usagePath = `${root}/budgets/${budget.payload.data.id}/usage?month=2026-01`;
    let usage = (await request("GET", usagePath, actor)).payload.data;
    expect(usage.usedAmount).toBe("60.00");
    expect(usage.remainingAmount).toBe("40.00");
    expect(usage.handledThresholds.map((item: { percentage: string }) => item.percentage)).toEqual([
      "50",
    ]);
    const second = await request("POST", `${root}/expenses`, actor, {
      ...expenseBody,
      description: "More groceries",
      originalAmount: "50.00",
    });
    expect(second.response.status).toBe(201);
    usage = (await request("GET", usagePath, actor)).payload.data;
    expect(usage.usedAmount).toBe("110.00");
    expect(usage.exceededAmount).toBe("10.00");
    expect(usage.handledThresholds.map((item: { percentage: string }) => item.percentage)).toEqual([
      "50",
      "100",
    ]);
    const refund = await request("POST", `${root}/expenses`, actor, {
      ...expenseBody,
      description: "Refund",
      originalAmount: "-20.00",
      refundOfExpenseId: expense.payload.data.id,
    });
    expect(refund.response.status).toBe(201);
    const report = await request(
      "GET",
      `${root}/reports/spending?period=custom&from=2026-01-01&toExclusive=2026-02-01&groupBy=category`,
      actor,
    );
    expect(report.payload.data.totalAmount).toBe("90.00");
    expect(report.payload.data.groups[0].amount).toBe("90.00");
    const dashboard = await request(
      "GET",
      `${root}/dashboard?period=month&anchorDate=2026-01-15`,
      actor,
    );
    expect(dashboard.payload.data.totalAmount).toBe("90.00");
    const deleted = await request(
      "DELETE",
      `${root}/expenses/${second.payload.data.id}`,
      actor,
      undefined,
      { "If-Match": second.response.headers.get("ETag")! },
    );
    expect(deleted.response.status).toBe(200);
    usage = (await request("GET", usagePath, actor)).payload.data;
    expect(usage.usedAmount).toBe("40.00");
    expect(usage.handledThresholds).toHaveLength(2);
    const changed = await request(
      "PATCH",
      `${root}/budgets/${budget.payload.data.id}`,
      actor,
      { name: "Household revised" },
      { "If-Match": budget.response.headers.get("ETag")! },
    );
    expect(changed.payload.data.name).toBe("Household revised");
    expect(
      (
        await request("DELETE", `${root}/budgets/${budget.payload.data.id}`, actor, undefined, {
          "If-Match": changed.response.headers.get("ETag")!,
        })
      ).response.status,
    ).toBe(200);
    expect((await request("GET", `${root}/budgets`, actor)).payload.data).toHaveLength(0);
    const custom = await request("POST", `${root}/budgets`, actor, {
      ...definition,
      name: "January only",
      periodType: "custom",
      from: "2026-01-01",
      toExclusive: "2026-02-01",
      thresholdPercentages: ["50", "75", "100"],
    });
    expect(custom.response.status).toBe(201);
    expect(
      (await request("GET", `${root}/budgets/${custom.payload.data.id}/usage`, actor)).payload.data
        .usedAmount,
    ).toBe("40.00");
    expect(
      (
        await request("POST", `${root}/expenses`, actor, {
          ...expenseBody,
          description: "January bulk purchase",
          originalAmount: "70.00",
        })
      ).response.status,
    ).toBe(201);
    const crossed = await request("GET", `${root}/budgets/${custom.payload.data.id}/usage`, actor);
    expect(
      crossed.payload.data.handledThresholds.map((item: { percentage: string }) => item.percentage),
    ).toEqual(["50", "75", "100"]);
    const thresholdEvents = await AuditModel.find({
      entityId: custom.payload.data.id,
      action: "budget.threshold_crossed",
    });
    expect(thresholdEvents).toHaveLength(1);
    expect(thresholdEvents[0].changedFields).toEqual(["100"]);
    expect(
      (
        await request("POST", `${root}/expenses`, actor, {
          ...expenseBody,
          expenseDate: "2026-02-01",
          description: "February purchase",
          originalAmount: "12.00",
        })
      ).response.status,
    ).toBe(201);
    expect(
      (await request("GET", `${root}/budgets/${custom.payload.data.id}/usage`, actor)).payload.data
        .usedAmount,
    ).toBe("110.00");
  });

  it("restricts shared budgets to owners and counts member budgets by Paid By", async () => {
    const owner = "phase3scopeowner";
    const member = "phase3scopemember";
    await request("POST", "me/bootstrap", owner, {});
    await request("POST", "me/bootstrap", member, {});
    const bucket = await request("POST", "buckets", owner, {
      name: "Scope test",
      primaryCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    const root = `buckets/${bucket.payload.data.id}`;
    const invitation = await request("POST", `${root}/invitations`, owner, {});
    const token = new URL(invitation.payload.data.shareUrl).hash.slice(1);
    expect((await request("POST", "invitations/join", member, { token })).response.status).toBe(
      201,
    );
    const category = (await request("GET", `${root}/categories`, owner)).payload.data[0];
    const platform = (await request("GET", `${root}/platforms`, owner)).payload.data[0];
    const account = await request("POST", `${root}/accounts`, owner, { name: "Shared card" });
    const ownerId = (await request("GET", "me", owner)).payload.data.id;
    const memberId = (await request("GET", "me", member)).payload.data.id;
    const input = {
      name: "Mine",
      scope: "member",
      categoryIds: [category.id],
      limitAmount: "200.00",
      periodType: "monthly",
      thresholdPercentages: [],
    };
    expect(
      (await request("POST", `${root}/budgets`, member, { ...input, scope: "shared" })).response
        .status,
    ).toBe(403);
    const budget = await request("POST", `${root}/budgets`, member, input);
    expect(budget.response.status).toBe(201);
    expect((await request("GET", `${root}/budgets`, owner)).payload.data).toHaveLength(1);
    const body = {
      expenseDate: "2026-01-15",
      categoryId: category.id,
      accountId: account.payload.data.id,
      platformId: platform.id,
      paymentMode: "upi",
      originalAmount: "70.00",
      originalCurrency: "INR",
    };
    expect(
      (
        await request("POST", `${root}/expenses`, owner, {
          ...body,
          description: "Owner paid",
          paidByUserId: ownerId,
        })
      ).response.status,
    ).toBe(201);
    expect(
      (
        await request("POST", `${root}/expenses`, owner, {
          ...body,
          description: "Member paid",
          paidByUserId: memberId,
        })
      ).response.status,
    ).toBe(201);
    const usage = await request(
      "GET",
      `${root}/budgets/${budget.payload.data.id}/usage?month=2026-01`,
      owner,
    );
    expect(usage.payload.data.usedAmount).toBe("70.00");
    const shared = await request("POST", `${root}/budgets`, owner, {
      ...input,
      name: "Shared",
      scope: "shared",
    });
    expect(shared.response.status).toBe(201);
    expect(
      (await request("GET", `${root}/budgets/${shared.payload.data.id}/usage?month=2026-01`, owner))
        .payload.data.usedAmount,
    ).toBe("140.00");
    expect(
      (await request("GET", `${root}/dashboard?period=month&anchorDate=2026-01-15`, owner)).payload
        .data.totalAmount,
    ).toBe("140.00");
    expect(
      (
        await request(
          "GET",
          `${root}/reports/spending?period=custom&from=2026-01-01&toExclusive=2026-02-01&groupBy=member&paidByUserId=${memberId}`,
          owner,
        )
      ).payload.data.totalAmount,
    ).toBe("70.00");
    expect(
      (
        await request(
          "PATCH",
          `${root}/budgets/${budget.payload.data.id}`,
          owner,
          { name: "Changed" },
          { "If-Match": budget.response.headers.get("ETag")! },
        )
      ).response.status,
    ).toBe(403);
    const membership = (await request("GET", `${root}/members`, owner)).payload.data.find(
      (person: { id: string }) => person.id === memberId,
    );
    expect(
      (
        await request("DELETE", `${root}/members/${membership.membershipId}`, owner, undefined, {
          "If-Match": `"r${membership.revision}"`,
        })
      ).response.status,
    ).toBe(200);
    const history = await request("GET", `${root}/budgets`, owner);
    expect(
      history.payload.data.find(
        (entry: { budget: { id: string } }) => entry.budget.id === budget.payload.data.id,
      ).budget.state,
    ).toBe("historical");
    expect(
      (await request("GET", `${root}/budgets?scope=member&state=historical`, owner)).payload.data,
    ).toHaveLength(1);
  });
});
