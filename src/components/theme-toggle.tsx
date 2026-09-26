"use client";
import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "@/features/identity/auth-provider";

export function ThemeToggle() {
  const { theme, setTheme } = useAuth();
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => { const query = window.matchMedia("(prefers-color-scheme: dark)"); const update = () => setSystemDark(query.matches); update(); query.addEventListener("change", update); return () => query.removeEventListener("change", update); }, []);
  const dark = theme === "dark" || (theme === "system" && systemDark);
  return <button type="button" className="theme-toggle" onClick={() => setTheme(dark ? "light" : "dark")} aria-label={`Switch to ${dark ? "light" : "dark"} theme`} title={`Switch to ${dark ? "light" : "dark"} theme`}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button>;
}
