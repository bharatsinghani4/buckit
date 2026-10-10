import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { cert, initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.loadEnvFile(".env.local");

const database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
const dbName = `buckit_smoke_${randomUUID().replaceAll("-", "")}`;
const port = 3100 + Math.floor(Math.random() * 500);
const base = `http://localhost:${port}`;
const env = { ...process.env, MONGODB_URI: database.getUri(), MONGODB_DB_NAME: dbName };
const app = initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});
const auth = getAuth(app);
let account;
let server;

async function run(command, args) {
  const child = spawn(command, args, { env, stdio: "ignore", shell: false });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`${command} exited with code ${code}`);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error("Next.js server stopped before readiness");
    try {
      const response = await fetch(base);
      if (response.ok) return;
    } catch {
      // Wait for the local server to bind.
    }
    await delay(1000);
  }
  throw new Error("Next.js server did not become ready");
}

function assertStatus(response, expected, label) {
  if (response.status !== expected)
    throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}`);
  console.log(`${label}: HTTP ${response.status}`);
}

try {
  await run(process.execPath, [
    "--conditions=react-server",
    "--import",
    "tsx",
    "scripts/setup-db.ts",
  ]);
  server = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", String(port)],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    },
  );
  let serverOutput = "";
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (chunk) => {
      serverOutput = (serverOutput + chunk.toString()).slice(-2000);
    });
  try {
    await waitForServer();
  } catch (error) {
    console.error(serverOutput);
    throw error;
  }

  for (const path of [
    "/",
    "/sign-in",
    "/sign-up",
    "/forgot-password",
    "/verify-email",
    "/onboarding",
    "/buckets/new",
    "/join",
    "/workspace",
    "/auth/action",
    "/manifest.webmanifest",
    "/firebase-messaging-sw.js",
  ])
    assertStatus(await fetch(`${base}${path}`), 200, `page ${path}`);
  assertStatus(await fetch(`${base}/api/v1/me`), 401, "unauthenticated API");

  const suffix = randomUUID();
  const email = `buckit-smoke-${suffix}@example.test`;
  const password = randomBytes(32).toString("base64url");
  account = await auth.createUser({
    email,
    password,
    emailVerified: true,
    displayName: "Buckit Smoke Test",
  });
  const signIn = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(process.env.NEXT_PUBLIC_FIREBASE_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  if (!signIn.ok) throw new Error(`Test account sign-in failed: HTTP ${signIn.status}`);
  const { idToken } = await signIn.json();
  console.log("disposable Firebase account: signed in");

  async function api(method, path, body, expected = 200) {
    const response = await fetch(`${base}/api/v1/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${idToken}`,
        ...(body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              "Idempotency-Key": randomUUID().replaceAll("-", ""),
            }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assertStatus(response, expected, `${method} ${path}`);
    return response.status === 204 ? null : (await response.json()).data;
  }

  await api("GET", "me", undefined, 403);
  await api("POST", "me/bootstrap", {}, 201);
  await api("GET", "me");
  await api("GET", "me/deletion-preview");
  await api("GET", "me/notification-preferences");
  await api("GET", "me/push-installations");
  const bucket = await api(
    "POST",
    "buckets",
    { name: "Smoke Test", primaryCurrency: "INR", timezone: "Asia/Kolkata" },
    201,
  );
  await api("GET", "buckets");
  await api("GET", `buckets/${bucket.id}`);
  await api("GET", `buckets/${bucket.id}/settings`);
  await api("GET", `buckets/${bucket.id}/activity`);
  await api("GET", `buckets/${bucket.id}/deletion-preview`);
  await api("GET", "capabilities");
  await api("GET", `buckets/${bucket.id}/expenses`);
  await api("GET", `buckets/${bucket.id}/expenses/summary`);
  await api("GET", `buckets/${bucket.id}/dashboard`);
  await api(
    "GET",
    `buckets/${bucket.id}/reports/spending?period=custom&from=2026-01-01&toExclusive=2026-02-01`,
  );
  await api("GET", `buckets/${bucket.id}/budgets`);
  await api("GET", `buckets/${bucket.id}/emi-plans`);
  await api("GET", `buckets/${bucket.id}/scheduled-expenses`);
  await api("GET", `buckets/${bucket.id}/members`);
  await api("GET", `buckets/${bucket.id}/invitations`);
  for (const kind of ["accounts", "categories", "platforms"])
    await api("GET", `buckets/${bucket.id}/options/${kind}`);
  await api("GET", "contacts");
  await api("GET", "contacts/share-candidates");
  await api("GET", "notifications");
  await api("GET", "notifications/unread-count");
  await api("GET", "me/reminders");
  console.log("real-token local API smoke test passed");
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(5000)]);
  }
  try {
    if (account) await auth.deleteUser(account.uid);
  } finally {
    await deleteApp(app);
    await database.stop();
  }
}
