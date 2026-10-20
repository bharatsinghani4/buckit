"use client";

import * as Select from "@radix-ui/react-select";
import { Check, Monitor, Moon, Sunrise, Sun } from "lucide-react";
import { useAuth } from "@/features/identity/auth-provider";
import { playThemeCue } from "@/lib/brand-sounds";
import { controls } from "./control-styles";

const choices = [
  { value: "auto", label: "Auto · sunrise & sunset", icon: Sunrise },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "Match device", icon: Monitor },
] as const;

export function ThemeToggle() {
  const { theme, resolvedTheme, autoLocationStatus, setTheme } = useAuth();
  const CurrentIcon =
    theme === "auto"
      ? Sunrise
      : theme === "system"
        ? Monitor
        : resolvedTheme === "dark"
          ? Moon
          : Sun;
  const label = choices.find((choice) => choice.value === theme)?.label ?? "Appearance";
  return (
    <Select.Root
      value={theme}
      onValueChange={(next) => {
        const choice = next as (typeof choices)[number]["value"];
        if (choice === "light" || choice === "dark") playThemeCue(choice);
        setTheme(choice);
      }}
    >
      <Select.Trigger
        className="theme-toggle inline-grid size-9 flex-none place-items-center rounded-full border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] hover:bg-[var(--soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--green)] max-[767px]:size-[42px]"
        aria-label={`Appearance: ${label}. Choose theme`}
        title={`Appearance: ${label}`}
      >
        <CurrentIcon size={18} aria-hidden="true" />
        <span className="sr-only">
          <Select.Value />
        </span>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          align="end"
          sideOffset={8}
          className={`${controls.dropdownContent} min-w-52`}
        >
          <Select.Viewport className={controls.dropdownViewport}>
            {choices.map((choice) => {
              const Icon = choice.icon;
              return (
                <Select.Item
                  key={choice.value}
                  value={choice.value}
                  className={controls.dropdownOption}
                >
                  <span className="inline-flex items-center gap-2">
                    <Icon size={15} aria-hidden="true" />
                    <Select.ItemText>{choice.label}</Select.ItemText>
                  </span>
                  <Select.ItemIndicator>
                    <Check size={15} />
                  </Select.ItemIndicator>
                </Select.Item>
              );
            })}
            {theme === "auto" && autoLocationStatus === "unavailable" && (
              <p className="px-2.5 py-2 text-[11px] text-[var(--muted)]">
                Location unavailable. Matching device appearance until it is allowed.
              </p>
            )}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
