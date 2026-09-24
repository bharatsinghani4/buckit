"use client";

import { getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { requireConfig } from "@/lib/config/required";

export function isFirebaseConfigured() {
  return !!(process.env.NEXT_PUBLIC_FIREBASE_API_KEY && process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN && process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID && process.env.NEXT_PUBLIC_FIREBASE_APP_ID && process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID);
}

export function getFirebaseClientApp() {
  if (typeof window === "undefined") {
    throw new Error("Firebase client initialization requires a browser.");
  }
  const existing = getApps().find((app) => app.name === "buckit-web");
  if (existing) return existing;

  // Keep explicit accesses: Next.js inlines NEXT_PUBLIC_ values at build time.
  return initializeApp({
    apiKey: requireConfig("NEXT_PUBLIC_FIREBASE_API_KEY", process.env.NEXT_PUBLIC_FIREBASE_API_KEY),
    authDomain: requireConfig("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN),
    projectId: requireConfig("NEXT_PUBLIC_FIREBASE_PROJECT_ID", process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID),
    appId: requireConfig("NEXT_PUBLIC_FIREBASE_APP_ID", process.env.NEXT_PUBLIC_FIREBASE_APP_ID),
    messagingSenderId: requireConfig("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID", process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID),
  }, "buckit-web");
}

export function getFirebaseClientAuth() {
  return getAuth(getFirebaseClientApp());
}
