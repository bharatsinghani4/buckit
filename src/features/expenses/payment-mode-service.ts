import "server-only";

import type { DecodedIdToken } from "firebase-admin/auth";
import mongoose, { type ClientSession } from "mongoose";
import { z } from "zod";
import { ApiError, assertRevision } from "@/lib/api/errors";
import { AuditModel, BucketModel, ExpenseModel } from "@/lib/db/models";
import { activeUser, bucketForUser, mutate } from "@/features/identity/service";
import { paymentModeSchema } from "./contracts";
import { paymentModeOptions, type PaymentMode } from "./payment-modes";

const inputSchema = z.object({ name: z.string().trim().min(1).max(40) }).strict();

function labelsFor(bucket: { paymentModeLabels?: Map<string, string> }) {
  return Object.fromEntries(bucket.paymentModeLabels ?? []) as Record<string, string>;
}

async function dto(
  bucket: { _id: unknown; paymentModeLabels?: Map<string, string>; paymentModeRevision?: number },
  session?: ClientSession,
) {
  const counts = await ExpenseModel.aggregate<{ _id: string; count: number }>([
    { $match: { bucketId: bucket._id } },
    { $group: { _id: "$paymentMode", count: { $sum: 1 } } },
  ]).session(session ?? null);
  const usage = new Map(counts.map((entry) => [entry._id, entry.count]));
  return {
    modes: paymentModeOptions(labelsFor(bucket)).map((mode) => ({
      ...mode,
      usageCount: usage.get(mode.value) ?? 0,
    })),
    revision: bucket.paymentModeRevision ?? 0,
  };
}

export async function listPaymentModes(identity: DecodedIdToken, bucketId: string) {
  return dto(await bucketForUser(bucketId, await activeUser(identity)));
}

export async function createPaymentMode(
  identity: DecodedIdToken,
  bucketId: string,
  raw: unknown,
  key: string,
  revisionHeader: string | null,
) {
  const input = inputSchema.parse(raw);
  return mutate(
    identity,
    `payment-mode:${bucketId}:create`,
    key,
    { input, revisionHeader },
    async (session) => {
      const user = await activeUser(identity, session);
      const bucket = await bucketForUser(bucketId, user, session, true, true);
      assertRevision(revisionHeader, bucket.paymentModeRevision ?? 0);
      const name = input.name.replace(/\s+/g, " ");
      const labels = labelsFor(bucket);
      if (Object.keys(labels).filter((value) => value.startsWith("custom_")).length >= 30)
        throw new ApiError(409, "MODE_LIMIT", "This bucket already has 30 custom payment modes.");
      if (
        paymentModeOptions(labels).some((mode) => mode.label.toLowerCase() === name.toLowerCase())
      )
        throw new ApiError(
          409,
          "DUPLICATE_OPTION",
          "A payment mode with this name already exists.",
        );
      const mode = `custom_${new mongoose.Types.ObjectId()}`;
      await BucketModel.updateOne(
        { _id: bucket._id },
        { $set: { [`paymentModeLabels.${mode}`]: name }, $inc: { paymentModeRevision: 1 } },
        { session },
      );
      await AuditModel.create(
        [
          {
            bucketId,
            actorUserId: user._id,
            action: "payment_mode.created",
            entityId: bucket._id,
            operationKey: key,
          },
        ],
        { session },
      );
      return {
        resourceId: bucketId,
        status: 201,
        data: {
          modes: paymentModeOptions({ ...labels, [mode]: name }),
          revision: (bucket.paymentModeRevision ?? 0) + 1,
        },
      };
    },
    async (_, session) =>
      dto(
        await bucketForUser(bucketId, await activeUser(identity, session), session, false, true),
        session,
      ),
  );
}

export async function renamePaymentMode(
  identity: DecodedIdToken,
  bucketId: string,
  mode: PaymentMode,
  raw: unknown,
  key: string,
  revisionHeader: string | null,
) {
  paymentModeSchema.parse(mode);
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
      const labels = labelsFor(bucket);
      if (!paymentModeOptions(labels).some((item) => item.value === mode))
        throw new ApiError(404, "RESOURCE_NOT_FOUND", "This payment mode is unavailable.");
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
      return dto(bucket, session);
    },
  );
}

export const paymentModePath =
  /^buckets\/[a-f\d]{24}\/payment-modes\/(?:upi|cash|neft|imps|credit_card|auto_debit|custom_[a-f\d]{24})$/i;
