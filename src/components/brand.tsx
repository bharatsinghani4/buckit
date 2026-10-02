"use client";
import Image from "next/image";
import Link from "next/link";
import type { MouseEventHandler } from "react";
import { useAuth } from "@/features/identity/auth-provider";
export function Wordmark() {
  return (
    <span className="wordmark text-[var(--ink)] [font-size:28px] font-extrabold [letter-spacing:-.065em] whitespace-nowrap [line-height:1.1] [&_em]:[font-family:'Fraunces_Variable',_Georgia,_serif] [&_em]:italic [&_em]:[color:var(--mint)] [&_em]:font-bold [&_em]:[letter-spacing:-.065em]">
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
      className="brand inline-flex items-center [gap:9px] [width:fit-content] [&_img]:[border-radius:10px] max-[767px]:[gap:6px] max-[767px]:[&_.wordmark]:[font-size:23px]"
      aria-label={ariaLabel}
      onClick={onClick}
    >
      <Image src="/buckit-mark.svg" width={36} height={36} alt="" priority />
      {!compact && <Wordmark />}
    </Link>
  );
}
