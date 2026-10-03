"use client";

import { api } from "@/lib/api/client";
import { getFirebaseClientApp, getFirebaseClientAuth } from "@/lib/firebase/client";

export type PushInstallation = {
  installationId: string;
  state: "active" | "revoked" | "invalid";
  permission: string;
  lastSeenAt: string | null;
  revision: number;
};

const storageKey = "buckit-push-installation-id";

function installationId() {
  let id = window.localStorage.getItem(storageKey);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(storageKey, id);
  }
  return id;
}

export async function currentPushInstallation() {
  if (!window.localStorage.getItem(storageKey)) return null;
  const id = installationId();
  const result = await api<PushInstallation[]>("me/push-installations");
  return result.data.find((item) => item.installationId === id) ?? null;
}

export async function enablePushOnThisDevice() {
  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
  if (!vapidKey) throw new Error("Web push is not configured for this deployment.");
  if (!("Notification" in window) || !("serviceWorker" in navigator))
    throw new Error("This browser does not support web push.");
  const { getMessaging, getToken, isSupported } = await import("firebase/messaging");
  if (!(await isSupported())) throw new Error("Web push is unavailable in this browser.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error("Allow notifications in your browser to enable push.");
  const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js", {
    scope: "/",
  });
  await navigator.serviceWorker.ready;
  const messaging = getMessaging(getFirebaseClientApp());
  const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  if (!token) throw new Error("Firebase did not provide a device registration. Try again.");
  const previous = await currentPushInstallation();
  const result = await api<PushInstallation>(`me/push-installations/${installationId()}`, {
    method: "PUT",
    body: { token, permission: "granted" },
    revision: previous?.revision,
    key: crypto.randomUUID(),
  });
  return result.data;
}

export async function disablePushOnThisDevice() {
  const previous = await currentPushInstallation();
  if (previous?.state === "active")
    await api(`me/push-installations/${previous.installationId}`, {
      method: "DELETE",
      revision: previous.revision,
      key: crypto.randomUUID(),
    });
  if ("serviceWorker" in navigator) {
    const registration = await navigator.serviceWorker.getRegistration("/");
    for (const notification of (await registration?.getNotifications()) ?? []) notification.close();
  }
  try {
    const { deleteToken, getMessaging, isSupported } = await import("firebase/messaging");
    if (await isSupported()) await deleteToken(getMessaging(getFirebaseClientApp()));
  } catch {
    // The server binding is already revoked, so this device cannot receive Buckit pushes.
  }
}

export async function revokePushBeforeLogout() {
  if (!getFirebaseClientAuth().currentUser || !window.localStorage.getItem(storageKey)) return;
  try {
    await disablePushOnThisDevice();
  } catch {
    // Sign-out remains available; device binding is rechecked before each send.
  }
}
