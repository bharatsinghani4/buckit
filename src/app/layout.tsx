import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/fraunces/standard-italic.css";
import { AuthProvider } from "@/features/identity/auth-provider";
import { SkipLink } from "@/components/skip-link";

export const metadata: Metadata = {
  title: "Buckit",
  description: "A shared space to record, understand, and plan spending.",
};

export const runtime = "nodejs";

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="en" suppressHydrationWarning><body><SkipLink /><AuthProvider>{children}</AuthProvider></body></html>;
}
