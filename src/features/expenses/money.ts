import { ApiError } from "@/lib/api/errors";

export function precision(currency: string) {
  return currency === "JPY" ? 0 : 2;
}

export function minorUnits(amount: string, currency: string): bigint {
  const places = precision(currency);
  if (!/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(amount))
    throw new ApiError(422, "INVALID_AMOUNT", "Enter a valid nonzero amount.");
  const negative = amount.startsWith("-");
  const [whole, fraction = ""] = (negative ? amount.slice(1) : amount).split(".");
  if (fraction.length > places)
    throw new ApiError(422, "INVALID_AMOUNT", "This currency does not support that precision.");
  const units = BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, "0") || "0");
  if (!units) throw new ApiError(422, "INVALID_AMOUNT", "Amount cannot be zero.");
  return negative ? -units : units;
}

export function fromMinor(units: bigint, currency: string): string {
  const places = precision(currency);
  const factor = 10n ** BigInt(places);
  const sign = units < 0n ? "-" : "";
  const absolute = units < 0n ? -units : units;
  return places
    ? `${sign}${absolute / factor}.${String(absolute % factor).padStart(places, "0")}`
    : `${sign}${absolute}`;
}

export function convertAmount(amount: string, from: string, to: string, rate: string): string {
  const source = minorUnits(amount, from);
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,8})?$/.test(rate))
    throw new ApiError(422, "INVALID_CONVERSION", "Enter a valid positive exchange rate.");
  const [whole, fraction = ""] = rate.split(".");
  const numerator = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0") || "0");
  if (!numerator) throw new ApiError(422, "INVALID_CONVERSION", "Exchange rate must be positive.");
  const denominator = 100_000_000n * 10n ** BigInt(precision(from));
  const scaled = source * numerator * 10n ** BigInt(precision(to));
  const half = denominator / 2n;
  const rounded = scaled < 0n ? -((-scaled + half) / denominator) : (scaled + half) / denominator;
  return fromMinor(rounded, to);
}
