"use client";

import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { Bucket } from "@/features/identity/contracts";

function bucketCaption(bucket: Bucket) {
  const kind = bucket.status === "archived" ? "Archived bucket" : "Shared bucket";
  return `${kind} · ${bucket.memberCount} ${bucket.memberCount === 1 ? "member" : "members"}`;
}

export function BucketSelector({
  buckets,
  selected,
  disabled,
  onValueChange,
  onOpenChange,
}: {
  buckets: Bucket[];
  selected: Bucket | null;
  disabled: boolean;
  onValueChange: (id: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Select.Root
      value={selected?.id ?? ""}
      disabled={disabled}
      onValueChange={onValueChange}
      onOpenChange={onOpenChange}
    >
      <Select.Trigger
        id="bucket-picker"
        className="flex w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-left shadow-sm transition-colors hover:border-[var(--muted)] focus-visible:border-[var(--green)]"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={`size-2 shrink-0 rounded-full ${selected?.status === "archived" ? "bg-[var(--muted)]" : "bg-[var(--mint)]"}`}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate text-sm font-semibold text-[var(--ink)]">
              <Select.Value placeholder="Choose a bucket" />
            </span>
          </span>
          {selected && (
            <span className="truncate pl-4 text-[10px] text-[var(--muted)]">
              {bucketCaption(selected)}
            </span>
          )}
        </span>
        <Select.Icon className="shrink-0 text-[var(--muted)]">
          <ChevronDown size={16} aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content position="popper" sideOffset={6} className="dropdown-content">
          <Select.ScrollUpButton className="dropdown-scroll">▲</Select.ScrollUpButton>
          <Select.Viewport className="dropdown-viewport">
            {buckets.map((bucket) => (
              <Select.Item
                key={bucket.id}
                value={bucket.id}
                className="dropdown-option flex items-center gap-3 data-[state=checked]:bg-[var(--sage)]"
              >
                <span
                  className={`mt-1 size-2 shrink-0 rounded-full ${bucket.status === "archived" ? "bg-[var(--muted)]" : "bg-[var(--mint)]"}`}
                  aria-hidden="true"
                />
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
          </Select.Viewport>
          <Select.ScrollDownButton className="dropdown-scroll">▼</Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
