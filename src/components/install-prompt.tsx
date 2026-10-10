"use client";

import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/features/identity/auth-provider";
import { controls } from "./control-styles";

type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const dismissalKey = "buckit-install-prompt-dismissed-at";
const installedKey = "buckit-installed";
const dismissalDuration = 30 * 24 * 60 * 60 * 1000;

export function InstallPrompt() {
  const pathname = usePathname();
  const { profile, loading } = useAuth();
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  const [eligible, setEligible] = useState(false);
  const [instructions, setInstructions] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    const dismissedAt = Number(localStorage.getItem(dismissalKey) ?? 0);
    const dismissedRecently = dismissedAt > 0 && Date.now() - dismissedAt < dismissalDuration;
    queueMicrotask(() => {
      setEligible(!standalone && !dismissedRecently && !localStorage.getItem(installedKey));
      setIos(/iPad|iPhone|iPod/.test(navigator.userAgent));
    });

    const capture = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as InstallEvent);
    };
    const installed = () => {
      localStorage.setItem(installedKey, "true");
      setEligible(false);
      setInstallEvent(null);
    };
    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", installed);
    return () => {
      window.removeEventListener("beforeinstallprompt", capture);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);

  if (!eligible || loading || !profile || !pathname.startsWith("/workspace")) return null;

  const dismiss = () => {
    localStorage.setItem(dismissalKey, String(Date.now()));
    setEligible(false);
  };

  const install = async () => {
    if (!installEvent) {
      setInstructions(true);
      return;
    }
    try {
      await installEvent.prompt();
      const choice = await installEvent.userChoice;
      setInstallEvent(null);
      if (choice.outcome === "accepted") setEligible(false);
      else dismiss();
    } catch {
      setInstructions(true);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/40 p-4">
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Install Buckit"
        className="relative w-[min(360px,100%)] rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 text-[var(--ink)] shadow-xl"
      >
        <button
          type="button"
          aria-label="Dismiss install suggestion"
          className="absolute right-3 top-3 grid size-7 place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--soft)]"
          onClick={dismiss}
        >
          <X size={16} />
        </button>
        <div className="flex items-start gap-3 pr-7">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--sage)] text-[var(--green)]">
            <Download size={18} />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Install Buckit</h2>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Open your buckets from your device’s home screen.
            </p>
          </div>
        </div>
        {instructions && (
          <p className="mt-3 rounded-lg bg-[var(--soft)] p-3 text-xs text-[var(--ink)]">
            {ios
              ? "Open your browser’s Share menu, then choose Add to Home Screen."
              : "Use your browser’s menu or address-bar install icon, then choose Install app or Add to Home Screen."}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={controls.quietAction} onClick={dismiss}>
            Later
          </button>
          <button
            type="button"
            className={controls.primary}
            onClick={() => (instructions ? dismiss() : void install())}
          >
            {installEvent ? "Install" : instructions ? "Got it" : "How to install"}
          </button>
        </div>
      </aside>
    </div>
  );
}
