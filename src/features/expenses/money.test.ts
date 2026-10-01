import { describe, expect, it } from "vitest";
import { convertAmount, fromMinor, minorUnits } from "./money";

describe("expense currency arithmetic", () => {
  it("rounds converted charges and refunds symmetrically", () => {
    expect(convertAmount("10.01", "USD", "INR", "83.12345678")).toBe("832.07");
    expect(convertAmount("-10.01", "USD", "INR", "83.12345678")).toBe("-832.07");
  });

  it("uses zero decimal places for JPY and rejects zero amounts", () => {
    expect(fromMinor(minorUnits("123", "JPY"), "JPY")).toBe("123");
    expect(() => minorUnits("123.45", "JPY")).toThrow();
    expect(() => minorUnits("0", "INR")).toThrow();
  });
});
