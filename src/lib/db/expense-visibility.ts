import "server-only";
import type mongoose from "mongoose";
import { EmiPlanModel } from "./models";

export async function liveEmiPlanIds(bucketId: string) {
  return EmiPlanModel.distinct("_id", {
    bucketId,
    state: { $in: ["active", "owner_departed"] },
  }) as Promise<mongoose.Types.ObjectId[]>;
}

/** Keep posted history, but hide unposted EMI entries whose plan was deleted outside the app. */
export function visibleExpenseFilter(planIds: mongoose.Types.ObjectId[]) {
  return {
    $or: [
      { "source.kind": { $ne: "emi" } },
      { postingState: "posted" },
      { "source.emiPlanId": { $in: planIds } },
    ],
  };
}
