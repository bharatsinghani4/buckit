"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  History,
  LockKeyhole,
  MessageCircle,
  MoreVertical,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Dropdown } from "@/components/dropdown";
import { Dialog, Notice, Pending } from "@/components/ui";
import type { Bucket, Invitation, Profile } from "@/features/identity/contracts";
import { currencies } from "@/features/identity/contracts";
import { api, friendlyError } from "@/lib/api/client";
import { useWorkspaceData } from "@/features/buckets/workspace-data-context";
import type { Comment, Expense, Member, Option, OptionKind } from "./contracts";
import { ReferenceGlyph } from "./reference-icon";

type View = "expenses" | "deleted" | "add-expense" | "expense" | "references" | "members";
const groups: { key: OptionKind; title: string }[] = [
  { key: "accounts", title: "Accounts" },
  { key: "categories", title: "Categories" },
  { key: "platforms", title: "Platforms" },
];
const paymentModes = [
  { value: "upi", label: "UPI" },
  { value: "cash", label: "Cash" },
  { value: "neft", label: "NEFT" },
  { value: "imps", label: "IMPS" },
  { value: "credit_card", label: "Credit card" },
];
const card =
  "rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]";
const field =
  "!h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--ink)]";
const muted = "text-xs text-[var(--muted)]";
const action =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2 !py-2 !text-xs font-semibold !text-[var(--ink)] hover:border-[var(--green)] hover:bg-[var(--soft)]";

function path(bucket: string, view: View, expense?: string) {
  return `/workspace?bucket=${bucket}&view=${view}${expense ? `&expense=${expense}` : ""}`;
}

function today(zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const part = (type: string) => parts.find((item) => item.type === type)?.value;

  return `${part("year")}-${part("month")}-${part("day")}`;
}

function money(amount: string | null, currency: string) {
  if (amount === null) return "Conversion needed";

  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(amount));
}

