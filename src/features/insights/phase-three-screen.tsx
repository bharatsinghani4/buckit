"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  Pencil,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  TrendingDown,
  TrendingUp,
  Wallet,
  CreditCard,
  X,
  BookOpen,
} from "lucide-react";
import { Dropdown } from "@/components/dropdown";
import { controls } from "@/components/control-styles";
import { Dialog, Notice, Pending } from "@/components/ui";
import { useWorkspaceData } from "@/features/buckets/workspace-data-context";
import type { Bucket } from "@/features/identity/contracts";
import type { Member, Option } from "@/features/expenses/contracts";
import { api, friendlyError } from "@/lib/api/client";
import type { Budget, BudgetUsage, SpendingGroup, SpendingReport } from "./contracts";

type View = "dashboard" | "reports" | "budgets" | "budget" | "budget-form";
type BudgetEntry = { budget: Budget; usage: BudgetUsage };
type Dashboard = SpendingReport & {
  comparable: { from: string; toExclusive: string; totalAmount: string };
  categories: SpendingGroup[];
  members: SpendingGroup[];
  trend: SpendingGroup[];
  budgets: BudgetEntry[];
  budgetCount: number;
  emi: {
    activePlans: number;
    upcomingInstallments: number;
    unpaidInstallments: number;
    nextDate: string | null;
  };
  recentExpenses: {
    id: string;
    description: string;
    date: string;
    category: string;
    amount: string | null;
    status: string;
  }[];
  stale: boolean;
};

const card =
  "rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]";
const secondary = controls.secondary;
const primary = controls.primary;
const field = controls.input;
const thresholds = ["50", "75", "85", "90", "95", "100"];

function url(bucketId: string, view: View, extra = "") {
  return `/workspace?bucket=${bucketId}${view === "dashboard" ? "" : `&view=${view}`}${extra}`;
}

function money(value: string | null, currency: string) {
  return value === null
    ? "Conversion needed"
    : new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(value));
}

function percent(value: number) {
  return `${Math.round(value * 10) / 10}%`;
}

