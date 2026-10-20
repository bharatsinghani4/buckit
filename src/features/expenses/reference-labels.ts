import "server-only";

import type { ClientSession } from "mongoose";
import { OptionModel } from "@/lib/db/models";

type References = { categoryId?: unknown; accountId?: unknown; platformId?: unknown };

export async function allCurrentReferenceNames(bucketId: unknown, session?: ClientSession) {
  const options = await OptionModel.find({ bucketId })
    .select("_id name")
    .session(session ?? null);
  return new Map(options.map((option) => [String(option._id), option.name]));
}

export async function currentReferenceNames(
  bucketId: unknown,
  records: References[],
  session?: ClientSession,
) {
  const ids = [
    ...new Set(
      records.flatMap((record) =>
        [record.categoryId, record.accountId, record.platformId].filter(Boolean).map(String),
      ),
    ),
  ];
  if (!ids.length) return new Map<string, string>();
  const options = await OptionModel.find({ bucketId, _id: { $in: ids } })
    .select("_id name")
    .session(session ?? null);
  return new Map(options.map((option) => [String(option._id), option.name]));
}

export function currentReferenceName(
  names: Map<string, string>,
  id: unknown,
  savedName: string | undefined,
  fallback: string,
) {
  const current = id ? names.get(String(id)) : undefined;
  return current ?? savedName ?? fallback;
}