export function PhaseTwoScreen({
  bucket,
  profile,
  view,
  expenseId,
  refundOf,
  month,
  onClearMonth,
  resolveRequested = false,
  refundMode = false,
}: {
  bucket: Bucket;
  profile: Profile;
  view: View;
  expenseId: string | null;
  refundOf: string | null;
  month: string;
  onClearMonth: () => void;
  resolveRequested?: boolean;
  refundMode?: boolean;
}) {
  const router = useRouter();
  const { read, invalidate } = useWorkspaceData();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [summary, setSummary] = useState<{
    currency: string;
    actualTotal: string;
    actualCount: number;
    scheduledTotal: string;
    scheduledCount: number;
    conversionNeededCount: number;
    incomplete: boolean;
  } | null>(null);
  const [expense, setExpense] = useState<Expense | null>(null);
  const [refundSource, setRefundSource] = useState<Expense | null>(null);
  const [options, setOptions] = useState<Record<OptionKind, Option[]>>({
    accounts: [],
    categories: [],
    platforms: [],
  });
  const [members, setMembers] = useState<Member[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [refunds, setRefunds] = useState<Expense[]>([]);
  const [activity, setActivity] = useState<
    {
      id: string;
      action: string;
      changedFields: string[];
      actorName: string;
      occurredAt: string;
      linkedExpenseId: string | null;
    }[]
  >([]);
  const [invitations, setInvitations] = useState<
    {
      id: string;
      status: string;
      createdAt: string;
      createdByName: string;
      expiresAt: string;
      revision: number;
    }[]
  >([]);
  const [newInvitation, setNewInvitation] = useState<Invitation | null>(null);
  const [conversionEstimate, setConversionEstimate] = useState<{
    status: string;
    bucketCurrency: string;
    convertedAmount: string | null;
    rate: string | null;
    rateDate: string | null;
  } | null>(null);
  const expenseFormRef = useRef<HTMLFormElement>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [appliedFilters, setAppliedFilters] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [editing, setEditing] = useState(resolveRequested);
  const [entryMode, setEntryMode] = useState<"expense" | "refund">(
    refundOf || refundMode ? "refund" : "expense",
  );
  const [foreignOpen, setForeignOpen] = useState(false);
  const [currencyValue, setCurrencyValue] = useState(bucket.primaryCurrency);
  const saveAnother = useRef(false);
  const [saved, setSaved] = useState(false);
  const [formVersion, setFormVersion] = useState(0);
  const [renderTime] = useState(() => Date.now());
  const [deleteTarget, setDeleteTarget] = useState<Expense | null>(null);
  const [commentDeleteTarget, setCommentDeleteTarget] = useState<Comment | null>(null);
  const [editingComment, setEditingComment] = useState<Comment | null>(null);
  const [editingCommentBody, setEditingCommentBody] = useState("");
  const [editingOptionId, setEditingOptionId] = useState<string | null>(null);
  const [editingOptionName, setEditingOptionName] = useState("");
  const [addingOption, setAddingOption] = useState<OptionKind | null>(null);
  const [removeMemberTarget, setRemoveMemberTarget] = useState<Member | null>(null);
  const [deleteOptionTarget, setDeleteOptionTarget] = useState<{
    option: Option;
    kind: OptionKind;
  } | null>(null);
  const [showInviteQr, setShowInviteQr] = useState(false);
  const loaded = useRef("");
  const filterOptionsLoaded = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (view === "expenses" || view === "deleted") {
        const filters = new URLSearchParams(appliedFilters);
        if (view === "deleted") filters.set("deleted", "only");
        else if (month && !filters.has("from") && !filters.has("toExclusive")) {
          filters.set("from", `${month}-01`);
          const [year, number] = month.split("-").map(Number);
          filters.set(
            "toExclusive",
            new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 10),
          );
        }
        const endpoint = `buckets/${bucket.id}/expenses${filters.size ? `?${filters}` : ""}`;
        const [result, totals] = await Promise.all([
          read<Expense[]>(endpoint),
          view === "expenses"
            ? read<NonNullable<typeof summary>>(
              `buckets/${bucket.id}/expenses/summary${month ? `?month=${month}` : ""}`,
            )
            : Promise.resolve(null),
        ]);
        setExpenses(result.data);
        setCursor(result.meta.nextCursor ?? null);
        if (totals) setSummary(totals.data);
      } else if (view === "add-expense") {
        const [accounts, categories, platforms, people] = await Promise.all([
          read<Option[]>(`buckets/${bucket.id}/accounts`),
          read<Option[]>(`buckets/${bucket.id}/categories`),
          read<Option[]>(`buckets/${bucket.id}/platforms`),
          read<Member[]>(`buckets/${bucket.id}/members`),
        ]);
        setOptions({
          accounts: accounts.data,
          categories: categories.data,
          platforms: platforms.data,
        });
        setMembers(people.data);
        if (refundOf) {
          const source = (await read<Expense>(`buckets/${bucket.id}/expenses/${refundOf}`)).data;
          setRefundSource(source);
          setCurrencyValue(source.originalCurrency);
          setForeignOpen(source.originalCurrency !== bucket.primaryCurrency);
        }
      } else if (view === "expense" && expenseId) {
        const [item, discussion, accounts, categories, platforms, people, linked, events] =
          await Promise.all([
            read<Expense>(`buckets/${bucket.id}/expenses/${expenseId}`),
            read<Comment[]>(`buckets/${bucket.id}/expenses/${expenseId}/comments`),
            read<Option[]>(`buckets/${bucket.id}/accounts?state=all`),
            read<Option[]>(`buckets/${bucket.id}/categories?state=all`),
            read<Option[]>(`buckets/${bucket.id}/platforms?state=all`),
            read<Member[]>(`buckets/${bucket.id}/members`),
            read<Expense[]>(`buckets/${bucket.id}/expenses/${expenseId}/refunds`),
            read<typeof activity>(`buckets/${bucket.id}/expenses/${expenseId}/activity`),
          ]);
        setExpense(item.data);
        setComments(discussion.data);
        setRefunds(linked.data);
        setActivity(events.data);
        setOptions({
          accounts: accounts.data,
          categories: categories.data,
          platforms: platforms.data,
        });
        setMembers(people.data);
      } else if (view === "references") {
        const values = await Promise.all(
          groups.map((group) => read<Option[]>(`buckets/${bucket.id}/${group.key}?state=all`)),
        );
        setOptions({
          accounts: values[0].data,
          categories: values[1].data,
          platforms: values[2].data,
        });
      } else if (view === "members") {
        const people = await read<Member[]>(`buckets/${bucket.id}/members`);
        setMembers(people.data);
        if (bucket.isOwner)
          setInvitations((await read<typeof invitations>(`buckets/${bucket.id}/invitations`)).data);
      }
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setLoading(false);
    }
  }, [
    appliedFilters,
    bucket.id,
    bucket.isOwner,
    bucket.primaryCurrency,
    expenseId,
    month,
    read,
    refundOf,
    view,
  ]);

  useEffect(() => {
    const key = `${bucket.id}:${view}:${expenseId ?? ""}:${refundOf ?? ""}:${appliedFilters}:${month}`;
    if (loaded.current === key) return;
    loaded.current = key;
    queueMicrotask(() => {
      void refresh();
    });
  }, [appliedFilters, bucket.id, view, expenseId, refundOf, month, refresh]);

  useEffect(() => {
    if (view !== "expenses" || !filtersOpen || filterOptionsLoaded.current) return;
    filterOptionsLoaded.current = true;
    void Promise.all([
      read<Option[]>(`buckets/${bucket.id}/accounts?state=all`),
      read<Option[]>(`buckets/${bucket.id}/categories?state=all`),
      read<Option[]>(`buckets/${bucket.id}/platforms?state=all`),
      read<Member[]>(`buckets/${bucket.id}/members`),
    ]).then(
      ([accounts, categories, platforms, people]) => {
        setOptions({
          accounts: accounts.data,
          categories: categories.data,
          platforms: platforms.data,
        });
        setMembers(people.data);
      },
      (cause: unknown) => {
        filterOptionsLoaded.current = false;
        setError(friendlyError(cause));
      },
    );
  }, [bucket.id, filtersOpen, read, view]);

  const navigate = (next: View, id?: string) => router.push(path(bucket.id, next, id));

  async function mutation<T>(
    endpoint: string,
    method: string,
    body?: unknown,
    revision?: number,
  ): Promise<T | null> {
    setBusy(true);
    setError("");
    try {
      const result = await api<T>(endpoint, { method, body, revision, key: crypto.randomUUID() });
      invalidate(`buckets/${bucket.id}/`);
      return result.data;
    } catch (cause) {
      setError(friendlyError(cause));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function submitExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = Object.fromEntries(
      [
        "expenseDate",
        "description",
        "paidByUserId",
        "categoryId",
        "accountId",
        "platformId",
        "paymentMode",
        "originalAmount",
        "originalCurrency",
        "notes",
      ].map((key) => [key, String(form.get(key) ?? "")]),
    );
    if (entryMode === "refund") {
      body.originalAmount = `-${String(body.originalAmount).replace(/^-/, "")}`;
    }
    if (!body.platformId) delete body.platformId;
    if (form.get("refundOfExpenseId"))
      body.refundOfExpenseId = String(form.get("refundOfExpenseId"));
    if (form.get("convertedAmount") && form.get("manualRate")) {
      setError("Enter either a converted amount or an exchange rate.");
      return;
    }
    if (form.get("convertedAmount"))
      body.manualConversion = {
        method: "manual_amount",
        convertedAmount: String(form.get("convertedAmount")),
      };
    if (form.get("manualRate"))
      body.manualConversion = { method: "manual_rate", rate: String(form.get("manualRate")) };
    const created = await mutation<Expense>(`buckets/${bucket.id}/expenses`, "POST", body);
    if (created) {
      if (saveAnother.current) {
        saveAnother.current = false;
        setFormVersion((version) => version + 1);
        setCurrencyValue(bucket.primaryCurrency);
        setForeignOpen(false);
        setSaved(true);
        setConversionEstimate(null);
      } else navigate("expense", created.id);
    }
  }
  async function previewConversion() {
    const form = expenseFormRef.current;
    if (!form) return;
    const values = new FormData(form);
    setBusy(true);
    setError("");
    try {
      const result = await api<NonNullable<typeof conversionEstimate>>(
        `buckets/${bucket.id}/conversion-preview`,
        {
          method: "POST",
          body: {
            expenseDate: String(values.get("expenseDate") ?? ""),
            originalAmount:
              entryMode === "refund"
                ? `-${String(values.get("originalAmount") ?? "").replace(/^-/, "")}`
                : String(values.get("originalAmount") ?? ""),
            originalCurrency: String(values.get("originalCurrency") ?? ""),
          },
        },
      );
      setConversionEstimate(result.data);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function addOption(event: FormEvent<HTMLFormElement>, kind: OptionKind) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      name: String(form.get("name") ?? "").trim(),
      ...(kind === "accounts" ? { ownerLabel: String(form.get("ownerLabel") ?? "").trim() } : {}),
    };
    if (await mutation(`buckets/${bucket.id}/${kind}`, "POST", body)) {
      event.currentTarget.reset();
      await refresh();
    }
  }

  async function optionAction(
    option: Option,
    kind: OptionKind,
    act: "archive" | "restore" | "delete",
  ) {
    if (
      await mutation(
        `buckets/${bucket.id}/${kind}/${option.id}${act === "delete" ? "" : `/${act}`}`,
        act === "delete" ? "DELETE" : "POST",
        undefined,
        option.revision,
      )
    )
      await refresh();
  }

  async function renameOption(option: Option, kind: OptionKind, nextName: string) {
    const name = nextName.trim();
    if (!name) return;
    if (name === option.name) {
      setEditingOptionId(null);
      return;
    }
    if (
      await mutation(
        `buckets/${bucket.id}/${kind}/${option.id}`,
        "PATCH",
        { name },
        option.revision,
      )
    ) {
      setEditingOptionId(null);
      await refresh();
    }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    for (const name of [
      "q",
      "from",
      "categoryId",
      "accountId",
      "platformId",
      "paymentMode",
      "paidByUserId",
    ]) {
      const value = String(form.get(name) ?? "").trim();
      if (value && value !== "all") params.set(name, value);
    }
    const to = String(form.get("to") ?? "");
    if (to) {
      const next = new Date(`${to}T12:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      params.set("toExclusive", next.toISOString().slice(0, 10));
    }
    if (status !== "all") params.set("status", status);
    setAppliedFilters(params.toString());
  }

  async function expenseAction(item: Expense, act: "delete" | "restore") {
    if (
      await mutation(
        `buckets/${bucket.id}/expenses/${item.id}${act === "restore" ? "/restore" : ""}`,
        act === "restore" ? "POST" : "DELETE",
        undefined,
        item.revision,
      )
    )
      navigate(act === "delete" ? "deleted" : "expenses");
  }

  async function postComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!expense) return;
    const form = new FormData(event.currentTarget);
    if (
      await mutation(`buckets/${bucket.id}/expenses/${expense.id}/comments`, "POST", {
        body: String(form.get("body") ?? ""),
      })
    ) {
      event.currentTarget.reset();
      setComments(
        (await api<Comment[]>(`buckets/${bucket.id}/expenses/${expense.id}/comments`)).data,
      );
    }
  }

  const filtered = expenses.filter(
    (item) =>
      (status === "all" || item.displayStatus === status) &&
      (!query ||
        [item.description, item.notes, item.categoryName, item.platformName, item.paidByName].some(
          (value) => value.toLowerCase().includes(query.toLowerCase()),
        )),
  );

  return (
    <div
      className={`mx-auto flex w-full flex-col gap-5 ${view === "add-expense" ? "max-w-[940px]" : view === "expense" ? "max-w-[1120px]" : "max-w-[1280px]"}`}
    >
      {error && <Notice>{error}</Notice>}
      {loading ? (
        <Pending />
      ) : (
        <>
          {(view === "expenses" || view === "deleted") && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-3">
                    <h1>{view === "deleted" ? "Deleted expenses" : "Expenses"}</h1>
                    {view === "expenses" && (
                      <span className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--surface)] px-3 py-1 text-xs text-[var(--muted)]">
                        <span className="status-dot" /> {bucket.name} · {bucket.primaryCurrency}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-[var(--muted)]">
                    {view === "deleted"
                      ? `Expenses you deleted from ${bucket.name} remain recoverable for 30 days.`
                      : `Track and review collective spending in ${bucket.name}.`}
                  </p>
                </div>
                {bucket.status === "active" && view === "expenses" && (
                  <div className="flex flex-wrap items-center gap-4">
                    <button
                      className="text-link"
                      onClick={() => router.push(`${path(bucket.id, "add-expense")}&mode=refund`)}
                    >
                      <History size={17} /> Record refund / credit
                    </button>
                    <button className="button primary" onClick={() => navigate("add-expense")}>
                      <Plus size={17} /> Add expense
                    </button>
                  </div>
                )}
              </div>
              <div className="flex gap-6 border-b border-[var(--line)] text-sm">
                <button
                  className={`flex items-center gap-2 border-b-2 p-3 !rounded-none ${view === "expenses" ? "border-[var(--ink)] font-semibold text-[var(--ink)]" : "border-transparent text-[var(--muted)]"}`}
                  onClick={() => navigate("expenses")}
                >
                  <Wallet size={16} /> Active expenses
                </button>
                <button
                  className={`flex items-center gap-2 border-b-2 p-3 !rounded-none ${view === "deleted" ? "border-[var(--ink)] font-semibold text-[var(--ink)]" : "border-transparent text-[var(--muted)]"}`}
                  onClick={() => navigate("deleted")}
                >
                  <Trash2 size={16} /> Deleted expenses
                </button>
              </div>
              {view === "expenses" && summary && (
                <div className="grid gap-3 lg:grid-cols-3">
                  <section className={`${card} flex min-h-36 flex-col justify-between`}>
                    <div className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
                      Actual spending{" "}
                      <span className="rounded-md bg-[var(--sage)] px-2 py-1 normal-case tracking-normal text-[var(--ink)]">
                        Finalized
                      </span>
                    </div>
                    <div className="mt-3 text-3xl font-bold tabular-nums">
                      {money(summary.actualTotal, summary.currency)}
                    </div>
                    <div className="mt-3 border-t border-[var(--line)] pt-3 text-xs text-[var(--muted)]">
                      {summary.actualCount} posted entries
                      {summary.incomplete && (
                        <span className="mt-1 block text-amber-700 dark:text-amber-300">
                          {summary.conversionNeededCount}{" "}
                          {summary.conversionNeededCount === 1 ? "item needs" : "items need"}{" "}
                          conversion — actual total incomplete
                        </span>
                      )}
                    </div>
                  </section>
                  <section
                    className={`${card} flex min-h-36 flex-col justify-between border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20`}
                  >
                    <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">
                      Needs conversion <span className="size-2 rounded-full bg-amber-500" />
                    </div>
                    <div className="mt-3 text-3xl font-bold tabular-nums text-amber-900 dark:text-amber-200">
                      {expenses.find((item) => item.displayStatus === "conversion_needed")
                        ? money(
                          expenses.find((item) => item.displayStatus === "conversion_needed")!
                            .originalAmount,
                          expenses.find((item) => item.displayStatus === "conversion_needed")!
                            .originalCurrency,
                        )
                        : summary.conversionNeededCount}
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2 border-t border-amber-200 pt-3 text-xs text-amber-800 dark:border-amber-800 dark:text-amber-300">
                      <span>
                        {summary.conversionNeededCount} foreign{" "}
                        {summary.conversionNeededCount === 1 ? "transaction" : "transactions"}{" "}
                        pending
                      </span>
                      {expenses.find(
                        (item) =>
                          item.displayStatus === "conversion_needed" && item.permissions.canEdit,
                      ) && (
                          <button
                            className="font-semibold underline"
                            onClick={() =>
                              router.push(
                                `${path(bucket.id, "expense", expenses.find((item) => item.displayStatus === "conversion_needed" && item.permissions.canEdit)!.id)}&resolve=1`,
                              )
                            }
                          >
                            Resolve
                          </button>
                        )}
                    </div>
                  </section>
                  <section className={`${card} flex min-h-36 flex-col justify-between`}>
                    <div className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
                      Scheduled commitments{" "}
                      <span className="rounded-md bg-[var(--sage)] px-2 py-1 normal-case tracking-normal text-[var(--ink)]">
                        Upcoming
                      </span>
                    </div>
                    <div className="mt-3 text-3xl font-bold tabular-nums">
                      {money(summary.scheduledTotal, summary.currency)}
                    </div>
                    <div className="mt-3 flex justify-between gap-2 border-t border-[var(--line)] pt-3 text-xs text-[var(--muted)]">
                      <span>{summary.scheduledCount} scheduled</span>
                      <span>{bucket.timezone}</span>
                    </div>
                  </section>
                </div>
              )}
              {view === "expenses" && (
                <form className="flex flex-col gap-3" onSubmit={applyFilters}>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex min-w-48 flex-1 items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3">
                      <Search size={14} className="text-[var(--muted)]" />
                      <input
                        className="!h-8 w-full !border-0 !bg-white text-sm !outline-none !shadow-none dark:!bg-[var(--surface)]"
                        name="q"
                        placeholder="Search description, merchant, or notes..."
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className={action}
                      onClick={() => setFiltersOpen((open) => !open)}
                      aria-expanded={filtersOpen}
                    >
                      <SlidersHorizontal size={16} /> Filters{" "}
                      {appliedFilters && (
                        <span className="rounded-full bg-[var(--ink)] px-1.5 text-[var(--surface)]">
                          {new URLSearchParams(appliedFilters).size}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className={action}
                      disabled
                      title="CSV export arrives in a later phase"
                    >
                      <Download size={16} /> Export
                    </button>
                  </div>
                  {filtersOpen && (
                    <div className={`${card} grid gap-3 sm:grid-cols-2 lg:grid-cols-4`}>
                      <div className="flex items-center justify-between sm:col-span-2 lg:col-span-4">
                        <h2 className="text-base">Filter ledger items</h2>
                        <button
                          type="button"
                          className={action}
                          onClick={() => setFiltersOpen(false)}
                          aria-label="Close filters"
                        >
                          <X size={15} />
                        </button>
                      </div>
                      <label className="text-xs">
                        <span className="text-xs font-semibold">Status</span>
                        <Dropdown
                          value={status}
                          onValueChange={setStatus}
                          options={[
                            { value: "all", label: "All statuses" },
                            { value: "actual", label: "Actual" },
                            { value: "scheduled", label: "Scheduled" },
                            { value: "pending_processing", label: "Pending processing" },
                            { value: "conversion_needed", label: "Conversion needed" },
                          ]}
                        />
                      </label>
                      <label className="text-xs">
                        From
                        <input className={field} type="date" name="from" />
                      </label>
                      <label className="text-xs">
                        To
                        <input className={field} type="date" name="to" />
                      </label>
                      <label className="text-xs">
                        Category
                        <Dropdown
                          name="categoryId"
                          defaultValue="all"
                          options={[
                            { value: "all", label: "All categories" },
                            ...options.categories.map((item) => ({
                              value: item.id,
                              label: item.name,
                            })),
                          ]}
                        />
                      </label>
                      <label className="text-xs">
                        Account
                        <Dropdown
                          name="accountId"
                          defaultValue="all"
                          options={[
                            { value: "all", label: "All accounts" },
                            ...options.accounts.map((item) => ({
                              value: item.id,
                              label: item.name,
                            })),
                          ]}
                        />
                      </label>
                      <label className="text-xs">
                        Platform
                        <Dropdown
                          name="platformId"
                          defaultValue="all"
                          options={[
                            { value: "all", label: "All platforms" },
                            ...options.platforms.map((item) => ({
                              value: item.id,
                              label: item.name,
                            })),
                          ]}
                        />
                      </label>
                      <label className="text-xs">
                        Payment mode
                        <Dropdown
                          name="paymentMode"
                          defaultValue="all"
                          options={[{ value: "all", label: "All modes" }, ...paymentModes]}
                        />
                      </label>
                      <label className="text-xs">
                        Paid by
                        <Dropdown
                          name="paidByUserId"
                          defaultValue="all"
                          options={[
                            { value: "all", label: "All members" },
                            ...members.map((item) => ({ value: item.id, label: item.displayName })),
                          ]}
                        />
                      </label>
                      <button className="button primary self-end" type="submit">
                        Apply filters
                      </button>
                    </div>
                  )}
                </form>
              )}
              {view === "expenses" && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                  {(appliedFilters || month) && (
                    <span className="mr-1 font-semibold uppercase tracking-wide">Active:</span>
                  )}
                  {[...new URLSearchParams(appliedFilters).entries()]
                    .filter(([key]) => key !== "q")
                    .map(([key, value]) => {
                      const labels: Record<string, string> = {
                        categoryId: "Category",
                        paidByUserId: "Paid by",
                        accountId: "Account",
                        platformId: "Platform",
                        paymentMode: "Mode",
                        status: "Status",
                        from: "From",
                        toExclusive: "To",
                      };
                      const option = [
                        ...options.categories,
                        ...options.accounts,
                        ...options.platforms,
                      ].find((item) => item.id === value);
                      const member = members.find((item) => item.id === value);
                      return (
                        <button
                          key={key}
                          className="flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-[var(--ink)]"
                          onClick={() => {
                            const next = new URLSearchParams(appliedFilters);
                            next.delete(key);
                            setAppliedFilters(next.toString());
                          }}
                        >
                          {labels[key] ?? key}: {option?.name ?? member?.displayName ?? value}{" "}
                          <X size={12} />
                        </button>
                      );
                    })}
                  {month && (
                    <span className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-[var(--ink)]">
                      Month:{" "}
                      {new Date(`${month}-01T12:00:00`).toLocaleDateString(undefined, {
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                  )}
                  {(appliedFilters || month) && (
                    <button
                      className="ml-1 hover:text-[var(--ink)]"
                      onClick={() => {
                        setAppliedFilters("");
                        setQuery("");
                        setStatus("all");
                        onClearMonth();
                      }}
                    >
                      Clear all
                    </button>
                  )}
                  <span className="ml-auto">
                    Showing {filtered.length} ledger {filtered.length === 1 ? "item" : "items"}
                  </span>
                </div>
              )}
              {view === "deleted" && (
                <div className="flex items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--sage)] p-5 text-sm">
                  <ShieldCheck size={19} className="text-[var(--green)]" />
                  <div>
                    <strong>30-day recovery</strong>
                    <p className="!mt-1 text-xs">
                      Restored items return to the active ledger with their original date and
                      financial effect. Only the creator can restore their records.
                    </p>
                  </div>
                </div>
              )}
              {view === "deleted" && (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg">
                      Items in recovery{" "}
                      <span className="rounded-full bg-[var(--soft)] px-2 text-xs">
                        {expenses.length}
                      </span>
                    </h2>
                    <p className="!mt-1 text-xs">
                      Deleted items are excluded from active spending and are purged after 30 days.
                    </p>
                  </div>
                  <label className="flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3">
                    <Search size={16} />
                    <input
                      className="h-10 border-0 bg-transparent text-xs outline-none"
                      placeholder="Search deleted items"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </label>
                </div>
              )}
              <div className={`${card} overflow-hidden p-0`}>
                {filtered.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[850px] text-left text-sm">
                      <thead className="border-b border-[var(--line)] bg-[var(--canvas)] text-xs uppercase tracking-wide text-[var(--muted)]">
                        <tr>
                          <th className="px-4 py-3">Date</th>
                          <th className="py-3">Description & platform</th>
                          <th className="py-3">Category</th>
                          <th className="py-3">Paid by</th>
                          <th className="py-3">
                            {view === "deleted" ? "Recovery deadline" : "Account & mode"}
                          </th>
                          <th className="py-3 pr-4 text-right">Amount & actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((item) => (
                          <tr
                            key={item.id}
                            className={`border-b border-[var(--line)] last:border-0 ${item.displayStatus === "conversion_needed" ? "bg-amber-50/60 dark:bg-amber-950/20" : item.displayStatus === "scheduled" ? "bg-[var(--soft)]/40" : "hover:bg-[var(--canvas)]"}`}
                          >
                            <td className="whitespace-nowrap px-4 py-4 text-xs text-[var(--muted)]">
                              {new Date(`${item.expenseDate}T12:00:00`).toLocaleDateString(
                                undefined,
                                { day: "2-digit", month: "short", year: "numeric" },
                              )}
                            </td>
                            <td className="max-w-72 py-4 pr-3">
                              <div className="flex items-start gap-3">
                                <span
                                  className={`grid size-9 shrink-0 place-items-center rounded-lg ${item.displayStatus === "conversion_needed" ? "bg-amber-100 text-amber-800 dark:bg-amber-900" : item.refundOfExpenseId ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900" : "bg-[var(--sage)] text-[var(--green)]"}`}
                                >
                                  {item.displayStatus === "conversion_needed" ? (
                                    <RotateCcw size={17} />
                                  ) : item.refundOfExpenseId ? (
                                    <History size={17} />
                                  ) : item.displayStatus === "scheduled" ? (
                                    <Clock3 size={17} />
                                  ) : (
                                    <ReferenceGlyph
                                      kind="categories"
                                      name={item.categoryName}
                                      size={17}
                                    />
                                  )}
                                </span>
                                <div className="min-w-0">
                                  <button
                                    className="max-w-full truncate text-left font-semibold hover:text-[var(--green)]"
                                    onClick={() => navigate("expense", item.id)}
                                  >
                                    {item.description}
                                  </button>
                                  {item.refundOfExpenseId && (
                                    <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
                                      Refund
                                    </span>
                                  )}
                                  {item.displayStatus === "conversion_needed" && (
                                    <span className="mt-1 block w-fit rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900 dark:bg-amber-900 dark:text-amber-200">
                                      Conversion needed
                                    </span>
                                  )}
                                  {item.displayStatus === "scheduled" && (
                                    <span className="mt-1 block w-fit rounded bg-[var(--sage)] px-1.5 py-0.5 text-[10px] font-semibold">
                                      Scheduled
                                    </span>
                                  )}
                                  <div className={muted}>
                                    {view === "deleted" && item.deletedAt
                                      ? `Deleted ${new Date(item.deletedAt).toLocaleDateString()} · `
                                      : ""}
                                    {item.platformName}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="py-4">
                              <span className="rounded-md border border-[var(--line)] bg-[var(--sage)] px-2 py-1 text-xs">
                                {item.categoryName}
                              </span>
                            </td>
                            <td className="py-4">
                              <span className="inline-flex items-center gap-2">
                                <span className="grid size-7 place-items-center rounded-full bg-[var(--sage)] text-xs font-bold">
                                  {item.paidByName.charAt(0)}
                                </span>
                                <span className="max-w-28 truncate text-xs">{item.paidByName}</span>
                              </span>
                            </td>
                            <td className="py-4 text-xs">
                              <span className="block font-medium">
                                {view === "deleted"
                                  ? item.restoreUntil
                                    ? new Date(item.restoreUntil).toLocaleDateString()
                                    : "Expired"
                                  : item.accountName}
                              </span>
                              <span className="text-[var(--muted)]">
                                {view === "deleted"
                                  ? item.restoreUntil
                                    ? `${Math.max(0, Math.ceil((new Date(item.restoreUntil).getTime() - renderTime) / 86_400_000))} days remaining`
                                    : "Recovery unavailable"
                                  : (paymentModes.find((mode) => mode.value === item.paymentMode)
                                    ?.label ?? item.paymentMode)}
                              </span>
                            </td>
                            <td className="py-4 pr-4 text-right font-semibold tabular-nums">
                              <span className={item.refundOfExpenseId ? "text-[var(--green)]" : ""}>
                                {money(item.originalAmount, item.originalCurrency)}
                              </span>
                              {item.displayStatus === "conversion_needed" ? (
                                <span className="block text-xs font-normal italic text-amber-800 dark:text-amber-300">
                                  Excluded from actual spending total
                                </span>
                              ) : item.displayStatus === "scheduled" ? (
                                <span className="block text-xs font-normal text-[var(--muted)]">
                                  Scheduled commitment
                                </span>
                              ) : item.originalCurrency !== item.bucketCurrency ? (
                                <span className={muted}>
                                  {money(item.convertedAmount, item.bucketCurrency)}
                                </span>
                              ) : null}
                              {item.displayStatus === "conversion_needed" &&
                                item.permissions.canEdit && (
                                  <button
                                    className="mt-2 inline-flex items-center gap-1 rounded-md bg-[var(--ink)] px-2 py-1 text-[11px] text-[var(--surface)]"
                                    onClick={() =>
                                      router.push(
                                        `${path(bucket.id, "expense", item.id)}&resolve=1`,
                                      )
                                    }
                                  >
                                    <RotateCcw size={12} /> Resolve conversion
                                  </button>
                                )}
                              {view === "deleted" && item.permissions.canRestore && (
                                <button
                                  className="mt-2 inline-flex items-center gap-1 rounded-md bg-[var(--green)] px-2 py-1 text-[11px] text-[var(--surface)]"
                                  onClick={() => expenseAction(item, "restore")}
                                  disabled={busy}
                                >
                                  <RotateCcw size={12} /> Restore to ledger
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="border-t border-[var(--line)] bg-[var(--canvas)] px-4 py-3 text-xs text-[var(--muted)]">
                      Showing {filtered.length} entries
                      {month && view === "expenses"
                        ? ` for ${new Date(`${month}-01T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}`
                        : ""}
                    </div>
                  </div>
                ) : (
                  <div className="py-14 text-center">
                    <h2>{view === "deleted" ? "Nothing to restore" : "No expenses yet"}</h2>
                    <p className="text-sm">
                      {view === "deleted"
                        ? "Deleted expenses will appear here for 30 days."
                        : "Add your first expense to start your ledger."}
                    </p>
                  </div>
                )}
              </div>
              {cursor && (
                <button
                  className={action}
                  disabled={busy}
                  onClick={async () => {
                    const result = await api<Expense[]>(
                      `buckets/${bucket.id}/expenses?${view === "deleted" ? "deleted=only&" : appliedFilters ? `${appliedFilters}&` : ""}cursor=${cursor}`,
                    );
                    setExpenses((items) => [...items, ...result.data]);
                    setCursor(result.meta.nextCursor ?? null);
                  }}
                >
                  Load more
                </button>
              )}
            </>
          )}
          {view === "add-expense" && (
            <>
              <button className="text-link self-start" onClick={() => navigate("expenses")}>
                <ArrowLeft size={15} /> Back to expenses
              </button>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h1>{refundSource ? "Record linked refund" : "Add expense"}</h1>
                  <p className="mt-1 text-sm">Record spending in {bucket.name}.</p>
                  <p className="mt-2 text-xs text-[var(--muted)]">
                    {bucket.primaryCurrency} base currency ·{" "}
                    {bucket.status === "active" ? "Active" : "Archived"} bucket · {bucket.timezone}
                  </p>
                </div>
                {!refundSource && (
                  <div className="flex rounded-lg border border-[var(--line)] bg-[var(--soft)] p-1 text-xs">
                    <button
                      className={`rounded-md px-3 py-2 ${entryMode === "expense" ? "bg-[var(--surface)] font-semibold shadow-sm" : "text-[var(--muted)]"}`}
                      onClick={() => setEntryMode("expense")}
                    >
                      Expense
                    </button>
                    <button
                      className={`rounded-md px-3 py-2 ${entryMode === "refund" ? "bg-[var(--surface)] font-semibold shadow-sm" : "text-[var(--muted)]"}`}
                      onClick={() => setEntryMode("refund")}
                    >
                      Refund / credit
                    </button>
                  </div>
                )}
              </div>
              {saved && <Notice kind="success">Expense saved. You can add another item.</Notice>}
              {refundSource && (
                <Notice kind="info">
                  Linked to {refundSource.description}. Enter the amount returned; it will be saved
                  as a dated credit.
                </Notice>
              )}
              <form
                key={formVersion}
                ref={expenseFormRef}
                className={`${card} flex flex-col gap-0 overflow-hidden p-0`}
                onChange={() => setConversionEstimate(null)}
                onSubmit={submitExpense}
              >
                {refundSource && (
                  <input type="hidden" name="refundOfExpenseId" value={refundSource.id} />
                )}
                <section className="border-b border-[var(--line)] p-5 sm:p-6">
                  <div className="mb-5 flex items-center justify-between">
                    <h2 className="text-lg">1. Amount</h2>
                    <span className="inline-flex items-center gap-1 text-xs text-[var(--green)]">
                      <CheckCircle2 size={15} /> Non-zero entry required
                    </span>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="flex flex-col gap-1 text-xs font-semibold">
                      Currency *
                      {foreignOpen ? (
                        <Dropdown
                          name="originalCurrency"
                          value={currencyValue}
                          onValueChange={setCurrencyValue}
                          options={currencies
                            .filter((item) => item.code !== bucket.primaryCurrency)
                            .map((item) => ({
                              value: item.code,
                              label: `${item.code} · ${item.name}`,
                            }))}
                        />
                      ) : (
                        <>
                          <input
                            type="hidden"
                            name="originalCurrency"
                            value={bucket.primaryCurrency}
                          />
                          <span
                            className={`${field} flex items-center justify-between bg-[var(--soft)] h-11.5`}
                          >
                            <span>{bucket.primaryCurrency} (base)</span>
                            <ShieldCheck size={15} />
                          </span>
                        </>
                      )}
                      <span className={muted}>Bucket baseline currency is locked.</span>
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-semibold">
                      Amount *
                      <input
                        className={field}
                        name="originalAmount"
                        defaultValue={
                          refundSource ? refundSource.originalAmount.replace(/^-/, "") : undefined
                        }
                        inputMode="decimal"
                        required
                        placeholder="0.00"
                      />
                      <span className={muted}>
                        {entryMode === "refund"
                          ? "Enter the positive amount returned; we record it as a credit."
                          : "Enter the amount paid, greater than zero."}
                      </span>
                    </label>
                  </div>
                  <label className="mt-4 flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--soft)] p-3 text-xs">
                    <input
                      type="checkbox"
                      checked={foreignOpen}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setForeignOpen(checked);
                        setCurrencyValue(
                          checked
                            ? (currencies.find((item) => item.code !== bucket.primaryCurrency)
                              ?.code ?? bucket.primaryCurrency)
                            : bucket.primaryCurrency,
                        );
                      }}
                    />{" "}
                    Spent in foreign currency?
                  </label>
                  {foreignOpen && (
                    <details
                      open
                      className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--soft)] p-3 text-xs"
                    >
                      <summary className="cursor-pointer font-semibold">
                        Foreign currency conversion
                      </summary>
                      <p className="mt-2 text-xs">
                        We look up the rate for the expense date. If no rate is available, enter
                        either a converted amount or a rate to finalize the record.
                      </p>
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <label className="flex flex-col gap-1 font-semibold">
                          Manual {bucket.primaryCurrency} amount
                          <input
                            className={field}
                            name="convertedAmount"
                            inputMode="decimal"
                            placeholder="Optional converted amount"
                          />
                        </label>
                        <label className="flex flex-col gap-1 font-semibold">
                          Exchange rate
                          <input
                            className={field}
                            name="manualRate"
                            inputMode="decimal"
                            placeholder="Optional rate"
                          />
                        </label>
                      </div>
                      <button
                        type="button"
                        className={`${action} mt-3`}
                        disabled={busy}
                        onClick={previewConversion}
                      >
                        Preview conversion
                      </button>
                      {conversionEstimate && (
                        <p className="mt-2 text-xs">
                          {conversionEstimate.convertedAmount
                            ? `${money(conversionEstimate.convertedAmount, conversionEstimate.bucketCurrency)} · rate ${conversionEstimate.rate} (${conversionEstimate.rateDate})`
                            : "No rate available. Enter a manual amount or rate."}
                        </p>
                      )}
                    </details>
                  )}
                </section>
                <section className="border-b border-[var(--line)] p-5 sm:p-6">
                  <h2 className="!mb-5 text-lg">2. Date and details</h2>
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="flex flex-col gap-1 text-xs font-semibold">
                      Date ({bucket.timezone}) *
                      <input
                        className={field}
                        type="date"
                        name="expenseDate"
                        defaultValue={today(bucket.timezone)}
                        required
                      />
                      <span className={muted}>
                        Future dates are recorded as scheduled commitments.
                      </span>
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-semibold">
                      Description *
                      <input
                        className={field}
                        name="description"
                        defaultValue={
                          refundSource ? `Refund: ${refundSource.description}` : undefined
                        }
                        maxLength={160}
                        required
                        placeholder="What was this for?"
                      />
                      <span className={muted}>
                        A clear title makes this item easy to find later.
                      </span>
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-semibold md:col-span-2">
                      Category *
                      <Dropdown
                        name="categoryId"
                        defaultValue={refundSource?.categoryId}
                        options={options.categories
                          .filter((item) => item.state === "active")
                          .map((item) => ({ value: item.id, label: item.name }))}
                        placeholder="Choose a category"
                      />
                      <span className={muted}>Select one category for reporting and budgets.</span>
                    </label>
                  </div>
                </section>
                <section className="border-b border-[var(--line)] p-5 sm:p-6">
                  <h2 className="!mb-5 text-lg">3. Payment</h2>
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="flex flex-col gap-1 text-xs font-semibold">
                      Platform / merchant
                      <Dropdown
                        name="platformId"
                        defaultValue={
                          refundSource?.platformId ??
                          options.platforms.find((item) => item.systemKey === "other")?.id
                        }
                        options={options.platforms
                          .filter((item) => item.state === "active")
                          .map((item) => ({ value: item.id, label: item.name }))}
                        placeholder="Other"
                      />
                      <span className={muted}>Where this expense happened; defaults to Other.</span>
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-semibold">
                      Payment account *
                      <Dropdown
                        name="accountId"
                        defaultValue={refundSource?.accountId}
                        options={options.accounts
                          .filter((item) => item.state === "active")
                          .map((item) => ({ value: item.id, label: item.name }))}
                        placeholder="Choose an account"
                      />
                      <span className={muted}>
                        An owner-governed account name, with no bank connection.
                      </span>
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-semibold">
                      Payment mode *
                      <Dropdown
                        name="paymentMode"
                        defaultValue={refundSource?.paymentMode}
                        options={paymentModes}
                        placeholder="Choose a mode"
                      />
                    </label>
                  </div>
                </section>
                <section className="p-5 sm:p-6">
                  <h2 className="!mb-5 text-lg">4. Payer and notes</h2>
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="flex flex-col gap-1 text-xs font-semibold">
                      Paid by *
                      <Dropdown
                        name="paidByUserId"
                        defaultValue={refundSource?.paidByUserId ?? profile.id}
                        options={members.map((item) => ({
                          value: item.id,
                          label: item.displayName,
                        }))}
                      />
                      <span className={muted}>
                        Identifies who paid. It does not create a debt or split.
                      </span>
                    </label>
                    <div className="flex flex-col gap-1 text-xs font-semibold">
                      Added by
                      <span
                        className={`${field} flex items-center gap-2 bg-[var(--soft)] text-[var(--muted)]`}
                      >
                        <ShieldCheck size={15} /> {profile.displayName} · current user
                      </span>
                    </div>
                    <label className="flex flex-col gap-1 text-xs font-semibold md:col-span-2">
                      Notes (optional)
                      <textarea
                        className={field}
                        name="notes"
                        maxLength={2000}
                        rows={3}
                        placeholder="Add itemized notes or references"
                      />
                      <span className={muted}>Notes remain with this ledger record.</span>
                    </label>
                  </div>
                </section>
                <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-[var(--line)] bg-[var(--canvas)] p-4 sm:px-6">
                  <button type="button" className={action} onClick={() => navigate("expenses")}>
                    Cancel
                  </button>
                  <button
                    className="button secondary"
                    disabled={
                      busy ||
                      bucket.status !== "active" ||
                      !options.accounts.some((item) => item.state === "active")
                    }
                    onClick={() => {
                      saveAnother.current = true;
                    }}
                  >
                    Save & add another
                  </button>
                  <button
                    className="button primary"
                    disabled={
                      busy ||
                      bucket.status !== "active" ||
                      !options.accounts.some((item) => item.state === "active")
                    }
                    onClick={() => {
                      saveAnother.current = false;
                    }}
                  >
                    <CheckCircle2 size={16} /> {busy ? "Saving…" : "Save expense"}
                  </button>
                </footer>
              </form>
              {!options.accounts.some((item) => item.state === "active") && (
                <Notice kind="info">
                  {bucket.isOwner ? (
                    <>
                      Create an account in{" "}
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => navigate("references")}
                      >
                        Reference settings
                      </button>{" "}
                      before adding an expense.
                    </>
                  ) : (
                    "Ask the bucket owner to add an account before recording expenses."
                  )}
                </Notice>
              )}
            </>
          )}
          {view === "expense" && expense && (
            <>
              <button className="text-link self-start" onClick={() => navigate("expenses")}>
                <ArrowLeft size={15} /> Back to expenses
              </button>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className="eyebrow">
                    {expense.displayStatus === "actual"
                      ? "RECORDED ON LEDGER"
                      : expense.displayStatus.replaceAll("_", " ").toUpperCase()}
                  </span>
                  <h1 className="mt-2">Expense details</h1>
                </div>
                <div className="flex gap-2">
                  {expense.permissions.canEdit && (
                    <button className={action} onClick={() => setEditing((value) => !value)}>
                      Edit
                    </button>
                  )}
                  {expense.displayStatus !== "deleted" && bucket.status === "active" && (
                    <button
                      className={action}
                      onClick={() =>
                        router.push(`${path(bucket.id, "add-expense")}&refundOf=${expense.id}`)
                      }
                    >
                      Record refund
                    </button>
                  )}
                  {expense.permissions.canDelete && (
                    <button
                      className={action}
                      disabled={busy}
                      onClick={() => setDeleteTarget(expense)}
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  )}
                  {expense.permissions.canRestore && (
                    <button
                      className={action}
                      disabled={busy}
                      onClick={() => expenseAction(expense, "restore")}
                    >
                      Restore
                    </button>
                  )}
                </div>
              </div>
              <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
                <section className={`${card} lg:col-start-1 ${editing ? "hidden" : ""}`}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <span className="rounded-md bg-[var(--sage)] px-2 py-1 text-[11px] font-semibold capitalize">
                        {expense.displayStatus.replaceAll("_", " ")}
                      </span>
                      <h2 className="mt-4 text-2xl">{expense.description}</h2>
                      <p className="mt-2 text-xs">Created by {expense.addedByName}</p>
                    </div>
                    <div className="text-right">
                      <div className="text-xs uppercase tracking-wide text-[var(--muted)]">
                        Total transaction
                      </div>
                      <strong className="mt-1 block text-3xl tabular-nums">
                        {money(expense.originalAmount, expense.originalCurrency)}
                      </strong>
                      {expense.originalCurrency !== expense.bucketCurrency && (
                        <span className="text-xs text-[var(--muted)]">
                          {money(expense.convertedAmount, expense.bucketCurrency)} in{" "}
                          {expense.bucketCurrency}
                        </span>
                      )}
                    </div>
                  </div>
                  {expense.notes && (
                    <div className="mt-5 rounded-lg bg-[var(--soft)] p-4">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                        Operational note
                      </span>
                      <p className="mt-1 whitespace-pre-wrap text-sm">{expense.notes}</p>
                    </div>
                  )}
                  {expense.displayStatus === "conversion_needed" && expense.permissions.canEdit && (
                    <button className="button primary mt-4" onClick={() => setEditing(true)}>
                      <RotateCcw size={16} /> Resolve conversion
                    </button>
                  )}
                </section>
                {editing ? (
                  <ExpenseEditor
                    bucket={bucket}
                    expense={expense}
                    options={options}
                    members={members}
                    onSaved={async () => {
                      setEditing(false);
                      setExpense(
                        (await api<Expense>(`buckets/${bucket.id}/expenses/${expense.id}`)).data,
                      );
                      setActivity(
                        (
                          await api<typeof activity>(
                            `buckets/${bucket.id}/expenses/${expense.id}/activity`,
                          )
                        ).data,
                      );
                    }}
                  />
                ) : (
                  <section className={`${card} grid gap-3 sm:grid-cols-2 lg:col-start-1`}>
                    <h2 className="border-b border-[var(--line)] pb-3 text-lg sm:col-span-2">
                      Key specifications
                    </h2>
                    {[
                      ["Date", new Date(`${expense.expenseDate}T12:00:00`).toLocaleDateString()],
                      ["Paid by", expense.paidByName],
                      ["Added by / creator", expense.addedByName],
                      ["Category", expense.categoryName],
                      ["Platform / merchant", expense.platformName],
                      ["Payment account", expense.accountName],
                      [
                        "Payment mode",
                        paymentModes.find((mode) => mode.value === expense.paymentMode)?.label ??
                        expense.paymentMode,
                      ],
                      [
                        "Currency & conversion",
                        `${money(expense.originalAmount, expense.originalCurrency)} · ${money(expense.convertedAmount, expense.bucketCurrency)}`,
                      ],
                    ].map(([name, value]) => (
                      <div key={name} className="min-w-0 rounded-lg bg-[var(--soft)] p-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                          {name}
                        </div>
                        <div className="mt-1 break-words text-sm font-semibold">{value}</div>
                      </div>
                    ))}
                  </section>
                )}
                <section
                  className={`${card} lg:col-start-2 lg:row-span-4 lg:row-start-1 ${editing ? "hidden" : ""}`}
                >
                  <h2 className="mb-4 flex items-center gap-2">
                    <MessageCircle size={20} /> Comments & ledger notes{" "}
                    <span className="rounded-full bg-[var(--soft)] px-2 text-xs">
                      {comments.length}
                    </span>
                  </h2>
                  <p className="mb-4 text-xs">
                    All current bucket members can participate in this discussion.
                  </p>
                  <div className="flex flex-col gap-4">
                    {comments.map((comment) => (
                      <div key={comment.id} className="rounded-lg bg-[var(--soft)] p-4">
                        <div className="flex justify-between gap-2">
                          <strong className="text-sm">{comment.authorName}</strong>
                          <span className={muted}>
                            {new Date(comment.createdAt).toLocaleString()}
                          </span>
                        </div>
                        {editingComment?.id === comment.id ? (
                          <div className="mt-2 space-y-2">
                            <textarea
                              className={field}
                              maxLength={2000}
                              rows={3}
                              value={editingCommentBody}
                              onChange={(event) => setEditingCommentBody(event.target.value)}
                            />
                            <div className="flex gap-2">
                              <button
                                className="button primary small"
                                disabled={busy || !editingCommentBody.trim()}
                                onClick={async () => {
                                  if (
                                    await mutation(
                                      `buckets/${bucket.id}/expenses/${expense.id}/comments/${comment.id}`,
                                      "PATCH",
                                      { body: editingCommentBody.trim() },
                                      comment.revision,
                                    )
                                  ) {
                                    setComments(
                                      (
                                        await api<Comment[]>(
                                          `buckets/${bucket.id}/expenses/${expense.id}/comments`,
                                        )
                                      ).data,
                                    );
                                    setEditingComment(null);
                                  }
                                }}
                              >
                                Save comment
                              </button>
                              <button className={action} onClick={() => setEditingComment(null)}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <p className="whitespace-pre-wrap text-sm">{comment.body}</p>
                        )}
                        {comment.canEdit && editingComment?.id !== comment.id && (
                          <button
                            className="text-link text-xs"
                            onClick={() => {
                              setEditingComment(comment);
                              setEditingCommentBody(comment.body);
                            }}
                          >
                            Edit
                          </button>
                        )}
                        {comment.canEdit && editingComment?.id !== comment.id && (
                          <button
                            className="ml-3 text-xs text-[var(--error)]"
                            onClick={() => setCommentDeleteTarget(comment)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    ))}
                    {comments.length === 0 && <p>No comments yet.</p>}
                  </div>
                  {expense.permissions.canComment && (
                    <form className="mt-5 flex flex-col gap-3" onSubmit={postComment}>
                      <textarea
                        className={field}
                        name="body"
                        rows={3}
                        maxLength={2000}
                        required
                        placeholder="Add a comment or operational note for bucket members..."
                      />
                      <button className="button primary self-end" disabled={busy}>
                        Post comment
                      </button>
                    </form>
                  )}
                </section>
                {expense.refundOfExpenseId && (
                  <section className={`${card} lg:col-start-1 ${editing ? "hidden" : ""}`}>
                    <h2 className="mb-2">Linked original expense</h2>
                    <button
                      className="text-link"
                      onClick={() => navigate("expense", expense.refundOfExpenseId!)}
                    >
                      View original expense
                    </button>
                  </section>
                )}
                {refunds.length > 0 && (
                  <section className={`${card} lg:col-start-1 ${editing ? "hidden" : ""}`}>
                    <h2 className="mb-4 flex items-center gap-2">
                      <History size={18} /> Linked refunds & credits{" "}
                      <span className="rounded-full bg-[var(--soft)] px-2 text-xs">
                        {refunds.length}
                      </span>
                    </h2>
                    <div className="flex flex-col gap-3">
                      {refunds.map((refund) => (
                        <button
                          key={refund.id}
                          className="flex w-full items-center justify-between gap-4 rounded-lg bg-[var(--soft)] p-4 text-left"
                          onClick={() => navigate("expense", refund.id)}
                        >
                          <span>
                            <strong className="text-sm">{refund.description}</strong>
                            <span className={`block ${muted}`}>
                              {new Date(`${refund.expenseDate}T12:00:00`).toLocaleDateString()}
                            </span>
                          </span>
                          <strong className="text-sm">
                            {money(refund.originalAmount, refund.originalCurrency)}
                          </strong>
                        </button>
                      ))}
                    </div>
                    <p className="mt-3 text-xs">
                      Refunds are separate dated records; the original amount stays unchanged.
                    </p>
                  </section>
                )}
                <section className={`${card} lg:col-start-1 ${editing ? "hidden" : ""}`}>
                  <h2 className="mb-4 flex items-center gap-2">
                    <History size={18} /> Activity history{" "}
                    <span className="rounded-full bg-[var(--soft)] px-2 text-xs">
                      {activity.length} events
                    </span>
                  </h2>
                  <div className="flex flex-col gap-3">
                    {activity.map((event) => (
                      <div key={event.id} className="border-l-2 border-[var(--green)] pl-4">
                        <strong className="text-sm capitalize">
                          {event.action.replace("expense.", "").replaceAll("_", " ")}
                        </strong>
                        <p className="text-xs">
                          {event.actorName} · {new Date(event.occurredAt).toLocaleString()}
                        </p>
                        {event.changedFields.length > 0 && (
                          <p className="text-xs">Updated {event.changedFields.join(", ")}</p>
                        )}
                      </div>
                    ))}
                    {activity.length === 0 && <p>No activity recorded yet.</p>}
                  </div>
                </section>
              </div>
            </>
          )}
          {view === "references" && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className="eyebrow">ACCESS & GOVERNANCE</span>
                  <h1 className="mt-2">Reference settings</h1>
                  <p className="!mt-1 max-w-2xl text-sm">
                    Manage shared accounts, expense categories, and merchant platforms for{" "}
                    {bucket.name}. Active references can be used across all expenses.
                  </p>
                </div>
                <span className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--soft)] px-3 py-2 text-xs font-semibold">
                  <ShieldCheck size={15} /> Owner controlled
                </span>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--sage)] p-5 text-sm">
                <CheckCircle2 size={20} className="text-[var(--green)]" />
                <div>
                  <strong>Case-insensitive uniqueness & archival rule</strong>
                  <p className="!mt-1 text-xs">
                    Reference names are unique regardless of letter case. Used references are
                    archived instead of deleted so historical expenses remain accurate.
                  </p>
                </div>
              </div>
              {groups.map((group) => (
                <section className={card} key={group.key}>
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
                    <div>
                      <h2 className="flex items-center gap-2">
                        <span>{group.key === "accounts"
                          ? "Payment accounts"
                          : group.key === "categories"
                            ? "Expense categories"
                            : "Platforms & merchants"}{" "}</span>
                        <span className="rounded-full bg-[var(--soft)] px-2 py-1 text-xs text-[var(--muted)]">
                          {options[group.key].filter((item) => item.state === "active").length}{" "}
                          active
                        </span>
                      </h2>
                      <p className="!mt-1 text-xs">
                        {group.key === "accounts"
                          ? "User-governed names for payment sources. There are no bank connections or live balances."
                          : group.key === "categories"
                            ? "Categories group expenses for reporting and budgets."
                            : "Named merchants and venues. An unselected platform defaults to Other."}
                      </p>
                    </div>
                    {bucket.isOwner && bucket.status === "active" && (
                      <button
                        type="button"
                        className="button primary small"
                        onClick={() =>
                          setAddingOption(addingOption === group.key ? null : group.key)
                        }
                        aria-expanded={addingOption === group.key}
                      >
                        <Plus size={16} /> Add{" "}
                        {group.key === "accounts"
                          ? "payment account"
                          : group.key === "categories"
                            ? "category"
                            : "platform"}
                      </button>
                    )}
                  </div>
                  <div
                    className={
                      group.key === "categories"
                        ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
                        : "grid gap-1"
                    }
                  >
                    {options[group.key].length > 0 ? options[group.key].map((item) => (
                      <div
                        key={item.id}
                        className={`relative flex min-w-0 items-center justify-between gap-3 rounded-lg ${group.key === "categories" ? "border border-[var(--line)] bg-[var(--soft)] p-3" : "border-b border-[var(--line)] px-1 py-3 last:border-0"}`}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--sage)] text-[var(--green)]">
                            <ReferenceGlyph
                              kind={group.key}
                              name={item.name}
                              iconKey={item.iconKey}
                            />
                          </span>
                          <div className="min-w-0">
                            <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-semibold">
                              {editingOptionId === item.id ? (
                                <input
                                  className={`${field} max-w-56`}
                                  value={editingOptionName}
                                  onChange={(event) => setEditingOptionName(event.target.value)}
                                  maxLength={80}
                                  aria-label={`Rename ${item.name}`}
                                />
                              ) : (
                                <span className="truncate">{item.name}</span>
                              )}
                              {group.key !== "categories" && (
                                <span
                                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${item.state === "active" ? "bg-[var(--sage)] text-[var(--green)]" : "bg-[var(--soft)] text-[var(--muted)]"}`}
                                >
                                  {item.systemKey === "other"
                                    ? "Permanent fallback"
                                    : item.state === "active"
                                      ? "Active"
                                      : "Archived"}
                                </span>
                              )}
                            </div>
                            <div className={muted}>
                              {item.usageCount === 0
                                ? "No expenses yet"
                                : `${item.usageCount} expenses logged`}
                              {item.ownerLabel ? ` · ${item.ownerLabel}` : ""}
                            </div>
                          </div>
                        </div>
                        {bucket.isOwner &&
                          bucket.status === "active" &&
                          group.key === "categories" &&
                          editingOptionId !== item.id && (
                            <details className="group shrink-0">
                              <summary
                                className="grid size-9 cursor-pointer list-none place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--sage)] hover:text-[var(--ink)]"
                                aria-label={`Actions for ${item.name}`}
                              >
                                <MoreVertical size={17} />
                              </summary>
                              <div className="absolute right-2 top-12 z-20 flex min-w-36 flex-col rounded-xl border border-[var(--line)] bg-[var(--surface)] p-1 shadow-lg">
                                <button
                                  className="rounded-lg px-3 py-2 text-left text-xs hover:bg-[var(--soft)]"
                                  onClick={() => {
                                    setEditingOptionId(item.id);
                                    setEditingOptionName(item.name);
                                  }}
                                >
                                  Edit
                                </button>
                                <button
                                  className="rounded-lg px-3 py-2 text-left text-xs hover:bg-[var(--soft)]"
                                  disabled={busy}
                                  onClick={() =>
                                    optionAction(
                                      item,
                                      group.key,
                                      item.state === "active" ? "archive" : "restore",
                                    )
                                  }
                                >
                                  {item.state === "active" ? "Archive" : "Restore"}
                                </button>
                                {item.usageCount === 0 && !item.systemKey && (
                                  <button
                                    className="rounded-lg px-3 py-2 text-left text-xs text-[var(--error)] hover:bg-[var(--error-bg)]"
                                    disabled={busy}
                                    onClick={() =>
                                      setDeleteOptionTarget({ option: item, kind: group.key })
                                    }
                                  >
                                    Delete unused
                                  </button>
                                )}
                              </div>
                            </details>
                          )}
                        {bucket.isOwner &&
                          bucket.status === "active" &&
                          (group.key !== "categories" || editingOptionId === item.id) && (
                            <div className="flex flex-wrap justify-end gap-1">
                              {editingOptionId === item.id ? (
                                <>
                                  <button
                                    className={action}
                                    disabled={busy || !editingOptionName.trim()}
                                    onClick={() =>
                                      void renameOption(item, group.key, editingOptionName)
                                    }
                                  >
                                    Save
                                  </button>
                                  <button
                                    className={action}
                                    onClick={() => setEditingOptionId(null)}
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <button
                                  className={action}
                                  disabled={busy}
                                  onClick={() => {
                                    setEditingOptionId(item.id);
                                    setEditingOptionName(item.name);
                                  }}
                                >
                                  Edit
                                </button>
                              )}
                              {group.key !== "categories" && (
                                <button
                                  className={action}
                                  disabled={busy || item.systemKey === "other"}
                                  onClick={() =>
                                    optionAction(
                                      item,
                                      group.key,
                                      item.state === "active" ? "archive" : "restore",
                                    )
                                  }
                                >
                                  {item.state === "active" ? "Archive" : "Restore"}
                                </button>
                              )}
                              {group.key !== "categories" &&
                                item.usageCount === 0 &&
                                !item.systemKey && (
                                  <button
                                    className={action}
                                    disabled={busy}
                                    onClick={() =>
                                      setDeleteOptionTarget({ option: item, kind: group.key })
                                    }
                                  >
                                    Delete
                                  </button>
                                )}
                            </div>
                          )}
                      </div>
                    )) : (
                      <span></span>
                    )}
                  </div>
                  {bucket.isOwner && bucket.status === "active" && addingOption === group.key && (
                    <form
                      className="mt-5 flex flex-wrap gap-2 border-t border-[var(--line)] pt-4"
                      onSubmit={(event) => addOption(event, group.key)}
                    >
                      <input
                        className={`${field} max-w-64`}
                        name="name"
                        required
                        maxLength={80}
                        placeholder={`New ${group.key.slice(0, -1)}`}
                      />
                      {group.key === "accounts" && (
                        <input
                          className={`${field} max-w-48`}
                          name="ownerLabel"
                          maxLength={80}
                          placeholder="Owner label (optional)"
                        />
                      )}
                      <button className="button primary" disabled={busy}>
                        <Plus size={15} /> Add
                      </button>
                    </form>
                  )}
                </section>
              ))}
            </>
          )}
          {view === "members" && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className="eyebrow">ACCESS & GOVERNANCE</span>
                  <h1 className="mt-2">Members & invitations</h1>
                  <p className="!mt-1 max-w-2xl text-sm">
                    Manage collaborators and shared access to {bucket.name}. Anyone with an active
                    7-day link can join after signing in.
                  </p>
                </div>
                <span className="rounded-full border border-[var(--line)] bg-[var(--soft)] px-4 py-2 text-xs font-semibold">
                  {members.length} active members ·{" "}
                  {invitations.filter((item) => item.status === "active").length} active links
                </span>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--sage)] p-5 text-sm">
                <ShieldCheck size={20} className="text-[var(--green)]" />
                <div>
                  <strong>Pseudonymous ledger security</strong>
                  <p className="!mt-1 text-xs">
                    Members appear in the shared ledger by display name. Private email and phone
                    directories are not exposed to other members.
                  </p>
                </div>
              </div>
              <section className={card}>
                <h2 className="pb-2 flex items-center gap-2 !leading-1">
                  <span className="leading-1">Bucket members</span>
                  <span className="rounded-full bg-[var(--soft)] px-2 text-xs">
                    {members.length}
                  </span>
                </h2>
                <p className="text-xs">Members can record expenses, view the ledger, and participate in comments. Only the owner can remove members or manage invitations.</p>
                <div className="flex flex-col gap-2">
                  {members.map((member) => (
                    <div
                      key={member.id}
                      className="flex items-center justify-between gap-3 border-b border-[var(--line)] py-3 last:border-0"
                    >
                      <div className="flex items-center gap-3">
                        <span className="grid size-10 place-items-center rounded-full bg-[var(--sage)] text-xs font-semibold">
                          {member.displayName
                            .split(" ")
                            .map((part) => part.charAt(0))
                            .slice(0, 2)
                            .join("")}
                        </span>
                        <div>
                          <strong className="text-sm">
                            {member.displayName}
                            {member.id === profile.id ? " (You)" : ""}
                          </strong>
                          <div className={muted}>
                            {member.isOwner ? "Owner" : "Member"} · Joined{" "}
                            {new Date(member.joinedAt).toLocaleDateString()}
                          </div>
                        </div>
                      </div>
                      {member.isOwner && (
                        <span className="rounded-full bg-[var(--sage)] px-2 py-1 text-xs text-[var(--green)] flex items-center gap-1">
                          <LockKeyhole size={10} /> Owner
                        </span>
                      )}
                      {bucket.isOwner && !member.isOwner && bucket.status === "active" && (
                        <button
                          className={action}
                          disabled={busy}
                          onClick={() => setRemoveMemberTarget(member)}
                        >
                          <Trash2 size={12} /> Remove
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
              {bucket.isOwner && (
                <section className={card}>
                  <div className="flex items-center justify-between gap-3 pb-6">
                    <div>
                      <h2 className="text-lg">Active invitation links</h2>
                      <p className="mb-4 !mt-1 text-xs">Invitation links are valid for seven days and can be used by multiple people.
                        The full secret link is shown only when it is created.</p>
                    </div>
                    {bucket.status === "active" && (
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={async () => {
                          const invitation = await mutation<Invitation>(
                            `buckets/${bucket.id}/invitations`,
                            "POST",
                            {},
                          );
                          if (invitation) {
                            setNewInvitation(invitation);
                            await refresh();
                          }
                        }}
                      >
                        <Plus size={15} /> Create invitation link
                      </button>
                    )}
                  </div>
                  {newInvitation?.shareUrl && (
                    <div className="mb-5 flex flex-wrap items-center gap-5 rounded-xl border border-[var(--line)] bg-[var(--soft)] p-4">
                      <div className="min-w-0 flex-1">
                        <p className="mb-2 text-xs font-semibold">
                          New invitation link · expires in 7 days
                        </p>
                        <input
                          className={field}
                          readOnly
                          value={newInvitation.shareUrl}
                          onFocus={(event) => event.target.select()}
                        />
                        <div className="mt-2 flex gap-2">
                          <button
                            className={action}
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(newInvitation.shareUrl!);
                              } catch {
                                setError("Copy the link from the field above.");
                              }
                            }}
                          >
                            <Copy size={14} /> Copy
                          </button>
                          <button className={action} onClick={() => setShowInviteQr(true)}>
                            QR code
                          </button>
                          <a
                            className={action}
                            href={`https://wa.me/?text=${encodeURIComponent(`Join my Buckit bucket:\n${newInvitation.shareUrl}`)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Share via WhatsApp
                          </a>
                        </div>
                      </div>
                    </div>
                  )}
                  {newInvitation?.shareUrl && (
                    <p className="mb-5 text-xs text-[var(--muted)]">
                      Security note: copy this link now. It is permanently masked after you leave or
                      refresh this page.
                    </p>
                  )}
                  <div className="flex flex-col gap-2">
                    <div className="hidden grid-cols-[1.1fr_1fr_1fr_1fr_auto] gap-3 border-b border-[var(--line)] pb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)] sm:grid">
                      <span>Invitation</span>
                      <span>Created by</span>
                      <span>Type</span>
                      <span>Expires On</span>
                      <span>Action</span>
                    </div>
                    {invitations.map((invitation) => {
                      if(invitation.status !== "revoked") return (
                        <div
                          key={invitation.id}
                          className="grid gap-2 border-b border-[var(--line)] py-3 text-xs last:border-0 sm:grid-cols-[1.1fr_1fr_1fr_1fr_auto] sm:items-center sm:gap-3"
                        >
                          <strong>Link ••••{invitation.id.slice(-4)}</strong>
                          <span>{invitation.createdByName}</span>
                          <span>7-day multi-use</span>
                          <span
                            className={
                              invitation.status === "active"
                                ? "text-[var(--green)]"
                                : "text-[var(--muted)]"
                            }
                          >
                            {invitation.status === "active"
                              ? `Expires ${new Date(invitation.expiresAt).toLocaleDateString()}`
                              : invitation.status}
                          </span>
                          {invitation.status === "active" && (
                            <button
                              className={action}
                              disabled={busy}
                              onClick={async () => {
                                if (
                                  await mutation(
                                    `buckets/${bucket.id}/invitations/${invitation.id}`,
                                    "DELETE",
                                    undefined,
                                    invitation.revision,
                                  )
                                )
                                  await refresh();
                              }}
                            >
                              Revoke link
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </section>
              )}
            </>
          )}
        </>
      )}
      {!loading && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--sage)] p-4 text-xs text-[var(--muted)]">
          <ShieldCheck size={18} className="text-[var(--green)]" />
          <span>
            Only current members of this bucket can access its spending. Your other buckets stay
            separate.
          </span>
        </div>
      )}
      {deleteTarget && (
        <Dialog title="Delete this expense?" onClose={() => setDeleteTarget(null)}>
          <div className="space-y-4 text-sm">
            <p>
              Deleting moves this expense into recovery for 30 days. Only its creator can restore
              it. Its discussion is hidden while deleted.
            </p>
            <div className="rounded-lg bg-[var(--soft)] p-4 font-semibold">
              {deleteTarget.description} ·{" "}
              {money(deleteTarget.originalAmount, deleteTarget.originalCurrency)}
            </div>
            <div className="flex justify-end gap-2">
              <button className={action} onClick={() => setDeleteTarget(null)}>
                Cancel
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => {
                  void expenseAction(deleteTarget, "delete");
                  setDeleteTarget(null);
                }}
              >
                <Trash2 size={15} /> Delete expense
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {showInviteQr && newInvitation?.shareUrl && (
        <Dialog title="Scan to join" onClose={() => setShowInviteQr(false)}>
          <div className="flex flex-col items-center gap-4 p-3 text-center">
            <p className="text-xs">Scan this code to join {bucket.name} after signing in.</p>
            <QRCodeSVG value={newInvitation.shareUrl} size={220} title="Invitation QR code" />
            <button className="button primary" onClick={() => setShowInviteQr(false)}>
              Done
            </button>
          </div>
        </Dialog>
      )}
      {commentDeleteTarget && expense && (
        <Dialog title="Delete this comment?" onClose={() => setCommentDeleteTarget(null)}>
          <div className="space-y-4 text-sm">
            <p>
              This comment will be deleted permanently. The expense’s 30-day recovery period does
              not apply to individual comments.
            </p>
            <div className="rounded-lg bg-[var(--soft)] p-4 text-xs">
              {commentDeleteTarget.body}
            </div>
            <div className="flex justify-end gap-2">
              <button className={action} onClick={() => setCommentDeleteTarget(null)}>
                Cancel
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={async () => {
                  const target = commentDeleteTarget;
                  if (
                    await mutation(
                      `buckets/${bucket.id}/expenses/${expense.id}/comments/${target.id}`,
                      "DELETE",
                      undefined,
                      target.revision,
                    )
                  ) {
                    setComments(
                      (await api<Comment[]>(`buckets/${bucket.id}/expenses/${expense.id}/comments`))
                        .data,
                    );
                    setCommentDeleteTarget(null);
                  }
                }}
              >
                Delete permanently
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {removeMemberTarget && (
        <Dialog title="Remove member?" onClose={() => setRemoveMemberTarget(null)}>
          <div className="space-y-4 text-sm">
            <p>
              {removeMemberTarget.displayName} will lose access to {bucket.name}. Existing ledger
              records keep their historical attribution.
            </p>
            <div className="flex justify-end gap-2">
              <button className={action} onClick={() => setRemoveMemberTarget(null)}>
                Cancel
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={async () => {
                  const target = removeMemberTarget;
                  if (
                    await mutation(
                      `buckets/${bucket.id}/members/${target.membershipId}`,
                      "DELETE",
                      undefined,
                      target.revision,
                    )
                  ) {
                    setRemoveMemberTarget(null);
                    await refresh();
                  }
                }}
              >
                Remove member
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {deleteOptionTarget && (
        <Dialog title="Delete unused reference?" onClose={() => setDeleteOptionTarget(null)}>
          <div className="space-y-4 text-sm">
            <p>
              {deleteOptionTarget.option.name} has no recorded expenses. Deleting it removes this
              reference from {bucket.name}.
            </p>
            <div className="flex justify-end gap-2">
              <button className={action} onClick={() => setDeleteOptionTarget(null)}>
                Cancel
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={async () => {
                  const target = deleteOptionTarget;
                  await optionAction(target.option, target.kind, "delete");
                  setDeleteOptionTarget(null);
                }}
              >
                Delete unused
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function ExpenseEditor({
  bucket,
  expense,
  options,
  members,
  onSaved,
}: {
  bucket: Bucket;
  expense: Expense;
  options: Record<OptionKind, Option[]>;
  members: Member[];
  onSaved: () => Promise<void>;
}) {
  const { invalidate } = useWorkspaceData();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {
      expenseDate: String(form.get("expenseDate")),
      description: String(form.get("description")),
      originalAmount: String(form.get("originalAmount")),
      originalCurrency: String(form.get("originalCurrency")),
      categoryId: String(form.get("categoryId")),
      accountId: String(form.get("accountId")),
      platformId: String(form.get("platformId")),
      paymentMode: String(form.get("paymentMode")),
      paidByUserId: String(form.get("paidByUserId")),
      notes: String(form.get("notes")),
    };
    if (!body.platformId) delete body.platformId;
    if (form.get("convertedAmount") && form.get("manualRate")) {
      setError("Enter either a converted amount or an exchange rate.");
      return;
    }
    if (form.get("convertedAmount"))
      body.manualConversion = {
        method: "manual_amount",
        convertedAmount: String(form.get("convertedAmount")),
      };
    if (form.get("manualRate"))
      body.manualConversion = { method: "manual_rate", rate: String(form.get("manualRate")) };
    setBusy(true);
    try {
      await api(`buckets/${bucket.id}/expenses/${expense.id}`, {
        method: "PATCH",
        body,
        revision: expense.revision,
        key: crypto.randomUUID(),
      });
      invalidate(`buckets/${bucket.id}/`);
      await onSaved();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className={`${card} lg:col-span-2`} onSubmit={submit}>
      <h2 className="text-lg">Edit expense</h2>
      <p className="!mt-1 text-xs">
        Update this ledger record. Date, amount, or currency changes may require a new conversion.
      </p>
      {error && (
        <div className="mt-4">
          <Notice>{error}</Notice>
        </div>
      )}
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <h3 className="border-b border-[var(--line)] pb-2 text-sm sm:col-span-2">
          1. Date and details
        </h3>
        <label className="text-sm font-semibold">
          Date
          <input
            className={field}
            type="date"
            name="expenseDate"
            defaultValue={expense.expenseDate}
            required
          />
        </label>
        <label className="text-sm font-semibold">
          Description
          <input className={field} name="description" defaultValue={expense.description} required />
        </label>
        <h3 className="mt-3 border-b border-[var(--line)] pb-2 text-sm sm:col-span-2">2. Amount</h3>
        <label className="text-sm font-semibold">
          Amount
          <input
            className={field}
            name="originalAmount"
            defaultValue={expense.originalAmount}
            required
          />
        </label>
        <label className="text-sm font-semibold">
          Currency
          <Dropdown
            name="originalCurrency"
            defaultValue={expense.originalCurrency}
            options={currencies.map((item) => ({ value: item.code, label: item.code }))}
          />
        </label>
        <h3 className="mt-3 border-b border-[var(--line)] pb-2 text-sm sm:col-span-2">
          3. Classification and payment
        </h3>
        <label className="text-sm font-semibold">
          Category
          <Dropdown
            name="categoryId"
            defaultValue={expense.categoryId}
            options={options.categories
              .filter((item) => item.state === "active" || item.id === expense.categoryId)
              .map((item) => ({ value: item.id, label: item.name }))}
          />
        </label>
        <label className="text-sm font-semibold">
          Account
          <Dropdown
            name="accountId"
            defaultValue={expense.accountId}
            options={options.accounts
              .filter((item) => item.state === "active" || item.id === expense.accountId)
              .map((item) => ({ value: item.id, label: item.name }))}
          />
        </label>
        <label className="text-sm font-semibold">
          Platform
          <Dropdown
            name="platformId"
            defaultValue={expense.platformId}
            options={options.platforms
              .filter((item) => item.state === "active" || item.id === expense.platformId)
              .map((item) => ({ value: item.id, label: item.name }))}
          />
        </label>
        <label className="text-sm font-semibold">
          Payment mode
          <Dropdown name="paymentMode" defaultValue={expense.paymentMode} options={paymentModes} />
        </label>
        <label className="text-sm font-semibold">
          Paid by
          <Dropdown
            name="paidByUserId"
            defaultValue={expense.paidByUserId}
            options={members.map((item) => ({ value: item.id, label: item.displayName }))}
          />
        </label>
        <h3 className="mt-3 border-b border-[var(--line)] pb-2 text-sm sm:col-span-2">
          4. Conversion and notes
        </h3>
        {expense.originalCurrency !== bucket.primaryCurrency && (
          <label className="text-sm font-semibold">
            Converted amount (optional)
            <input
              className={field}
              name="convertedAmount"
              inputMode="decimal"
              placeholder={`Manual ${bucket.primaryCurrency} amount`}
            />
            <span className={muted}>Leave blank to refresh the exchange rate.</span>
          </label>
        )}
        {expense.originalCurrency !== bucket.primaryCurrency && (
          <label className="text-sm font-semibold">
            Exchange rate (optional)
            <input
              className={field}
              name="manualRate"
              inputMode="decimal"
              placeholder="Manual rate"
            />
            <span className={muted}>Use either a converted amount or a rate.</span>
          </label>
        )}
        <label className="text-sm font-semibold sm:col-span-2">
          Notes
          <textarea className={field} name="notes" defaultValue={expense.notes} rows={3} />
        </label>
      </div>
      <div className="mt-5 flex justify-end border-t border-[var(--line)] pt-4">
        <button className="button primary" disabled={busy}>
          Save changes
        </button>
      </div>
    </form>
  );
}
