import { fromMinor, precision } from "@/features/expenses/money";

export function todayInZone(zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function units(value: string, currency: string): bigint {
  const places = precision(currency);
  if (!/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(value))
    throw new Error("Invalid stored amount");
  const negative = value.startsWith("-");
  const [whole, part = ""] = (negative ? value.slice(1) : value).split(".");
  if (part.length > places) throw new Error("Invalid stored precision");
  const result = BigInt(whole) * 10n ** BigInt(places) + BigInt(part.padEnd(places, "0") || "0");
  return negative ? -result : result;
}

export function usageMath(used: bigint, limit: bigint, currency: string) {
  return {
    usedAmount: fromMinor(used, currency),
    remainingAmount: fromMinor(limit - used, currency),
    exceededAmount: fromMinor(used > limit ? used - limit : 0n, currency),
    usagePercent: Number((used * 10_000n) / limit) / 100,
  };
}

export function nextMonth(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 7);
}

export function periodRange(period: string, anchor: string, from?: string, toExclusive?: string) {
  if (period === "custom") {
    if (!from || !toExclusive || from >= toExclusive) throw new Error("Invalid date range");
    return { from, toExclusive };
  }
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7));
  if (period === "year") return { from: `${year}-01-01`, toExclusive: `${year + 1}-01-01` };
  if (period === "quarter") {
    const start = Math.floor((month - 1) / 3) * 3;
    return {
      from: new Date(Date.UTC(year, start, 1)).toISOString().slice(0, 10),
      toExclusive: new Date(Date.UTC(year, start + 3, 1)).toISOString().slice(0, 10),
    };
  }
  if (period !== "month") throw new Error("Invalid period");
  return { from: `${anchor.slice(0, 7)}-01`, toExclusive: `${nextMonth(anchor.slice(0, 7))}-01` };
}

export function priorElapsedRange(
  from: string,
  toExclusive: string,
  today: string,
  period = "custom",
) {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${toExclusive}T00:00:00Z`);
  const daysInCurrent = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  const priorStart = new Date(start);
  if (period === "month") priorStart.setUTCMonth(priorStart.getUTCMonth() - 1);
  else if (period === "quarter") priorStart.setUTCMonth(priorStart.getUTCMonth() - 3);
  else if (period === "year") priorStart.setUTCFullYear(priorStart.getUTCFullYear() - 1);
  else priorStart.setUTCDate(priorStart.getUTCDate() - daysInCurrent);
  const priorEnd = new Date(start);
  const elapsedDays = Math.max(
    0,
    Math.min(
      daysInCurrent,
      Math.round((new Date(`${today}T00:00:00Z`).getTime() - start.getTime()) / 86_400_000) + 1,
    ),
  );
  const comparableEnd = new Date(
    Math.min(priorEnd.getTime(), priorStart.getTime() + elapsedDays * 86_400_000),
  );
  return {
    from: priorStart.toISOString().slice(0, 10),
    toExclusive: comparableEnd.toISOString().slice(0, 10),
  };
}
