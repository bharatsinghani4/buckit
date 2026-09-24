import { describe, expect, it } from "vitest";
import { assertRevision, readJson, requireIdempotencyKey } from "./errors";
describe("HTTP input protection", () => {
  it("rejects oversized JSON before parsing", async () => {
    const request = new Request("http://localhost/api/v1/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x".repeat(256 * 1024) }) });
    await expect(readJson(request)).rejects.toMatchObject({ status: 413 });
  });
  it("distinguishes malformed JSON and stale versions", async () => {
    await expect(readJson(new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }))).rejects.toMatchObject({ status: 400 });
    expect(() => assertRevision(null, 2)).toThrow("Refresh this page");
    expect(() => assertRevision('"r1"', 2)).toThrow("another session");
    expect(() => assertRevision('"r2"', 2)).not.toThrow();
  });
  it("requires bounded safe operation keys", () => {
    expect(() => requireIdempotencyKey(new Request("http://localhost"))).toThrow();
    expect(requireIdempotencyKey(new Request("http://localhost", { headers: { "Idempotency-Key": "a-valid-operation-key" } }))).toBe("a-valid-operation-key");
  });
});
