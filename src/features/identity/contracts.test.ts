import { describe, expect, it } from "vitest";
import {
  authHref,
  bootstrapSchema,
  bucketSchema,
  invitationSchema,
  profileSchema,
  safeNext,
} from "./contracts";
describe("Phase 1 input boundaries", () => {
  it.each([
    "https://example.com",
    "//example.com",
    "/\\example.com",
    "javascript:alert(1)",
    "/api/v1/me",
    "/join?next=https://example.com",
  ])("rejects unsafe return target %s", (value) => expect(safeNext(value)).toBe("/workspace"));
  it("preserves a same-app invitation fragment through sign-in", () => {
    const target = `/join#${"a".repeat(43)}`;
    expect(safeNext(target)).toBe(target);
  });
  it("keeps invitation tokens out of authentication query strings", () => {
    const token = "a".repeat(43);
    const url = new URL(authHref("/sign-in", `/join#${token}`), "https://buckit.test");
    expect(url.hash).toBe(`#${token}`);
    expect(url.search).not.toContain(token);
    expect(url.searchParams.get("next")).toBe("/join");
  });
  it("rejects client supplied identity and ownership", () => {
    expect(bootstrapSchema.safeParse({ firebaseUid: "someone-else" }).success).toBe(false);
    expect(
      bucketSchema.safeParse({
        name: "House",
        primaryCurrency: "INR",
        timezone: "Asia/Kolkata",
        ownerUserId: "someone-else",
      }).success,
    ).toBe(false);
    expect(profileSchema.safeParse({ status: "active" }).success).toBe(false);
  });
  it("rejects invalid timezone/currency and blank names", () => {
    expect(
      bucketSchema.safeParse({ name: " ", primaryCurrency: "XYZ", timezone: "Invalid/Zone" })
        .success,
    ).toBe(false);
    expect(
      bucketSchema.parse({ name: " House ", primaryCurrency: "INR", timezone: "Asia/Kolkata" })
        .name,
    ).toBe("House");
  });
  it("requires a high entropy invitation token shape", () => {
    expect(invitationSchema.safeParse({ token: "short" }).success).toBe(false);
  });
});
