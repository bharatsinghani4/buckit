import * as SunCalc from "suncalc";

export type ResolvedTheme = "light" | "dark";
export type SolarThemeSchedule = {
  baseTheme: ResolvedTheme;
  calculatedAt: number;
  expiresAt: number;
  transitions: { at: number; theme: ResolvedTheme }[];
};

const day = 86_400_000;

export function solarThemeAt(schedule: SolarThemeSchedule, now: number): ResolvedTheme | null {
  if (now < schedule.calculatedAt || now >= schedule.expiresAt) return null;
  let theme = schedule.baseTheme;
  for (const transition of schedule.transitions) {
    if (transition.at > now) break;
    theme = transition.theme;
  }
  return theme;
}

/** Calculate seven days of transitions locally; no coordinates leave the browser. */
export function solarThemeSchedule(now: Date, latitude: number, longitude: number) {
  const calculatedAt = now.getTime();
  const expiresAt = calculatedAt + 7 * day;
  const events: SolarThemeSchedule["transitions"] = [];
  for (let offset = -1; offset <= 8; offset++) {
    const date = new Date(calculatedAt + offset * day);
    const times = SunCalc.getTimes(date, latitude, longitude, 0, -date.getTimezoneOffset());
    if (times.sunrise && Number.isFinite(times.sunrise.getTime()))
      events.push({ at: times.sunrise.getTime(), theme: "light" });
    if (times.sunset && Number.isFinite(times.sunset.getTime()))
      events.push({ at: times.sunset.getTime(), theme: "dark" });
  }
  events.sort((a, b) => a.at - b.at);
  const unique = events.filter((event, index) => index === 0 || event.at !== events[index - 1].at);
  const last = unique.filter((event) => event.at <= calculatedAt).at(-1);
  return {
    baseTheme:
      last?.theme ??
      (SunCalc.getPosition(now, latitude, longitude).altitude >= 0 ? "light" : "dark"),
    calculatedAt,
    expiresAt,
    transitions: unique.filter((event) => event.at > calculatedAt && event.at < expiresAt),
  } satisfies SolarThemeSchedule;
}

export function readSolarThemeSchedule(): SolarThemeSchedule | null {
  try {
    const raw = window.localStorage.getItem("buckit-solar-theme");
    if (!raw) return null;
    const value: SolarThemeSchedule = JSON.parse(raw);
    if (
      !Number.isFinite(value.calculatedAt) ||
      !Number.isFinite(value.expiresAt) ||
      !Array.isArray(value.transitions) ||
      !["light", "dark"].includes(value.baseTheme)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function saveSolarThemeSchedule(schedule: SolarThemeSchedule) {
  try {
    window.localStorage.setItem("buckit-solar-theme", JSON.stringify(schedule));
  } catch {
    // Auto still works while the page is open if storage is unavailable.
  }
}
