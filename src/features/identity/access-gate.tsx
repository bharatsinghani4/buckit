"use client";
import { useEffect, type ReactNode } from "react";
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
        <div className="preview-notice">
          <Notice kind="info">
            Setup preview — connect Buckit’s services to save your profile and create a bucket.
          </Notice>
        </div>
        {children}
      </>
    );
  if (!auth.configured)
    return (
      <main id="main" className="centered-page">
        <Brand />
        <h1>Your workspace is almost ready.</h1>
        <p>Connect Buckit’s services to sign in and start your first bucket.</p>
        <Link href="/onboarding" className="button primary">
          Preview bucket setup
        </Link>
        <Link href="/" className="text-link">
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
      <main id="main" className="centered-page">
        <Brand />
        <h1>Let’s reconnect.</h1>
        <Notice>{auth.error || "Your profile could not be loaded."}</Notice>
        <button className="button primary" onClick={() => auth.refresh()}>
          Try again
        </button>
        <button className="button secondary" onClick={() => auth.logout()}>
          Sign out
        </button>
      </main>
    );
  return children;
}
