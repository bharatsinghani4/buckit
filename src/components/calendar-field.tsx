"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays } from "lucide-react";
import { controls } from "./control-styles";

type CalendarMode = "date" | "month" | "quarter" | "year";

type CalendarFieldProps = {
  mode?: CalendarMode;
  name?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  "aria-label"?: string;
  className?: string;
  containerClassName?: string;
  required?: boolean;
  min?: string;
  max?: string;
};

function displayValue(value: string, mode: CalendarMode) {
  if (!value) return mode === "date" ? "Choose date" : `Choose ${mode}`;
  if (mode === "quarter") return value;
  if (mode === "year") return value;
  const date = new Date(`${mode === "month" ? `${value}-01` : value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    timeZone: "UTC",
    month: mode === "month" ? "long" : "short",
    ...(mode === "date" ? { day: "numeric" } : {}),
    year: "numeric",
  }).format(date);
}

export function CalendarField({
  mode = "date",
  name,
  value,
  defaultValue = "",
  onValueChange,
  "aria-label": ariaLabel,
  className = "",
  containerClassName = "",
  required,
  min,
  max,
}: CalendarFieldProps) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const currentValue = value ?? internalValue;
  const root = useRef<HTMLDivElement>(null);
  const calendarRoot = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const popupId = useId();
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  const onValueChangeRef = useRef(onValueChange);
  useEffect(() => {
    onValueChangeRef.current = onValueChange;
  }, [onValueChange]);

  useEffect(() => {
    if (!open || !calendarRoot.current) return;
    let disposed = false;
    let calendar: import("vanilla-calendar-pro").Calendar | undefined;
    void import("vanilla-calendar-pro").then(({ Calendar }) => {
      if (disposed || !calendarRoot.current) return;
      const selectedYear = Number(currentValue.slice(0, 4)) || new Date().getFullYear();
      const selectedMonth =
        mode === "quarter"
          ? Math.max(0, (Number(currentValue.slice(-1)) - 1) * 3)
          : Math.max(0, Number(currentValue.slice(5, 7)) - 1);
      const select = (next: string) => {
        setInternalValue(next);
        onValueChangeRef.current?.(next);
        setOpen(false);
        requestAnimationFrame(() => input.current?.focus());
      };
      calendar = new Calendar(calendarRoot.current, {
        type: mode === "date" ? "default" : mode === "year" ? "year" : "month",
        selectedYear,
        selectedMonth: selectedMonth as 0,
        selectedDates: mode === "date" && currentValue ? [currentValue] : [],
        ...(min ? { displayDateMin: new Date(`${min.slice(0, 10)}T12:00:00Z`) } : {}),
        ...(max ? { displayDateMax: new Date(`${max.slice(0, 10)}T12:00:00Z`) } : {}),
        onClickDate: (self) => {
          const selected = self.context.selectedDates[0];
          if (selected) select(selected);
        },
        onClickMonth: (self) => {
          if (mode !== "month" && mode !== "quarter") return;
          const year = self.context.selectedYear;
          const month = self.context.selectedMonth + 1;
          select(
            mode === "quarter"
              ? `${year}-Q${Math.ceil(month / 3)}`
              : `${year}-${String(month).padStart(2, "0")}`,
          );
        },
        onClickYear: (self) => {
          if (mode === "year") select(String(self.context.selectedYear));
        },
      });
      calendar.init();
    });
    return () => {
      disposed = true;
      calendar?.destroy();
    };
    // Opening creates a fresh calendar with the current selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, min, max]);

  useEffect(() => {
    if (!open) return;
    function closeOutside(event: PointerEvent) {
      if (
        !root.current?.contains(event.target as Node) &&
        !popup.current?.contains(event.target as Node)
      )
        setOpen(false);
    }
    function closeEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        input.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePlacement = () => {
      if (!root.current || !popup.current) return;
      const anchor = root.current.getBoundingClientRect();
      const panel = popup.current.getBoundingClientRect();
      const inset = 8;
      const left = Math.max(inset, Math.min(anchor.left, window.innerWidth - panel.width - inset));
      const below = anchor.bottom + inset;
      const above = anchor.top - panel.height - inset;
      const top =
        below + panel.height <= window.innerHeight - inset
          ? below
          : above >= inset
            ? above
            : Math.max(inset, window.innerHeight - panel.height - inset);
      setPlacement({ left, top });
    };
    updatePlacement();
    const observer = new ResizeObserver(updatePlacement);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [open]);

  return (
    <div ref={root} className={`relative min-w-0 ${containerClassName}`}>
      <div className="relative">
        <input
          ref={input}
          type="text"
          name={name}
          value={currentValue}
          readOnly
          required={required}
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          aria-controls={popupId}
          onClick={() => setOpen((visible) => !visible)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setOpen((visible) => !visible);
            }
          }}
          className={`${controls.date} cursor-pointer pr-10 ${className}`}
          placeholder={displayValue("", mode)}
          title={displayValue(currentValue, mode)}
        />
        <CalendarDays
          size={16}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)]"
          aria-hidden="true"
        />
      </div>
      {open &&
        createPortal(
          <div
            ref={popup}
            id={popupId}
            role="dialog"
            aria-label={`Choose ${mode}`}
            style={{
              left: placement?.left ?? 0,
              top: placement?.top ?? 0,
              visibility: placement ? "visible" : "hidden",
            }}
            className="fixed z-[110] max-h-[calc(100dvh-16px)] w-max max-w-[calc(100vw-16px)] overflow-auto rounded-xl border border-[var(--line)] bg-[var(--surface)] p-1 text-[var(--ink)] shadow-xl [--vc-date-selected-bg:var(--green)] [--vc-date-selected-color:var(--surface)] [--vc-date-weekend-color:var(--muted)] [--vc-date-weekend-selected-bg:var(--green)] [--vc-date-weekend-selected-color:var(--surface)] [--vc-months-years-bg-selected:var(--green)] [--vc-months-years-color-selected:var(--surface)] [--vc-focus-outline-color:var(--green)]"
          >
            <div ref={calendarRoot} />
          </div>,
          document.body,
        )}
    </div>
  );
}
