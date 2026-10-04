/** Shared Tailwind classes for interactive controls across every phase. */
const buttonBase =
  "inline-flex h-9 min-h-9 items-center justify-center gap-2 rounded-lg border px-3 text-xs font-semibold leading-none transition-[background-color,border-color,color,translate,box-shadow] duration-200 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--green)] min-[768px]:hover:-translate-y-0.5 min-[768px]:disabled:hover:translate-y-0 [&_.lucide-arrow-right]:transition-transform [&_.lucide-chevron-right]:transition-transform [&_.lucide-arrow-up-right]:transition-transform min-[768px]:hover:[&_.lucide-arrow-right]:translate-x-1 min-[768px]:hover:[&_.lucide-chevron-right]:translate-x-1 min-[768px]:hover:[&_.lucide-arrow-up-right]:translate-x-1 motion-reduce:!translate-y-0 motion-reduce:transition-none motion-reduce:[&_.lucide-arrow-right]:!translate-x-0 motion-reduce:[&_.lucide-chevron-right]:!translate-x-0 motion-reduce:[&_.lucide-arrow-up-right]:!translate-x-0";

const inputBase =
  "h-9 max-[767px]:h-11 w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-sm text-[var(--ink)] placeholder:text-[var(--muted)] focus:border-[var(--green)] focus:bg-[var(--surface)] focus:outline-none focus:ring-2 focus:ring-[var(--green)]/15 disabled:cursor-not-allowed disabled:opacity-50";

export const controls = {
  primary: `${buttonBase} border-transparent bg-[var(--button-primary)] text-[var(--button-primary-text)] hover:bg-[var(--ink)]`,
  secondary: `${buttonBase} border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] hover:border-[var(--green)] hover:bg-[var(--soft)]`,
  action: `${buttonBase} border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] hover:border-[var(--green)] hover:bg-[var(--soft)]`,
  quietAction: `${buttonBase} border-transparent bg-transparent text-[var(--muted)] hover:bg-[var(--soft)] hover:text-[var(--ink)]`,
  dangerAction: `${buttonBase} border-transparent bg-transparent text-[var(--error)] hover:bg-[var(--error-bg)]`,
  input: inputBase,
  search: `${inputBase} pl-9`,
  date: `${inputBase} [color-scheme:light] dark:[color-scheme:dark]`,
  checkbox: "m-0 size-4 min-w-4 accent-[var(--green)]",
  dropdownTrigger: `${inputBase} inline-flex items-center justify-between gap-2 text-left`,
  dropdownContent:
    "z-[100] min-w-[var(--radix-select-trigger-width)] max-h-[min(300px,var(--radix-select-content-available-height))] overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] shadow-xl",
  dropdownViewport: "p-1",
  dropdownOption:
    "flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-2 text-xs outline-none data-[highlighted]:bg-[var(--sage)] data-[highlighted]:text-[var(--green)] data-[state=checked]:bg-[var(--sage)]",
  dropdownScroll: "grid place-items-center text-[10px] text-[var(--muted)]",
  pickerContent:
    "absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3 text-[var(--ink)] shadow-xl max-[767px]:fixed max-[767px]:left-4 max-[767px]:right-4 max-[767px]:top-[68px] max-[767px]:mt-0 max-[767px]:w-auto",
} as const;
