import { describe, expect, it } from "vitest";
import { daysBefore, recurringDate } from "./recurring-dates";

describe("open-ended recurring dates", () => {
  it("returns to the intended day after a short month", () => {
    expect([0, 1, 2, 3].map((index) => recurringDate("2028-01-31", "monthly", index))).toEqual([
      "2028-01-31",
      "2028-02-29",
      "2028-03-31",
      "2028-04-30",
    ]);
  });

  it("keeps annual and quarterly anchors across leap years", () => {
    expect(recurringDate("2028-02-29", "yearly", 1)).toBe("2029-02-28");
    expect(recurringDate("2028-01-31", "quarterly", 1)).toBe("2028-04-30");
    expect(recurringDate("2028-01-31", "quarterly", 2)).toBe("2028-07-31");
  });

  it("computes reminder dates before the due day", () => {
    expect(daysBefore("2028-03-01", 1)).toBe("2028-02-29");
    expect(recurringDate("2028-01-01", "weekly", 9)).toBe("2028-03-04");
  });
});