function shiftDay(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function progress(value: number, warning = false) {
  return (
    <div
      className="h-2.5 overflow-hidden rounded-full bg-[var(--soft)]"
      role="meter"
      aria-valuenow={Math.min(100, Math.max(0, Math.round(value)))}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full ${warning ? "bg-[var(--error)]" : "bg-[var(--green)]"}`}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

function BudgetCard({
  entry,
  bucketId,
  currency,
}: {
  entry: BudgetEntry;
  bucketId: string;
  currency: string;
}) {
  const { budget, usage } = entry;
  return (
    <Link
      href={url(bucketId, "budget", `&budget=${budget.id}`)}
      className={`${card} block transition hover:border-[var(--green)] hover:shadow-lg`}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <span className="mb-2 inline-block rounded bg-[var(--soft)] px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-[var(--green)]">
            {budget.state === "historical"
              ? "Historical · read only"
              : budget.scope === "shared"
                ? "Shared pool"
                : "Member budget"}
          </span>
          <h3 className="text-base font-bold text-[var(--ink)]">{budget.name}</h3>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {budget.scope === "shared" ? "Owner managed" : `Created by ${budget.ownerName}`}
          </p>
        </div>
        <ChevronRight size={18} className="shrink-0 text-[var(--muted)]" />
      </div>
      <div className="mb-3 flex items-end justify-between gap-2">
        <div>
          <span className="text-xs text-[var(--muted)]">Allocated limit</span>
          <p className="text-lg font-bold text-[var(--ink)]">
            {money(budget.limitAmount, currency)}
          </p>
        </div>
        <div className="text-right">
          <span className="text-xs text-[var(--muted)]">Spent to date</span>
          <p className="text-sm font-semibold text-[var(--ink)]">
            {money(usage.usedAmount, currency)}
          </p>
        </div>
      </div>
      {progress(usage.usagePercent, usage.usagePercent >= 100)}
      <div className="mt-2 flex justify-between text-[11px] text-[var(--muted)]">
        <span>{percent(usage.usagePercent)} used</span>
        <span>{money(usage.remainingAmount, currency)} remaining</span>
      </div>
      <div className="mt-4 border-t border-[var(--line)] pt-3 text-xs text-[var(--muted)]">
        {budget.categoryNames.join(", ")} ·{" "}
        {budget.periodType === "monthly"
          ? "Resets every month"
          : `${budget.from} to ${shiftDay(budget.toExclusive!, -1)}`}
      </div>
      {usage.incompleteCount > 0 && (
        <p className="mt-2 flex items-center gap-1 text-xs text-[var(--error)]">
          <CircleAlert size={13} /> {usage.incompleteCount} conversion needed
        </p>
      )}
    </Link>
  );
}

export function PhaseThreeScreen({
  bucket,
  view,
  budgetId,
}: {
  bucket: Bucket;
  view: View;
  budgetId: string | null;
}) {
  const { read, peek, invalidate } = useWorkspaceData();
  const [period, setPeriod] = useState("month");
  const [anchor, setAnchor] = useState(() => new Date().toISOString().slice(0, 10));
  const [customFrom, setCustomFrom] = useState(() => `${new Date().toISOString().slice(0, 7)}-01`);
  const [customTo, setCustomTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [groupBy, setGroupBy] = useState("category");
  const [filterOpen, setFilterOpen] = useState(false);
  const [reportFilters, setReportFilters] = useState<Record<string, string>>({});
  const [reportOptions, setReportOptions] = useState<{
    categories: Option[];
    accounts: Option[];
    platforms: Option[];
    members: Member[];
  }>({ categories: [], accounts: [], platforms: [], members: [] });
  const [budgetTab, setBudgetTab] = useState("all");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [report, setReport] = useState<SpendingReport | null>(null);
  const [budgets, setBudgets] = useState<BudgetEntry[]>([]);
  const [budgetLoaded, setBudgetLoaded] = useState(false);
  const [categories, setCategories] = useState<Option[]>([]);
  const [categoryFetched, setCategoryFetched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [scope, setScope] = useState<"shared" | "member">(bucket.isOwner ? "shared" : "member");
  const [periodType, setPeriodType] = useState<"monthly" | "custom">("monthly");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedThresholds, setSelectedThresholds] = useState<string[]>([]);
  const [customThreshold, setCustomThreshold] = useState("");
  const requestToken = useRef(0);
  const selected = budgets.find((entry) => entry.budget.id === budgetId);
  const editing = view === "budget-form" && Boolean(budgetId);

  const month = anchor.slice(0, 7);
  const query = new URLSearchParams({ period, anchorDate: anchor });
  if (period === "custom" && customFrom && customTo) {
    query.set("from", customFrom);
    query.set("toExclusive", shiftDay(customTo, 1));
  }
  const dashboardPath = `buckets/${bucket.id}/dashboard?${query}`;
  query.set("groupBy", groupBy);
  for (const [key, value] of Object.entries(reportFilters))
    if (value && value !== "all") query.set(key, value);
  const reportPath = `buckets/${bucket.id}/reports/spending?${query}`;
  const budgetPath = `buckets/${bucket.id}/budgets?month=${month}`;

  const load = useCallback(
    async (path: string, kind: "dashboard" | "report" | "budgets") => {
      const token = ++requestToken.current;
      setError("");
      setLoading(!peek(path));
      try {
        if (kind === "dashboard") {
          const result = await read<Dashboard>(path);
          if (token === requestToken.current) setDashboard(result.data);
        } else if (kind === "report") {
          const result = await read<SpendingReport>(path);
          if (token === requestToken.current) setReport(result.data);
        } else {
          const result = await read<BudgetEntry[]>(path);
          if (token === requestToken.current) {
            setBudgets(result.data);
            setBudgetLoaded(true);
          }
        }
      } catch (failure) {
        if (token === requestToken.current) setError(friendlyError(failure));
      } finally {
        if (token === requestToken.current) setLoading(false);
      }
    },
    [peek, read],
  );

  useEffect(() => {
    if (view === "budget-form" && !budgetId) return;
    const path =
      view === "dashboard" ? dashboardPath : view === "reports" ? reportPath : budgetPath;
    const kind = view === "dashboard" ? "dashboard" : view === "reports" ? "report" : "budgets";
    queueMicrotask(() => {
      void load(path, kind);
    });
  }, [view, budgetId, dashboardPath, reportPath, budgetPath, load]);

  useEffect(() => {
    if (view !== "budget-form") return;
    void read<Option[]>(`buckets/${bucket.id}/categories`)
      .then((result) => {
        setCategories(result.data);
        setCategoryFetched(true);
      })
      .catch((failure) => {
        setError(friendlyError(failure));
        setCategoryFetched(true);
      });
  }, [bucket.id, read, view]);

  useEffect(() => {
    if (view !== "reports" || !filterOpen) return;
    void Promise.all([
      read<Option[]>(`buckets/${bucket.id}/categories`),
      read<Option[]>(`buckets/${bucket.id}/accounts`),
      read<Option[]>(`buckets/${bucket.id}/platforms`),
      read<Member[]>(`buckets/${bucket.id}/members`),
    ])
      .then(([categoryResult, accountResult, platformResult, memberResult]) =>
        setReportOptions({
          categories: categoryResult.data,
          accounts: accountResult.data,
          platforms: platformResult.data,
          members: memberResult.data,
        }),
      )
      .catch((failure) => setError(friendlyError(failure)));
  }, [bucket.id, filterOpen, read, view]);

  useEffect(() => {
    if (!editing || !selected) return;
    queueMicrotask(() => {
      setScope(selected.budget.scope);
      setPeriodType(selected.budget.periodType);
      setSelectedCategories(selected.budget.categoryIds);
      setSelectedThresholds(selected.budget.thresholdPercentages);
    });
  }, [editing, selected]);

  useEffect(() => {
    if (view !== "budget-form" || budgetId) return;
    queueMicrotask(() => {
      setScope(bucket.isOwner ? "shared" : "member");
      setPeriodType("monthly");
      setSelectedCategories([]);
      setSelectedThresholds([]);
      setCustomThreshold("");
    });
  }, [view, budgetId, bucket.isOwner]);

  function afterMutation() {
    invalidate(`buckets/${bucket.id}/budgets`);
    invalidate(`buckets/${bucket.id}/dashboard`);
    setBusy(false);
  }

  function addCustomThreshold() {
    const value = Number(customThreshold);
    if (!Number.isFinite(value) || value <= 0 || value > 100) {
      setError("Enter a threshold greater than 0 and no more than 100%.");
      return;
    }
    const canonical = String(value);
    setSelectedThresholds((values) =>
      values.includes(canonical) ? values : [...values, canonical],
    );
    setCustomThreshold("");
    setError("");
  }

  async function saveBudget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      name: String(form.get("name") ?? "").trim(),
      ...(editing ? {} : { scope }),
      categoryIds: selectedCategories,
      limitAmount: String(form.get("limitAmount") ?? ""),
      periodType,
      ...(periodType === "custom"
        ? { from: String(form.get("from")), toExclusive: shiftDay(String(form.get("to")), 1) }
        : {}),
      thresholdPercentages: selectedThresholds,
    };
    setBusy(true);
    setError("");
    try {
      await api<Budget>(`buckets/${bucket.id}/budgets${editing ? `/${budgetId}` : ""}`, {
        method: editing ? "PATCH" : "POST",
        body,
        revision: editing ? selected?.budget.revision : undefined,
        key: crypto.randomUUID(),
      });
      afterMutation();
      window.history.pushState(null, "", url(bucket.id, "budgets"));
      void load(budgetPath, "budgets");
    } catch (failure) {
      setBusy(false);
      setError(friendlyError(failure));
    }
  }

  async function deleteBudget() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await api(`buckets/${bucket.id}/budgets/${selected.budget.id}`, {
        method: "DELETE",
        revision: selected.budget.revision,
        key: crypto.randomUUID(),
      });
      setDeleteOpen(false);
      setBudgets((entries) => entries.filter((entry) => entry.budget.id !== selected.budget.id));
      afterMutation();
      window.history.pushState(null, "", url(bucket.id, "budgets"));
    } catch (failure) {
      setBusy(false);
      setError(friendlyError(failure));
    }
  }

  const currency = bucket.primaryCurrency;
  const visibleBudgets = budgets.filter(
    (entry) =>
      budgetTab === "all" ||
      (budgetTab === "shared" ? entry.budget.scope === "shared" : entry.budget.scope === "member"),
  );
  const actual = Number(dashboard?.totalAmount ?? "0");
  const previous = Number(dashboard?.comparable.totalAmount ?? "0");
  const change = previous ? ((actual - previous) / Math.abs(previous)) * 100 : null;

  return (
    <div className="mx-auto max-w-[1440px] space-y-5 pb-10">
      {error && <Notice>{error}</Notice>}
      {!error &&
      ((view === "dashboard" && !dashboard) ||
        (view === "reports" && !report) ||
        (["budgets", "budget"].includes(view) && !budgetLoaded) ||
        (view === "budget-form" && Boolean(budgetId) && !budgetLoaded)) ? (
        <Pending />
      ) : null}
      {loading &&
        ((view === "dashboard" && dashboard) ||
          (view === "reports" && report) ||
          (view === "budgets" && budgetLoaded)) && (
          <p className="text-xs text-[var(--muted)]">Updating insights…</p>
        )}
      {view === "dashboard" && dashboard && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-[.18em] text-[var(--green)]">
                Bucket overview
              </span>
              <h1 className="mt-1 text-2xl font-bold text-[var(--ink)]">{bucket.name}</h1>
              <p className="mt-1 text-xs text-[var(--muted)]">
                {currency} · {bucket.timezone} · {bucket.memberCount}{" "}
                {bucket.memberCount === 1 ? "member" : "members"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Dropdown
                value={period}
                onValueChange={setPeriod}
                options={[
                  { value: "month", label: "This month" },
                  { value: "quarter", label: "This quarter" },
                  { value: "year", label: "This year" },
                  { value: "custom", label: "Custom range" },
                ]}
              />
              {period === "custom" ? (
                <>
                  <input
                    className={field}
                    type="date"
                    aria-label="From date"
                    value={customFrom}
                    onChange={(event) => setCustomFrom(event.target.value)}
                  />
                  <input
                    className={field}
                    type="date"
                    aria-label="Through date"
                    value={customTo}
                    onChange={(event) => setCustomTo(event.target.value)}
                  />
                </>
              ) : (
                <input
                  className={field}
                  type="date"
                  aria-label="Anchor date"
                  value={anchor}
                  onChange={(event) => setAnchor(event.target.value)}
                />
              )}
            </div>
          </div>
          {dashboard.stale && (
            <Notice kind="info">
              Spending changed while this view loaded. Refresh for the latest totals.
            </Notice>
          )}
          {(dashboard.incompleteCount > 0 || dashboard.pendingCount > 0) && (
            <Notice kind="info">
              <CircleAlert size={16} /> Totals are incomplete: {dashboard.incompleteCount} need
              conversion and {dashboard.pendingCount} await processing.
            </Notice>
          )}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className={card}>
              <p className="text-xs text-[var(--muted)]">Actual spending</p>
              <p className="mt-2 text-2xl font-bold text-[var(--ink)]">
                {money(dashboard.totalAmount, currency)}
              </p>
              <p className="mt-2 text-xs text-[var(--muted)]">
                {dashboard.actualCount} posted entries
              </p>
            </div>
            <div className={card}>
              <p className="text-xs text-[var(--muted)]">Previous equivalent period</p>
              <p className="mt-2 text-2xl font-bold text-[var(--ink)]">
                {money(dashboard.comparable.totalAmount, currency)}
              </p>
              <p className="mt-2 flex items-center gap-1 text-xs text-[var(--muted)]">
                {change === null ? (
                  "No comparison yet"
                ) : (
                  <>
                    {change >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                    {percent(Math.abs(change))} {change >= 0 ? "higher" : "lower"}
                  </>
                )}
              </p>
            </div>
            <div className={card}>
              <p className="text-xs text-[var(--muted)]">Scheduled separately</p>
              <p className="mt-2 text-2xl font-bold text-[var(--ink)]">
                {money(dashboard.scheduledAmount, currency)}
              </p>
              <p className="mt-2 text-xs text-[var(--muted)]">
                {dashboard.scheduledCount} future entries · estimate
              </p>
            </div>
            <div className={card}>
              <p className="text-xs text-[var(--muted)]">Active budgets</p>
              <p className="mt-2 text-2xl font-bold text-[var(--ink)]">{dashboard.budgetCount}</p>
              <Link
                href={url(bucket.id, "budgets")}
                className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[var(--green)]"
              >
                Manage budgets <ArrowRight size={12} />
              </Link>
            </div>
          </div>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)]">
            <section className={card}>
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-[var(--ink)]">Spending by category</h2>
                  <p className="text-xs text-[var(--muted)]">Posted, finalized entries only</p>
                </div>
                <Link
                  href={url(bucket.id, "reports")}
                  className="text-xs font-semibold text-[var(--green)]"
                >
                  View report
                </Link>
              </div>
              {dashboard.categories.length ? (
                dashboard.categories.slice(0, 6).map((group) => (
                  <div
                    key={group.id}
                    className="mb-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-xs"
                  >
                    <span className="truncate text-[var(--ink)]">{group.name}</span>
                    <strong className="text-[var(--ink)]">{money(group.amount, currency)}</strong>
                    <div className="col-span-2">
                      {progress(actual ? (Number(group.amount) / actual) * 100 : 0)}
                    </div>
                  </div>
                ))
              ) : (
                <p className="py-8 text-center text-xs text-[var(--muted)]">
                  Add a posted expense to see your categories.
                </p>
              )}
            </section>
            <section className={card}>
              <h2 className="text-base font-bold text-[var(--ink)]">Member spending</h2>
              <p className="mb-4 text-xs text-[var(--muted)]">
                Who recorded the payment, without splitting or debts.
              </p>
              {dashboard.members.length ? (
                dashboard.members.slice(0, 6).map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center justify-between gap-3 border-t border-[var(--line)] py-3 text-xs"
                  >
                    <span className="truncate text-[var(--ink)]">{member.name}</span>
                    <strong>{money(member.amount, currency)}</strong>
                  </div>
                ))
              ) : (
                <p className="py-8 text-center text-xs text-[var(--muted)]">
                  Member spending will appear after the first expense.
                </p>
              )}
            </section>
            <section className={card}>
              <h2 className="text-base font-bold text-[var(--ink)]">Spending trajectory</h2>
              <p className="mb-4 text-xs text-[var(--muted)]">
                Actual spending by day in this period
              </p>
              {dashboard.trend.length ? (
                <div
                  className="flex h-36 items-end gap-1"
                  role="img"
                  aria-label="Daily spending chart"
                >
                  {dashboard.trend.map((point) => (
                    <div
                      key={point.id}
                      className="group relative min-w-1 flex-1 rounded-t bg-[var(--green)]/70 hover:bg-[var(--green)]"
                      style={{
                        height: `${Math.max(4, Math.min(100, (Number(point.amount) / Math.max(...dashboard.trend.map((day) => Math.abs(Number(day.amount))), 1)) * 100))}%`,
                      }}
                      title={`${point.name}: ${money(point.amount, currency)}`}
                    />
                  ))}
                </div>
              ) : (
                <p className="py-8 text-center text-xs text-[var(--muted)]">
                  No posted spending in this period.
                </p>
              )}
            </section>
            <section className={card}>
              <div className="mb-4 flex justify-between">
                <div>
                  <h2 className="text-base font-bold text-[var(--ink)]">Active budgets</h2>
                  <p className="text-xs text-[var(--muted)]">Usage and remaining limit</p>
                </div>
                <Link
                  href={url(bucket.id, "budgets")}
                  className="text-xs font-semibold text-[var(--green)]"
                >
                  Manage
                </Link>
              </div>
              {dashboard.budgets.length ? (
                dashboard.budgets.map((entry) => (
                  <div key={entry.budget.id} className="mb-4">
                    <div className="mb-1 flex justify-between gap-2 text-xs">
                      <span className="truncate font-semibold text-[var(--ink)]">
                        {entry.budget.name}
                      </span>
                      <span className="text-[var(--muted)]">
                        {percent(entry.usage.usagePercent)}
                      </span>
                    </div>
                    {progress(entry.usage.usagePercent, entry.usage.usagePercent >= 100)}
                    <p className="mt-1 text-[11px] text-[var(--muted)]">
                      {money(entry.usage.remainingAmount, currency)} remaining
                    </p>
                  </div>
                ))
              ) : (
                <p className="py-8 text-center text-xs text-[var(--muted)]">
                  Create a budget to track a spending limit.
                </p>
              )}
            </section>
            <section className={card}>
              <div className="mb-3 flex justify-between">
                <div>
                  <h2 className="text-base font-bold text-[var(--ink)]">Ledger activity</h2>
                  <p className="text-xs text-[var(--muted)]">Recent bucket entries</p>
                </div>
                <Link
                  href={url(bucket.id, "dashboard").replace(/$/, "&view=expenses")}
                  className="text-xs font-semibold text-[var(--green)]"
                >
                  View all
                </Link>
              </div>
              {dashboard.recentExpenses.length ? (
                dashboard.recentExpenses.map((entry) => (
                  <Link
                    key={entry.id}
                    href={`/workspace?bucket=${bucket.id}&view=expense&expense=${entry.id}`}
                    className="flex justify-between gap-2 border-t border-[var(--line)] py-3 text-xs hover:text-[var(--green)]"
                  >
                    <div>
                      <p className="font-semibold">{entry.description}</p>
                      <p className="text-[var(--muted)]">
                        {entry.date} · {entry.category} · {entry.status.replaceAll("_", " ")}
                      </p>
                    </div>
                    <strong className="shrink-0">{money(entry.amount, currency)}</strong>
                  </Link>
                ))
              ) : (
                <p className="py-8 text-center text-xs text-[var(--muted)]">
                  No ledger activity yet.
                </p>
              )}
            </section>
            <section className={`${card} md:col-span-2`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="rounded-lg bg-[var(--soft)] p-2.5 text-[var(--green)]">
                    <CreditCard size={19} />
                  </span>
                  <div>
                    <h2 className="text-sm font-bold text-[var(--ink)]">EMI commitments</h2>
                    <p className="text-xs text-[var(--muted)]">
                      Scheduled installments are separate from actual spending.
                    </p>
                  </div>
                </div>
                <Link
                  href={`/workspace?bucket=${bucket.id}&view=emis`}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--green)]"
                >
                  View plans <ArrowRight size={14} />
                </Link>
              </div>
              <div className="mt-4 grid gap-3 border-t border-[var(--line)] pt-4 sm:grid-cols-3">
                <div>
                  <p className="text-[11px] text-[var(--muted)]">Active plans</p>
                  <strong className="mt-1 block text-lg">{dashboard.emi.activePlans}</strong>
                </div>
                <div>
                  <p className="text-[11px] text-[var(--muted)]">Upcoming installments</p>
                  <strong className="mt-1 block text-lg">
                    {dashboard.emi.upcomingInstallments}
                  </strong>
                </div>
                <div>
                  <p className="text-[11px] text-[var(--muted)]">Unpaid obligations</p>
                  <strong className="mt-1 block text-lg">{dashboard.emi.unpaidInstallments}</strong>
                </div>
              </div>
            </section>
          </div>
        </>
      )}
      {view === "reports" && report && (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-[.18em] text-[var(--green)]">
                Spending insights
              </span>
              <h1 className="mt-1 text-2xl font-bold text-[var(--ink)]">Reports</h1>
              <p className="mt-1 text-xs text-[var(--muted)]">
                Explore finalized spending without double-counting overlapping budgets.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Dropdown
                value={period}
                onValueChange={setPeriod}
                options={[
                  { value: "month", label: "Month" },
                  { value: "quarter", label: "Quarter" },
                  { value: "year", label: "Year" },
                  { value: "custom", label: "Custom range" },
                ]}
              />
              {period === "custom" ? (
                <>
                  <input
                    className={field}
                    type="date"
                    aria-label="From date"
                    value={customFrom}
                    onChange={(event) => setCustomFrom(event.target.value)}
                  />
                  <input
                    className={field}
                    type="date"
                    aria-label="Through date"
                    value={customTo}
                    onChange={(event) => setCustomTo(event.target.value)}
                  />
                </>
              ) : (
                <input
                  className={field}
                  type="date"
                  aria-label="Anchor date"
                  value={anchor}
                  onChange={(event) => setAnchor(event.target.value)}
                />
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={secondary}
              onClick={() => setFilterOpen((open) => !open)}
              aria-expanded={filterOpen}
            >
              <SlidersHorizontal size={14} /> Filters
            </button>
            {Object.values(reportFilters).some((value) => value && value !== "all") && (
              <button
                type="button"
                className="text-xs font-semibold text-[var(--green)]"
                onClick={() => setReportFilters({})}
              >
                Clear filters
              </button>
            )}
          </div>
          {filterOpen && (
            <div className={`${card} grid gap-3 sm:grid-cols-2 xl:grid-cols-5`}>
              {(
                [
                  ["categoryId", "Category", reportOptions.categories],
                  ["accountId", "Account", reportOptions.accounts],
                  ["platformId", "Platform", reportOptions.platforms],
                ] as const
              ).map(([key, label, options]) => (
                <label key={key} className="text-xs font-semibold">
                  {label}
                  <div className="mt-1">
                    <Dropdown
                      value={reportFilters[key] ?? "all"}
                      onValueChange={(value) =>
                        setReportFilters((current) => ({ ...current, [key]: value }))
                      }
                      options={[
                        {
                          value: "all",
                          label:
                            key === "categoryId" ? "All categories" : `All ${label.toLowerCase()}s`,
                        },
                        ...options.map((option) => ({ value: option.id, label: option.name })),
                      ]}
                    />
                  </div>
                </label>
              ))}
              <label className="text-xs font-semibold">
                Paid by
                <div className="mt-1">
                  <Dropdown
                    value={reportFilters.paidByUserId ?? "all"}
                    onValueChange={(value) =>
                      setReportFilters((current) => ({ ...current, paidByUserId: value }))
                    }
                    options={[
                      { value: "all", label: "All members" },
                      ...reportOptions.members.map((member) => ({
                        value: member.id,
                        label: member.displayName,
                      })),
                    ]}
                  />
                </div>
              </label>
              <label className="text-xs font-semibold">
                Payment mode
                <div className="mt-1">
                  <Dropdown
                    value={reportFilters.paymentMode ?? "all"}
                    onValueChange={(value) =>
                      setReportFilters((current) => ({ ...current, paymentMode: value }))
                    }
                    options={[
                      { value: "all", label: "All modes" },
                      { value: "upi", label: "UPI" },
                      { value: "cash", label: "Cash" },
                      { value: "neft", label: "NEFT" },
                      { value: "imps", label: "IMPS" },
                      { value: "credit_card", label: "Credit card" },
                    ]}
                  />
                </div>
              </label>
            </div>
          )}
          {(report.incompleteCount > 0 || report.pendingCount > 0) && (
            <Notice kind="info">
              This report excludes {report.incompleteCount} entries needing conversion and{" "}
              {report.pendingCount} pending entries.
            </Notice>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className={card}>
              <p className="text-xs text-[var(--muted)]">Actual spending</p>
              <p className="mt-2 text-2xl font-bold">{money(report.totalAmount, currency)}</p>
            </div>
            <div className={card}>
              <p className="text-xs text-[var(--muted)]">Posted entries</p>
              <p className="mt-2 text-2xl font-bold">{report.actualCount}</p>
            </div>
            <div className={card}>
              <p className="text-xs text-[var(--muted)]">Scheduled separately</p>
              <p className="mt-2 text-2xl font-bold">{money(report.scheduledAmount, currency)}</p>
            </div>
          </div>
          <section className={card}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold">Breakdown</h2>
                <p className="text-xs text-[var(--muted)]">
                  {report.from} to {shiftDay(report.toExclusive, -1)} · {report.currency}
                </p>
              </div>
              <Dropdown
                value={groupBy}
                onValueChange={setGroupBy}
                options={[
                  { value: "category", label: "Category" },
                  { value: "account", label: "Account" },
                  { value: "platform", label: "Platform" },
                  { value: "payment_mode", label: "Payment mode" },
                  { value: "member", label: "Member" },
                  { value: "day", label: "Day" },
                  { value: "month", label: "Month" },
                ]}
              />
            </div>
            {report.groups.length ? (
              report.groups.map((group) => (
                <div
                  key={group.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 border-t border-[var(--line)] py-3 text-xs"
                >
                  <span className="truncate font-semibold">{group.name}</span>
                  <span className="text-[var(--muted)]">{group.count} entries</span>
                  <strong>{money(group.amount, currency)}</strong>
                </div>
              ))
            ) : (
              <p className="py-10 text-center text-xs text-[var(--muted)]">
                No posted expenses in this period. Change the period or add an expense.
              </p>
            )}
          </section>
        </>
      )}
      {view === "budgets" && budgetLoaded && (
        <>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-[.18em] text-[var(--green)]">
                Money planning · budgets
              </span>
              <h1 className="mt-1 text-2xl font-bold">Budgets</h1>
              <p className="mt-1 max-w-2xl text-xs text-[var(--muted)]">
                Budgets are visible to all bucket members. Track shared thresholds or individual
                payer limits across categories with zero rollover.
              </p>
            </div>
            {bucket.status === "active" && (
              <Link className={primary} href={url(bucket.id, "budget-form")}>
                <Plus size={15} /> Create budget
              </Link>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="flex gap-2 border-b border-[var(--line)]">
              {[
                ["all", "All budgets"],
                ["shared", "Shared budgets"],
                ["member", "Member budgets"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`flex items-center gap-2 border-b-2 p-3 !rounded-none !font-semibold ${budgetTab === value ? "border-[var(--ink)] text-[var(--ink)]" : "border-transparent !text-[var(--muted)]"}`}
                  onClick={() => setBudgetTab(value)}
                >
                  <BookOpen size={16} /> {label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
              <CalendarDays size={14} /> Month{" "}
              <input
                className={field}
                type="month"
                value={month}
                onChange={(event) => setAnchor(`${event.target.value}-01`)}
              />
            </label>
          </div>
          {visibleBudgets.length ? (
            <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
              {visibleBudgets.map((entry) => (
                <BudgetCard
                  key={entry.budget.id}
                  entry={entry}
                  bucketId={bucket.id}
                  currency={currency}
                />
              ))}
            </div>
          ) : (
            <section className={`${card} py-12 text-center`}>
              <Wallet className="mx-auto mb-3 text-[var(--green)]" size={30} />
              <h2 className="font-bold">No budgets here yet</h2>
              <p className="mt-2 text-xs text-[var(--muted)]">
                Set a limit for one or more categories. Actual spending will update it
                automatically.
              </p>
              {bucket.status === "active" && (
                <Link href={url(bucket.id, "budget-form")} className={`${primary} mt-4`}>
                  <Plus size={14} /> Create budget
                </Link>
              )}
            </section>
          )}
          <div
            className={`${card} flex flex-wrap items-center justify-between gap-3 bg-[var(--soft)]`}
          >
            <div className="flex items-start gap-3">
              <ShieldCheck size={20} className="shrink-0 text-[var(--green)]" />
              <p className="max-w-3xl text-xs text-[var(--muted)]">
                <strong className="text-[var(--ink)]">How Buckit handles budget overlaps.</strong>{" "}
                Refunds reduce usage. The same expense can affect multiple budgets, but bucket
                spending counts it only once. Monthly limits reset without rollover.
              </p>
            </div>
          </div>
        </>
      )}
      {view === "budget" && selected && (
        <>
          <Link
            className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--green)]"
            href={url(bucket.id, "budgets")}
          >
            <ArrowLeft size={15} /> All budgets
          </Link>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-[.18em] text-[var(--green)]">
                {selected.budget.scope === "shared" ? "Shared budget" : "Member budget"}
              </span>
              <h1 className="mt-1 text-2xl font-bold">{selected.budget.name}</h1>
              <p className="mt-1 text-xs text-[var(--muted)]">
                {selected.budget.categoryNames.join(", ")} ·{" "}
                {selected.budget.periodType === "monthly" ? "Monthly" : "Custom range"}
              </p>
            </div>
            {selected.budget.canManage && bucket.status === "active" && (
              <div className="flex gap-2">
                <Link
                  href={url(bucket.id, "budget-form", `&budget=${budgetId}`)}
                  className={secondary}
                >
                  <Pencil size={14} /> Edit
                </Link>
                <button className={secondary} onClick={() => setDeleteOpen(true)}>
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            )}
          </div>
          {selected.usage.incompleteCount > 0 && (
            <Notice kind="info">
              {selected.usage.incompleteCount} matching expenses need conversion. Usage is
              incomplete until they are resolved.
            </Notice>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className={card}>
              <p className="text-xs text-[var(--muted)]">Allocated limit</p>
              <p className="mt-2 text-2xl font-bold">
                {money(selected.usage.limitAmount, currency)}
              </p>
            </div>
            <div className={card}>
              <p className="text-xs text-[var(--muted)]">Used</p>
              <p className="mt-2 text-2xl font-bold">
                {money(selected.usage.usedAmount, currency)}
              </p>
            </div>
            <div className={card}>
              <p className="text-xs text-[var(--muted)]">
                {Number(selected.usage.exceededAmount) > 0 ? "Exceeded" : "Remaining"}
              </p>
              <p className="mt-2 text-2xl font-bold">
                {money(
                  Number(selected.usage.exceededAmount) > 0
                    ? selected.usage.exceededAmount
                    : selected.usage.remainingAmount,
                  currency,
                )}
              </p>
            </div>
          </div>
          <section className={card}>
            <div className="mb-3 flex justify-between text-xs">
              <span>
                {selected.usage.from} to {shiftDay(selected.usage.toExclusive, -1)}
              </span>
              <strong>{percent(selected.usage.usagePercent)} used</strong>
            </div>
            {progress(selected.usage.usagePercent, selected.usage.usagePercent >= 100)}
            <div className="mt-5 grid gap-4 text-xs sm:grid-cols-2">
              <p>
                <span className="text-[var(--muted)]">Managed by</span>
                <br />
                <strong>{selected.budget.ownerName}</strong>
              </p>
              <p>
                <span className="text-[var(--muted)]">Categories</span>
                <br />
                <strong>{selected.budget.categoryNames.join(", ")}</strong>
              </p>
              <p>
                <span className="text-[var(--muted)]">Alert thresholds</span>
                <br />
                <strong>
                  {selected.budget.thresholdPercentages.length
                    ? selected.budget.thresholdPercentages.map((value) => `${value}%`).join(", ")
                    : "None selected"}
                </strong>
              </p>
              <p>
                <span className="text-[var(--muted)]">Handled this period</span>
                <br />
                <strong>
                  {selected.usage.handledThresholds.length
                    ? selected.usage.handledThresholds
                        .map((item) => `${item.percentage}%`)
                        .join(", ")
                    : "None"}
                </strong>
              </p>
            </div>
          </section>
        </>
      )}
      {view === "budget-form" && (!editing || selected) && (
        <>
          <Link
            className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--green)]"
            href={url(bucket.id, "budgets")}
          >
            <ArrowLeft size={15} /> All budgets
          </Link>
          <div>
            <span className="text-[10px] font-bold uppercase tracking-[.18em] text-[var(--green)]">
              Money planning
            </span>
            <h1 className="mt-1 text-2xl font-bold">
              {editing ? "Edit budget" : "Create a budget"}
            </h1>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Choose which spending this limit follows. Only posted, finalized expenses affect
              usage.
            </p>
          </div>
          <form
            className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(260px,1fr)]"
            onSubmit={saveBudget}
          >
            <section className={`${card} space-y-5`}>
              <h2 className="font-bold">Budget details</h2>
              <label className="block text-xs font-semibold">
                Budget name
                <input
                  className={`${field} mt-2`}
                  name="name"
                  required
                  maxLength={80}
                  defaultValue={selected?.budget.name ?? ""}
                  placeholder="e.g. Groceries & Pantry"
                />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-xs font-semibold">
                  Limit ({currency})
                  <input
                    className={`${field} mt-2`}
                    name="limitAmount"
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    defaultValue={selected?.budget.limitAmount ?? ""}
                    placeholder="0.00"
                  />
                </label>
                <label className="block text-xs font-semibold">
                  Budget type
                  <div className="mt-2">
                    <Dropdown
                      value={scope}
                      onValueChange={(value) => setScope(value as "shared" | "member")}
                      disabled={editing}
                      options={[
                        ...(bucket.isOwner
                          ? [{ value: "shared", label: "Shared · all payers" }]
                          : []),
                        { value: "member", label: "My spending · Paid By me" },
                      ]}
                    />
                  </div>
                </label>
              </div>
              <label className="block text-xs font-semibold">
                Period
                <div className="mt-2">
                  <Dropdown
                    value={periodType}
                    onValueChange={(value) => setPeriodType(value as "monthly" | "custom")}
                    options={[
                      { value: "monthly", label: "Monthly · resets each month" },
                      { value: "custom", label: "Custom date range" },
                    ]}
                  />
                </div>
              </label>
              {periodType === "custom" && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block text-xs font-semibold">
                    Start date
                    <input
                      className={`${field} mt-2`}
                      name="from"
                      type="date"
                      required
                      defaultValue={selected?.budget.from ?? ""}
                    />
                  </label>
                  <label className="block text-xs font-semibold">
                    End date
                    <input
                      className={`${field} mt-2`}
                      name="to"
                      type="date"
                      required
                      defaultValue={
                        selected?.budget.toExclusive
                          ? shiftDay(selected.budget.toExclusive, -1)
                          : ""
                      }
                    />
                  </label>
                </div>
              )}
              <div>
                <p className="mb-2 text-xs font-semibold">
                  Categories{" "}
                  <span className="font-normal text-[var(--muted)]">· select one or more</span>
                </p>
                {categories.length ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {categories.map((category) => (
                      <label
                        key={category.id}
                        className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs ${selectedCategories.includes(category.id) ? "border-[var(--green)] bg-[var(--soft)]" : "border-[var(--line)]"}`}
                      >
                        <input
                          className={controls.checkbox}
                          type="checkbox"
                          checked={selectedCategories.includes(category.id)}
                          onChange={(event) =>
                            setSelectedCategories((ids) =>
                              event.target.checked
                                ? [...ids, category.id]
                                : ids.filter((id) => id !== category.id),
                            )
                          }
                        />
                        {category.name}
                      </label>
                    ))}
                  </div>
                ) : !categoryFetched ? (
                  <p className="text-xs text-[var(--muted)]">Loading categories…</p>
                ) : (
                  <p className="text-xs text-[var(--muted)]">
                    Create categories in Reference settings before setting up a budget.
                  </p>
                )}
              </div>
            </section>
            <section className={`${card} h-fit space-y-5`}>
              <div>
                <h2 className="font-bold">Usage thresholds</h2>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Crossings are tracked once per period. Notifications for them are not available
                  yet. None are selected by default.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {thresholds.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={selectedThresholds.includes(value)}
                    className={`min-h-9 rounded-lg border text-xs font-semibold ${selectedThresholds.includes(value) ? "border-[var(--green)] bg-[var(--soft)] text-[var(--green)]" : "border-[var(--line)] text-[var(--muted)]"}`}
                    onClick={() =>
                      setSelectedThresholds((values) =>
                        values.includes(value)
                          ? values.filter((item) => item !== value)
                          : [...values, value],
                      )
                    }
                  >
                    {value}%
                  </button>
                ))}
              </div>
              <div>
                <label className="block text-xs font-semibold" htmlFor="custom-budget-threshold">
                  Custom threshold (%)
                </label>
                <div className="mt-2 flex gap-2">
                  <input
                    id="custom-budget-threshold"
                    className={field}
                    type="number"
                    min="0.01"
                    max="100"
                    step="0.01"
                    value={customThreshold}
                    onChange={(event) => setCustomThreshold(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addCustomThreshold();
                      }
                    }}
                    placeholder="e.g. 67.5"
                  />
                  <button type="button" className={secondary} onClick={addCustomThreshold}>
                    Add
                  </button>
                </div>
              </div>
              {selectedThresholds.length ? (
                <div className="flex flex-wrap gap-1.5" aria-label="Selected alert thresholds">
                  {selectedThresholds.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className="inline-flex items-center gap-1 rounded-full bg-[var(--soft)] px-2 py-1 text-[11px] font-semibold text-[var(--ink)]"
                      onClick={() =>
                        setSelectedThresholds((values) => values.filter((item) => item !== value))
                      }
                      aria-label={`Remove ${value}% threshold`}
                    >
                      {value}% <X size={11} />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-[var(--muted)]">No alerts selected.</p>
              )}
              <div className="flex flex-wrap gap-2 border-t border-[var(--line)] pt-4">
                <button
                  type="submit"
                  className={primary}
                  disabled={busy || !selectedCategories.length}
                >
                  {busy ? "Saving…" : editing ? "Save changes" : "Create budget"}{" "}
                  <ArrowRight size={14} />
                </button>
                <Link className={secondary} href={url(bucket.id, "budgets")}>
                  Cancel
                </Link>
              </div>
            </section>
          </form>
        </>
      )}
      {(view === "budget" || view === "budget-form") && budgetId && !selected && !loading && (
        <Notice>This budget is unavailable. Return to all budgets and choose another.</Notice>
      )}
      {deleteOpen && selected && (
        <Dialog
          title="Delete this budget?"
          subtitle={`${selected.budget.name} will disappear from budget views. Expense records remain unchanged.`}
          onClose={() => setDeleteOpen(false)}
        >
          <div className="flex justify-end gap-2">
            <button className={secondary} onClick={() => setDeleteOpen(false)}>
              Cancel
            </button>
            <button className={primary} disabled={busy} onClick={deleteBudget}>
              Delete budget
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
