"use client";
import Image from "next/image";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { ArrowLeft, Eye, EyeOff, Search, X } from "lucide-react";
import { controls } from "./control-styles";
export function Notice({
  children,
  kind = "error",
}: {
  children: ReactNode;
  kind?: "error" | "success" | "info";
}) {
  return (
    <div
      className={`d-alert notice [background:var(--error-bg)] [color:var(--error)] [border:1px_solid_currentColor] [border-radius:7px] [padding:12px_14px] flex items-center [gap:8px] text-xs [line-height:1.7] [margin-bottom:18px] [overflow-wrap:anywhere] [&.info]:bg-[var(--sage)] [&.info]:text-[var(--green)] [&.info]:[border-color:transparent] [&.success]:bg-[var(--sage)] [&.success]:text-[var(--green)] [&.success]:[border-color:transparent] [&_a]:[text-decoration:underline] ${kind}`}
      role={kind === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
export function Pending({
  label = "Loading your workspace…",
  layout = "page",
}: {
  label?: string;
  layout?: "page" | "workspace" | "inline";
}) {
  const height =
    layout === "page"
      ? "min-h-[100dvh]"
      : layout === "workspace"
        ? "min-h-[calc(100dvh-64px)] max-[767px]:min-h-[calc(100dvh-130px)]"
        : "min-h-48";
  return (
    <div
      className={`pending grid w-full place-items-center px-6 py-8 text-center ${height}`}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3 sm:gap-4 lg:gap-5">
        <div className="grid size-16 place-items-center rounded-2xl shadow-[var(--shadow)] sm:size-20 lg:size-24">
          <Image
            src="/buckit-mark.svg"
            width={80}
            height={80}
            alt=""
            aria-hidden="true"
            className="size-12 motion-safe:animate-[buckit-float_1.8s_ease-in-out_infinite] sm:size-16 lg:size-20"
          />
        </div>
        <span className="text-xs font-medium text-[var(--muted)] sm:text-sm lg:text-base">
          {label}
        </span>
      </div>
    </div>
  );
}
export function SearchField(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...inputProps } = props;
  return (
    <label className="relative block min-w-48 flex-1">
      <Search
        size={16}
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--muted)]"
      />
      <input {...inputProps} type="search" className={`${controls.search} ${className ?? ""}`} />
    </label>
  );
}
export function PasswordField(props: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  const { className, ...inputProps } = props;
  return (
    <div className="password-field relative [&_input]:[padding-right:48px] [&_.icon-button]:absolute [&_.icon-button]:[right:1px] [&_.icon-button]:[top:1px]">
      <input
        {...inputProps}
        className={`${controls.input} pr-12 ${className ?? ""}`}
        type={visible ? "text" : "password"}
      />
      <button
        type="button"
        className="icon-button inline-flex items-center justify-center [width:44px] [height:44px] border-0 bg-transparent text-[var(--muted)] [&:hover]:bg-[var(--soft)]"
        onClick={() => setVisible(!visible)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
      >
        {visible ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
}
export function Dialog({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [backLabel] = useState(() => {
    if (typeof document === "undefined") return "workspace";
    return document.querySelector("main h1")?.textContent?.trim() || "workspace";
  });
  useEffect(() => {
    const dialog = ref.current;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    dialog?.showModal();
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby={titleId}
      className="dialog fixed inset-0 m-auto h-fit overflow-y-auto text-[var(--ink)] bg-[var(--surface)] [border:1px_solid_var(--line)] [border-radius:14px] [padding:30px] [width:min(600px,_calc(100%_-_32px))] [max-height:calc(100svh_-_48px)] [box-shadow:0_20px_48px_#172f2825] [&::backdrop]:[background:#172f2860] [&::backdrop]:[backdrop-filter:blur(4px)] [&_.dialog-header]:flex [&_.dialog-header]:[align-items:start] [&_.dialog-header]:justify-between [&_.dialog-header]:[gap:14px] [&_.dialog-header]:[margin-bottom:22px] [&_.dialog-header_h2]:[font-size:21px] [&_p]:text-xs max-[767px]:!m-0 max-[767px]:!h-[100dvh] max-[767px]:!max-h-[100dvh] max-[767px]:!w-full max-[767px]:!max-w-none max-[767px]:!rounded-none max-[767px]:!border-0 max-[767px]:!bg-[var(--canvas)] max-[767px]:!p-4 max-[767px]:!pt-[calc(16px+env(safe-area-inset-top))] max-[767px]:!pb-[calc(24px+env(safe-area-inset-bottom))] max-[767px]:[&::backdrop]:!bg-transparent"
    >
      <div className="mx-auto max-w-[640px] max-[767px]:rounded-2xl max-[767px]:border max-[767px]:border-[var(--line)] max-[767px]:bg-[var(--surface)] max-[767px]:p-5 max-[767px]:shadow-[var(--shadow)]">
        <header className="dialog-header max-[767px]:!mb-5 max-[767px]:!flex-col">
          <button
            type="button"
            className="inline-flex h-9 items-center gap-1.5 text-xs font-semibold text-[var(--green)] min-[768px]:hidden"
            onClick={onClose}
          >
            <ArrowLeft size={15} aria-hidden="true" /> Back to {backLabel}
          </button>
          <div>
            <h2 id={titleId} className="max-[767px]:!text-lg">
              {title}
            </h2>
            {subtitle && <p className="text-[var(--muted)]">{subtitle}</p>}
          </div>
          <button
            type="button"
            className="icon-button inline-flex items-center justify-center [width:44px] [height:44px] border-0 bg-transparent text-[var(--muted)] [&:hover]:bg-[var(--soft)] max-[767px]:hidden"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
