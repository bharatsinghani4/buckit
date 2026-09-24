import { z } from "zod";

export const currencies = [
  { code: "INR", name: "Indian Rupee", symbol: "₹" },
  { code: "USD", name: "US Dollar", symbol: "$" },
  { code: "EUR", name: "Euro", symbol: "€" },
  { code: "GBP", name: "British Pound", symbol: "£" },
  { code: "AED", name: "UAE Dirham", symbol: "د.إ" },
  { code: "SGD", name: "Singapore Dollar", symbol: "S$" },
  { code: "AUD", name: "Australian Dollar", symbol: "A$" },
  { code: "CAD", name: "Canadian Dollar", symbol: "C$" },
  { code: "JPY", name: "Japanese Yen", symbol: "¥" },
] as const;

export const timezoneSchema = z.string().max(100).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; }
  catch { return false; }
}, "Choose a valid timezone.");
export const displayNameSchema = z.string().trim().min(1, "Enter your name.").max(80);
export const bootstrapSchema = z.object({ displayName: displayNameSchema.optional(), timezone: timezoneSchema.optional() }).strict();
export const tourSchema = z.object({ version: z.literal(1), state: z.enum(["not_started", "in_progress", "completed", "skipped"]), lastStep: z.number().int().min(0).max(3) }).strict();
export const profileSchema = z.object({ displayName: displayNameSchema.optional(), timezone: timezoneSchema.optional(), theme: z.enum(["light", "dark", "system"]).optional(), lastBucketId: z.string().regex(/^[a-f\d]{24}$/i).nullable().optional(), tour: tourSchema.optional() }).strict();
export const bucketSchema = z.object({ name: z.string().trim().min(1, "Name your bucket.").max(80), primaryCurrency: z.string().refine((code) => currencies.some((c) => c.code === code), "Choose a supported currency."), timezone: timezoneSchema }).strict();
export const invitationSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "This invitation link is not valid.") }).strict();

export type Tour = z.infer<typeof tourSchema>;
export type Profile = { id: string; displayName: string; email: string; emailVerified: boolean; timezone: string; theme: "light" | "dark" | "system"; lastBucketId: string | null; tour: Tour; revision: number };
export type Bucket = { id: string; name: string; primaryCurrency: string; timezone: string; status: "active" | "archived"; isOwner: boolean; revision: number; memberCount: number };
export type Invitation = { id: string; bucketId: string; expiresAt: string; shareUrl?: string; secretUnavailable?: boolean; revision: number };

/** Only application destinations are accepted after authentication. */
export function safeNext(value: string | null): string {
  if (value === "/onboarding" || value === "/workspace" || value === "/buckets/new") return value;
  if (value && /^\/join(?:#[A-Za-z0-9_-]{43})?$/.test(value)) return value;
  return "/workspace";
}

/** Keep invitation secrets in the URL fragment, never an HTTP query string. */
export function authHref(path: string, next: string): string {
  const target = safeNext(next);
  const [destination, fragment] = target.split("#");
  return `${path}?next=${encodeURIComponent(destination)}${fragment ? `#${fragment}` : ""}`;
}
