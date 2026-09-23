import "server-only";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getMessaging } from "firebase-admin/messaging";
import { requireConfig } from "@/lib/config/required";

export function getFirebaseAdminApp() {
  const existing = getApps().find((app) => app.name === "buckit-admin");
  if (existing) return existing;

  return initializeApp({
    credential: cert({
      projectId: requireConfig("FIREBASE_PROJECT_ID", process.env.FIREBASE_PROJECT_ID),
      clientEmail: requireConfig("FIREBASE_CLIENT_EMAIL", process.env.FIREBASE_CLIENT_EMAIL),
      privateKey: requireConfig("FIREBASE_PRIVATE_KEY", process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, "\n"),
    }),
  }, "buckit-admin");
}

export function getFirebaseAdminAuth() {
  return getAuth(getFirebaseAdminApp());
}

export function getFirebaseAdminMessaging() {
  return getMessaging(getFirebaseAdminApp());
}
