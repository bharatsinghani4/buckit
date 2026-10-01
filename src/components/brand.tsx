"use client";
import Image from "next/image";
import Link from "next/link";
import type { MouseEventHandler } from "react";
import { useAuth } from "@/features/identity/auth-provider";
export function Wordmark() {
  return (
    <span className="wordmark">
      buck<em>it</em>
    </span>
  );
}
export function Brand({
  compact = false,
  onClick,
  ariaLabel = "Buckit home",
}: {
  compact?: boolean;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  ariaLabel?: string;
}) {
  const { user } = useAuth();
  return (
    <Link
      href={user ? "/workspace" : "/"}
      className="brand"
      aria-label={ariaLabel}
      onClick={onClick}
    >
      <Image src="/buckit-mark.svg" width={36} height={36} alt="" priority />
      {!compact && <Wordmark />}
    </Link>
  );
}
