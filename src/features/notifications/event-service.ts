import "server-only";
import type { ClientSession } from "mongoose";
import { DomainEventModel } from "@/lib/db/models";
import type { NotificationTrigger } from "./catalog";

export async function recordDomainEvent(
  session: ClientSession,
  input: {
    eventKey: string;
    type: NotificationTrigger;
    actorUserId?: unknown;
    bucketId?: unknown;
    entityType: string;
    entityId: unknown;
    recipientUserId?: unknown;
    suppressed?: boolean;
  },
) {
  await DomainEventModel.updateOne(
    { eventKey: input.eventKey },
    {
      $setOnInsert: {
        eventKey: input.eventKey,
        type: input.type,
        actorUserId: input.actorUserId,
        bucketId: input.bucketId,
        entityType: input.entityType,
        entityId: input.entityId,
        context: input.recipientUserId ? { recipientUserId: String(input.recipientUserId) } : {},
        notificationPolicy: input.suppressed ? "suppressed" : "eligible",
        occurredAt: new Date(),
      },
    },
    { session, upsert: true },
  );
}
