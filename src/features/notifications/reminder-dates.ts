import { dueInstant, localDate } from "@/features/scheduling/dates";

export type ReminderSchedule = {
  timezone: string;
  frequency: "daily" | "weekly" | "twice_weekly" | "fortnightly" | "monthly";
  weekdays?: number[];
  anchorDate?: string;
  dayOfMonth?: number;
};

function addDays(date: string, count: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + count)).toISOString().slice(0, 10);
}

function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function isOccurrence(schedule: ReminderSchedule, date: string): boolean {
  if (schedule.frequency === "daily") return true;
  if (schedule.frequency === "weekly" || schedule.frequency === "twice_weekly")
    return schedule.weekdays?.includes(isoWeekday(date)) ?? false;
  if (schedule.frequency === "fortnightly") {
    if (!schedule.anchorDate || date < schedule.anchorDate) return false;
    const elapsed =
      (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${schedule.anchorDate}T00:00:00Z`)) /
      86_400_000;
    return elapsed % 14 === 0;
  }
  const [year, month, day] = date.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day === Math.min(schedule.dayOfMonth ?? 1, lastDay);
}

export function nextReminderDate(schedule: ReminderSchedule, fromDate: string): string {
  for (let offset = 0; offset <= 62; offset += 1) {
    const candidate = addDays(fromDate, offset);
    if (isOccurrence(schedule, candidate)) return candidate;
  }
  throw new Error("Reminder recurrence has no eligible date.");
}

export function nextReminderDue(
  schedule: ReminderSchedule,
  now: Date,
  skipToday = false,
): { date: string; dueAt: Date } {
  const today = localDate(now, schedule.timezone);
  const date = nextReminderDate(schedule, skipToday ? addDays(today, 1) : today);
  return { date, dueAt: dueInstant(date, schedule.timezone) };
}
