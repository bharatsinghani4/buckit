"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
  CreditCard,
  Layers3,
  Plus,
  RotateCcw,
  SkipForward,
  Wallet,
} from "lucide-react";
import { Dropdown } from "@/components/dropdown";
import { controls } from "@/components/control-styles";
import { Dialog, Notice, Pending } from "@/components/ui";
import { currencies } from "@/features/identity/contracts";
import type { Bucket } from "@/features/identity/contracts";
import type { Member, Option } from "@/features/expenses/contracts";
import { useWorkspaceData } from "@/features/buckets/workspace-data-context";
import { api, friendlyError } from "@/lib/api/client";
import type { Installment, Plan } from "./contracts";

type View = "emis" | "emi-plan" | "scheduled";
type Scheduled = {
  id: string;
  description: string;
  expenseDate: string;
  amount: string;
  currency: string;
  status: string;
  sourceKind: string;
  conversionStatus: string;
  canResolve: boolean;
  revision: number;
};
const card =
  "rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]";
const secondary = controls.secondary;
const primary = controls.primary;
const field = controls.input;
const modes = [
  { value: "upi", label: "UPI" },
  { value: "cash", label: "Cash" },
  { value: "neft", label: "NEFT" },
  { value: "imps", label: "IMPS" },
  { value: "credit_card", label: "Credit card" },
];

function money(amount: string, currency: string) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(amount));
}
function dateLabel(date: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}
function page(bucket: string, view: View, plan?: string) {
  return `/workspace?bucket=${bucket}&view=${view}${plan ? `&plan=${plan}` : ""}`;
}
function statusLabel(status: string) {
  return (
    (
      {
        scheduled: "Upcoming commitment",
        recorded: "Recorded in ledger",
        skipped: "Skipped · unpaid",
        unpaid: "Unpaid",
        canceled: "Canceled",
        conversion_needed: "Conversion needed",
        pending_processing: "Pending daily processing",
        review_required: "Review required",
      } as Record<string, string>
    )[status] ?? status
  );
}
function statusStyle(status: string) {
  return status === "recorded"
    ? "bg-[var(--soft)] text-[var(--green)]"
    : status === "unpaid" ||
        status === "skipped" ||
        status === "conversion_needed" ||
        status === "review_required"
      ? "bg-[var(--error-bg)] text-[var(--error)]"
      : "bg-[var(--surface-2)] text-[var(--muted)]";
}

