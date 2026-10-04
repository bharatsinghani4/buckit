"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Bell,
  CalendarClock,
  Check,
  Clock3,
  Globe2,
  Inbox,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Smartphone,
  Trash2,
} from "lucide-react";
import { controls } from "@/components/control-styles";
import { Dropdown } from "@/components/dropdown";
import { Notice, Pending } from "@/components/ui";
import type { Bucket, Profile } from "@/features/identity/contracts";
import { api, friendlyError } from "@/lib/api/client";
import { useWorkspaceData } from "@/features/buckets/workspace-data-context";
import { getFirebaseClientApp } from "@/lib/firebase/client";
import {
  currentPushInstallation,
  disablePushOnThisDevice,
  enablePushOnThisDevice,
} from "./push-client";
import { notificationGroups, triggerLabels, type NotificationTrigger } from "./catalog";

type Preferences = {
  revision: number;
  triggers: Record<NotificationTrigger, { inApp: boolean; push: boolean }>;
};
type NotificationItem = {
  id: string;
  trigger: NotificationTrigger;
  title: string;
  occurredAt: string;
  readAt: string | null;
  target: { kind: string; id: string; bucketId?: string } | null;
};
type Frequency = "daily" | "weekly" | "twice_weekly" | "fortnightly" | "monthly";
type Reminder = {
  id: string;
  bucketId: string | null;
  enabled: boolean;
  timezone: string;
  frequency: Frequency;
  weekdays: number[];
  anchorDate: string | null;
  dayOfMonth: number | null;
  nextEligibleDate: string | null;
  revision: number;
};
type ReminderForm = {
  bucketId: string;
  enabled: boolean;
  timezone: string;
  frequency: Frequency;
  weekdays: number[];
  anchorDate: string;
  dayOfMonth: number;
};

const card = "rounded-xl border border-[var(--line)] bg-[var(--surface)]";
const small = "text-xs leading-relaxed text-[var(--muted)]";
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const frequencies: { value: Frequency; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "twice_weekly", label: "Twice weekly" },
  { value: "fortnightly", label: "Every two weeks" },
  { value: "monthly", label: "Monthly" },
];

function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--green)] disabled:opacity-50 ${checked ? "bg-[var(--green)]" : "bg-[var(--line)]"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-4" : "translate-x-0"}`}
      />
    </button>
  );
}

function heading(eyebrow: string, title: string, description: string) {
  return (
    <div className="mb-6">
      <p className="mb-2 text-[10px] font-bold tracking-[.16em] text-[var(--green)] uppercase">
        {eyebrow}
      </p>
      <h1 className="text-[28px] font-bold tracking-tight text-[var(--ink)]">{title}</h1>
      <p className={`${small} mt-1 max-w-2xl`}>{description}</p>
    </div>
  );
}

function targetHref(item: NotificationItem) {
  const target = item.target;
  if (!target) return null;
  if (target.kind === "contact") return `/workspace?view=contacts&contact=${target.id}`;
  if (target.kind === "reminder") return "/workspace?view=reminders";
  if (target.kind === "expense" && target.bucketId)
    return `/workspace?bucket=${target.bucketId}&view=expense&expense=${target.id}`;
  if (target.kind === "emiPlan" && target.bucketId)
    return `/workspace?bucket=${target.bucketId}&view=emi-plan&plan=${target.id}`;
  if (target.bucketId) return `/workspace?bucket=${target.bucketId}`;
  return null;
}

export function PhaseFiveScreen({
  view,
  bucket,
  buckets,
  profile,
}: {
  view: "notifications" | "reminders";
  bucket: Bucket;
  buckets: Bucket[];
  profile: Profile;
}) {
  return view === "notifications" ? (
    <NotificationSettings bucket={bucket} />
  ) : (
    <ReminderSettings bucket={bucket} buckets={buckets} profile={profile} />
  );
}

