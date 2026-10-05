"use client";

import * as Select from "@radix-ui/react-select";
import {
  BriefcaseBusiness,
  CarFront,
  Check,
  ChevronDown,
  GraduationCap,
  HeartPulse,
  House,
  PiggyBank,
  Plane,
  Plus,
  ShoppingBasket,
  UserRound,
  UsersRound,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { Bucket } from "@/features/identity/contracts";
import { controls } from "@/components/control-styles";

function bucketCaption(bucket: Bucket) {
  const kind = bucket.status === "archived" ? "Archived" : "Shared";
  return `${kind} · ${bucket.memberCount} ${bucket.memberCount === 1 ? "member" : "members"} · ${bucket.primaryCurrency}`;
}

const bucketIcons: [RegExp, LucideIcon][] = [
  [/home|house|rent|apartment/i, House],
  [/family|shared|couple|roommate/i, UsersRound],
  [/personal|my |mine|self/i, UserRound],
  [/travel|trip|holiday|vacation/i, Plane],
  [/work|business|office/i, BriefcaseBusiness],
  [/grocer|food|market|shopping/i, ShoppingBasket],
  [/car|vehicle|transport/i, CarFront],
  [/health|medical|wellness/i, HeartPulse],
  [/school|college|education/i, GraduationCap],
  [/sav|goal|emergency fund/i, PiggyBank],
];

function BucketGlyph({ bucket, size = 18 }: { bucket: Bucket; size?: number }) {
  const Icon = bucketIcons.find(([pattern]) => pattern.test(bucket.name))?.[1] ?? Wallet;
  return <Icon size={size} aria-hidden="true" />;
}

const createBucketValue = "create-bucket";
const loadMoreValue = "load-more-buckets";

export function BucketSelector({
  buckets,
  selected,
  disabled,
  onValueChange,
  onCreateBucket,
  hasMore,
  onLoadMore,
}: {
  buckets: Bucket[];
  selected: Bucket | null;
  disabled: boolean;
  onValueChange: (id: string) => void;
  onCreateBucket: () => void;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  return (
    <Select.Root
      value={selected?.id ?? ""}
      disabled={disabled}
      onValueChange={(value) => {
        if (value === createBucketValue) onCreateBucket();
        else if (value === loadMoreValue) onLoadMore();
        else onValueChange(value);
      }}
    >
      <Select.Trigger
        id="bucket-picker"
        className={`${controls.dropdownTrigger} !h-9 w-[clamp(96px,30vw,210px)] min-w-0 !px-2.5 shadow-sm hover:border-[var(--muted)] max-[767px]:!w-full max-[767px]:!px-2 max-[767px]:gap-1 max-[400px]:!px-1`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {selected && (
            <span className="shrink-0 text-[var(--green)]">
              <BucketGlyph bucket={selected} size={16} />
            </span>
          )}
          <span className="flex min-w-0 flex-col leading-none">
            <span className="truncate text-xs font-semibold text-[var(--ink)] max-[767px]:text-[11px]">
              <Select.Value placeholder="Choose bucket" />
            </span>
            {selected && (
              <span className="mt-0.5 truncate text-[10px] text-[var(--muted)] max-[767px]:text-[9px]">
                {bucketCaption(selected)}
              </span>
            )}
          </span>
        </span>
        <Select.Icon className="shrink-0 text-[var(--muted)] max-[400px]:[&_svg]:size-3">
          <ChevronDown size={16} aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content position="popper" sideOffset={6} className={controls.dropdownContent}>
          <Select.ScrollUpButton className={controls.dropdownScroll}>▲</Select.ScrollUpButton>
          <Select.Viewport className={`${controls.dropdownViewport} space-y-1`}>
            {buckets.map((bucket) => (
              <Select.Item
                key={bucket.id}
                value={bucket.id}
                className={`${controls.dropdownOption} gap-3`}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--sage)] text-[var(--green)]">
                  <BucketGlyph bucket={bucket} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Select.ItemText>{bucket.name}</Select.ItemText>
                  <span className="truncate text-[10px] text-[var(--muted)]">
                    {bucketCaption(bucket)}
                  </span>
                </span>
                <Select.ItemIndicator className="text-[var(--green)]">
                  <Check size={15} aria-hidden="true" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
            <Select.Separator className="my-1 h-px bg-[var(--line)]" />
            {hasMore && (
              <Select.Item
                value={loadMoreValue}
                className={`${controls.dropdownOption} justify-start font-semibold`}
              >
                <Select.ItemText>Load more buckets</Select.ItemText>
              </Select.Item>
            )}
            <Select.Item
              value={createBucketValue}
              className={`${controls.dropdownOption} justify-start gap-2 font-semibold text-[var(--green)]`}
            >
              <Plus size={16} aria-hidden="true" />
              <Select.ItemText>Create a bucket</Select.ItemText>
            </Select.Item>
          </Select.Viewport>
          <Select.ScrollDownButton className={controls.dropdownScroll}>▼</Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
