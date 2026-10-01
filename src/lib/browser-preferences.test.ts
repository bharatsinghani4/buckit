import { afterEach, expect, it, vi } from "vitest";
import { getPreference, setPreference } from "./browser-preferences";

afterEach(() => vi.unstubAllGlobals());

it("keeps the UI usable when browser storage is denied", () => {
  vi.stubGlobal("window", {
    localStorage: {
      getItem() {
        throw new DOMException("Access denied", "SecurityError");
      },
      setItem() {
        throw new DOMException("Access denied", "SecurityError");
      },
    },
  });

  expect(getPreference("buckit-theme")).toBeNull();
  expect(() => setPreference("buckit-theme", "dark")).not.toThrow();
});
