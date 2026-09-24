"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Pending } from "@/components/ui";
import { useAuth } from "./auth-provider";

export function GuestHome({ children }: { children: ReactNode }) {
  const { loading, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user) router.replace("/workspace");
  }, [loading, user, router]);

  if (loading || user) return <main id="main"><Pending label="Checking your session…" /></main>;
  return children;
}
