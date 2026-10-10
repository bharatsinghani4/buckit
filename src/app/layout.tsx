import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Script from "next/script";
import "./globals.css";
import "vanilla-calendar-pro/styles/index.css";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/fraunces/standard-italic.css";
import { AuthProvider } from "@/features/identity/auth-provider";
import { SkipLink } from "@/components/skip-link";
import { InstallPrompt } from "@/components/install-prompt";

export const metadata: Metadata = {
  title: "Buckit",
  description: "A shared space to record, understand, and plan spending.",
  icons: { apple: "/icon-192.png" },
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
      <body className="m-0 bg-[var(--canvas)] font-['Plus_Jakarta_Sans_Variable',Arial,sans-serif] text-base leading-[1.6] text-[var(--ink)] antialiased max-[767px]:[&_input]:!text-base max-[767px]:[&_select]:!text-base max-[767px]:[&_textarea]:!text-base">
        <Script src="/theme-init.js" strategy="beforeInteractive" />
        <SkipLink />
        <AuthProvider>
          {children}
          <InstallPrompt />
        </AuthProvider>
      </body>
    </html>
  );
}
