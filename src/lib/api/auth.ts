import "server-only";
import type { DecodedIdToken } from "firebase-admin/auth";
import { getFirebaseAdminAuth } from "@/lib/firebase/admin";
import { ApiError } from "./errors";

export async function authenticate(request: Request): Promise<DecodedIdToken> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
  const auth = getFirebaseAdminAuth();
  try { return await auth.verifyIdToken(authorization.slice(7), true); }
  catch (error) {
    const code = (error as { code?: string }).code;
    if (code && ["auth/id-token-expired", "auth/id-token-revoked", "auth/argument-error", "auth/invalid-id-token", "auth/user-disabled", "auth/user-not-found"].includes(code)) throw new ApiError(401, "INVALID_TOKEN", "Your session has expired. Sign in again.");
    throw new ApiError(503, "SERVICE_UNAVAILABLE", "Sign-in verification is temporarily unavailable.");
  }
}
