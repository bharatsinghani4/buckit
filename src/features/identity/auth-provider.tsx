"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { useRouter } from "next/navigation";
import { getFirebaseClientAuth, isFirebaseConfigured } from "@/lib/firebase/client";
import { api, friendlyError, ClientError } from "@/lib/api/client";
import type { Profile } from "./contracts";

type AuthContextValue = { user: User | null; profile: Profile | null; loading: boolean; error: string; configured: boolean; refresh: () => Promise<void>; logout: () => Promise<void> };
const Context = createContext<AuthContextValue | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null); const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const generation = useRef(0); const bootKeys = useRef(new Map<string, string>()); const router = useRouter();
  const configured = isFirebaseConfigured();
  const load = useCallback(async (current: User) => {
    const run = ++generation.current; setLoading(true); setError("");
    try {
      let result: Profile;
      try { result = (await api<Profile>("me")).data; }
      catch (e) {
        if (!(e instanceof ClientError) || e.code !== "ACCOUNT_NOT_READY") throw e;
        let key = bootKeys.current.get(current.uid); if (!key) { key = crypto.randomUUID(); bootKeys.current.set(current.uid, key); }
        result = (await api<Profile>("me/bootstrap", { method: "POST", body: {}, key })).data;
      }
      if (run === generation.current) setProfile(result);
    } catch (e) { if (run === generation.current) { setProfile(null); setError(friendlyError(e)); } }
    finally { if (run === generation.current) setLoading(false); }
  }, []);
  useEffect(() => {
    if (!configured) { queueMicrotask(() => setLoading(false)); return; }
    return onAuthStateChanged(getFirebaseClientAuth(), (current) => {
      setUser(current); setProfile(null);
      if (current) void load(current);
      else { generation.current++; setLoading(false); setError(""); }
    }, () => { setError("Unable to restore your session. Please sign in again."); setLoading(false); });
  }, [configured, load]);
  useEffect(() => {
    if (!profile) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.setAttribute("data-theme", profile.theme === "system" ? (query.matches ? "dark" : "light") : profile.theme);
    apply(); query.addEventListener("change", apply); return () => query.removeEventListener("change", apply);
  }, [profile]);
  const refresh = useCallback(async () => { const current = getFirebaseClientAuth().currentUser; if (current) await load(current); }, [load]);
  const logout = useCallback(async () => {
    generation.current++; await signOut(getFirebaseClientAuth()); setProfile(null); setUser(null); document.documentElement.removeAttribute("data-theme"); router.push("/sign-in");
  }, [router]);
  return <Context value={{ user, profile, loading, error, configured, refresh, logout }}>{children}</Context>;
}
export function useAuth() { const context = useContext(Context); if (!context) throw new Error("AuthProvider is required"); return context; }
