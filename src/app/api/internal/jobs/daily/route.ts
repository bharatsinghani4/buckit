import { randomUUID, timingSafeEqual } from "node:crypto";
import { connectDatabase } from "@/lib/db/mongoose";
import { processDaily } from "@/features/scheduling/service";
import { JobLeaseModel } from "@/lib/db/models";
import { processDueReminders } from "@/features/notifications/reminder-worker";
import { fanoutPendingEvents } from "@/features/notifications/inbox-service";
import { sendPendingPush } from "@/features/notifications/push-service";
import { continuePendingImports } from "@/features/csv/import-service";
import { processLifecycleCleanup } from "@/features/lifecycle/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret ?? ""}`;
  if (
    !secret ||
    supplied.length !== expected.length ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  )
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  await connectDatabase();
  const ownerToken = randomUUID();
  const now = new Date();
  try {
    const lease = await JobLeaseModel.findOneAndUpdate(
      {
        _id: "daily-financial",
        $or: [{ expiresAt: { $lte: now } }, { expiresAt: { $exists: false } }],
      },
      { $set: { ownerToken, expiresAt: new Date(now.getTime() + 90_000) } },
      { upsert: true, returnDocument: "after" },
    );
    if (lease.ownerToken !== ownerToken)
      return Response.json(
        { state: "already_running" },
        { headers: { "Cache-Control": "no-store" } },
      );
  } catch (error) {
    if ((error as { code?: number }).code === 11000)
      return Response.json(
        { state: "already_running" },
        { headers: { "Cache-Control": "no-store" } },
      );
    throw error;
  }
  try {
    const startedAt = Date.now();
    const lifecycle = await processLifecycleCleanup(startedAt + 12_000);
    const finance = await processDaily();
    const reminders = await processDueReminders();
    const notifications = await fanoutPendingEvents();
    const push = await sendPendingPush();
    const imports =
      Date.now() - startedAt < 42_000
        ? await continuePendingImports(startedAt + 54_000)
        : { committed: 0, reviewed: 0, failed: 0, hasMore: false };
    const processedCounts = { ...finance, reminders, notifications, push, imports, lifecycle };
    const hasRemainingWork =
      finance.hasRemainingWork ||
      reminders.hasMore ||
      notifications.hasMore ||
      push.hasMore ||
      imports.hasMore ||
      lifecycle.hasMore;
    return Response.json(
      { state: hasRemainingWork ? "partial" : "completed", processedCounts, hasRemainingWork },
      { headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    await JobLeaseModel.updateOne(
      { _id: "daily-financial", ownerToken },
      { $set: { expiresAt: new Date(), lastRunAt: new Date() } },
    );
  }
}
