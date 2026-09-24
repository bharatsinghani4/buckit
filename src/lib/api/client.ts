"use client";
import { getFirebaseClientAuth } from "@/lib/firebase/client";

export class ClientError extends Error {
  constructor(message: string, public status = 0, public code = "NETWORK_ERROR", public fieldErrors: { path: string; message: string }[] = []) { super(message); }
}
type Envelope<T> = { data: T; meta: { nextCursor?: string | null; hasMore?: boolean } };
export async function api<T>(path: string, options: { method?: string; body?: unknown; revision?: number; key?: string } = {}): Promise<Envelope<T>> {
  const user = getFirebaseClientAuth().currentUser;
  if (!user) throw new ClientError("Sign in to continue.", 401, "AUTHENTICATION_REQUIRED");
  const headers: Record<string, string> = { Authorization: `Bearer ${await user.getIdToken()}` };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.key) headers["Idempotency-Key"] = options.key;
  if (options.revision !== undefined) headers["If-Match"] = `"r${options.revision}"`;
  const send = () => fetch(`/api/v1/${path}`, { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), cache: "no-store" });
  let response: Response;
  try { response = await send(); } catch { throw new ClientError("You appear to be offline. Reconnect and try again."); }
  if (response.status === 401) { headers.Authorization = `Bearer ${await user.getIdToken(true)}`; response = await send(); }
  const result = await response.json();
  if (!response.ok) throw new ClientError(result.error?.message ?? "Something went wrong.", response.status, result.error?.code, result.error?.fieldErrors);
  return result;
}
export function operationKey(slot: { current: { body: string; key: string } | null }, body: unknown) {
  const encoded = JSON.stringify(body);
  if (!slot.current || slot.current.body !== encoded) slot.current = { body: encoded, key: crypto.randomUUID() };
  return slot.current.key;
}
export function friendlyError(error: unknown): string {
  if (error instanceof ClientError) return error.fieldErrors.length ? error.fieldErrors.map((f) => f.message).join(" ") : error.message;
  const code = (error as { code?: string })?.code;
  const messages: Record<string, string> = {
    "auth/invalid-credential": "The email or password is incorrect.", "auth/wrong-password": "The email or password is incorrect.", "auth/user-not-found": "The email or password is incorrect.",
    "auth/email-already-in-use": "An account already uses this email. Try signing in.", "auth/weak-password": "Choose a stronger password with at least 8 characters.", "auth/invalid-email": "Enter a valid email address.",
    "auth/too-many-requests": "Too many attempts. Please wait before trying again.", "auth/network-request-failed": "Check your internet connection and try again.",
    "auth/popup-closed-by-user": "Google sign-in was closed. You can try again.", "auth/popup-blocked": "Allow the sign-in pop-up in your browser and try again.",
    "auth/account-exists-with-different-credential": "Sign in using your original sign-in method for this email.", "auth/expired-action-code": "This link has expired. Request a new one.",
    "auth/invalid-action-code": "This link is invalid or has already been used.", "auth/operation-not-allowed": "This sign-in method is not enabled yet.", "auth/unauthorized-domain": "This address is not configured for sign-in yet.",
  };
  return code && messages[code] ? messages[code] : "We couldn’t complete that action. Please try again.";
}
