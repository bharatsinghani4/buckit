"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, CalendarClock, Check, Pause, Play, Plus } from "lucide-react";
import { CalendarField } from "@/components/calendar-field";
import { Dropdown } from "@/components/dropdown";
import { controls } from "@/components/control-styles";
import { Notice, Pending } from "@/components/ui";
import { useWorkspaceData } from "@/features/buckets/workspace-data-context";
import type { Bucket } from "@/features/identity/contracts";
import { currencies } from "@/features/identity/contracts";
import type { Member, Option } from "@/features/expenses/contracts";
import { api, friendlyError, operationKey } from "@/lib/api/client";
import { MoveRecordDialog } from "@/features/buckets/move-record-dialog";

type Plan = {
  id: string;
  title: string;
  amount: string;
  currency: string;
  frequency: "weekly" | "monthly" | "quarterly" | "yearly";
  startDate: string;
  endDate: string | null;
  nextDate: string | null;
  categoryId: string;
  accountId: string;
  platformId: string;
  categoryName: string;
  accountName: string;
  paymentMode: string;
  paidByUserId: string;
  recordingMode: "confirm" | "automatic";
  reminderLeadDays: number;
  reminderPurpose: "funds" | "pay" | "add_expenses" | "custom";
  reminderMessage: string;
  state: "active" | "paused" | "ended";
  isCreator: boolean;
  revision: number;
};
type Form = Omit<
  Plan,
  "id" | "nextDate" | "categoryName" | "accountName" | "state" | "isCreator" | "revision"
>;
const card =
  "rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]";
const modes = [
  { value: "upi", label: "UPI" },
  { value: "cash", label: "Cash" },
  { value: "neft", label: "NEFT" },
  { value: "imps", label: "IMPS" },
  { value: "credit_card", label: "Credit card" },
  { value: "auto_debit", label: "Auto debit" },
];

function todayIn(zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function money(amount: string, currency: string) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(amount));
}
function initial(bucket: Bucket): Form {
  return {
    title: "",
    amount: "",
    currency: bucket.primaryCurrency,
    frequency: "monthly",
    startDate: todayIn(bucket.timezone),
    endDate: null,
    categoryId: "",
    accountId: "",
    platformId: "",
    paymentMode: "upi",
    paidByUserId: "",
    recordingMode: "confirm",
    reminderLeadDays: 1,
    reminderPurpose: "funds",
    reminderMessage: "",
  };
}

