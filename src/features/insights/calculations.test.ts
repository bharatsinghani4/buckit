import { describe, expect, it } from "vitest";
import { priorElapsedRange, units, usageMath } from "./calculations";

describe("spending insight calculations", () => {
  it("keeps signed refunds and budget overages exact in minor units", () => {
    expect(usageMath(units("90.00", "INR"), units("100.00", "INR"), "INR")).toMatchObject({
      usedAmount: "90.00",
      remainingAmount: "10.00",
      exceededAmount: "0.00",
      usagePercent: 90,
    });
    expect(usageMath(units("-20.00", "INR"), units("100.00", "INR"), "INR")).toMatchObject({
      usedAmount: "-20.00",
      remainingAmount: "120.00",
      exceededAmount: "0.00",
    });
    expect(usageMath(units("110.00", "INR"), units("100.00", "INR"), "INR").exceededAmount).toBe(
      "10.00",
    );
  });

  it("compares an ongoing month with the same elapsed days of the prior month", () => {
    expect(priorElapsedRange("2026-10-01", "2026-11-01", "2026-10-15", "month")).toEqual({
      from: "2026-09-01",
      toExclusive: "2026-09-16",
    });
    expect(priorElapsedRange("2026-03-01", "2026-04-01", "2026-03-31", "month")).toEqual({
      from: "2026-02-01",
      toExclusive: "2026-03-01",
    });
  });
});
