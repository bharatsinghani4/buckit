"use client";
import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Eye, EyeOff, LoaderCircle, X } from "lucide-react";
export function Notice({
  children,
  kind = "error",
}: {
  children: ReactNode;
  kind?: "error" | "success" | "info";
}) {
  return (
    <div className={`d-alert notice ${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}
export function Pending({ label = "Loading your workspace…" }: { label?: string }) {
  return (
    <div className="pending" role="status">
      <LoaderCircle className="spin" size={22} />
      <span>{label}</span>
    </div>
  );
}
export function PasswordField(props: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-field">
      <input {...props} type={visible ? "text" : "password"} />
      <button
        type="button"
        className="icon-button"
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
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby="dialog-title"
      className="dialog"
    >
      <header>
        <div>
          <h2 id="dialog-title">{title}</h2>
          {subtitle && <p className="text-[var(--muted)]">{subtitle}</p>}
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close dialog">
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
