import { describe, expect, it } from "vitest";
import { dueInstant, installmentDate, localDate } from "./dates";

describe("calendar scheduling", () => {
  it("returns to the original day after a short month", () => {
    expect([1, 2, 3, 4].map((number) => installmentDate("2028-01-31", number))).toEqual([
      "2028-01-31",
      "2028-02-29",
      "2028-03-31",
      "2028-04-30",
    ]);
  });

  it("uses the bucket's local day at the date boundary", () => {
    expect(dueInstant("2028-03-31", "Asia/Kolkata").toISOString()).toBe("2028-03-30T18:30:00.000Z");
    expect(localDate(new Date("2028-03-30T18:29:59Z"), "Asia/Kolkata")).toBe("2028-03-30");
    expect(localDate(new Date("2028-03-30T18:30:00Z"), "Asia/Kolkata")).toBe("2028-03-31");
    expect(dueInstant("2028-01-15", "America/New_York").toISOString()).toBe(
      "2028-01-15T05:00:00.000Z",
    );
    expect(dueInstant("2028-07-15", "America/New_York").toISOString()).toBe(
      "2028-07-15T04:00:00.000Z",
    );
  });
});