export function RecurringPlans({ bucket }: { bucket: Bucket }) {
  const { read, invalidate } = useWorkspaceData();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<"list" | "form" | "confirm">("list");
  const [editing, setEditing] = useState<Plan | null>(null);
  const [confirming, setConfirming] = useState<Plan | null>(null);
  const [moveTarget, setMoveTarget] = useState<Plan | null>(null);
  const [paymentDate, setPaymentDate] = useState(todayIn(bucket.timezone));
  const [form, setForm] = useState<Form>(() => initial(bucket));
  const [references, setReferences] = useState<{
    categories: Option[];
    accounts: Option[];
    platforms: Option[];
    members: Member[];
  } | null>(null);
  const keySlot = useRef<{ body: string; key: string } | null>(null);
  const endpoint = `buckets/${bucket.id}/recurring-plans`;

  useEffect(() => {
    let live = true;
    read<Plan[]>(endpoint)
      .then((result) => {
        if (live) setPlans(result.data);
      })
      .catch((cause) => {
        if (live) setError(friendlyError(cause));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [read, endpoint]);

  async function loadReferences() {
    if (references) return references;
    const [categories, accounts, platforms, members] = await Promise.all([
      read<Option[]>(`buckets/${bucket.id}/options/categories`),
      read<Option[]>(`buckets/${bucket.id}/options/accounts`),
      read<Option[]>(`buckets/${bucket.id}/options/platforms`),
      read<Member[]>(`buckets/${bucket.id}/members`),
    ]);
    const result = {
      categories: categories.data.filter((item) => item.state === "active"),
      accounts: accounts.data.filter((item) => item.state === "active"),
      platforms: platforms.data.filter((item) => item.state === "active"),
      members: members.data,
    };
    setReferences(result);
    return result;
  }

  async function openForm(plan: Plan | null) {
    setError("");
    try {
      const data = await loadReferences();
      setEditing(plan);
      setForm(
        plan
          ? {
              title: plan.title,
              amount: plan.amount,
              currency: plan.currency,
              frequency: plan.frequency,
              startDate: plan.startDate,
              endDate: plan.endDate,
              categoryId: plan.categoryId,
              accountId: plan.accountId,
              platformId: plan.platformId,
              paymentMode: plan.paymentMode,
              paidByUserId: plan.paidByUserId,
              recordingMode: plan.recordingMode,
              reminderLeadDays: plan.reminderLeadDays,
              reminderPurpose: plan.reminderPurpose,
              reminderMessage: plan.reminderMessage,
            }
          : {
              ...initial(bucket),
              categoryId: data.categories[0]?.id ?? "",
              accountId: data.accounts[0]?.id ?? "",
              platformId:
                data.platforms.find((item) => item.systemKey === "other")?.id ??
                data.platforms[0]?.id ??
                "",
              paidByUserId: data.members[0]?.id ?? "",
            },
      );
      setPanel("form");
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function refresh() {
    invalidate(endpoint);
    const result = await read<Plan[]>(endpoint);
    setPlans(result.data);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const body = {
      ...form,
      endDate: form.endDate || null,
      platformId: form.platformId || undefined,
    };
    try {
      const key = operationKey(keySlot, body);
      const result = await api<Plan>(editing ? `${endpoint}/${editing.id}` : endpoint, {
        method: editing ? "PATCH" : "POST",
        body,
        key,
        revision: editing?.revision,
      });
      setPlans((current) =>
        editing
          ? current.map((item) => (item.id === result.data.id ? result.data : item))
          : [result.data, ...current],
      );
      invalidate(endpoint);
      keySlot.current = null;
      setPanel("list");
      setEditing(null);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function changeState(plan: Plan, state: "active" | "paused" | "ended") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<Plan>(`${endpoint}/${plan.id}`, {
        method: "PATCH",
        body: { state },
        revision: plan.revision,
        key: crypto.randomUUID(),
      });
      setPlans((current) => current.map((item) => (item.id === plan.id ? result.data : item)));
      invalidate(endpoint);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirming || busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`${endpoint}/${confirming.id}/confirm`, {
        method: "POST",
        body: { paymentDate },
        revision: confirming.revision,
        key: crypto.randomUUID(),
      });
      invalidate(`buckets/${bucket.id}/expenses`);
      invalidate(`buckets/${bucket.id}/dashboard`);
      invalidate(`buckets/${bucket.id}/reports`);
      invalidate(`buckets/${bucket.id}/budgets`);
      await refresh();
      setPanel("list");
      setConfirming(null);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Pending label="Loading recurring plans…" layout="workspace" />;
  return (
    <section className={card}>
      {panel === "list" ? (
        <>
          <div className="mb-4 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
            <div>
              <h2 className="text-base font-bold">Recurring payments</h2>
              <p className="mt-1 text-xs text-[var(--muted)]">
                SIPs, premiums, subscriptions, and other payments with no fixed installment count.
              </p>
            </div>
            {bucket.status === "active" && (
              <button className={controls.primary} onClick={() => void openForm(null)}>
                <Plus size={15} /> Add recurring
              </button>
            )}
          </div>
          {error && <Notice>{error}</Notice>}
          {plans.length ? (
            <div className="grid gap-3 sm:grid-cols-2 min-[768px]:max-[1024px]:grid-cols-1">
              {plans.map((plan) => (
                <article key={plan.id} className="rounded-lg border border-[var(--line)] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold">{plan.title}</h3>
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        {plan.categoryName} · {plan.accountName} · {plan.frequency}
                      </p>
                    </div>
                    <strong className="shrink-0 text-sm">
                      {money(plan.amount, plan.currency)}
                    </strong>
                  </div>
                  <p className="mt-3 text-xs text-[var(--muted)]">
                    {plan.state === "active"
                      ? `Next: ${plan.nextDate ?? "None"}`
                      : plan.state === "paused"
                        ? "Paused"
                        : "Ended"}{" "}
                    ·{" "}
                    {plan.recordingMode === "automatic"
                      ? "Automatic recording"
                      : "Confirm each payment"}
                  </p>
                  {plan.isCreator && bucket.status === "active" && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {plan.state === "active" &&
                        plan.recordingMode === "confirm" &&
                        plan.nextDate &&
                        plan.nextDate <= todayIn(bucket.timezone) && (
                          <button
                            className={controls.primary}
                            onClick={() => {
                              setConfirming(plan);
                              setPaymentDate(todayIn(bucket.timezone));
                              setError("");
                              setPanel("confirm");
                            }}
                          >
                            <Check size={14} /> Record payment
                          </button>
                        )}
                      {plan.state !== "ended" && (
                        <>
                          <button
                            className={controls.secondary}
                            onClick={() => void openForm(plan)}
                          >
                            Edit
                          </button>
                          <button
                            className={controls.secondary}
                            disabled={busy}
                            onClick={() =>
                              void changeState(plan, plan.state === "paused" ? "active" : "paused")
                            }
                          >
                            {plan.state === "paused" ? <Play size={14} /> : <Pause size={14} />}
                            {plan.state === "paused" ? "Resume" : "Pause"}
                          </button>
                          <button
                            className={controls.dangerAction}
                            disabled={busy}
                            onClick={() => void changeState(plan, "ended")}
                          >
                            End
                          </button>
                        </>
                      )}
                      <button className={controls.secondary} onClick={() => setMoveTarget(plan)}>
                        Move to another bucket
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-[var(--line)] p-6 text-center text-xs text-[var(--muted)]">
              No recurring payments yet.
            </p>
          )}
        </>
      ) : panel === "confirm" && confirming ? (
        <>
          <button className={`${controls.quietAction} mb-3`} onClick={() => setPanel("list")}>
            <ArrowLeft size={14} /> All recurring payments
          </button>
          <h2 className="text-base font-bold">Record {confirming.title}</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Due {confirming.nextDate}. Choose the date the payment actually left your account.
          </p>
          {error && <Notice>{error}</Notice>}
          <form onSubmit={confirm} className="mt-5 max-w-sm space-y-4">
            <label className="block text-xs font-semibold">
              Payment date
              <CalendarField
                value={paymentDate}
                onValueChange={setPaymentDate}
                max={todayIn(bucket.timezone)}
                className="mt-2"
                required
              />
            </label>
            <button className={controls.primary} disabled={busy}>
              {busy ? "Recording…" : `Record ${money(confirming.amount, confirming.currency)}`}
            </button>
          </form>
        </>
      ) : (
        <>
          <button className={`${controls.quietAction} mb-3`} onClick={() => setPanel("list")}>
            <ArrowLeft size={14} /> All recurring payments
          </button>
          <h2 className="text-base font-bold">
            {editing ? "Edit recurring payment" : "Add recurring payment"}
          </h2>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Confirmed payments count in expenses, reports, and budgets. Automatic recording follows
            the schedule without bank confirmation.
          </p>
          {error && <Notice>{error}</Notice>}
          <form onSubmit={save} className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="block text-xs font-semibold sm:col-span-2">
              Name
              <input
                className={`${controls.input} mt-2`}
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                placeholder="e.g. Monthly SIP"
                maxLength={160}
                required
              />
            </label>
            <label className="block text-xs font-semibold">
              Amount
              <input
                className={`${controls.input} mt-2`}
                inputMode="decimal"
                value={form.amount}
                onChange={(event) => setForm({ ...form, amount: event.target.value })}
                required
              />
            </label>
            <Field label="Currency">
              <Dropdown
                value={form.currency}
                onValueChange={(value) => setForm({ ...form, currency: value })}
                options={currencies.map((item) => ({ value: item.code, label: item.code }))}
              />
            </Field>
            <Field label="Repeats">
              <Dropdown
                value={form.frequency}
                onValueChange={(value) =>
                  setForm({ ...form, frequency: value as Form["frequency"] })
                }
                options={[
                  { value: "weekly", label: "Weekly" },
                  { value: "monthly", label: "Monthly" },
                  { value: "quarterly", label: "Quarterly" },
                  { value: "yearly", label: "Yearly" },
                ]}
              />
            </Field>
            <label className="block text-xs font-semibold">
              First due date
              <CalendarField
                value={form.startDate}
                onValueChange={(value) => setForm({ ...form, startDate: value })}
                className="mt-2"
                required
              />
            </label>
            <label className="block text-xs font-semibold">
              End date (optional)
              <CalendarField
                value={form.endDate ?? ""}
                onValueChange={(value) => setForm({ ...form, endDate: value || null })}
                className="mt-2"
                min={form.startDate}
              />
              {form.endDate && (
                <button
                  type="button"
                  className="mt-1 text-[11px] font-semibold text-[var(--green)]"
                  onClick={() => setForm({ ...form, endDate: null })}
                >
                  Remove end date
                </button>
              )}
            </label>
            <Field label="Category">
              <Dropdown
                value={form.categoryId}
                onValueChange={(value) => setForm({ ...form, categoryId: value })}
                options={(references?.categories ?? []).map((item) => ({
                  value: item.id,
                  label: item.name,
                }))}
              />
            </Field>
            <Field label="Payment account">
              <Dropdown
                value={form.accountId}
                onValueChange={(value) => setForm({ ...form, accountId: value })}
                options={(references?.accounts ?? []).map((item) => ({
                  value: item.id,
                  label: item.name,
                }))}
              />
            </Field>
            <Field label="Platform or merchant">
              <Dropdown
                value={form.platformId}
                onValueChange={(value) => setForm({ ...form, platformId: value })}
                options={(references?.platforms ?? []).map((item) => ({
                  value: item.id,
                  label: item.name,
                }))}
              />
            </Field>
            <Field label="Payment method">
              <Dropdown
                value={form.paymentMode}
                onValueChange={(value) => setForm({ ...form, paymentMode: value })}
                options={modes}
              />
            </Field>
            <Field label="Paid by">
              <Dropdown
                value={form.paidByUserId}
                onValueChange={(value) => setForm({ ...form, paidByUserId: value })}
                options={(references?.members ?? []).map((item) => ({
                  value: item.id,
                  label: item.displayName,
                }))}
              />
            </Field>
            <Field label="Recording">
              <Dropdown
                value={form.recordingMode}
                onValueChange={(value) =>
                  setForm({ ...form, recordingMode: value as Form["recordingMode"] })
                }
                options={[
                  { value: "confirm", label: "Remind me to confirm" },
                  { value: "automatic", label: "Add expense automatically" },
                ]}
              />
            </Field>
            <div className="sm:col-span-2 mt-2 flex items-center gap-2 border-t border-[var(--line)] pt-4">
              <CalendarClock size={17} className="text-[var(--green)]" />
              <h3 className="text-sm font-semibold">Payment reminder</h3>
            </div>
            <Field label="Remind me to">
              <Dropdown
                value={form.reminderPurpose}
                onValueChange={(value) =>
                  setForm({ ...form, reminderPurpose: value as Form["reminderPurpose"] })
                }
                options={[
                  { value: "funds", label: "Keep money ready" },
                  { value: "pay", label: "Make a payment" },
                  { value: "add_expenses", label: "Add the payment to expenses" },
                  { value: "custom", label: "Custom message" },
                ]}
              />
            </Field>
            <Field label="When">
              <Dropdown
                value={String(form.reminderLeadDays)}
                onValueChange={(value) => setForm({ ...form, reminderLeadDays: Number(value) })}
                options={[
                  { value: "0", label: "On the due date" },
                  { value: "1", label: "1 day before" },
                  { value: "3", label: "3 days before" },
                  { value: "7", label: "7 days before" },
                ]}
              />
            </Field>
            <label className="block text-xs font-semibold sm:col-span-2">
              Message {form.reminderPurpose === "custom" ? "" : "(optional override)"}
              <input
                className={`${controls.input} mt-2`}
                value={form.reminderMessage}
                onChange={(event) => setForm({ ...form, reminderMessage: event.target.value })}
                placeholder={
                  form.reminderPurpose === "funds"
                    ? "Check that your account has enough money"
                    : "Message shown in your inbox"
                }
                maxLength={240}
                required={form.reminderPurpose === "custom"}
              />
            </label>
            <div className="sm:col-span-2 flex justify-end gap-2">
              <button type="button" className={controls.secondary} onClick={() => setPanel("list")}>
                Cancel
              </button>
              <button
                className={controls.primary}
                disabled={busy || !form.categoryId || !form.accountId || !form.paidByUserId}
              >
                {busy ? "Saving…" : editing ? "Save changes" : "Create plan"}
              </button>
            </div>
          </form>
        </>
      )}
      {moveTarget && (
        <MoveRecordDialog
          bucket={bucket}
          kind="recurring-plan"
          id={moveTarget.id}
          revision={moveTarget.revision}
          onClose={() => setMoveTarget(null)}
          onMoved={(targetId) => {
            setMoveTarget(null);
            window.history.pushState(
              null,
              "",
              `/workspace?bucket=${targetId}&view=scheduled&tab=recurring`,
            );
          }}
        />
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold">{label}</p>
      {children}
    </div>
  );
}