function NotificationSettings({ bucket }: { bucket: Bucket }) {
  const { read, invalidate } = useWorkspaceData();
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pushStatus, setPushStatus] = useState<
    "checking" | "disabled" | "enabled" | "unconfigured"
  >(process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY ? "checking" : "unconfigured");

  const refreshInbox = useCallback(async (which: "all" | "unread") => {
    const [list, count] = await Promise.all([
      api<NotificationItem[]>(`notifications?filter=${which}`),
      api<{ count: number }>("notifications/unread-count"),
    ]);
    setItems(list.data);
    setCursor(list.meta.nextCursor ?? null);
    setUnread(count.data.count);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      read<Preferences>("me/notification-preferences"),
      Promise.resolve().then(() => refreshInbox(filter)),
    ])
      .then(([settings]) => {
        if (!cancelled) setPreferences(settings.data);
      })
      .catch((cause) => {
        if (!cancelled) setError(friendlyError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [read, refreshInbox, filter]);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY) return;
    let cancelled = false;
    void currentPushInstallation()
      .then((installation) => {
        if (!cancelled)
          setPushStatus(
            installation?.state === "active" && Notification.permission === "granted"
              ? "enabled"
              : "disabled",
          );
      })
      .catch(() => {
        if (!cancelled) setPushStatus("disabled");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (pushStatus !== "enabled") return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void import("firebase/messaging").then(({ getMessaging, onMessage }) => {
      if (cancelled) return;
      unsubscribe = onMessage(getMessaging(getFirebaseClientApp()), () => {
        void refreshInbox(filter).catch(() => {});
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [pushStatus, filter, refreshInbox]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void refreshInbox(filter).catch(() => {});
    };
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 45_000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, [filter, refreshInbox]);

  async function toggle(trigger: NotificationTrigger, channel: "inApp" | "push") {
    if (!preferences || busy) return;
    if (channel === "push" && pushStatus !== "enabled") {
      setError("Enable push on this device first, then turn on the triggers you want.");
      return;
    }
    setBusy(trigger);
    setError("");
    const next = {
      ...preferences.triggers[trigger],
      [channel]: !preferences.triggers[trigger][channel],
    };
    try {
      const result = await api<Preferences>("me/notification-preferences", {
        method: "PATCH",
        revision: preferences.revision,
        key: crypto.randomUUID(),
        body: { [trigger]: next },
      });
      setPreferences(result.data);
      invalidate("me/notification-preferences");
      await refreshInbox(filter);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy("");
    }
  }

  async function changePushDevice() {
    if (busy) return;
    setBusy("device");
    setError("");
    try {
      if (pushStatus === "enabled") {
        await disablePushOnThisDevice();
        setPushStatus("disabled");
      } else {
        await enablePushOnThisDevice();
        setPushStatus("enabled");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : friendlyError(cause));
    } finally {
      setBusy("");
    }
  }

  async function markRead(ids: string[]) {
    if (!ids.length || busy) return;
    setBusy("read");
    setError("");
    try {
      await api("notifications/read", {
        method: "POST",
        body: { notificationIds: ids },
        key: crypto.randomUUID(),
      });
      await refreshInbox(filter);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy("");
    }
  }

  async function loadMore() {
    if (!cursor) return;
    setBusy("more");
    try {
      const page = await api<NotificationItem[]>(
        `notifications?filter=${filter}&cursor=${encodeURIComponent(cursor)}`,
      );
      setItems((current) => [...current, ...page.data]);
      setCursor(page.meta.nextCursor ?? null);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy("");
    }
  }

  return (
    <div>
      {heading(
        "Communication · Your space",
        "Notifications & Channels",
        "Control which updates appear in your inbox and which reach this device.",
      )}
      {error && <Notice>{error}</Notice>}
      <section className={`${card} mb-5 flex flex-wrap items-center gap-4 p-5`}>
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-[var(--sage)] text-[var(--green)]">
          <Bell size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-[var(--ink)]">
            Push notifications:{" "}
            {pushStatus === "enabled"
              ? "active"
              : pushStatus === "checking"
                ? "checking this browser"
                : "disabled on this browser"}
          </h2>
          <p className={`${small} mt-1`}>
            Your inbox works without push. Enable this device to receive generic lock-screen
            updates.
          </p>
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--muted)]">
            <span>
              <Check size={12} className="mr-1 inline" /> Private lock-screen copy
            </span>
            <span>
              <ShieldCheck size={12} className="mr-1 inline" /> No spending details in push
            </span>
          </p>
        </div>
        <button
          type="button"
          className={controls.primary}
          disabled={!!busy || pushStatus === "checking" || pushStatus === "unconfigured"}
          title={
            pushStatus === "unconfigured"
              ? "Add the Firebase Web Push public key to enable this feature."
              : undefined
          }
          onClick={() => void changePushDevice()}
        >
          <Smartphone size={15} />{" "}
          {pushStatus === "enabled" ? "Disable push on this device" : "Enable push on this device"}
        </button>
      </section>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,.85fr)]">
        <div className="space-y-5">
          <section className={`${card} p-5`}>
            <div className="mb-4 flex items-end justify-between gap-4 border-b border-[var(--line)] pb-4">
              <div>
                <h2 className="text-sm font-semibold text-[var(--ink)]">
                  Notification channel preferences
                </h2>
                <p className={`${small} mt-1`}>
                  Choose in-app and push independently for each update.
                </p>
              </div>
              <div className="flex shrink-0 gap-4 text-[10px] font-bold tracking-wide text-[var(--muted)] uppercase max-[767px]:hidden">
                <span>In-app</span>
                <span>Push</span>
              </div>
            </div>
            {loading ? (
              <Pending label="Loading your preferences…" />
            ) : (
              notificationGroups.map((group) => (
                <div key={group.title} className="border-b border-[var(--line)] py-3 last:border-0">
                  <p className="mb-2 text-[10px] font-bold tracking-[.12em] text-[var(--green)] uppercase">
                    {group.title}
                  </p>
                  <p className="mb-1 text-[11px] text-[var(--muted)]">{group.description}</p>
                  {group.triggers.map((trigger) => (
                    <div
                      key={trigger}
                      className="grid grid-cols-[minmax(0,1fr)_36px_36px] items-center gap-x-4 gap-y-1 py-2.5 max-[767px]:grid-cols-2 max-[767px]:gap-3"
                    >
                      <div className="min-w-0 max-[767px]:col-span-2">
                        <p className="text-xs font-semibold text-[var(--ink)]">
                          {triggerLabels[trigger]}
                        </p>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--muted)] max-[767px]:rounded-lg max-[767px]:bg-[var(--soft)] max-[767px]:p-2">
                        <span className="min-[768px]:sr-only">In-app</span>
                        <Switch
                          checked={preferences?.triggers[trigger]?.inApp ?? true}
                          disabled={!preferences || !!busy}
                          onChange={() => void toggle(trigger, "inApp")}
                          label={`${triggerLabels[trigger]} in-app`}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--muted)] max-[767px]:rounded-lg max-[767px]:bg-[var(--soft)] max-[767px]:p-2">
                        <span className="min-[768px]:sr-only">Push</span>
                        <Switch
                          checked={preferences?.triggers[trigger]?.push ?? false}
                          disabled={!preferences || !!busy || pushStatus !== "enabled"}
                          onChange={() => void toggle(trigger, "push")}
                          label={`${triggerLabels[trigger]} push`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ))
            )}
            <p className={`${small} mt-4 flex items-start gap-2`}>
              <ShieldCheck size={15} className="mt-0.5 shrink-0 text-[var(--green)]" /> Changes
              apply only to future events. Push is optional on every device.
            </p>
          </section>
          <section className={`${card} p-5`}>
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <LockKeyhole size={17} className="text-[var(--green)]" /> Lock-screen privacy
            </div>
            <p className={small}>
              Push notices say only that Buckit has an update. Expense amounts, names, and comments
              stay inside your authenticated workspace.
            </p>
          </section>
        </div>
        <aside className="space-y-4">
          <section className={`${card} p-5`}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Inbox size={17} /> Inbox{" "}
                <span className="rounded-full bg-[var(--sage)] px-2 py-0.5 text-[10px] text-[var(--green)]">
                  {unread} new
                </span>
              </h2>
            </div>
            <div className="mb-3 flex gap-2 border-b border-[var(--line)] pb-3">
              {(["all", "unread"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`rounded-md px-2.5 py-1.5 text-xs font-semibold ${filter === value ? "bg-[var(--sage)] text-[var(--green)]" : "text-[var(--muted)] hover:bg-[var(--soft)]"}`}
                  onClick={() => setFilter(value)}
                >
                  {value === "all" ? "All" : "Unread"}
                </button>
              ))}
            </div>
            {items.length ? (
              <div className="divide-y divide-[var(--line)]">
                {items.map((item) => (
                  <div key={item.id} className="py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-[var(--ink)]">{item.title}</p>
                        <p className="mt-1 text-[11px] text-[var(--muted)]">
                          {new Date(item.occurredAt).toLocaleString()}
                        </p>
                      </div>
                      {!item.readAt && (
                        <span className="mt-1 size-2 shrink-0 rounded-full bg-[var(--green)]" />
                      )}
                    </div>
                    <div className="mt-2 flex gap-3">
                      {targetHref(item) && (
                        <a
                          href={targetHref(item)!}
                          className="text-[11px] font-semibold text-[var(--green)] hover:underline"
                        >
                          View update →
                        </a>
                      )}
                      {!item.readAt && (
                        <button
                          type="button"
                          className="text-[11px] text-[var(--muted)] hover:text-[var(--ink)]"
                          onClick={() => void markRead([item.id])}
                        >
                          Mark read
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className={`${small} py-8 text-center`}>
                {loading ? "Loading updates…" : "No notifications here yet."}
              </p>
            )}
            {cursor && (
              <button
                type="button"
                className={`${controls.secondary} mt-3 w-full`}
                disabled={!!busy}
                onClick={() => void loadMore()}
              >
                Load more
              </button>
            )}
            {items.some((item) => !item.readAt) && (
              <button
                type="button"
                className={`${controls.secondary} mt-4 w-full`}
                disabled={!!busy}
                onClick={() =>
                  void markRead(items.filter((item) => !item.readAt).map((item) => item.id))
                }
              >
                Mark visible as read
              </button>
            )}
          </section>
          <a
            href={`/workspace?bucket=${bucket.id}&view=reminders`}
            className={`${card} flex items-center justify-between gap-3 p-4 text-xs font-semibold text-[var(--ink)] hover:border-[var(--green)]`}
          >
            <span className="flex items-center gap-2">
              <CalendarClock size={17} className="text-[var(--green)]" /> Processing rhythm &
              reminders
            </span>
            <span aria-hidden="true">→</span>
          </a>
        </aside>
      </div>
    </div>
  );
}

function emptyForm(profile: Profile, bucketId = ""): ReminderForm {
  return {
    bucketId,
    enabled: true,
    timezone: profile.timezone,
    frequency: "weekly",
    weekdays: [1],
    anchorDate: new Date().toISOString().slice(0, 10),
    dayOfMonth: 1,
  };
}

function ReminderSettings({
  bucket,
  buckets,
  profile,
}: {
  bucket: Bucket;
  buckets: Bucket[];
  profile: Profile;
}) {
  const { read, invalidate } = useWorkspaceData();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<ReminderForm>(() => emptyForm(profile, bucket.id));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    read<Reminder[]>("me/reminders")
      .then((result) => {
        if (!cancelled) setReminders(result.data);
      })
      .catch((cause) => {
        if (!cancelled) setError(friendlyError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [read]);

  function edit(item: Reminder) {
    setSelectedId(item.id);
    setForm({
      bucketId: item.bucketId ?? "",
      enabled: item.enabled,
      timezone: item.timezone,
      frequency: item.frequency,
      weekdays: item.weekdays,
      anchorDate: item.anchorDate ?? new Date().toISOString().slice(0, 10),
      dayOfMonth: item.dayOfMonth ?? 1,
    });
    setError("");
    setMessage("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    const current = reminders.find((item) => item.id === selectedId);
    const body = {
      bucketId: form.bucketId || null,
      enabled: form.enabled,
      timezone: form.timezone,
      frequency: form.frequency,
      ...(form.frequency === "weekly" || form.frequency === "twice_weekly"
        ? { weekdays: form.weekdays }
        : {}),
      ...(form.frequency === "fortnightly" ? { anchorDate: form.anchorDate } : {}),
      ...(form.frequency === "monthly" ? { dayOfMonth: form.dayOfMonth } : {}),
    };
    try {
      const result = await api<Reminder>(current ? `me/reminders/${current.id}` : "me/reminders", {
        method: current ? "PATCH" : "POST",
        body,
        revision: current?.revision,
        key: crypto.randomUUID(),
      });
      setReminders((items) =>
        current
          ? items.map((item) => (item.id === current.id ? result.data : item))
          : [result.data, ...items],
      );
      setSelectedId(result.data.id);
      invalidate("me/reminders");
      setMessage("Reminder schedule saved.");
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: Reminder) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`me/reminders/${item.id}`, {
        method: "DELETE",
        revision: item.revision,
        key: crypto.randomUUID(),
      });
      setReminders((items) => items.filter((row) => row.id !== item.id));
      setSelectedId(null);
      setForm(emptyForm(profile, bucket.id));
      invalidate("me/reminders");
      setMessage("Reminder removed.");
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  const timezoneOptions = Array.from(
    new Set([profile.timezone, bucket.timezone, "UTC", ...Intl.supportedValuesOf("timeZone")]),
  ).map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") }));
  return (
    <div>
      {heading(
        "Communication · Calendar logic",
        "Reminders & Processing Schedule",
        "Configure personal expense-entry nudges and inspect automated ledger processing cycles.",
      )}
      {error && <Notice>{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}
      <section className={`${card} mb-6 p-5`}>
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-[var(--line)] pb-4">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <CalendarClock size={18} className="text-[var(--green)]" /> Personal spending
              reminders
            </h2>
            <p className={`${small} mt-1`}>
              Choose a fixed schedule. Reminders do not depend on whether you entered an expense.
            </p>
          </div>
          <Switch
            checked={form.enabled}
            onChange={() => setForm((current) => ({ ...current, enabled: !current.enabled }))}
            label="Enable this reminder"
          />
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_250px]">
          <form id="reminder-form" onSubmit={save} className="min-w-0 space-y-5">
            <div className="flex flex-wrap gap-2">
              {frequencies.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  onClick={() =>
                    setForm((current) => ({
                      ...current,
                      frequency: option.value,
                      weekdays: option.value === "twice_weekly" ? [1, 4] : [1],
                    }))
                  }
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold ${form.frequency === option.value ? "border-[var(--green)] bg-[var(--sage)] text-[var(--green)]" : "border-[var(--line)] text-[var(--muted)] hover:bg-[var(--soft)]"}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {(form.frequency === "weekly" || form.frequency === "twice_weekly") && (
              <div>
                <p className="mb-2 text-[11px] font-semibold text-[var(--ink)]">
                  Reminder day{form.frequency === "twice_weekly" ? "s (choose two)" : ""}
                </p>
                <div className="flex flex-wrap gap-2">
                  {weekdays.map((label, index) => {
                    const day = index + 1;
                    const active = form.weekdays.includes(day);
                    return (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={active}
                        className={`grid size-9 place-items-center rounded-lg border text-[11px] font-semibold ${active ? "border-[var(--green)] bg-[var(--green)] text-white" : "border-[var(--line)] text-[var(--muted)] hover:border-[var(--green)]"}`}
                        onClick={() =>
                          setForm((current) => {
                            const selected = current.weekdays.includes(day)
                              ? current.weekdays.filter((value) => value !== day)
                              : [...current.weekdays, day].slice(
                                  -(current.frequency === "twice_weekly" ? 2 : 1),
                                );
                            return { ...current, weekdays: selected };
                          })
                        }
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {form.frequency === "fortnightly" && (
              <label className="block text-[11px] font-semibold">
                Anchor date
                <input
                  type="date"
                  className={`${controls.date} mt-2`}
                  value={form.anchorDate}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, anchorDate: event.target.value }))
                  }
                  required
                />
              </label>
            )}
            {form.frequency === "monthly" && (
              <label className="block text-[11px] font-semibold">
                Day of month
                <input
                  type="number"
                  min="1"
                  max="31"
                  className={`${controls.input} mt-2`}
                  value={form.dayOfMonth}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, dayOfMonth: Number(event.target.value) }))
                  }
                  required
                />
                <span className={`${small} mt-1 block`}>
                  Short months use their last day, then return to the selected date.
                </span>
              </label>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="reminder-bucket" className="mb-2 block text-[11px] font-semibold">
                  Applies to
                </label>
                <Dropdown
                  id="reminder-bucket"
                  value={form.bucketId || "personal"}
                  onValueChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      bucketId: value === "personal" ? "" : value,
                    }))
                  }
                  options={[
                    { value: "personal", label: "Personal · all buckets" },
                    ...buckets
                      .filter((item) => item.status === "active")
                      .map((item) => ({ value: item.id, label: item.name })),
                  ]}
                />
              </div>
              <div>
                <label htmlFor="reminder-timezone" className="mb-2 block text-[11px] font-semibold">
                  Timezone
                </label>
                <Dropdown
                  id="reminder-timezone"
                  value={form.timezone}
                  onValueChange={(value) => setForm((current) => ({ ...current, timezone: value }))}
                  options={timezoneOptions}
                />
              </div>
            </div>
          </form>
          <aside className="rounded-lg border border-[var(--line)] bg-[var(--soft)] p-4">
            <p className="mb-3 flex items-center gap-2 text-xs font-semibold">
              <Clock3 size={16} className="text-[var(--green)]" /> Delivery rhythm
            </p>
            <p className={small}>
              Reminders are checked during Buckit’s daily processing run. Your selected date follows{" "}
              {form.timezone}.
            </p>
            <div className="mt-4 border-t border-[var(--line)] pt-3 text-[11px] text-[var(--muted)]">
              <p className="font-semibold text-[var(--ink)]">What to expect</p>
              <p className="mt-1">
                No exact notification hour is promised. Old missed reminders do not arrive in a
                burst.
              </p>
            </div>
          </aside>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-4">
          <p className={small}>
            {selectedId
              ? "Editing an existing reminder"
              : "Create as many personal schedules as you need."}
          </p>
          <div className="flex gap-2">
            {selectedId && (
              <button
                type="button"
                className={controls.secondary}
                onClick={() => {
                  setSelectedId(null);
                  setForm(emptyForm(profile, bucket.id));
                }}
              >
                <Plus size={15} /> New reminder
              </button>
            )}
            <button type="submit" form="reminder-form" disabled={busy} className={controls.primary}>
              {busy ? "Saving…" : selectedId ? "Save reminder" : "Add reminder"}
            </button>
          </div>
        </div>
      </section>
      {loading ? (
        <Pending label="Loading reminders…" />
      ) : (
        reminders.length > 0 && (
          <section className={`${card} mb-6 p-5`}>
            <h2 className="mb-3 text-sm font-semibold">Your reminders</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {reminders.map((item) => (
                <div
                  key={item.id}
                  className={`rounded-lg border p-4 ${item.id === selectedId ? "border-[var(--green)] bg-[var(--sage)]" : "border-[var(--line)]"}`}
                >
                  <p className="text-xs font-semibold capitalize">
                    {item.frequency.replaceAll("_", " ")} · {item.enabled ? "On" : "Off"}
                  </p>
                  <p className={`${small} mt-1`}>
                    {item.bucketId
                      ? (buckets.find((entry) => entry.id === item.bucketId)?.name ?? "Bucket")
                      : "Personal"}{" "}
                    · {item.timezone}
                  </p>
                  <p className={`${small} mt-1`}>Next: {item.nextEligibleDate ?? "Paused"}</p>
                  <div className="mt-3 flex gap-2">
                    <button className={controls.secondary} type="button" onClick={() => edit(item)}>
                      Edit
                    </button>
                    <button
                      className={controls.dangerAction}
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(item)}
                    >
                      <Trash2 size={14} /> Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )
      )}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Globe2 size={17} className="text-[var(--green)]" /> System processing architecture &
          cadence
        </h2>
        <p className={`${small} mb-4`}>
          Automated posting, reminders, and delivery are handled in a bounded daily run.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            {
              title: "Daily processing run",
              text: "Scheduled expenses and due reminders are processed once per day. A missed run resumes eligible work later.",
            },
            {
              title: "Installment generation",
              text: "EMI plans generate upcoming installments and post due entries through the same financial rules.",
            },
            {
              title: "Retention & recovery",
              text: "Deleted expenses stay restorable for their retention window before lifecycle cleanup.",
            },
            {
              title: "Zero background bank scraping",
              text: "Buckit does not access your bank account. Spending comes from the entries you and your bucket members create.",
            },
          ].map((item) => (
            <div key={item.title} className={`${card} p-5`}>
              <h3 className="text-xs font-semibold text-[var(--ink)]">{item.title}</h3>
              <p className={`${small} mt-2`}>{item.text}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
