"use client";
import { useEffect, type ReactNode } from "react";
import { controls } from "@/components/control-styles";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "./auth-provider";
import { Notice, Pending } from "@/components/ui";
import { Brand } from "@/components/brand";

export function AccessGate({
  children,
  preview = false,
}: {
  children: ReactNode;
  preview?: boolean;
}) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (auth.configured && !auth.loading && !auth.user)
      router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
  }, [auth.configured, auth.loading, auth.user, pathname, router]);
  if (!auth.configured && preview)
    return (
      <>
        <div className="preview-notice [max-width:650px] [margin:20px_auto_-12px] [padding:0_20px]">
          <Notice kind="info">
            Setup preview — connect Buckit’s services to save your profile and create a bucket.
          </Notice>
        </div>
        {children}
      </>
    );
  if (!auth.configured)
    return (
      <main
        id="main"
        className="centered-page [min-height:100svh] flex flex-col items-center justify-center [gap:24px] [padding:40px_20px] text-center [&_p]:[max-width:450px]"
      >
        <Brand />
        <h1>Your workspace is almost ready.</h1>
        <p>Connect Buckit’s services to sign in and start your first bucket.</p>
        <Link href="/onboarding" className={`${controls.primary} button`}>
          Preview bucket setup
        </Link>
        <Link
          href="/"
          className="text-link [background:none] border-0 [padding:0] inline-flex items-center [gap:8px] text-[var(--green)] font-semibold text-xs [&:hover]:[text-decoration:underline] [&:hover]:[text-underline-offset:4px]"
        >
          Back to home
        </Link>
      </main>
    );
  if (auth.loading || !auth.user)
    return (
      <main id="main">
        <Pending />
      </main>
    );
  if (auth.error || !auth.profile)
    return (
      <main
        id="main"
        className="centered-page [min-height:100svh] flex flex-col items-center justify-center [gap:24px] [padding:40px_20px] text-center [&_p]:[max-width:450px]"
      >
        <Brand />
        <h1>Let’s reconnect.</h1>
        <Notice>{auth.error || "Your profile could not be loaded."}</Notice>
        <button className={`${controls.primary} button`} onClick={() => auth.refresh()}>
          Try again
        </button>
        <button className={`${controls.secondary} button`} onClick={() => auth.logout()}>
          Sign out
        </button>
      </main>
    );
  return children;
}
