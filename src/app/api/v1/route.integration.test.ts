import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  AuditModel,
  ExpenseModel,
  ReminderModel,
  UserModel,
  phaseFiveModels,
} from "@/lib/db/models";
import { generateInstallments, processDaily } from "@/features/scheduling/service";
import { processDueReminders } from "@/features/notifications/reminder-worker";
import { fanoutPendingEvents } from "@/features/notifications/inbox-service";
import { localDate } from "@/features/scheduling/dates";
import { GET as dailyGET } from "../internal/jobs/daily/route";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/mongoose", () => ({ connectDatabase: async () => mongoose.connection }));
vi.mock("@/lib/api/auth", () => ({
  authenticate: async (request: Request) => {
    const uid = request.headers.get("authorization")?.replace("Bearer ", "");
    if (!uid) throw { status: 401, code: "AUTHENTICATION_REQUIRED" };
    return { uid, email: `${uid}@example.test`, email_verified: true, name: uid };
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
  for (const model of phaseFiveModels) {
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

describe("Phase 1 HTTP API flows", () => {
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
    expect((await request("GET", "capabilities")).payload.data.phase).toBe(5);
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
