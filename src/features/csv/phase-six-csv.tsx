"use client";

import { useEffect, useState, type ChangeEvent } from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileUp,
  Filter,
  Info,
  RefreshCw,
  ShieldCheck,
  UploadCloud,
} from "lucide-react";
import { controls } from "@/components/control-styles";
import { Dropdown } from "@/components/dropdown";
import { Notice } from "@/components/ui";
import type { Bucket } from "@/features/identity/contracts";
import { api, ClientError, friendlyError } from "@/lib/api/client";
import { quoteCsv } from "./codec";

const columns = [
  "Date",
  "Description",
  "PaidBy",
  "Category",
  "Platform",
  "Payment Mode",
  "Bank Account",
  "Amount",
  "Currency",
  "Added By",
  "Notes",
  "Comments",
  "Status",
] as const;
type Column = (typeof columns)[number];
type ImportSession = {
  id: string;
  state: string;
  fileName: string;
  rowCount: number;
  headers: string[];
  mapping: Record<string, number>;
  revision: number;
  previewDigest: string | null;
  counts?: Record<string, number> | null;
  proposedOptions?: { kind: string; name: string }[];
};
type ImportGuidance = {
  isOwner: boolean;
  currentMembers: { id: string; name: string }[];
  formerMembers: { id: string; name: string }[];
  options: { id: string; kind: string; name: string }[];
};
type ImportRow = {
  rowNumber: number;
  state: string;
  normalized: Record<string, string> | null;
  defaultsApplied: string[];
  warnings: string[];
  fieldErrors: string[];
  duplicateCandidates: string[];
  duplicateDecision: string;
  excluded: boolean;
  expenseId: string | null;
};
type ImportPreview = {
  previewDigest: string;
  revision: number;
  counts: Record<string, number>;
  rows: ImportRow[];
  hasMore: boolean;
  warnings: string[];
};
type ExportPreview = {
  columns: string[];
  count: number;
  scheduledCount: number;
  conversionNeededCount: number;
  message: string;
};
type ExportPage = {
  rows: { cells: string[] }[];
  cursor: string | null;
  hasMore: boolean;
  completionCursor: string | null;
};
const card = "rounded-xl border border-[var(--line)] bg-[var(--surface)]";
const label = "mb-1.5 block text-xs font-semibold text-[var(--ink)]";
const steps = ["Upload file", "Map columns", "Review & post"];
const csvError = (cause: unknown) =>
  cause instanceof Error && !(cause instanceof ClientError) ? cause.message : friendlyError(cause);

function heading(eyebrow: string, title: string, description: string) {
  return (
    <div className="mb-6">
      <p className="mb-2 text-[10px] font-bold uppercase tracking-[.16em] text-[var(--green)]">
        {eyebrow}
      </p>
      <h1 className="text-[28px] font-bold tracking-tight text-[var(--ink)] max-[767px]:text-2xl">
        {title}
      </h1>
      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--muted)]">{description}</p>
    </div>
  );
}

export function PhaseSixCsv({
  bucket,
  view,
  importId,
  exportFilters,
}: {
  bucket: Bucket;
  view: "csv-import" | "csv-export";
  importId: string | null;
  exportFilters: string;
}) {
  return view === "csv-import" ? (
    <ImportScreen bucket={bucket} importId={importId} />
  ) : (
    <ExportScreen bucket={bucket} initialFilters={exportFilters} />
  );
}

