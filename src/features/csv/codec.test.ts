import { describe, expect, it } from "vitest";
import { parseCsv, quoteCsv } from "./codec";

describe("CSV codec", () => {
  it("preserves quoted commas, escaped quotes, multiline cells, and CRLF", () => {
    expect(parseCsv('Date,Notes\r\n02/01/2026,"Paid, with ""cash""\nagain"\r\n')).toEqual([
      ["Date", "Notes"],
      ["02/01/2026", 'Paid, with "cash"\nagain'],
    ]);
    expect(() => parseCsv('Date,"unclosed')).toThrow("unclosed quoted field");
    expect(parseCsv("Date,Description\n\n01/01/2026,Food\n")).toEqual([
      ["Date", "Description"],
      [""],
      ["01/01/2026", "Food"],
    ]);
  });

  it("neutralizes spreadsheet formulas in text while retaining signed amounts", () => {
    expect(quoteCsv('=HYPERLINK("url")')).toBe('"\'=HYPERLINK(""url"")"');
    expect(quoteCsv("\n+SUM(1,2)")).toBe('"\'\n+SUM(1,2)"');
    expect(quoteCsv("-12.50", true)).toBe('"-12.50"');
  });
});