export function PhaseFourScreen({
  bucket,
  view,
  planId,
}: {
  bucket: Bucket;
  view: View;
  planId: string | null;
}) {
  const router = useRouter();
  const { read, invalidate } = useWorkspaceData();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selected, setSelected] = useState<Plan | null>(null);
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [installmentCursor, setInstallmentCursor] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<Scheduled[]>([]);
  const [options, setOptions] = useState<{
    categories: Option[];
    accounts: Option[];
    platforms: Option[];
    members: Member[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<
    "add" | "edit" | "end" | "skip" | "reschedule" | "review" | null
  >(null);
  const [target, setTarget] = useState<Installment | null>(null);
  const [reviewTarget, setReviewTarget] = useState<Scheduled | null>(null);
  const [preview, setPreview] = useState<{ number: number; date: string }[]>([]);
  const [correctionPreview, setCorrectionPreview] = useState<{
    affected: { id: string; number: number; date: string }[];
    affectedCount: number;
    remainingUngenerated: number;
    validationToken: string;
  } | null>(null);
  const [form, setForm] = useState({
    title: "",
    installmentAmount: "",
    currency: bucket.primaryCurrency,
    totalInstallments: "12",
    previouslyPaidCount: "0",
    firstInstallmentDate: new Date().toISOString().slice(0, 10),
    categoryId: "",
    accountId: "",
    platformId: "",
    paymentMode: "upi",
    paidByUserId: "",
  });
  const mutationKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      if (view === "scheduled") {
        const result = await read<Scheduled[]>(`buckets/${bucket.id}/scheduled-expenses`);
        setScheduled(result.data);
      } else if (view === "emi-plan" && planId) {
        const [plan, entries] = await Promise.all([
          read<Plan>(`buckets/${bucket.id}/emi-plans/${planId}`),
          read<Installment[]>(`buckets/${bucket.id}/emi-plans/${planId}/installments`),
        ]);
        setSelected(plan.data);
        setInstallments(entries.data);
        setInstallmentCursor(entries.meta.nextCursor ?? null);
      } else {
        const result = await read<Plan[]>(`buckets/${bucket.id}/emi-plans`);
        setPlans(result.data);
      }
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setLoading(false);
    }
  }, [bucket.id, planId, read, view]);

  async function loadMoreInstallments() {
    if (!planId || !installmentCursor || busy) return;
    setBusy(true);
    try {
      const result = await read<Installment[]>(
        `buckets/${bucket.id}/emi-plans/${planId}/installments?cursor=${installmentCursor}`,
      );
      setInstallments((current) => [
        ...current,
        ...result.data.filter((entry) => !current.some((item) => item.id === entry.id)),
      ]);
      setInstallmentCursor(result.meta.nextCursor ?? null);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function openForm(editing: boolean) {
    setError("");
    setPreview([]);
    setCorrectionPreview(null);
    try {
      const [categories, accounts, platforms, members] = await Promise.all([
        read<Option[]>(`buckets/${bucket.id}/options/categories`),
        read<Option[]>(`buckets/${bucket.id}/options/accounts`),
        read<Option[]>(`buckets/${bucket.id}/options/platforms`),
        read<Member[]>(`buckets/${bucket.id}/members`),
      ]);
      setOptions({
        categories: categories.data.filter((item) => item.state === "active"),
        accounts: accounts.data.filter((item) => item.state === "active"),
        platforms: platforms.data.filter((item) => item.state === "active"),
        members: members.data,
      });
      if (editing && selected)
        setForm({
          title: selected.title,
          installmentAmount: selected.installmentAmount,
          currency: selected.currency,
          totalInstallments: String(selected.totalInstallments),
          previouslyPaidCount: String(selected.previouslyPaidCount),
          firstInstallmentDate: selected.firstInstallmentDate,
          categoryId: selected.categoryId,
          accountId: selected.accountId,
          platformId: selected.platformId,
          paymentMode: selected.paymentMode,
          paidByUserId: selected.paidByUserId,
        });
      else
        setForm({
          title: "",
          installmentAmount: "",
          currency: bucket.primaryCurrency,
          totalInstallments: "12",
          previouslyPaidCount: "0",
          firstInstallmentDate: new Date().toISOString().slice(0, 10),
          categoryId: categories.data.find((item) => item.state === "active")?.id ?? "",
          accountId: accounts.data.find((item) => item.state === "active")?.id ?? "",
          platformId: platforms.data.find((item) => item.state === "active")?.id ?? "",
          paymentMode: "upi",
          paidByUserId: members.data[0]?.id ?? "",
        });
      setDialog(editing ? "edit" : "add");
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  const update = (key: keyof typeof form, value: string) => {
    setCorrectionPreview(null);
    setPreview([]);
    setForm((current) => ({ ...current, [key]: value }));
  };
  function planEdits() {
    return {
      title: form.title,
      installmentAmount: form.installmentAmount,
      currency: form.currency,
      categoryId: form.categoryId,
      accountId: form.accountId,
      platformId: form.platformId || undefined,
      paymentMode: form.paymentMode,
      paidByUserId: form.paidByUserId,
    };
  }
  function planBody() {
    return {
      ...form,
      totalInstallments: Number(form.totalInstallments),
      previouslyPaidCount: Number(form.previouslyPaidCount),
      ...(form.platformId ? {} : { platformId: undefined }),
    };
  }
  async function showPreview() {
    try {
      if (dialog === "edit" && selected) {
        const result = await api<NonNullable<typeof correctionPreview>>(
          `buckets/${bucket.id}/emi-plans/preview`,
          {
            method: "POST",
            body: { planId: selected.id, expectedRevision: selected.revision, edits: planEdits() },
          },
        );
        setCorrectionPreview(result.data);
      } else {
        const result = await api<{ dates: { number: number; date: string }[] }>(
          `buckets/${bucket.id}/emi-plans/preview`,
          { method: "POST", body: planBody() },
        );
        setPreview(result.data.dates);
      }
      setError("");
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }
  async function savePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const editing = dialog === "edit" && selected;
    if (editing && !correctionPreview) {
      setError("Preview the affected future installments before saving.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = editing
        ? {
            ...planEdits(),
            validationToken: correctionPreview!.validationToken,
          }
        : planBody();
      const result = await api<Plan>(
        editing
          ? `buckets/${bucket.id}/emi-plans/${selected.id}`
          : `buckets/${bucket.id}/emi-plans`,
        {
          method: editing ? "PATCH" : "POST",
          body,
          revision: editing ? selected.revision : undefined,
          key: (mutationKey.current ??= crypto.randomUUID()),
        },
      );
      mutationKey.current = null;
      invalidate(`buckets/${bucket.id}/`);
      setDialog(null);
      if (editing) {
        setSelected(result.data);
        await load();
      } else router.push(page(bucket.id, "emi-plan", result.data.id));
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function endPlan() {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const result = await api<Plan>(`buckets/${bucket.id}/emi-plans/${selected.id}/end`, {
        method: "POST",
        revision: selected.revision,
        key: (mutationKey.current ??= crypto.randomUUID()),
      });
      mutationKey.current = null;
      setSelected(result.data);
      setInstallments((items) =>
        items.map((item) => (item.state === "scheduled" ? { ...item, state: "canceled" } : item)),
      );
      invalidate(`buckets/${bucket.id}/`);
      setDialog(null);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function changeEntry(action: "skip" | "reschedule", date?: string) {
    if (!selected || !target || busy) return;
    setBusy(true);
    try {
      await api(
        `buckets/${bucket.id}/emi-plans/${selected.id}/installments/${target.id}/${action}`,
        {
          method: "POST",
          body: action === "reschedule" ? { expenseDate: date } : undefined,
          revision: target.expenseRevision ?? undefined,
          key: (mutationKey.current ??= crypto.randomUUID()),
        },
      );
      mutationKey.current = null;
      setInstallments((items) =>
        items.map((item) =>
          item.id === target.id
            ? {
                ...item,
                state: action === "skip" ? "skipped" : item.state,
                scheduledDate: date ?? item.scheduledDate,
                revision: item.revision + 1,
                expenseRevision: (item.expenseRevision ?? 0) + 1,
              }
            : item,
        ),
      );
      setSelected(
        (item) =>
          item && {
            ...item,
            upcomingCount: item.upcomingCount - (action === "skip" ? 1 : 0),
            unpaidCount: item.unpaidCount + (action === "skip" ? 1 : 0),
          },
      );
      invalidate(`buckets/${bucket.id}/`);
      setDialog(null);
      setTarget(null);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function resolveReview(decision: "post" | "cancel") {
    if (!reviewTarget || busy) return;
    setBusy(true);
    try {
      await api(`buckets/${bucket.id}/expenses/${reviewTarget.id}/archive-resolution`, {
        method: "POST",
        body: { decision },
        revision: reviewTarget.revision,
        key: (mutationKey.current ??= crypto.randomUUID()),
      });
      mutationKey.current = null;
      setScheduled((items) => items.filter((item) => item.id !== reviewTarget.id));
      invalidate(`buckets/${bucket.id}/`);
      setDialog(null);
      setReviewTarget(null);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  const totalPlanned = plans
    .filter((item) => item.currency === bucket.primaryCurrency)
    .reduce((sum, item) => sum + Number(item.installmentAmount) * item.upcomingCount, 0);
  const foreignPlans = plans.filter((item) => item.currency !== bucket.primaryCurrency).length;
  const active = plans.filter((item) => item.state === "active");
  const dueCount = plans.reduce((sum, item) => sum + item.unpaidCount, 0);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 pb-12">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          {view === "emi-plan" && (
            <Link
              href={page(bucket.id, "emis")}
              className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-[var(--muted)] hover:text-[var(--green)]"
            >
              <ArrowLeft size={14} /> All EMI plans
            </Link>
          )}
          <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--green)]">
            Scheduled spending · {bucket.name}
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--ink)]">
            {view === "scheduled"
              ? "Scheduled expenses"
              : view === "emi-plan"
                ? (selected?.title ?? "EMI plan")
                : "EMI Plans & Commitments"}
          </h1>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-[var(--muted)]">
            {view === "scheduled"
              ? "Future commitments stay separate from spending until the daily run records them."
              : "Track installments and unpaid commitments before they become spending."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={page(bucket.id, view === "scheduled" ? "emis" : "scheduled")}
            className={secondary}
          >
            <CalendarDays size={15} /> {view === "scheduled" ? "EMI plans" : "Scheduled expenses"}
          </Link>
          {bucket.status === "active" && view !== "scheduled" && (
            <button className={primary} onClick={() => void openForm(false)}>
              <Plus size={15} /> Add EMI plan
            </button>
          )}
        </div>
      </div>
      {error && <Notice>{error}</Notice>}
      {loading ? (
        <Pending label="Loading scheduled spending…" layout="workspace" />
      ) : view === "scheduled" ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Summary
              icon={<CalendarDays size={18} />}
              label="Upcoming entries"
              value={String(scheduled.filter((item) => item.status === "scheduled").length)}
              detail="Not yet actual spending"
            />
            <Summary
              icon={<Clock3 size={18} />}
              label="Pending processing"
              value={String(
                scheduled.filter((item) => item.status === "pending_processing").length,
              )}
              detail="Eligible for the next daily run"
            />
            <Summary
              icon={<Wallet size={18} />}
              label="Needs attention"
              value={String(
                scheduled.filter((item) =>
                  ["conversion_needed", "review_required"].includes(item.status),
                ).length,
              )}
              detail="Resolve before posting"
            />
          </div>
          <section className={card}>
            <h2 className="!mb-4 text-base font-bold">Scheduled ledger</h2>
            {scheduled.length ? (
              <div className="divide-y divide-[var(--line)]">
                {scheduled.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div>
                      <p className="text-sm font-semibold">{item.description}</p>
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        {dateLabel(item.expenseDate)} ·{" "}
                        {item.sourceKind === "emi" ? "EMI installment" : "Manual expense"}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className={`rounded-full px-2 py-1 text-[11px] font-semibold ${statusStyle(item.status)}`}
                      >
                        {statusLabel(item.status)}
                      </span>
                      <strong className="text-sm">{money(item.amount, item.currency)}</strong>
                      {item.status === "review_required" && item.canResolve ? (
                        <button
                          className={secondary}
                          onClick={() => {
                            setReviewTarget(item);
                            setDialog("review");
                          }}
                        >
                          Review
                        </button>
                      ) : (
                        <Link
                          className={secondary}
                          href={`/workspace?bucket=${bucket.id}&view=expense&expense=${item.id}${item.status === "conversion_needed" && item.canResolve ? "&resolve=1" : ""}`}
                        >
                          {item.status === "conversion_needed" && item.canResolve
                            ? "Resolve conversion"
                            : "View expense"}
                          <ArrowRight size={13} />
                        </Link>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty text="No scheduled expenses yet. Future-dated entries and EMI installments appear here." />
            )}
          </section>
        </>
      ) : view === "emis" ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Summary
              icon={<Layers3 size={18} />}
              label="Active EMI plans"
              value={String(active.length)}
              detail="Across this bucket"
            />
            <Summary
              icon={<Wallet size={18} />}
              label={`Remaining in ${bucket.primaryCurrency}`}
              value={money(String(totalPlanned), bucket.primaryCurrency)}
              detail={
                foreignPlans
                  ? `${foreignPlans} foreign-currency plan${foreignPlans === 1 ? "" : "s"} shown separately`
                  : "Unposted installments only"
              }
            />
            <Summary
              icon={<CalendarDays size={18} />}
              label="Upcoming installments"
              value={String(plans.reduce((sum, item) => sum + item.upcomingCount, 0))}
              detail="Scheduled, not recorded"
            />
            <Summary
              icon={<Clock3 size={18} />}
              label="Unpaid obligations"
              value={String(dueCount)}
              detail="Skipped or deleted payments"
            />
          </div>
          <section className={card}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold">Financing schedule</h2>
                <p className="text-xs text-[var(--muted)]">
                  Choose a plan to inspect every installment.
                </p>
              </div>
            </div>
            {plans.length ? (
              <div className="grid gap-3 md:grid-cols-2">
                {plans.map((plan) => (
                  <Link
                    key={plan.id}
                    href={page(bucket.id, "emi-plan", plan.id)}
                    className="block rounded-xl border border-[var(--line)] p-4 transition hover:border-[var(--green)] hover:bg-[var(--soft)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="rounded-lg bg-[var(--soft)] p-2 text-[var(--green)]">
                        <CreditCard size={20} />
                      </span>
                      <span
                        className={`rounded-full px-2 py-1 text-[11px] font-semibold ${plan.state === "active" ? "bg-[var(--soft)] text-[var(--green)]" : "bg-[var(--surface-2)] text-[var(--muted)]"}`}
                      >
                        {plan.state}
                      </span>
                    </div>
                    <h3 className="mt-3 text-base font-bold max-[767px]:text-sm">{plan.title}</h3>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {plan.categoryName} · {plan.accountName} · {plan.creatorName}
                    </p>
                    <div className="mt-4 flex flex-wrap justify-between gap-2 border-t border-[var(--line)] pt-3 text-xs">
                      <span>
                        {plan.recordedCount} of {plan.totalInstallments} recorded
                      </span>
                      <strong>{money(plan.installmentAmount, plan.currency)} / month</strong>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
                      <div
                        className="h-full rounded-full bg-[var(--green)]"
                        style={{
                          width: `${Math.min(100, (plan.recordedCount / plan.totalInstallments) * 100)}%`,
                        }}
                      />
                    </div>
                    <p className="mt-3 text-[11px] text-[var(--muted)]">
                      {plan.nextDate
                        ? `Next: ${dateLabel(plan.nextDate)}`
                        : "No upcoming installments"}
                      {plan.unpaidCount ? ` · ${plan.unpaidCount} unpaid` : ""}
                    </p>
                  </Link>
                ))}
              </div>
            ) : (
              <Empty text="No EMI plans yet. Add a plan to schedule its remaining installments." />
            )}
          </section>
          <p className="text-xs text-[var(--muted)]">
            Upcoming installments are commitments. They enter the expense ledger only after the
            daily processing run on or after their scheduled dates.
          </p>
        </>
      ) : selected ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Summary
              icon={<CheckCircle2 size={18} />}
              label="Recorded"
              value={`${selected.recordedCount} / ${selected.totalInstallments}`}
              detail="Includes previously paid count"
            />
            <Summary
              icon={<CalendarDays size={18} />}
              label="Upcoming"
              value={String(selected.upcomingCount)}
              detail={
                selected.nextDate ? `Next ${dateLabel(selected.nextDate)}` : "No future dates"
              }
            />
            <Summary
              icon={<Clock3 size={18} />}
              label="Unpaid"
              value={String(selected.unpaidCount)}
              detail="Skipped or deleted payments"
            />
          </div>
          <section className={card}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <span className="rounded bg-[var(--soft)] px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--green)]">
                  {selected.state} plan
                </span>
                <h2 className="mt-3 text-lg font-bold">{selected.title}</h2>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  {selected.categoryName} · {selected.platformName} · {selected.accountName} ·{" "}
                  {selected.creatorName}
                </p>
              </div>
              <strong className="text-xl">
                {money(selected.installmentAmount, selected.currency)}
                <span className="text-xs font-medium text-[var(--muted)]"> / installment</span>
              </strong>
            </div>
            <div className="mt-4 grid gap-2 border-t border-[var(--line)] pt-4 text-xs sm:grid-cols-3">
              <p>
                First installment{" "}
                <strong className="block mt-1">{dateLabel(selected.firstInstallmentDate)}</strong>
              </p>
              <p>
                Plan length{" "}
                <strong className="block mt-1">{selected.totalInstallments} months</strong>
              </p>
              <p>
                Generation{" "}
                <strong className="block mt-1">
                  {selected.generatedThroughNumber} of {selected.totalInstallments} ready
                </strong>
              </p>
            </div>
            {selected.isCreator && selected.state === "active" && bucket.status === "active" && (
              <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--line)] pt-4">
                <button className={secondary} onClick={() => void openForm(true)}>
                  Edit future defaults
                </button>
                <button className={secondary} onClick={() => setDialog("end")}>
                  End plan
                </button>
              </div>
            )}
          </section>
          <section className={card}>
            <div className="mb-3">
              <h2 className="text-base font-bold">Installment schedule</h2>
              <p className="text-xs text-[var(--muted)]">
                Recorded entries link to the expense ledger. Skipped and deleted installments remain
                unpaid obligations.
              </p>
            </div>
            {installments.length ? (
              <div className="divide-y divide-[var(--line)]">
                {installments.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div className="flex min-w-[150px] items-center gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--soft)] text-[11px] font-bold text-[var(--green)]">
                        #{item.number}
                      </span>
                      <div>
                        <p className="text-xs font-semibold">{dateLabel(item.scheduledDate)}</p>
                        {item.scheduledDate !== item.originalScheduledDate && (
                          <p className="text-[11px] text-[var(--muted)]">
                            Originally {dateLabel(item.originalScheduledDate)}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <strong className="text-xs">{money(item.amount, item.currency)}</strong>
                      <span
                        className={`rounded-full px-2 py-1 text-[11px] font-semibold ${statusStyle(item.state)}`}
                      >
                        {statusLabel(item.state)}
                      </span>
                      {item.state === "recorded" && item.expenseId ? (
                        <Link
                          className={secondary}
                          href={`/workspace?bucket=${bucket.id}&view=expense&expense=${item.expenseId}`}
                        >
                          View expense <ArrowRight size={12} />
                        </Link>
                      ) : item.state === "scheduled" &&
                        selected.isCreator &&
                        bucket.status === "active" ? (
                        <>
                          <button
                            className={secondary}
                            onClick={() => {
                              setTarget(item);
                              setDialog("reschedule");
                            }}
                          >
                            Reschedule
                          </button>
                          <button
                            className={secondary}
                            onClick={() => {
                              setTarget(item);
                              setDialog("skip");
                            }}
                          >
                            Skip
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty text="Installment setup is processing. The daily worker resumes remaining dates." />
            )}
            {installmentCursor && (
              <button
                type="button"
                className={`${secondary} mt-4`}
                disabled={busy}
                onClick={() => void loadMoreInstallments()}
              >
                {busy ? "Loading…" : "Load more installments"}
              </button>
            )}
          </section>
        </>
      ) : (
        <Notice>This plan is unavailable.</Notice>
      )}

      {(dialog === "add" || dialog === "edit") && (
        <Dialog
          title={dialog === "edit" ? "Edit EMI plan" : "Add EMI plan"}
          subtitle="Installments become scheduled commitments and enter spending after their due dates are
            processed."
          onClose={() => {
            setDialog(null);
            setError("");
          }}
        >
          <form
            onSubmit={savePlan}
            className="max-h-[70vh] space-y-4 overflow-y-auto px-1 pb-1 text-xs"
          >
            <Field label="Plan title">
              <input
                required
                maxLength={160}
                className={field}
                value={form.title}
                onChange={(event) => update("title", event.target.value)}
                placeholder="e.g. Living room air conditioner"
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Installment amount">
                <input
                  required
                  type="number"
                  min="0.01"
                  step="0.01"
                  className={field}
                  value={form.installmentAmount}
                  onChange={(event) => update("installmentAmount", event.target.value)}
                />
              </Field>
              <Field label="Currency">
                <Dropdown
                  value={form.currency}
                  onValueChange={(value) => update("currency", value)}
                  options={currencies.map((item) => ({ value: item.code, label: item.code }))}
                />
              </Field>
            </div>
            {dialog === "add" && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Total installments">
                  <input
                    required
                    type="number"
                    min={1}
                    max={120}
                    className={field}
                    value={form.totalInstallments}
                    onChange={(event) => update("totalInstallments", event.target.value)}
                  />
                </Field>
                <Field label="Previously paid">
                  <input
                    required
                    type="number"
                    min={0}
                    max={119}
                    className={field}
                    value={form.previouslyPaidCount}
                    onChange={(event) => update("previouslyPaidCount", event.target.value)}
                  />
                </Field>
                <Field label="First installment">
                  <input
                    required
                    type="date"
                    className={field}
                    value={form.firstInstallmentDate}
                    onInput={(event) => update("firstInstallmentDate", event.currentTarget.value)}
                    onChange={(event) => update("firstInstallmentDate", event.target.value)}
                  />
                </Field>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Category">
                <Dropdown
                  value={form.categoryId}
                  onValueChange={(value) => update("categoryId", value)}
                  options={(options?.categories ?? []).map((item) => ({
                    value: item.id,
                    label: item.name,
                  }))}
                />
              </Field>
              <Field label="Payment account">
                <Dropdown
                  value={form.accountId}
                  onValueChange={(value) => update("accountId", value)}
                  options={(options?.accounts ?? []).map((item) => ({
                    value: item.id,
                    label: item.name,
                  }))}
                />
              </Field>
              <Field label="Platform">
                <Dropdown
                  value={form.platformId}
                  onValueChange={(value) => update("platformId", value)}
                  options={(options?.platforms ?? []).map((item) => ({
                    value: item.id,
                    label: item.name,
                  }))}
                />
              </Field>
              <Field label="Payment mode">
                <Dropdown
                  value={form.paymentMode}
                  onValueChange={(value) => update("paymentMode", value)}
                  options={modes}
                />
              </Field>
              <Field label="Paid by">
                <Dropdown
                  value={form.paidByUserId}
                  onValueChange={(value) => update("paidByUserId", value)}
                  options={(options?.members ?? []).map((item) => ({
                    value: item.id,
                    label: item.displayName,
                  }))}
                />
              </Field>
            </div>
            {(dialog === "add" || dialog === "edit") && (
              <div className="rounded-lg bg-[var(--soft)] p-3">
                <button
                  type="button"
                  className="text-xs font-semibold text-[var(--green)]"
                  onClick={() => void showPreview()}
                >
                  {dialog === "edit"
                    ? "Preview affected installments"
                    : "Preview installment dates"}
                </button>
                {preview.length > 0 && (
                  <div className="mt-2 text-[11px] text-[var(--muted)]">
                    <p>
                      {preview.length} remaining · {dateLabel(preview[0].date)} to{" "}
                      {dateLabel(preview.at(-1)!.date)}. The monthly anchor returns after shorter
                      months.
                    </p>
                    <ol className="mt-2 max-h-32 overflow-y-auto rounded-md border border-[var(--line)] bg-[var(--surface)] p-2">
                      {preview.map((item) => (
                        <li key={item.number} className="flex justify-between gap-3 py-0.5">
                          <span>Installment #{item.number}</span>
                          <span>{dateLabel(item.date)}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {correctionPreview && (
                  <div className="mt-2 text-[11px] text-[var(--muted)]">
                    <p>
                      {correctionPreview.affectedCount} scheduled installments will change.
                      {correctionPreview.remainingUngenerated > 0 &&
                        ` ${correctionPreview.remainingUngenerated} later installments will use the new defaults.`}
                      {" Recorded and unpaid history will stay unchanged."}
                    </p>
                    {correctionPreview.affected.length > 0 && (
                      <ol className="mt-2 max-h-32 overflow-y-auto rounded-md border border-[var(--line)] bg-[var(--surface)] p-2">
                        {correctionPreview.affected.map((item) => (
                          <li key={item.id} className="flex justify-between gap-3 py-0.5">
                            <span>Installment #{item.number}</span>
                            <span>{dateLabel(item.date)}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </div>
            )}
            {error && <Notice>{error}</Notice>}
            <div className="flex justify-end gap-2 border-t border-[var(--line)] pt-4">
              <button type="button" className={secondary} onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button
                type="submit"
                className={primary}
                disabled={busy || !options?.categories.length || !options.accounts.length}
              >
                {busy ? "Saving…" : dialog === "edit" ? "Save changes" : "Create EMI plan"}{" "}
                <ArrowRight size={14} />
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {dialog === "end" && selected && (
        <Dialog
          title="End this EMI plan?"
          subtitle="Future installments will be canceled. Recorded and unpaid history stays visible."
          onClose={() => setDialog(null)}
        >
          {error && <Notice>{error}</Notice>}
          <div className="flex justify-end gap-2">
            <button className={secondary} onClick={() => setDialog(null)}>
              Keep plan
            </button>
            <button className={primary} disabled={busy} onClick={() => void endPlan()}>
              End plan
            </button>
          </div>
        </Dialog>
      )}
      {dialog === "skip" && target && (
        <Dialog
          title={`Skip installment #${target.number}?`}
          subtitle="Skipping creates no spending. This installment remains visible as unpaid."
          onClose={() => setDialog(null)}
        >
          {error && <Notice>{error}</Notice>}
          <div className="flex justify-end gap-2">
            <button className={secondary} onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button className={primary} disabled={busy} onClick={() => void changeEntry("skip")}>
              <SkipForward size={14} /> Skip installment
            </button>
          </div>
        </Dialog>
      )}
      {dialog === "reschedule" && target && (
        <Dialog
          title={`Reschedule installment #${target.number}`}
          subtitle="Adjust the date for this installment."
          onClose={() => setDialog(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              void changeEntry("reschedule", new FormData(form).get("expenseDate")?.toString());
            }}
          >
            <Field label="New date">
              <input
                name="expenseDate"
                type="date"
                required
                defaultValue={target.scheduledDate}
                className={field}
              />
            </Field>
            <p className="mt-2 text-xs text-[var(--muted)]">
              Other installments keep their original schedule.
            </p>
            {error && <Notice>{error}</Notice>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={secondary} onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="submit" className={primary} disabled={busy}>
                <RotateCcw size={14} /> Save date
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {dialog === "review" && reviewTarget && (
        <Dialog
          title="Review overdue expense"
          subtitle="Choose whether it should enter actual spending."
          onClose={() => setDialog(null)}
        >
          <p className="mb-4 text-xs text-[var(--muted)]">
            {reviewTarget.description} was due during a bucket archive. Choose whether it should
            enter actual spending. A conversion must be resolved before posting.
          </p>
          {reviewTarget.conversionStatus === "missing" && (
            <Link
              className={`${secondary} mb-4`}
              href={`/workspace?bucket=${bucket.id}&view=expense&expense=${reviewTarget.id}&resolve=1`}
            >
              Resolve conversion <ArrowRight size={13} />
            </Link>
          )}
          {error && <Notice>{error}</Notice>}
          <div className="flex flex-wrap justify-end gap-2">
            <button className={secondary} onClick={() => setDialog(null)}>
              Decide later
            </button>
            <button
              className={secondary}
              disabled={busy}
              onClick={() => void resolveReview("cancel")}
            >
              Cancel entry
            </button>
            <button
              className={primary}
              disabled={busy || reviewTarget.conversionStatus === "missing"}
              onClick={() => void resolveReview("post")}
            >
              Post expense
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Summary({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className={`${card} min-w-0 max-[767px]:p-3`}>
      <div className="mb-3 flex items-center justify-between text-[var(--green)]">
        {icon}
        <ArrowRight size={13} className="text-[var(--muted)]" />
      </div>
      <p className="text-[11px] font-medium text-[var(--muted)]">{label}</p>
      <strong className="mt-1 block break-words text-xl text-[var(--ink)] max-[767px]:text-lg">
        {value}
      </strong>
      <p className="mt-1 text-[11px] text-[var(--muted)]">{detail}</p>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-semibold text-[var(--ink)]">{label}</span>
      {children}
    </label>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--line)] p-10 text-center text-xs text-[var(--muted)]">
      <CalendarDays size={23} className="text-[var(--green)]" />
      {text}
    </div>
  );
}