function ImportScreen({ bucket, importId }: { bucket: Bucket; importId: string | null }) {
  const [fileName, setFileName] = useState("");
  const [session, setSession] = useState<ImportSession | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [rowCursor, setRowCursor] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [guidance, setGuidance] = useState<ImportGuidance | null>(null);
  const [proposalKind, setProposalKind] = useState("category");
  const [proposalName, setProposalName] = useState("");
  const [fixes, setFixes] = useState<Record<number, { field: Column; value: string }>>({});
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [step, setStep] = useState(0);
  const base = `buckets/${bucket.id}/imports`;
  useEffect(() => {
    if (!importId) return;
    let active = true;
    void api<ImportSession>(`${base}/${importId}`)
      .then(async (result) => {
        if (!active) return;
        setSession(result.data);
        setMapping(result.data.mapping);
        setFileName(result.data.fileName);
        setStep(result.data.state === "preview" ? 1 : 2);
        const page = await api<ImportRow[]>(`${base}/${importId}/rows`);
        if (active) {
          setRows(page.data);
          setRowCursor(page.meta.nextCursor ?? null);
        }
      })
      .catch((cause) => {
        if (active) setError(friendlyError(cause));
      });
    return () => {
      active = false;
    };
  }, [base, importId]);
  useEffect(() => {
    if (!session?.id) return;
    let active = true;
    void api<ImportGuidance>(`${base}/guidance`)
      .then((result) => {
        if (active) setGuidance(result.data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [base, session?.id]);
  function correctionChoices(field: Column) {
    if (!guidance) return [];
    if (field === "PaidBy")
      return guidance.formerMembers.map((row) => ({ value: row.id, label: row.name }));
    if (field === "Added By")
      return guidance.formerMembers.map((row) => ({ value: row.id, label: row.name }));
    if (field === "Payment Mode")
      return ["upi", "cash", "neft", "imps", "credit_card"].map((value) => ({
        value,
        label: value.replaceAll("_", " "),
      }));
    const kind =
      field === "Category"
        ? "category"
        : field === "Bank Account"
          ? "account"
          : field === "Platform"
            ? "platform"
            : null;
    return kind
      ? guidance.options
          .filter((row) => row.kind === kind)
          .map((row) => ({ value: row.id, label: row.name }))
      : [];
  }
  function setFix(rowNumber: number, patch: Partial<{ field: Column; value: string }>) {
    setFixes((old) => ({
      ...old,
      [rowNumber]: {
        field: old[rowNumber]?.field ?? "PaidBy",
        value: old[rowNumber]?.value ?? "",
        ...patch,
      },
    }));
  }
  async function addProposal() {
    if (!session || !proposalName.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<ImportSession>(`${base}/${session.id}/resolution`, {
        method: "PATCH",
        revision: session.revision,
        key: crypto.randomUUID(),
        body: {
          proposedOptions: [
            ...(session.proposedOptions ?? []),
            { kind: proposalKind, name: proposalName.trim() },
          ],
        },
      });
      setSession(result.data);
      setProposalName("");
      setPreview(null);
      await validate(result.data);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    setBusy(true);
    setError("");
    setNotice("");
    let createdSessionId: string | null = null;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("Choose a CSV no larger than 5 MiB.");
      const { parsed, hash } = await new Promise<{ parsed: string[][]; hash: string }>(
        (resolve, reject) => {
          const worker = new Worker(new URL("./parse-worker.ts", import.meta.url), {
            type: "module",
          });
          const timeout = window.setTimeout(() => {
            worker.terminate();
            reject(new Error("CSV parsing timed out. Try a smaller file."));
          }, 30_000);
          worker.onmessage = (
            message: MessageEvent<{ parsed?: string[][]; hash?: string; error?: string }>,
          ) => {
            window.clearTimeout(timeout);
            worker.terminate();
            if (message.data.error) reject(new Error(message.data.error));
            else resolve({ parsed: message.data.parsed!, hash: message.data.hash! });
          };
          worker.onerror = () => {
            window.clearTimeout(timeout);
            worker.terminate();
            reject(new Error("Could not parse the CSV file."));
          };
          worker.postMessage(file);
        },
      );
      const headers = parsed.shift();
      if (!headers || parsed.length === 0 || parsed.length > 5000)
        throw new Error("The CSV needs a header and 1–5,000 expense rows.");
      if (headers.length > 50) throw new Error("The CSV has too many columns.");
      const created = (
        await api<ImportSession>(base, {
          method: "POST",
          body: {
            fileName: file.name,
            fileHash: hash,
            fileSize: file.size,
            rowCount: parsed.length,
            headers,
          },
          key: crypto.randomUUID(),
        })
      ).data;
      createdSessionId = created.id;
      let current = created;
      let chunk: { rowNumber: number; cells: string[] }[] = [];
      let chunkNumber = 0;
      async function sendChunk() {
        if (chunk.length === 0) return;
        current = (
          await api<ImportSession>(`${base}/${created.id}/chunks/${chunkNumber++}`, {
            method: "PUT",
            body: { rows: chunk },
            revision: current.revision,
            key: crypto.randomUUID(),
          })
        ).data;
        chunk = [];
      }
      for (let index = 0; index < parsed.length; index++) {
        const next = { rowNumber: index + 1, cells: parsed[index] };
        const nextSize = new TextEncoder().encode(
          JSON.stringify({ rows: [...chunk, next] }),
        ).byteLength;
        if (nextSize > 220_000 || chunk.length >= 200) await sendChunk();
        if (new TextEncoder().encode(JSON.stringify({ rows: [next] })).byteLength > 220_000)
          throw new Error(`Row ${next.rowNumber} is too large to import.`);
        chunk.push(next);
      }
      await sendChunk();
      setSession(current);
      setMapping(current.mapping);
      setFileName(file.name);
      setStep(1);
      setNotice(`${parsed.length} rows staged. Check column mapping before validation.`);
      window.history.replaceState(
        null,
        "",
        `/workspace?bucket=${bucket.id}&view=csv-import&import=${created.id}`,
      );
      createdSessionId = null;
    } catch (cause) {
      if (createdSessionId)
        await api(`${base}/${createdSessionId}/cancel`, {
          method: "POST",
          body: {},
          key: crypto.randomUUID(),
        }).catch(() => {});
      setError(csvError(cause));
    } finally {
      setBusy(false);
      input.value = "";
    }
  }
  async function template() {
    try {
      const result = (await api<{ csv: string; fileName: string }>(`${base}/template`)).data;
      const url = URL.createObjectURL(
        new Blob(["\uFEFF", result.csv], { type: "text/csv;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = result.fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }
  async function applyMapping() {
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<ImportSession>(`${base}/${session.id}/resolution`, {
        method: "PATCH",
        body: { mapping },
        revision: session.revision,
        key: crypto.randomUUID(),
      });
      setSession(result.data);
      setPreview(null);
      setStep(2);
      await validate(result.data);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function validate(current = session) {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      const result = (
        await api<ImportPreview>(`${base}/${current.id}/validate`, { method: "POST", body: {} })
      ).data;
      setPreview(result);
      setRows(result.rows);
      setRowCursor(result.hasMore ? "50" : null);
      setStep(2);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function correct(row: ImportRow, field: Column, value: string) {
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<ImportSession>(`${base}/${session.id}/resolution`, {
        method: "PATCH",
        body: { rows: [{ rowNumber: row.rowNumber, corrections: { [field]: value } }] },
        revision: session.revision,
        key: crypto.randomUUID(),
      });
      setSession(result.data);
      setPreview(null);
      await validate(result.data);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function decide(row: ImportRow, decision: "include" | "skip" | "exclude") {
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        rows: [
          {
            rowNumber: row.rowNumber,
            ...(decision === "exclude"
              ? { excluded: true }
              : { duplicateDecision: decision, excluded: false }),
          },
        ],
      };
      const result = await api<ImportSession>(`${base}/${session.id}/resolution`, {
        method: "PATCH",
        body,
        revision: session.revision,
        key: crypto.randomUUID(),
      });
      setSession(result.data);
      setPreview(null);
      await validate(result.data);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function loadMore() {
    if (!session || !rowCursor) return;
    try {
      const result = await api<ImportRow[]>(`${base}/${session.id}/rows?after=${rowCursor}`);
      setRows((old) => [...old, ...result.data]);
      setRowCursor(result.meta.nextCursor ?? null);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }
  async function confirm() {
    if (!session || !preview || !ack) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<ImportSession>(`${base}/${session.id}/confirm`, {
        method: "POST",
        revision: session.revision,
        key: crypto.randomUUID(),
        body: {
          previewDigest: preview.previewDigest,
          acknowledgments: ["defaults", "ignored_comments", "duplicates", "conversion"],
        },
      });
      setSession(result.data);
      await commit(result.data);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function commit(current = session) {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      let hasMore = true;
      let total = 0;
      while (hasMore) {
        const result = (
          await api<{ state: string; committed: number; pending: number; hasMore: boolean }>(
            `${base}/${current.id}/commit-next`,
            { method: "POST", body: {}, key: crypto.randomUUID() },
          )
        ).data;
        total = result.committed;
        hasMore = result.hasMore;
        setSession((old) =>
          old
            ? {
                ...old,
                state: result.state,
                counts: { committed: result.committed, ready: result.pending },
              }
            : old,
        );
      }
      setNotice(`${total} expenses imported. Import entries do not send notifications.`);
      const page = await api<ImportRow[]>(`${base}/${current.id}/rows`);
      setRows(page.data);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function reopen() {
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<ImportSession>(`${base}/${session.id}/reopen`, {
        method: "POST",
        body: {},
        revision: session.revision,
        key: crypto.randomUUID(),
      });
      setSession(result.data);
      setPreview(null);
      setStep(2);
      await validate(result.data);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<ImportSession>(`${base}/${session.id}/cancel`, {
        method: "POST",
        body: {},
        key: crypto.randomUUID(),
      });
      setSession(result.data);
      setNotice("Import canceled. Already committed expenses remain.");
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-[1400px] pb-12">
      {heading(
        "Bring your history together",
        "CSV Import & Column Mapping",
        "Map a CSV to Buckit’s expense fields, resolve issues, and review exactly what will post.",
      )}
      <div className="mb-6 flex flex-wrap gap-2">
        {steps.map((name, index) => (
          <div
            key={name}
            className={`flex items-center gap-2 rounded-full px-3 py-2 text-xs font-semibold ${step === index ? "bg-[var(--sage)] text-[var(--green)]" : "bg-[var(--soft)] text-[var(--muted)]"}`}
          >
            <span className="grid size-5 place-items-center rounded-full border border-current text-[10px]">
              {index + 1}
            </span>
            {name}
          </div>
        ))}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}
      {!session && (
        <div className={`${card} p-6 sm:p-8`}>
          <div className="grid min-h-56 place-items-center rounded-xl border-2 border-dashed border-[var(--line)] bg-[var(--soft)] p-6 text-center">
            <div>
              <UploadCloud size={32} className="mx-auto mb-3 text-[var(--green)]" />
              <h2 className="text-lg font-bold text-[var(--ink)]">Choose an expense CSV</h2>
              <p className="my-2 text-xs text-[var(--muted)]">
                UTF-8, up to 5 MiB and 5,000 rows. Nothing posts before confirmation.
              </p>
              <label className={`${controls.primary} relative cursor-pointer`}>
                <FileUp size={16} /> Select CSV
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="absolute inset-0 cursor-pointer opacity-0"
                  disabled={busy}
                  onChange={(event) => void upload(event)}
                />
              </label>
            </div>
          </div>
          <button className={`${controls.secondary} mt-4`} onClick={() => void template()}>
            <Download size={15} /> Download template
          </button>
        </div>
      )}
      {session && (
        <div className="space-y-5">
          <div className={`${card} flex flex-wrap items-center justify-between gap-3 p-4`}>
            <div className="flex items-center gap-3">
              <FileSpreadsheet size={22} className="text-[var(--green)]" />
              <div>
                <strong className="block text-sm text-[var(--ink)]">{fileName}</strong>
                <span className="text-xs text-[var(--muted)]">
                  {session.rowCount} rows · {session.state}
                </span>
              </div>
            </div>
            {!["completed", "canceled"].includes(session.state) && (
              <button
                className={controls.quietAction}
                disabled={busy}
                onClick={() => void cancel()}
              >
                Cancel import
              </button>
            )}
          </div>
          {session.state === "preview" && (
            <section className={`${card} p-5 sm:p-6`}>
              <div className="mb-5">
                <h2 className="text-lg font-bold text-[var(--ink)]">Map your columns</h2>
                <p className="text-xs text-[var(--muted)]">
                  Required fields are marked *. Leave optional fields unmapped to use the disclosed
                  defaults.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {columns.map((name) => (
                  <label key={name}>
                    <span className={label}>
                      {name}
                      {[
                        "Date",
                        "Description",
                        "PaidBy",
                        "Category",
                        "Payment Mode",
                        "Bank Account",
                        "Amount",
                      ].includes(name)
                        ? " *"
                        : ""}
                    </span>
                    <Dropdown
                      value={mapping[name] === undefined ? "unmapped" : String(mapping[name])}
                      onValueChange={(value) =>
                        setMapping((old) => {
                          const next = { ...old };
                          if (value === "unmapped") delete next[name];
                          else next[name] = Number(value);
                          return next;
                        })
                      }
                      options={[
                        { value: "unmapped", label: "Not mapped" },
                        ...session.headers.map((header, index) => ({
                          value: String(index),
                          label: header || `Column ${index + 1}`,
                        })),
                      ]}
                    />
                  </label>
                ))}
              </div>
              <div className="mt-6 flex flex-wrap gap-2">
                <button
                  className={controls.primary}
                  disabled={busy}
                  onClick={() => void applyMapping()}
                >
                  <Check size={15} /> Apply mapping & validate
                </button>
                <button
                  className={controls.secondary}
                  disabled={busy}
                  onClick={() => void validate()}
                >
                  <RefreshCw size={15} /> Refresh preview
                </button>
              </div>
            </section>
          )}
          {session.state === "preview" && guidance?.isOwner && (
            <section className={`${card} p-5 sm:p-6`}>
              <h2 className="text-base font-bold text-[var(--ink)]">Missing reference option?</h2>
              <p className="mb-4 mt-1 text-xs text-[var(--muted)]">
                As the bucket owner, you can approve a new category, account, or platform for this
                import. It is created with the first committed batch.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="w-40">
                  <span className={label}>Type</span>
                  <Dropdown
                    value={proposalKind}
                    onValueChange={setProposalKind}
                    options={[
                      { value: "category", label: "Category" },
                      { value: "account", label: "Bank account" },
                      { value: "platform", label: "Platform" },
                    ]}
                  />
                </label>
                <label className="min-w-48 flex-1">
                  <span className={label}>Name</span>
                  <input
                    className={controls.input}
                    value={proposalName}
                    onChange={(event) => setProposalName(event.target.value)}
                    maxLength={80}
                  />
                </label>
                <button
                  className={controls.secondary}
                  disabled={busy || !proposalName.trim()}
                  onClick={() => void addProposal()}
                >
                  Approve option
                </button>
              </div>
              {Boolean(session.proposedOptions?.length) && (
                <p className="mt-3 text-xs text-[var(--muted)]">
                  Approved:{" "}
                  {session
                    .proposedOptions!.map((option) => `${option.name} (${option.kind})`)
                    .join(", ")}
                </p>
              )}
            </section>
          )}
          {step === 2 && (
            <section className={`${card} overflow-hidden`}>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] p-5">
                <div>
                  <h2 className="text-lg font-bold text-[var(--ink)]">Review rows</h2>
                  <p className="text-xs text-[var(--muted)]">
                    Resolve invalid fields and decide whether to include possible duplicates.
                  </p>
                </div>
                {preview && (
                  <div className="flex gap-2 text-xs font-semibold">
                    <span className="rounded-full bg-[var(--sage)] px-3 py-1.5 text-[var(--green)]">
                      {preview.counts.ready ?? 0} ready
                    </span>
                    <span className="rounded-full bg-[var(--error-bg)] px-3 py-1.5 text-[var(--error)]">
                      {preview.counts.invalid ?? 0} needs review
                    </span>
                    <span className="rounded-full bg-[var(--soft)] px-3 py-1.5 text-[var(--muted)]">
                      {preview.counts.excluded ?? 0} excluded
                    </span>
                  </div>
                )}
              </div>
              <div className="divide-y divide-[var(--line)]">
                {rows.map((row) => (
                  <div key={row.rowNumber} className="p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <strong className="text-sm text-[var(--ink)]">
                          Row {row.rowNumber}: {row.normalized?.description || "Incomplete expense"}
                        </strong>
                        <p className="mt-1 text-xs text-[var(--muted)]">
                          {row.normalized?.expenseDate || "No date"} ·{" "}
                          {row.normalized?.originalAmount || "No amount"}{" "}
                          {row.normalized?.originalCurrency || ""}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${row.state === "ready" || row.state === "committed" ? "bg-[var(--sage)] text-[var(--green)]" : "bg-[var(--error-bg)] text-[var(--error)]"}`}
                      >
                        {row.state}
                      </span>
                    </div>
                    {row.fieldErrors.length > 0 && (
                      <div className="mt-3 flex items-start gap-2 text-xs text-[var(--error)]">
                        <AlertCircle size={15} className="shrink-0" />
                        <span>{row.fieldErrors.join(" ")}</span>
                      </div>
                    )}
                    {[
                      ...row.warnings,
                      ...row.defaultsApplied.map((name) => `${name} used its default.`),
                    ].length > 0 && (
                      <p className="mt-2 text-xs text-[var(--muted)]">
                        {[
                          ...row.warnings,
                          ...row.defaultsApplied.map((name) => `${name} used its default.`),
                        ].join(" ")}
                      </p>
                    )}
                    {session.state === "preview" && row.state !== "committed" && (
                      <div className="mt-3 flex flex-wrap items-end gap-2">
                        {row.state === "invalid" && (
                          <>
                            <div className="w-40">
                              <span className={label}>Correct field</span>
                              <Dropdown
                                value={fixes[row.rowNumber]?.field ?? "PaidBy"}
                                options={columns.map((name) => ({ value: name, label: name }))}
                                onValueChange={(value) =>
                                  setFix(row.rowNumber, { field: value as Column, value: "" })
                                }
                              />
                            </div>
                            {correctionChoices(fixes[row.rowNumber]?.field ?? "PaidBy").length ? (
                              <div className="w-48">
                                <span className={label}>Value</span>
                                <Dropdown
                                  value={fixes[row.rowNumber]?.value || undefined}
                                  placeholder="Choose a value"
                                  options={correctionChoices(
                                    fixes[row.rowNumber]?.field ?? "PaidBy",
                                  )}
                                  onValueChange={(value) => setFix(row.rowNumber, { value })}
                                />
                              </div>
                            ) : (
                              <label className="w-48">
                                <span className={label}>Value</span>
                                <input
                                  className={controls.input}
                                  value={fixes[row.rowNumber]?.value ?? ""}
                                  placeholder="Correct value"
                                  aria-label={`Correction for row ${row.rowNumber}`}
                                  onChange={(event) =>
                                    setFix(row.rowNumber, { value: event.target.value })
                                  }
                                />
                              </label>
                            )}
                            <button
                              className={controls.secondary}
                              disabled={busy || !fixes[row.rowNumber]?.value}
                              onClick={() =>
                                void correct(
                                  row,
                                  fixes[row.rowNumber]?.field ?? "PaidBy",
                                  fixes[row.rowNumber]?.value ?? "",
                                )
                              }
                            >
                              Apply correction
                            </button>
                          </>
                        )}
                        {row.duplicateCandidates.length > 0 && (
                          <>
                            <button
                              className={controls.secondary}
                              disabled={busy}
                              onClick={() => void decide(row, "include")}
                            >
                              Include duplicate
                            </button>
                            <button
                              className={controls.secondary}
                              disabled={busy}
                              onClick={() => void decide(row, "skip")}
                            >
                              Skip duplicate
                            </button>
                          </>
                        )}
                        {!row.excluded && (
                          <button
                            className={controls.quietAction}
                            disabled={busy}
                            onClick={() => void decide(row, "exclude")}
                          >
                            Exclude row
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {rowCursor && (
                <button className={`${controls.quietAction} m-4`} onClick={() => void loadMore()}>
                  Load more rows
                </button>
              )}
            </section>
          )}
          {session.state === "preview" && preview && (
            <div className={`${card} p-5`}>
              <div className="flex items-start gap-2">
                <Info size={17} className="mt-0.5 shrink-0 text-[var(--green)]" />
                <p className="text-xs leading-relaxed text-[var(--muted)]">
                  Blank Currency uses {bucket.primaryCurrency}, Platform uses Other, Added By uses
                  you, and Notes is empty. Comments are ignored; Status is derived. Possible
                  duplicates require an explicit choice. Conversion may remain unresolved. Import
                  sends no notifications.
                </p>
              </div>
              <label className="mt-4 flex items-center gap-2 text-xs font-medium text-[var(--ink)]">
                <input
                  type="checkbox"
                  className={controls.checkbox}
                  checked={ack}
                  onChange={(event) => setAck(event.target.checked)}
                />
                I understand these defaults, ignored fields, duplicate choices, and conversion
                limits.
              </label>
              <button
                className={`${controls.primary} mt-4`}
                disabled={busy || !ack || Boolean(preview.counts.invalid)}
                onClick={() => void confirm()}
              >
                <ArrowRight size={16} /> Confirm & import {preview.counts.ready ?? 0} expenses
              </button>
            </div>
          )}
          {["ready", "committing", "partial"].includes(session.state) && (
            <div className={`${card} p-5`}>
              <p className="mb-3 text-xs text-[var(--muted)]">
                {session.counts?.committed ?? 0} committed. Resume remaining rows safely.
              </p>
              <button className={controls.primary} disabled={busy} onClick={() => void commit()}>
                <RefreshCw size={15} /> Resume import
              </button>
              <button
                className={`${controls.secondary} ml-2`}
                disabled={busy}
                onClick={() => void reopen()}
              >
                Review remaining rows
              </button>
            </div>
          )}
          {session.state === "completed" && (
            <div
              className={`${card} flex items-center gap-3 p-5 text-sm font-semibold text-[var(--green)]`}
            >
              <CheckCircle2 size={20} /> Import complete. Review the new entries in Expenses.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ExportScreen({ bucket, initialFilters }: { bucket: Bucket; initialFilters: string }) {
  const initial = new URLSearchParams(initialFilters);
  const [scope, setScope] = useState<"filtered" | "all">("filtered");
  const [from, setFrom] = useState(() => initial.get("from") ?? "");
  const [toExclusive, setToExclusive] = useState(() => initial.get("toExclusive") ?? "");
  const [otherFilters, setOtherFilters] = useState<Record<string, string>>(() => {
    const next: Record<string, string> = {};
    for (const key of [
      "categoryId",
      "accountId",
      "platformId",
      "paidByUserId",
      "paymentMode",
      "q",
      "status",
    ])
      if (initial.has(key)) next[key] = initial.get(key)!;
    return next;
  });
  const [includeScheduled, setIncludeScheduled] = useState(() =>
    ["scheduled", "conversion_needed", "archive_review", "pending_processing"].includes(
      initial.get("status") ?? "",
    ),
  );
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = `buckets/${bucket.id}/exports`;
  const selection = {
    scope,
    filters: {
      ...(from ? { from } : {}),
      ...(toExclusive ? { toExclusive } : {}),
      ...otherFilters,
    },
    includeScheduled,
  };
  async function inspect() {
    setBusy(true);
    setError("");
    try {
      setPreview(
        (await api<ExportPreview>(`${base}/preview`, { method: "POST", body: selection })).data,
      );
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setError("");
    try {
      const start = (
        await api<{ exportToken: string }>(`${base}/start`, { method: "POST", body: selection })
      ).data;
      const all: string[][] = [];
      let cursor: string | null = null;
      let complete: string | null = null;
      do {
        const page: ExportPage = (
          await api<ExportPage>(`${base}/page`, {
            method: "POST",
            body: { exportToken: start.exportToken, ...(cursor ? { cursor } : {}) },
          })
        ).data;
        all.push(...page.rows.map((row) => row.cells));
        cursor = page.cursor;
        complete = page.completionCursor;
      } while (cursor);
      if (!complete) throw new Error("The export did not finish. Try again.");
      await api(`${base}/complete`, {
        method: "POST",
        body: { exportToken: start.exportToken, completionCursor: complete },
      });
      const csv =
        [
          columns.map((value) => quoteCsv(value)).join(","),
          ...all.map((row) => row.map((cell, index) => quoteCsv(cell, index === 7)).join(",")),
        ].join("\r\n") + "\r\n";
      const url = URL.createObjectURL(
        new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `buckit-${bucket.name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (cause) {
      setError(csvError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-[1200px] pb-12">
      {heading(
        "Your data, ready to go",
        "Export Expenses & Data",
        "Choose a scope, preview the count, and download a clean expense CSV.",
      )}
      {error && <Notice kind="error">{error}</Notice>}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_310px]">
        <div className="space-y-5">
          <section className={`${card} p-5 sm:p-6`}>
            <div className="mb-5 flex items-center gap-2">
              <Filter size={18} className="text-[var(--green)]" />
              <h2 className="text-lg font-bold text-[var(--ink)]">Export scope</h2>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                {
                  value: "filtered",
                  title: "Current filters",
                  text: "Use the ledger filters and date range below.",
                },
                { value: "all", title: "All expenses", text: "Include all dates in this bucket." },
              ].map((option) => (
                <button
                  key={option.value}
                  className={`rounded-lg border p-4 text-left ${scope === option.value ? "border-[var(--green)] bg-[var(--sage)]" : "border-[var(--line)] bg-[var(--surface)]"}`}
                  onClick={() => {
                    setScope(option.value as "filtered" | "all");
                    setPreview(null);
                  }}
                >
                  <strong className="block text-sm text-[var(--ink)]">{option.title}</strong>
                  <span className="text-xs text-[var(--muted)]">{option.text}</span>
                </button>
              ))}
            </div>
            {scope === "filtered" && (
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                {Object.keys(otherFilters).length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                    <span className="text-xs text-[var(--muted)]">
                      {Object.keys(otherFilters).length} ledger filter
                      {Object.keys(otherFilters).length === 1 ? "" : "s"} applied
                    </span>
                    <button
                      className={controls.quietAction}
                      onClick={() => {
                        setOtherFilters({});
                        setPreview(null);
                      }}
                    >
                      Clear ledger filters
                    </button>
                  </div>
                )}
                <label>
                  <span className={label}>From</span>
                  <input
                    type="date"
                    className={controls.date}
                    value={from}
                    onChange={(event) => {
                      setFrom(event.target.value);
                      setPreview(null);
                    }}
                  />
                </label>
                <label>
                  <span className={label}>To (exclusive)</span>
                  <input
                    type="date"
                    className={controls.date}
                    value={toExclusive}
                    onChange={(event) => {
                      setToExclusive(event.target.value);
                      setPreview(null);
                    }}
                  />
                </label>
              </div>
            )}
          </section>
          <section className={`${card} p-5 sm:p-6`}>
            <h2 className="mb-3 text-lg font-bold text-[var(--ink)]">What to include</h2>
            <label className="flex items-center gap-3 text-xs text-[var(--ink)]">
              <input
                type="checkbox"
                className={controls.checkbox}
                checked={includeScheduled}
                onChange={(event) => {
                  setIncludeScheduled(event.target.checked);
                  setPreview(null);
                }}
              />
              Include scheduled and conversion-needed entries
            </label>
            <p className="mt-3 text-xs leading-relaxed text-[var(--muted)]">
              Deleted or canceled entries are always excluded. Amount and Currency keep their
              original values.
            </p>
          </section>
          <section className={`${card} overflow-hidden`}>
            <div className="border-b border-[var(--line)] p-5">
              <h2 className="text-lg font-bold text-[var(--ink)]">CSV column preview</h2>
              <p className="text-xs text-[var(--muted)]">
                The familiar 13-column expense template.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 p-5">
              {columns.map((column) => (
                <span
                  key={column}
                  className="rounded-md bg-[var(--soft)] px-2.5 py-1.5 text-xs text-[var(--ink)]"
                >
                  {column}
                </span>
              ))}
            </div>
          </section>
        </div>
        <aside className={`${card} h-fit p-5 sm:p-6 lg:sticky lg:top-24`}>
          <ShieldCheck size={25} className="mb-4 text-[var(--green)]" />
          <h2 className="text-lg font-bold text-[var(--ink)]">Ready to export?</h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
            Preview checks the selected scope. Download starts only when all pages pass a final
            revision check.
          </p>
          {preview && (
            <div className="mt-5 space-y-2 rounded-lg bg-[var(--soft)] p-4 text-xs text-[var(--ink)]">
              <p>
                <strong className="text-xl">{preview.count}</strong> expense rows
              </p>
              <p>
                {preview.scheduledCount} scheduled · {preview.conversionNeededCount} need conversion
              </p>
            </div>
          )}
          <div className="mt-5 flex flex-col gap-2">
            <button className={controls.secondary} disabled={busy} onClick={() => void inspect()}>
              <Info size={15} /> Preview export
            </button>
            <button
              className={controls.primary}
              disabled={busy || !preview}
              onClick={() => void download()}
            >
              <Download size={15} /> Download CSV
            </button>
          </div>
          {busy && (
            <p className="mt-3 text-xs text-[var(--muted)]">Preparing a consistent export…</p>
          )}
          <p className="mt-4 text-xs leading-relaxed text-[var(--muted)]">
            CSV is a readable expense export, not a full backup of plans, audit history, or
            identities.
          </p>
        </aside>
      </div>
    </div>
  );
}
