import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { phaseOneModels } from "@/lib/db/models";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/mongoose", () => ({ connectDatabase: async () => mongoose.connection }));
vi.mock("@/lib/api/auth", () => ({ authenticate: async (request: Request) => {
  const uid = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!uid) throw { status: 401, code: "AUTHENTICATION_REQUIRED" };
  return { uid, email: `${uid}@example.test`, email_verified: true, name: uid };
} }));
import { GET, POST, PATCH } from "./[...path]/route";

let database: MongoMemoryReplSet;
beforeAll(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: "7.0.14" } });
  await mongoose.connect(database.getUri(), { dbName: "buckit_route_tests", autoIndex: false, autoCreate: false });
  for (const model of phaseOneModels) { await model.createCollection(); await model.createIndexes(); }
  process.env.API_CURSOR_SECRET = "route-tests-only-secret-not-for-production";
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await database?.stop(); delete process.env.API_CURSOR_SECRET; });

async function request(method: "GET" | "POST" | "PATCH", path: string, uid = "owner", body?: unknown, extra: Record<string, string> = {}) {
  const input = new Request(`http://localhost:3000/api/v1/${path}`, { method, headers: { Authorization: `Bearer ${uid}`, ...(body === undefined ? {} : { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const response = await ({ GET, POST, PATCH })[method](input, { params: Promise.resolve({ path: path.split("/") }) });
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
    expect((await request("PATCH", "me", "owner", { theme: "dark" }, { "If-Match": profile.response.headers.get("ETag")! })).payload.data.theme).toBe("dark");
    expect((await request("PATCH", "me", "owner", { theme: "light" }, { "If-Match": profile.response.headers.get("ETag")! })).response.status).toBe(412);
    const created = await request("POST", "buckets", "owner", { name: "Shared Living", primaryCurrency: "INR", timezone: "Asia/Kolkata" });
    expect(created.response.status).toBe(201);
    const id = created.payload.data.id;
    const refreshed = await request("GET", "me");
    expect(refreshed.payload.data.revision).toBeGreaterThan(profile.payload.data.revision);
    expect((await request("PATCH", "me", "owner", { theme: "light" }, { "If-Match": refreshed.response.headers.get("ETag")! })).payload.data.theme).toBe("light");
    expect((await request("GET", `buckets/${id}`)).payload.data.name).toBe("Shared Living");
    expect((await request("GET", "buckets")).payload.data).toHaveLength(1);
    expect((await request("GET", "capabilities")).payload.data.phase).toBe(1);
    const invite = await request("POST", `buckets/${id}/invitations`, "owner", {});
    expect(invite.response.status).toBe(201);
    const token = new URL(invite.payload.data.shareUrl).hash.slice(1);
    expect((await request("POST", "me/bootstrap", "guest", {})).response.status).toBe(201);
    expect((await request("GET", `buckets/${id}`, "guest")).response.status).toBe(404);
    expect((await request("POST", "invitations/preview", "guest", { token })).payload.data.alreadyMember).toBe(false);
    expect((await request("POST", "invitations/join", "guest", { token })).response.status).toBe(201);
    expect((await request("GET", `buckets/${id}`, "guest")).response.status).toBe(200);
    expect((await request("POST", `buckets/${id}/invitations`, "guest", {})).response.status).toBe(403);
    expect((await request("GET", "missing")).response.status).toBe(404);
  });
});
