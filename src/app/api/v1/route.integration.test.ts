import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { phaseTwoModels } from "@/lib/db/models";

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
  for (const model of phaseTwoModels) {
    await model.createCollection();
    await model.createIndexes();
  }
  process.env.API_CURSOR_SECRET = "route-tests-only-secret-not-for-production";
}, 180_000);
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
  delete process.env.API_CURSOR_SECRET;
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
  return { response, payload: await response.json() };
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
    expect((await request("GET", "capabilities")).payload.data.phase).toBe(2);
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
