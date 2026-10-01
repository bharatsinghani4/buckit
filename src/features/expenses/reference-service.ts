import "server-only";
import type { DecodedIdToken } from "firebase-admin/auth";
import { ApiError, assertRevision } from "@/lib/api/errors";
import { AuditModel, ExpenseModel, OptionModel } from "@/lib/db/models";
import { activeUser, bucketForUser, mutate } from "@/features/identity/service";
import { objectId, optionEditInput, optionInput, optionKinds, type OptionKind } from "./contracts";

const missing = () => new ApiError(404, "RESOURCE_NOT_FOUND", "This option is not available.");
const label = (value: string) => value.trim().replace(/\s+/g, " ");

async function dto(option: {
  _id: unknown;
  bucketId: unknown;
  kind: string;
  name: string;
  state: string;
  iconKey?: string;
  ownerLabel?: string;
  systemKey?: string;
  revision: number;
}) {
  const usageCount = await ExpenseModel.countDocuments({
    bucketId: option.bucketId,
    [`${option.kind}Id`]: option._id,
  });
  return {
    id: String(option._id),
    name: option.name,
    kind: option.kind,
    state: option.state,
    iconKey: option.iconKey,
    ownerLabel: option.ownerLabel,
    systemKey: option.systemKey,
    revision: option.revision,
    usageCount,
  };
}

export async function listOptions(
  identity: DecodedIdToken,
  bucketId: string,
  kind: OptionKind,
  state: string | null = null,
) {
  const user = await activeUser(identity);
  await bucketForUser(bucketId, user);
  const options = await OptionModel.find({
    bucketId,
    kind: optionKinds[kind],
    ...(state === "all" ? {} : { state: "active" }),
  }).sort({
    nameKey: 1,
  });
  return Promise.all(options.map(dto));
}

export async function createOption(
  identity: DecodedIdToken,
  bucketId: string,
  kind: OptionKind,
  raw: unknown,
  key: string,
) {
  const input = optionInput.parse(raw);
  return mutate(
    identity,
    `option:${bucketId}:${kind}:create`,
    key,
    input,
    async (session) => {
      const user = await activeUser(identity, session);
      await bucketForUser(bucketId, user, session, true, true);
      const name = label(input.name);
      const duplicate = await OptionModel.exists({
        bucketId,
        kind: optionKinds[kind],
        nameKey: name.toLowerCase(),
      }).session(session);
      if (duplicate)
        throw new ApiError(409, "DUPLICATE_OPTION", "An option with this name already exists.");
      const [option] = await OptionModel.create(
        [
          {
            bucketId,
            kind: optionKinds[kind],
            name,
            nameKey: name.toLowerCase(),
            iconKey: input.iconKey,
            ownerLabel: kind === "accounts" ? input.ownerLabel : undefined,
            state: "active",
            createdByUserId: user._id,
          },
        ],
        { session },
      );
      await AuditModel.create(
        [
          {
            bucketId,
            actorUserId: user._id,
            action: "option.created",
            entityId: option._id,
            operationKey: key,
          },
        ],
        { session },
      );
      return { resourceId: String(option._id), status: 201, data: await dto(option) };
    },
    async (id, session) => {
      await bucketForUser(bucketId, await activeUser(identity, session), session, false, true);
      return dto(await OptionModel.findById(id).session(session));
    },
  );
}

export async function changeOption(
  identity: DecodedIdToken,
  bucketId: string,
  kind: OptionKind,
  optionId: string,
  method: "PATCH" | "POST" | "DELETE",
  action: "edit" | "archive" | "restore" | "delete",
  raw: unknown,
  key: string,
  revisionHeader: string | null,
) {
  objectId.parse(optionId);
  const input = action === "edit" ? optionEditInput.parse(raw) : {};
  return mutate(
    identity,
    `option:${bucketId}:${kind}:${optionId}:${action}`,
    key,
    { input, revisionHeader },
    async (session) => {
      const user = await activeUser(identity, session);
      await bucketForUser(bucketId, user, session, true, true);
      const option = await OptionModel.findOne({
        _id: optionId,
        bucketId,
        kind: optionKinds[kind],
      }).session(session);
      if (!option) throw missing();
      assertRevision(revisionHeader, option.revision);
      if (option.systemKey === "other" && ["archive", "delete"].includes(action))
        throw new ApiError(
          409,
          "SYSTEM_OPTION",
          "The default Other platform must remain available.",
        );
      if (action === "delete") {
        const used = await ExpenseModel.exists({
          bucketId,
          [`${option.kind}Id`]: option._id,
        }).session(session);
        if (used || option.systemKey)
          throw new ApiError(
            409,
            "OPTION_IN_USE",
            "Archive this option instead; it is part of existing records.",
          );
        await OptionModel.deleteOne({ _id: option._id }, { session });
      } else {
        if (action === "edit") {
          if ("name" in input && input.name) {
            const name = label(input.name);
            const duplicate = await OptionModel.exists({
              bucketId,
              kind: option.kind,
              nameKey: name.toLowerCase(),
              _id: { $ne: option._id },
            }).session(session);
            if (duplicate)
              throw new ApiError(
                409,
                "DUPLICATE_OPTION",
                "An option with this name already exists.",
              );
            option.name = name;
            option.nameKey = name.toLowerCase();
          }
          if ("iconKey" in input) option.iconKey = input.iconKey;
          if (kind === "accounts" && "ownerLabel" in input) option.ownerLabel = input.ownerLabel;
        } else option.state = action === "archive" ? "archived" : "active";
        option.revision += 1;
        await option.save({ session });
      }
      await AuditModel.create(
        [
          {
            bucketId,
            actorUserId: user._id,
            action: `option.${action}`,
            entityId: option._id,
            operationKey: key,
          },
        ],
        { session },
      );
      return {
        resourceId: optionId,
        status: 200,
        data: action === "delete" ? { id: optionId, deleted: true } : await dto(option),
      };
    },
    async (id, session) => {
      await bucketForUser(bucketId, await activeUser(identity, session), session, false, true);
      return action === "delete"
        ? { id, deleted: true }
        : dto(await OptionModel.findById(id).session(session));
    },
  );
}
