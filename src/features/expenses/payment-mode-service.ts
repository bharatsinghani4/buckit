import "server-only";

import type { DecodedIdToken } from "firebase-admin/auth";
import { z } from "zod";
import { ApiError, assertRevision } from "@/lib/api/errors";
import { AuditModel, BucketModel } from "@/lib/db/models";
import { activeUser, bucketForUser, mutate } from "@/features/identity/service";
import { paymentModes } from "./contracts";
import { paymentModeOptions, type PaymentMode } from "./payment-modes";

const inputSchema = z.object({ name: z.string().trim().min(1).max(40) }).strict();

function dto(bucket: { paymentModeLabels?: Map<string, string>; paymentModeRevision?: number }) {
  const labels = Object.fromEntries(bucket.paymentModeLabels ?? []) as Partial<
    Record<PaymentMode, string>
  >;
  return {
    modes: paymentModeOptions(labels),
    revision: bucket.paymentModeRevision ?? 0,
  };
}

export async function listPaymentModes(identity: DecodedIdToken, bucketId: string) {
  return dto(await bucketForUser(bucketId, await activeUser(identity)));
}

export async function renamePaymentMode(
  identity: DecodedIdToken,
  bucketId: string,
  mode: PaymentMode,
  raw: unknown,
  key: string,
  revisionHeader: string | null,
) {
  const input = inputSchema.parse(raw);
  return mutate(
    identity,
    `payment-mode:${bucketId}:${mode}`,
    key,
    { input, revisionHeader },
    async (session) => {
      const user = await activeUser(identity, session);
      const bucket = await bucketForUser(bucketId, user, session, true, true);
      assertRevision(revisionHeader, bucket.paymentModeRevision ?? 0);
      const name = input.name.replace(/\s+/g, " ");
      const labels = Object.fromEntries(bucket.paymentModeLabels ?? []) as Partial<
        Record<PaymentMode, string>
      >;
      const duplicate = paymentModeOptions(labels).some(
        (item) => item.value !== mode && item.label.toLowerCase() === name.toLowerCase(),
      );
      if (duplicate)
        throw new ApiError(
          409,
          "DUPLICATE_OPTION",
          "A different payment mode already has this name.",
        );
      await BucketModel.updateOne(
        { _id: bucket._id },
        {
          $set: { [`paymentModeLabels.${mode}`]: name },
          $inc: { paymentModeRevision: 1, exportRevision: 1 },
        },
        { session },
      );
      await AuditModel.create(
        [
          {
            bucketId,
            actorUserId: user._id,
            action: "payment_mode.renamed",
            entityId: bucket._id,
            operationKey: key,
          },
        ],
        { session },
      );
      return {
        resourceId: bucketId,
        status: 200,
        data: {
          modes: paymentModeOptions({ ...labels, [mode]: name }),
          revision: (bucket.paymentModeRevision ?? 0) + 1,
        },
      };
    },
    async (_, session) => {
      const bucket = await bucketForUser(
        bucketId,
        await activeUser(identity, session),
        session,
        false,
        true,
      );
      return dto(bucket);
    },
  );
}

export const paymentModePath = new RegExp(
  `^buckets/([a-f\\d]{24})/payment-modes/(${paymentModes.join("|")})$`,
  "i",
);
