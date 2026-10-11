export type RecurringFrequency = "weekly" | "monthly" | "quarterly" | "yearly";

/** Keep the original anchor day when a short month clips an occurrence. */
export function recurringDate(startDate: string, frequency: RecurringFrequency, index: number) {
  const [year, month, day] = startDate.split("-").map(Number);
  if (frequency === "weekly") {
    const date = new Date(Date.UTC(year, month - 1, day + index * 7));
    return date.toISOString().slice(0, 10);
  }
  const step = frequency === "monthly" ? 1 : frequency === "quarterly" ? 3 : 12;
  const monthIndex = month - 1 + index * step;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = monthIndex % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)))
    .toISOString()
    .slice(0, 10);
}

export function daysBefore(date: string, days: number) {
  const instant = Date.parse(`${date}T00:00:00Z`);
  return new Date(instant - days * 86_400_000).toISOString().slice(0, 10);
}
