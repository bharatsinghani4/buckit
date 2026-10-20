"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
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
import { CalendarField } from "@/components/calendar-field";
import { useWorkspaceData } from "@/features/buckets/workspace-data-context";
import { useWorkspacePeriod } from "@/features/buckets/workspace-period-context";
import type { Bucket } from "@/features/identity/contracts";
import type { Expense, Member, Option } from "@/features/expenses/contracts";
import { usePaymentModes } from "@/features/expenses/use-payment-modes";
import { api, friendlyError } from "@/lib/api/client";
import type { Budget, BudgetUsage, SpendingGroup, SpendingReport } from "./contracts";

type View = "dashboard" | "reports" | "budgets" | "budget" | "budget-form";
type BudgetEntry = { budget: Budget; usage: BudgetUsage };
type Dashboard = SpendingReport & {
  comparable: { from: string; toExclusive: string; totalAmount: string };
  categories: SpendingGroup[];
  members: SpendingGroup[];
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
  "rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] min-[768px]:max-[1199px]:p-4";
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

function PeriodAnchorField({
  period,
  anchor,
  onChange,
  className,
}: {
  period: string;
  anchor: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const mode = period as "month" | "quarter" | "year";
  const month = Number(anchor.slice(5, 7)) || 1;
  const value =
    mode === "year"
      ? anchor.slice(0, 4)
      : mode === "quarter"
        ? `${anchor.slice(0, 4)}-Q${Math.ceil(month / 3)}`
        : anchor.slice(0, 7);
  return (
    <CalendarField
      mode={mode}
      value={value}
      containerClassName={className}
      aria-label={`${mode} period`}
      onValueChange={(selected) =>
        onChange(
          mode === "year"
            ? `${selected}-01-01`
            : mode === "quarter"
              ? `${selected.slice(0, 4)}-${String((Number(selected.slice(-1)) - 1) * 3 + 1).padStart(2, "0")}-01`
              : `${selected}-01`,
        )
      }
    />
  );
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

function MonthlySpendingChart({
  bucketId,
  currency,
  anchor,
  timezone,
}: {
  bucketId: string;
  currency: string;
  anchor: string;
  timezone: string;
}) {
  const { read } = useWorkspaceData();
  const [selection, setSelection] = useState("3");
  const [groups, setGroups] = useState<SpendingGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [width, setWidth] = useState(800);
  const [active, setActive] = useState<number | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const selectedMonth = anchor.slice(0, 7);
  const daily = selection === "current";
  const months = daily ? 1 : Number(selection);
  const [year, number] = anchor.slice(0, 7).split("-").map(Number);
  const start = daily
    ? selectedMonth
    : new Date(Date.UTC(year, number - months, 1)).toISOString().slice(0, 7);
  const end = daily
    ? new Date(Date.UTC(Number(selectedMonth.slice(0, 4)), Number(selectedMonth.slice(5, 7)), 1))
        .toISOString()
        .slice(0, 7)
    : new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 7);

  useEffect(() => {
    const node = chartRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(320, entry.contentRect.width)),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let canceled = false;
    const params = new URLSearchParams({
      period: "custom",
      anchorDate: anchor,
      from: `${start}-01`,
      toExclusive: `${end}-01`,
      groupBy: daily ? "day" : "month",
    });
    queueMicrotask(() => {
      if (canceled) return;
      setLoading(true);
      setError("");
      void read<SpendingReport>(`buckets/${bucketId}/reports/spending?${params}`)
        .then((result) => {
          if (!canceled) setGroups(result.data.groups);
        })
        .catch((cause: unknown) => {
          if (!canceled) setError(friendlyError(cause));
        })
        .finally(() => {
          if (!canceled) setLoading(false);
        });
    });
    return () => {
      canceled = true;
    };
  }, [anchor, bucketId, daily, end, read, start]);

  const todayParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const today = `${todayParts.find((part) => part.type === "year")?.value}-${todayParts.find((part) => part.type === "month")?.value}-${todayParts.find((part) => part.type === "day")?.value}`;
  const amounts = daily
    ? Array.from(
        {
          length: new Date(
            Date.UTC(Number(selectedMonth.slice(0, 4)), Number(selectedMonth.slice(5, 7)), 0),
          ).getUTCDate(),
        },
        (_, index) => {
          const date = `${selectedMonth}-${String(index + 1).padStart(2, "0")}`;
          return {
            id: date,
            amount:
              date > today
                ? null
                : Number(groups.find((group) => group.id === date)?.amount ?? "0"),
          };
        },
      )
    : Array.from({ length: months }, (_, index) => {
        const month = new Date(Date.UTC(year, number - months + index, 1))
          .toISOString()
          .slice(0, 7);
        return {
          id: month,
          amount: Number(groups.find((group) => group.id === month)?.amount ?? "0"),
        };
      });
  const max = Math.max(1, ...amounts.map((point) => point.amount ?? 0));
  const left = 48;
  const right = width - 18;
  const top = 18;
  const bottom = 184;
  const x = (index: number) =>
    amounts.length === 1
      ? (left + right) / 2
      : left + (index / (amounts.length - 1)) * (right - left);
  const y = (amount: number) => bottom - (amount / max) * (bottom - top);
  const line = amounts
    .filter((point) => point.amount !== null)
    .map(
      (point, index) =>
        `${index ? "L" : "M"}${x(index).toFixed(1)} ${y(point.amount ?? 0).toFixed(1)}`,
    )
    .join(" ");
  const activePoint = active === null ? null : amounts[active];

  return (
    <section className={`${card} col-span-full min-w-0`}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-[var(--ink)]">Spending trajectory</h2>
          <p className="text-xs text-[var(--muted)]">
            Posted spending by {daily ? `day in ${selectedMonth}` : "month"}
          </p>
        </div>
        <Dropdown
          value={selection}
          onValueChange={(value) => {
            setSelection(value);
            setActive(null);
          }}
          className="!w-[130px]"
          options={[
            { value: "current", label: "This month" },
            { value: "1", label: "Last 1 month" },
            { value: "3", label: "Last 3 months" },
            { value: "6", label: "Last 6 months" },
            { value: "12", label: "Last 12 months" },
          ]}
        />
      </div>
      {error && <Notice>{error}</Notice>}
      <div ref={chartRef} className="relative h-[240px] w-full min-w-0" aria-busy={loading}>
        {loading ? (
          <div className="grid h-full place-items-center text-xs text-[var(--muted)]">
            Loading spending…
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${width} 220`}
            className="h-[220px] w-full overflow-visible"
            role="img"
            aria-label={`${daily ? "Daily" : "Monthly"} spending from ${start} to ${end}`}
          >
            {[0, 0.5, 1].map((fraction) => {
              const value = max * fraction;
              const at = y(value);
              return (
                <g key={fraction}>
                  <line
                    x1={left}
                    x2={right}
                    y1={at}
                    y2={at}
                    stroke="var(--line)"
                    strokeDasharray={fraction === 0 ? undefined : "4 5"}
                  />
                  <text x="0" y={at + 4} fill="var(--muted)" fontSize="10">
                    {new Intl.NumberFormat(undefined, { notation: "compact" }).format(value)}
                  </text>
                </g>
              );
            })}
            <path
              d={line}
              fill="none"
              stroke="var(--green)"
              strokeWidth="3"
              vectorEffect="non-scaling-stroke"
            />
            {amounts.map((point, index) => (
              <g key={point.id}>
                {point.amount !== null && (
                  <g
                    tabIndex={0}
                    role="button"
                    aria-label={`${point.id}: ${money(String(point.amount), currency)}`}
                    onMouseEnter={() => setActive(index)}
                    onMouseLeave={() => setActive(null)}
                    onFocus={() => setActive(index)}
                    onBlur={() => setActive(null)}
                  >
                    <circle cx={x(index)} cy={y(point.amount)} r="14" fill="transparent" />
                    <circle
                      cx={x(index)}
                      cy={y(point.amount)}
                      r={active === index ? 6 : 4}
                      fill="var(--green)"
                    />
                  </g>
                )}
                {(daily
                  ? index === 0 || (index + 1) % 5 === 0 || index === amounts.length - 1
                  : months <= 6 || index % 2 === 0 || index === months - 1) && (
                  <text x={x(index)} y="212" textAnchor="middle" fill="var(--muted)" fontSize="11">
                    {daily
                      ? String(index + 1)
                      : new Date(`${point.id}-01T12:00:00Z`).toLocaleDateString(undefined, {
                          month: "short",
                          ...(months > 6 ? { year: "2-digit" } : {}),
                        })}
                  </text>
                )}
              </g>
            ))}
          </svg>
        )}
        {activePoint?.amount !== null && activePoint && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-xs shadow-lg"
            style={{
              left: Math.min(Math.max(x(active ?? 0) - 55, 0), width - 125),
              top: Math.max(0, y(activePoint.amount) - 60),
            }}
          >
            <strong className="block text-[var(--ink)]">{activePoint.id}</strong>
            <span className="text-[var(--muted)]">
              {money(String(activePoint.amount), currency)}
            </span>
          </div>
        )}
      </div>
    </section>
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
          <h3 className="text-base font-bold text-[var(--ink)] max-[767px]:text-sm">
            {budget.name}
          </h3>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {budget.scope === "shared" ? "Owner managed" : `Created by ${budget.ownerName}`}
          </p>
        </div>
        <ChevronRight size={18} className="shrink-0 text-[var(--muted)]" />
      </div>
      <div className="mb-3 flex items-center justify-between gap-2">
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
  const paymentModes = usePaymentModes(bucket.id, view === "reports").settings.modes;
  const { period, setPeriod, anchor, setAnchor, customFrom, setCustomFrom, customTo, setCustomTo } =
    useWorkspacePeriod();
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
  const [budgetExpenses, setBudgetExpenses] = useState<Expense[]>([]);
  const [budgetExpenseCursor, setBudgetExpenseCursor] = useState<string | null>(null);
  const [budgetExpensesLoading, setBudgetExpensesLoading] = useState(false);
  const [budgetExpensesError, setBudgetExpensesError] = useState("");
  const [categories, setCategories] = useState<Option[]>([]);
  const [categoryFetched, setCategoryFetched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [scope, setScope] = useState<"shared" | "member">(bucket.isOwner ? "shared" : "member");
  const [periodType, setPeriodType] = useState<"monthly" | "custom">("monthly");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [categoryQuery, setCategoryQuery] = useState("");
  const [selectedThresholds, setSelectedThresholds] = useState<string[]>([]);
  const [customThreshold, setCustomThreshold] = useState("");
  const requestToken = useRef(0);
  const selected = budgets.find((entry) => entry.budget.id === budgetId);
  const budgetExpensesPath = selected
    ? `buckets/${bucket.id}/expenses?${new URLSearchParams({
        categoryIds: selected.budget.categoryIds.join(","),
        from: selected.usage.from,
        toExclusive: selected.usage.toExclusive,
        ...(selected.budget.memberUserId ? { paidByUserId: selected.budget.memberUserId } : {}),
        limit: "100",
      })}`
    : "";
  const editing = view === "budget-form" && Boolean(budgetId);

  useEffect(() => {
    if (view !== "budget" || !budgetExpensesPath) return;
    let canceled = false;
    queueMicrotask(() => {
      setBudgetExpenses([]);
      setBudgetExpenseCursor(null);
      setBudgetExpensesLoading(true);
      setBudgetExpensesError("");
      void read<Expense[]>(budgetExpensesPath)
        .then((result) => {
          if (canceled) return;
          setBudgetExpenses(result.data);
          setBudgetExpenseCursor(result.meta.nextCursor ?? null);
        })
        .catch((cause) => {
          if (!canceled) setBudgetExpensesError(friendlyError(cause));
        })
        .finally(() => {
          if (!canceled) setBudgetExpensesLoading(false);
        });
    });
    return () => {
      canceled = true;
    };
  }, [budgetExpensesPath, read, view]);

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
    <div className="mx-auto max-w-[1440px] space-y-5 min-[768px]:max-[1199px]:space-y-4">
      {error && <Notice>{error}</Notice>}
      {!error &&
      ((view === "dashboard" && !dashboard) ||
        (view === "reports" && !report) ||
        (["budgets", "budget"].includes(view) && !budgetLoaded) ||
        (view === "budget-form" && Boolean(budgetId) && !budgetLoaded)) ? (
        <Pending layout="workspace" />
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
              <h1 className="mt-1 text-2xl font-bold text-[var(--ink)]">Overview</h1>
              <p className="mt-1 text-xs text-[var(--muted)]">
                Spending and plans for this bucket.
              </p>
            </div>
            <div className="flex w-full flex-wrap gap-2 min-[1200px]:w-auto [&>*]:min-w-0 [&>*]:flex-1 min-[768px]:[&>*]:min-w-[160px]">
              <Dropdown
                value={period}
                onValueChange={(value) => setPeriod(value as typeof period)}
                options={[
                  { value: "month", label: "This month" },
                  { value: "quarter", label: "This quarter" },
                  { value: "year", label: "This year" },
                  { value: "custom", label: "Custom range" },
                ]}
              />
              {period === "custom" ? (
                <>
                  <CalendarField
                    aria-label="From date"
                    value={customFrom}
                    onValueChange={setCustomFrom}
                  />
                  <CalendarField
                    aria-label="Through date"
                    value={customTo}
                    onValueChange={setCustomTo}
                  />
                </>
              ) : (
                <PeriodAnchorField period={period} anchor={anchor} onChange={setAnchor} />
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
              <span className="inline-flex items-start gap-2">
                <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>
                  {dashboard.incompleteCount > 0 && (
                    <>
                      {dashboard.incompleteCount}{" "}
                      {dashboard.incompleteCount === 1 ? "expense needs" : "expenses need"} currency
                      conversion before counting toward spending.{" "}
                      <Link
                        className="font-semibold underline"
                        href={`/workspace?bucket=${bucket.id}&view=expenses&status=conversion_needed`}
                      >
                        Review expenses
                      </Link>
                      {dashboard.pendingCount > 0 ? " · " : ""}
                    </>
                  )}
                  {dashboard.pendingCount > 0 && (
                    <>
                      {dashboard.pendingCount}{" "}
                      {dashboard.pendingCount === 1 ? "dated expense is" : "dated expenses are"}{" "}
                      awaiting posting or final conversion. Buckit processes these automatically;
                      they enter totals only when finalized.
                    </>
                  )}
                </span>
              </span>
            </Notice>
          )}
          <div className="grid gap-3 grid-cols-2 xl:grid-cols-4 max-[767px]:grid-cols-1">
            <div className={card}>
              <p className="text-xs text-[var(--muted)]">Actual spending</p>
              <p className="mt-2 text-2xl font-bold text-[var(--ink)]">
                {money(dashboard.totalAmount, currency)}
              </p>
              <p className="mt-2 text-xs text-[var(--muted)]">
                {dashboard.actualCount} posted entries
              </p>
            </div>
            <div className={`${card} max-[767px]:hidden`}>
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
            <div className={`${card} max-[767px]:hidden`}>
              <p className="text-xs text-[var(--muted)]">Scheduled separately</p>
              <p className="mt-2 text-2xl font-bold text-[var(--ink)]">
                {money(dashboard.scheduledAmount, currency)}
              </p>
              <p className="mt-2 text-xs text-[var(--muted)]">
                {dashboard.scheduledCount} future entries · estimate
              </p>
              {!!dashboard.scheduledUnconvertedCount && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                  {dashboard.scheduledUnconvertedCount} recurring payment(s) need conversion.
                </p>
              )}
            </div>
            <div className={`${card} max-[767px]:hidden`}>
              <p className="text-xs text-[var(--muted)]">Active budgets</p>
              <p className="mt-2 text-2xl font-bold text-[var(--ink)]">{dashboard.budgetCount}</p>
              <Link
                href={url(bucket.id, "budgets")}
                className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[var(--green)]"
              >
                Manage budgets <ArrowRight size={12} />
              </Link>
            </div>
            <div className={`${card} divide-y divide-[var(--line)] !p-0 min-[768px]:hidden`}>
              <div className="flex items-center justify-between gap-3 p-4">
                <div>
                  <p className="text-xs font-semibold text-[var(--ink)]">Previous period</p>
                  <p className="mt-1 text-[11px] text-[var(--muted)]">
                    {change === null
                      ? "No comparison yet"
                      : `${percent(Math.abs(change))} ${change >= 0 ? "higher" : "lower"}`}
                  </p>
                </div>
                <strong className="text-sm tabular-nums">
                  {money(dashboard.comparable.totalAmount, currency)}
                </strong>
              </div>
              <div className="flex items-center justify-between gap-3 p-4">
                <div>
                  <p className="text-xs font-semibold text-[var(--ink)]">Scheduled separately</p>
                  <p className="mt-1 text-[11px] text-[var(--muted)]">
                    {dashboard.scheduledCount} future entries
                  </p>
                </div>
                <strong className="text-sm tabular-nums">
                  {money(dashboard.scheduledAmount, currency)}
                </strong>
              </div>
              <Link
                href={url(bucket.id, "budgets")}
                className="flex min-h-14 items-center justify-between gap-3 p-4 text-xs font-semibold text-[var(--green)]"
              >
                Active budgets <strong className="text-sm">{dashboard.budgetCount}</strong>
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
            <MonthlySpendingChart
              bucketId={bucket.id}
              currency={currency}
              anchor={anchor}
              timezone={bucket.timezone}
            />
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
            <section className={`${card} xl:col-span-2`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="rounded-lg bg-[var(--soft)] p-2.5 text-[var(--green)]">
                    <CreditCard size={19} />
                  </span>
                  <div>
                    <h2 className="text-base font-bold text-[var(--ink)]">EMI commitments</h2>
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
              <div className="mt-4 grid gap-3 border-t border-[var(--line)] pt-4 sm:grid-cols-3 min-[768px]:max-[1024px]:!grid-cols-1">
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
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
            <h1 className="mt-1 text-2xl font-bold text-[var(--ink)]">Reports</h1>
            <div className="flex flex-wrap items-center justify-end gap-2 max-[767px]:col-span-2 max-[767px]:grid max-[767px]:w-full max-[767px]:grid-cols-2">
              <Dropdown
                value={period}
                onValueChange={(value) => setPeriod(value as typeof period)}
                className={`!w-[136px] max-[767px]:!w-full ${period === "custom" ? "max-[767px]:col-span-2" : ""}`}
                options={[
                  { value: "month", label: "Month" },
                  { value: "quarter", label: "Quarter" },
                  { value: "year", label: "Year" },
                  { value: "custom", label: "Custom range" },
                ]}
              />
              {period === "custom" ? (
                <>
                  <CalendarField
                    aria-label="From date"
                    value={customFrom}
                    onValueChange={setCustomFrom}
                    containerClassName="w-[142px] max-[767px]:w-full"
                  />
                  <CalendarField
                    aria-label="Through date"
                    value={customTo}
                    onValueChange={setCustomTo}
                    containerClassName="w-[142px] max-[767px]:w-full"
                  />
                </>
              ) : (
                <PeriodAnchorField
                  period={period}
                  anchor={anchor}
                  onChange={setAnchor}
                  className="w-[168px] max-[767px]:w-full"
                />
              )}
            </div>
            <p className="col-span-2 mt-1 text-xs text-[var(--muted)]">
              Explore finalized spending without double-counting overlapping budgets.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
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
            <div
              className={`${card} grid gap-3 sm:grid-cols-2 xl:grid-cols-5 min-[768px]:max-[1024px]:!grid-cols-1`}
            >
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
                    options={[{ value: "all", label: "All modes" }, ...paymentModes]}
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
          <div className="grid grid-cols-2 gap-3 max-[767px]:grid-cols-1 min-[1100px]:grid-cols-3">
            <div className={`${card} col-span-2 max-[767px]:col-span-1 min-[1100px]:col-span-1`}>
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
              {!!report.scheduledUnconvertedCount && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                  {report.scheduledUnconvertedCount} recurring payment(s) need conversion.
                </p>
              )}
            </div>
          </div>
          <section className={card}>
            <div className="mb-4 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1">
              <h2 className="text-base font-bold">Breakdown</h2>
              <Dropdown
                value={groupBy}
                onValueChange={setGroupBy}
                className="!w-[150px] max-[767px]:!w-[132px]"
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
              <p className="col-span-2 text-xs text-[var(--muted)]">
                {report.from} to {shiftDay(report.toExclusive, -1)} · {report.currency}
              </p>
            </div>
            {report.groups.length ? (
              report.groups.map((group) => (
                <div
                  key={group.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 border-t border-[var(--line)] py-3 text-xs max-[767px]:grid-cols-[minmax(0,1fr)_auto] max-[767px]:gap-x-2 max-[767px]:gap-y-0.5"
                >
                  <span className="truncate font-semibold">{group.name}</span>
                  <span className="text-[var(--muted)] max-[767px]:col-start-1 max-[767px]:row-start-2">
                    {group.count} entries
                  </span>
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
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
            <h1 className="mt-1 text-2xl font-bold">Budgets</h1>
            {bucket.status === "active" && (
              <Link className={primary} href={url(bucket.id, "budget-form")}>
                <Plus size={15} /> Create budget
              </Link>
            )}
            <p className="col-span-2 mt-1 max-w-2xl text-xs text-[var(--muted)]">
              Track shared or personal spending limits across categories.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="flex gap-2 border-b border-[var(--line)] max-[1024px]:grid max-[1024px]:w-full max-[1024px]:grid-cols-3 max-[1024px]:gap-0">
              {[
                ["all", "All budgets"],
                ["shared", "Shared budgets"],
                ["member", "Member budgets"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`flex items-center gap-2 border-b-2 p-3 !rounded-none !font-semibold max-[1024px]:justify-center max-[1024px]:px-1 max-[1024px]:text-xs ${budgetTab === value ? "border-[var(--ink)] text-[var(--ink)]" : "border-transparent !text-[var(--muted)]"}`}
                  aria-label={label}
                  onClick={() => setBudgetTab(value)}
                >
                  <BookOpen size={16} className="max-[1024px]:hidden" />
                  <span className="max-[1024px]:hidden">{label}</span>
                  <span className="min-[1025px]:hidden">
                    {value === "all" ? "All" : value === "shared" ? "Shared" : "Member"}
                  </span>
                </button>
              ))}
            </div>
            <label className="ml-auto flex w-[176px] items-center gap-2 text-xs text-[var(--muted)]">
              <span className="sr-only">Budget month</span>
              <CalendarField
                mode="month"
                value={month}
                onValueChange={(value) => {
                  setAnchor(`${value}-01`);
                  setPeriod("month");
                }}
                containerClassName="w-full"
              />
            </label>
          </div>
          {visibleBudgets.length ? (
            <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3 min-[768px]:max-[1024px]:!grid-cols-1">
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
            </section>
          )}
          <div
            className={`${card} flex flex-wrap items-center justify-between gap-3 bg-[var(--soft)] max-[767px]:hidden`}
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
          <details className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-xs min-[768px]:hidden">
            <summary className="cursor-pointer font-semibold text-[var(--green)]">
              How budget overlaps work
            </summary>
            <p className="mt-2">
              Refunds reduce usage. One expense can affect multiple budgets, but bucket spending
              counts it once. Monthly limits reset without rollover.
            </p>
          </details>
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
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
          <div className="grid gap-3 sm:grid-cols-2 min-[1100px]:grid-cols-3 min-[768px]:max-[1024px]:!grid-cols-1">
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
            <div className={`${card} min-[768px]:max-[1099px]:col-span-2`}>
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
            <div className="mt-5 grid gap-4 text-xs sm:grid-cols-2 min-[768px]:max-[1024px]:!grid-cols-1">
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
          <section className={card}>
            <div className="mb-4">
              <h2 className="text-base font-bold text-[var(--ink)]">Expenses in this budget</h2>
              <p className="mt-1 text-xs text-[var(--muted)]">
                All selected categories from {selected.usage.from} through{" "}
                {shiftDay(selected.usage.toExclusive, -1)}.
                {selected.budget.scope === "member"
                  ? " Only this member’s expenses are included."
                  : ""}{" "}
                Only posted expenses count toward the used amount above.
              </p>
            </div>
            {budgetExpensesError && <Notice>{budgetExpensesError}</Notice>}
            {budgetExpensesLoading && !budgetExpenses.length ? (
              <p className="text-xs text-[var(--muted)]">Loading expenses…</p>
            ) : budgetExpenses.length ? (
              <div className="divide-y divide-[var(--line)]">
                {budgetExpenses.map((item) => (
                  <Link
                    key={item.id}
                    href={`/workspace?bucket=${bucket.id}&view=expense&expense=${item.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs hover:text-[var(--green)]"
                  >
                    <span className="min-w-0">
                      <strong className="block truncate text-sm text-[var(--ink)]">
                        {item.description}
                      </strong>
                      <span className="text-[var(--muted)]">
                        {item.expenseDate} · {item.categoryName} · {item.paidByName} ·{" "}
                        {item.displayStatus.replaceAll("_", " ")}
                      </span>
                    </span>
                    <strong className="tabular-nums text-[var(--ink)]">
                      {money(item.convertedAmount, currency)}
                    </strong>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-xs text-[var(--muted)]">
                No matching expenses in this budget period.
              </p>
            )}
            {budgetExpenseCursor && (
              <button
                type="button"
                className={`${secondary} mt-4`}
                disabled={budgetExpensesLoading}
                onClick={async () => {
                  if (!budgetExpenseCursor) return;
                  setBudgetExpensesLoading(true);
                  setBudgetExpensesError("");
                  try {
                    const result = await api<Expense[]>(
                      `${budgetExpensesPath}&cursor=${budgetExpenseCursor}`,
                    );
                    setBudgetExpenses((current) => [...current, ...result.data]);
                    setBudgetExpenseCursor(result.meta.nextCursor ?? null);
                  } catch (cause) {
                    setBudgetExpensesError(friendlyError(cause));
                  } finally {
                    setBudgetExpensesLoading(false);
                  }
                }}
              >
                {budgetExpensesLoading ? "Loading…" : "Load more expenses"}
              </button>
            )}
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
            <h1 className="mt-1 text-2xl font-bold">
              {editing ? "Edit budget" : "Create a budget"}
            </h1>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Choose which spending this limit follows. Only posted, finalized expenses affect
              usage.
            </p>
          </div>
          <form
            id="budget-entry-form"
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
              <div className="grid gap-4 sm:grid-cols-2 min-[768px]:max-[1024px]:!grid-cols-1">
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
                <div className="grid gap-4 sm:grid-cols-2 min-[768px]:max-[1024px]:!grid-cols-1">
                  <label className="block text-xs font-semibold">
                    Start date
                    <CalendarField
                      className="mt-2"
                      name="from"
                      required
                      defaultValue={selected?.budget.from ?? ""}
                    />
                  </label>
                  <label className="block text-xs font-semibold">
                    End date
                    <CalendarField
                      className="mt-2"
                      name="to"
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
                  <div>
                    {categories.length > 8 && (
                      <input
                        className={`${field} mb-2`}
                        type="search"
                        aria-label="Find a category"
                        placeholder="Find a category"
                        value={categoryQuery}
                        onChange={(event) => setCategoryQuery(event.target.value)}
                      />
                    )}
                    <div className="grid gap-2 sm:grid-cols-2 min-[768px]:max-[1024px]:!grid-cols-1">
                      {categories
                        .filter((category) =>
                          category.name.toLowerCase().includes(categoryQuery.trim().toLowerCase()),
                        )
                        .map((category) => (
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
                  Choose the thresholds that should notify you. Each crossing is tracked once per
                  period.
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
              <div className="flex flex-wrap gap-2 border-t border-[var(--line)] pt-4 max-[767px]:hidden">
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
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--line)] bg-[var(--surface)] px-4 pb-[calc(12px+env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_28px_rgba(0,0,0,.08)] min-[768px]:hidden">
            <button
              type="submit"
              form="budget-entry-form"
              className={`${primary} w-full`}
              disabled={busy || !selectedCategories.length}
            >
              {busy ? "Saving…" : editing ? "Save changes" : "Create budget"}
              <ArrowRight size={14} />
            </button>
          </div>
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
