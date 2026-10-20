"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { useRouter } from "next/navigation";
import { getFirebaseClientAuth, isFirebaseConfigured } from "@/lib/firebase/client";
import { getPreference, setPreference } from "@/lib/browser-preferences";
import { api, friendlyError, ClientError } from "@/lib/api/client";
import type { Profile } from "./contracts";
import { revokePushBeforeLogout } from "@/features/notifications/push-client";
import {
  readSolarThemeSchedule,
  saveSolarThemeSchedule,
  solarThemeAt,
  solarThemeSchedule,
  type ResolvedTheme,
  type SolarThemeSchedule,
} from "@/lib/solar-theme";

type Theme = Profile["theme"];
type AuthContextValue = {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  error: string;
  configured: boolean;
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  autoLocationStatus: "checking" | "active" | "unavailable";
  setTheme: (theme: Theme) => void;
  syncProfile: (profile: Profile) => void;
  refresh: () => Promise<void>;
  logout: (options?: { skipPushRevoke?: boolean }) => Promise<void>;
};
const Context = createContext<AuthContextValue | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");
  const [autoLocationStatus, setAutoLocationStatus] = useState<
    "checking" | "active" | "unavailable"
  >("checking");
  const generation = useRef(0);
  const bootKeys = useRef(new Map<string, string>());
  const router = useRouter();
  const configured = isFirebaseConfigured();
  const load = useCallback(async (current: User) => {
    const run = ++generation.current;
    setLoading(true);
    setError("");
    try {
      let result: Profile;
      try {
        result = (await api<Profile>("me")).data;
      } catch (e) {
        if (!(e instanceof ClientError) || e.code !== "ACCOUNT_NOT_READY") throw e;
        let key = bootKeys.current.get(current.uid);
        if (!key) {
          key = crypto.randomUUID();
          bootKeys.current.set(current.uid, key);
        }
        result = (await api<Profile>("me/bootstrap", { method: "POST", body: {}, key })).data;
      }
      if (run === generation.current) setProfile(result);
    } catch (e) {
      if (run === generation.current) {
        setProfile(null);
        setError(friendlyError(e));
      }
    } finally {
      if (run === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!configured) {
      queueMicrotask(() => setLoading(false));
      return;
    }
    return onAuthStateChanged(
      getFirebaseClientAuth(),
      (current) => {
        setUser(current);
        setProfile(null);
        if (current) void load(current);
        else {
          generation.current++;
          setLoading(false);
          setError("");
        }
      },
      () => {
        setError("Unable to restore your session. Please sign in again.");
        setLoading(false);
      },
    );
  }, [configured, load]);
  useEffect(() => {
    const saved = getPreference("buckit-theme");
    if (saved === "light" || saved === "dark" || saved === "system" || saved === "auto")
      queueMicrotask(() => setThemeState(saved));
  }, []);
  useEffect(() => {
    if (getPreference("buckit-theme") || !profile) return;
    queueMicrotask(() => setThemeState(profile.theme));
  }, [profile]);
  useEffect(() => {
    const saved = getPreference("buckit-theme");
    if (
      (saved === "light" || saved === "dark" || saved === "system" || saved === "auto") &&
      saved !== theme
    )
      return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    let closed = false;
    let timer: number | undefined;
    let schedule: SolarThemeSchedule | null = null;
    let coordinates: { latitude: number; longitude: number } | null = null;
    let lastLocationCheck = 0;
    const apply = (next: ResolvedTheme) => {
      document.documentElement.setAttribute("data-theme", next);
      queueMicrotask(() => {
        if (!closed) setResolvedTheme(next);
      });
    };
    const deviceTheme = (): ResolvedTheme => (query.matches ? "dark" : "light");
    const updateAuto = () => {
      window.clearTimeout(timer);
      const now = Date.now();
      if (schedule && !solarThemeAt(schedule, now) && coordinates) {
        schedule = solarThemeSchedule(new Date(now), coordinates.latitude, coordinates.longitude);
        saveSolarThemeSchedule(schedule);
      }
      apply((schedule && solarThemeAt(schedule, now)) || deviceTheme());
      const next = schedule?.transitions.find((transition) => transition.at > now)?.at;
      timer = window.setTimeout(
        updateAuto,
        Math.min(next ? next - now + 1_000 : 3_600_000, 3_600_000),
      );
    };
    const requestLocation = () => {
      if (!navigator.geolocation) {
        queueMicrotask(() => {
          if (!closed) setAutoLocationStatus("unavailable");
        });
        return;
      }
      lastLocationCheck = Date.now();
      navigator.geolocation.getCurrentPosition(
        (position) => {
          if (closed) return;
          coordinates = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          };
          schedule = solarThemeSchedule(new Date(), coordinates.latitude, coordinates.longitude);
          saveSolarThemeSchedule(schedule);
          setAutoLocationStatus("active");
          updateAuto();
        },
        () => {
          if (closed) return;
          schedule = null;
          setAutoLocationStatus("unavailable");
          updateAuto();
        },
        { enableHighAccuracy: false, maximumAge: 900_000, timeout: 10_000 },
      );
    };
    const onDeviceChange = () => {
      if (theme === "system" || (theme === "auto" && !schedule)) apply(deviceTheme());
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible" || theme !== "auto") return;
      updateAuto();
      if (Date.now() - lastLocationCheck > 3_600_000) requestLocation();
    };
    if (theme === "auto") {
      schedule = readSolarThemeSchedule();
      updateAuto();
      requestLocation();
    } else apply(theme === "system" ? deviceTheme() : theme);
    query.addEventListener("change", onDeviceChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      closed = true;
      window.clearTimeout(timer);
      query.removeEventListener("change", onDeviceChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [theme]);
  const setTheme = useCallback((next: Theme) => {
    setPreference("buckit-theme", next);
    setThemeState(next);
  }, []);
  const refresh = useCallback(async () => {
    const current = getFirebaseClientAuth().currentUser;
    if (current) await load(current);
  }, [load]);
  const syncProfile = useCallback((updated: Profile) => {
    setProfile((current) =>
      current?.id === updated.id && updated.revision >= current.revision ? updated : current,
    );
  }, []);
  const logout = useCallback(
    async (options?: { skipPushRevoke?: boolean }) => {
      generation.current++;
      if (!options?.skipPushRevoke) await revokePushBeforeLogout();
      await signOut(getFirebaseClientAuth());
      setProfile(null);
      setUser(null);
      router.push("/sign-in");
    },
    [router],
  );
  return (
    <Context
      value={{
        user,
        profile,
        loading,
        error,
        configured,
        theme,
        resolvedTheme,
        autoLocationStatus,
        setTheme,
        syncProfile,
        refresh,
        logout,
      }}
    >
      {children}
    </Context>
  );
}
export function useAuth() {
  const context = useContext(Context);
  if (!context) throw new Error("AuthProvider is required");
  return context;
}
