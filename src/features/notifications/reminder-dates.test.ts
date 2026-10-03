import { describe, expect, it } from "vitest";
import { nextReminderDate, nextReminderDue } from "./reminder-dates";

describe("personal reminder recurrence", () => {
  it("keeps ISO weekdays and advances a fortnightly anchor", () => {
    expect(
      nextReminderDate(
        { timezone: "UTC", frequency: "twice_weekly", weekdays: [2, 5] },
        "2026-10-03",
      ),
    ).toBe("2026-10-06");
    expect(
      nextReminderDate(
        { timezone: "UTC", frequency: "fortnightly", anchorDate: "2026-10-01" },
        "2026-10-02",
      ),
    ).toBe("2026-10-15");
  });

  it("clamps a monthly day and uses the user's calendar timezone", () => {
    const schedule = { timezone: "Asia/Kolkata", frequency: "monthly" as const, dayOfMonth: 31 };
    expect(nextReminderDate(schedule, "2028-02-01")).toBe("2028-02-29");
    expect(nextReminderDue(schedule, new Date("2028-02-28T20:00:00Z")).date).toBe("2028-02-29");
  });
});
