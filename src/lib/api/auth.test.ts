import { beforeEach, describe, expect, it, vi } from "vitest";
const { verifyIdToken } = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => ({ getFirebaseAdminAuth: () => ({ verifyIdToken }) }));
import { authenticate } from "./auth";
beforeEach(() => { verifyIdToken.mockReset(); });
describe("Firebase authentication boundary", () => {
  it("rejects absent credentials before calling Firebase", async () => {
    await expect(authenticate(new Request("http://localhost"))).rejects.toMatchObject({ status: 401 }); expect(verifyIdToken).not.toHaveBeenCalled();
  });
  it("checks revocation on every protected request", async () => {
    verifyIdToken.mockResolvedValue({ uid: "verified-user" });
    await expect(authenticate(new Request("http://localhost", { headers: { Authorization: "Bearer opaque-token" } }))).resolves.toEqual({ uid: "verified-user" });
    expect(verifyIdToken).toHaveBeenCalledWith("opaque-token", true);
  });
  it.each(["auth/id-token-revoked", "auth/id-token-expired", "auth/user-disabled", "auth/argument-error"])("rejects %s without exposing provider details", async (code) => {
    verifyIdToken.mockRejectedValue({ code, message: "private provider details" });
    await expect(authenticate(new Request("http://localhost", { headers: { Authorization: "Bearer bad-token" } }))).rejects.toMatchObject({ status: 401, code: "INVALID_TOKEN" });
  });
});
