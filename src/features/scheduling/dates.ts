/** Calendar dates are stored as YYYY-MM-DD and interpreted in the bucket timezone. */
export function localDate(now: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (kind: string) => parts.find((part) => part.type === kind)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function dueInstant(date: string, zone: string): Date {
  const base = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(base)) throw new Error("Invalid schedule date");
  let instant = base;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const number = (kind: string) => Number(parts.find((part) => part.type === kind)?.value);
    const displayed = Date.UTC(
      number("year"),
      number("month") - 1,
      number("day"),
      number("hour"),
      number("minute"),
      number("second"),
    );
    const correction = displayed - base;
    if (!correction) break;
    instant -= correction;
  }
  return new Date(instant);
}

export function installmentDate(first: string, number: number): string {
  const [year, month, day] = first.split("-").map(Number);
  const monthIndex = month - 1 + number - 1;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = monthIndex % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)))
    .toISOString()
    .slice(0, 10);
}
