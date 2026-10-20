import { describe, expect, it } from "vitest";
import { solarThemeAt, solarThemeSchedule } from "./solar-theme";

describe("solar appearance", () => {
  it("switches between sunrise and sunset and expires stale coordinates", () => {
    const morning = new Date("2026-10-20T02:00:00.000Z");
    const schedule = solarThemeSchedule(morning, 19.076, 72.8777);
    expect(solarThemeAt(schedule, morning.getTime())).toBe("light");
    expect(solarThemeAt(schedule, Date.parse("2026-10-20T16:00:00.000Z"))).toBe("dark");
    expect(solarThemeAt(schedule, schedule.expiresAt)).toBeNull();
    expect(schedule.transitions.length).toBeGreaterThanOrEqual(12);
  });
});
