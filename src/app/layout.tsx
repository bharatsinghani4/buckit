import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Script from "next/script";
import "./globals.css";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/fraunces/standard-italic.css";
import { AuthProvider } from "@/features/identity/auth-provider";
import { SkipLink } from "@/components/skip-link";

export const metadata: Metadata = {
  title: "Buckit",
  description: "A shared space to record, understand, and plan spending.",
};

export const viewport: Viewport = { viewportFit: "cover" };

export const runtime = "nodejs";

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className="scroll-smooth scroll-pt-[30px]"
      suppressHydrationWarning
    >
      <body className="m-0 bg-[var(--canvas)] font-['Plus_Jakarta_Sans_Variable',Arial,sans-serif] text-base leading-[1.6] text-[var(--ink)] antialiased">
        <Script src="/theme-init.js" strategy="beforeInteractive" />
        <SkipLink />
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
