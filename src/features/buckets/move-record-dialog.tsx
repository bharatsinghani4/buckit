"use client";

import { useEffect, useState } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { Dialog, Notice } from "@/components/ui";
import { Dropdown } from "@/components/dropdown";
import { controls } from "@/components/control-styles";
import { api, friendlyError } from "@/lib/api/client";
import type { Bucket } from "@/features/identity/contracts";
import { useWorkspaceData } from "./workspace-data-context";
import type { MoveKind } from "./move-service";

type Choice = { id: string; name: string };
type Mapping = {
  sourceId: string;
  name: string;
  kind?: "category" | "account" | "platform";
  choices: Choice[];
};
type Preview = {
  targetBucketId: string;
  targetBucketName: string;
  expenseCount: number;
  installmentCount: number;
  references: Mapping[];
  payers: Mapping[];
};

export function MoveRecordDialog({
  bucket,
  kind,
  id,
  revision,
  records,
  onClose,
  onMoved,
}: {
  bucket: Bucket;
  kind: MoveKind;
  id: string;
  revision: number;
  records?: { id: string; revision: number }[];
  onClose: () => void;
  onMoved: (targetBucketId: string, movedIds: string[], failedCount: number) => void;
}) {
  const { invalidate, read } = useWorkspaceData();
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [targetId, setTargetId] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [referenceMap, setReferenceMap] = useState<Record<string, string>>({});
  const [payerMap, setPayerMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let canceled = false;
    queueMicrotask(() => {
      void (async () => {
        try {
          const all: Bucket[] = [];
          let cursor: string | null = null;
          do {
            const endpoint: string = `buckets${cursor ? `?cursor=${cursor}` : ""}`;
            const page: Awaited<ReturnType<typeof api<Bucket[]>>> = await read<Bucket[]>(endpoint);
            all.push(...page.data);
            cursor = page.meta.nextCursor ?? null;
          } while (cursor);
          if (!canceled)
            setBuckets(all.filter((item) => item.id !== bucket.id && item.status === "active"));
        } catch (cause) {
          if (!canceled) setError(friendlyError(cause));
        } finally {
          if (!canceled) setLoading(false);
        }
      })();
    });
    return () => {
      canceled = true;
    };
  }, [bucket.id, read]);

  useEffect(() => {
    if (!targetId) return;
    let canceled = false;
    queueMicrotask(() => {
      void (async () => {
        setLoading(true);
        setError("");
        setPreview(null);
        try {
          const selected = records ?? [{ id, revision }];
          const results = await Promise.all(
            selected.map((record) =>
              api<Preview>(
                `buckets/${bucket.id}/moves/${kind}/${record.id}/preview?targetBucketId=${targetId}`,
              ),
            ),
          );
          if (canceled) return;
          const references = [
            ...new Map(
              results
                .flatMap((result) => result.data.references)
                .map((entry) => [entry.sourceId, entry]),
            ).values(),
          ];
          const payers = [
            ...new Map(
              results
                .flatMap((result) => result.data.payers)
                .map((entry) => [entry.sourceId, entry]),
            ).values(),
          ];
          setPreview({
            ...results[0].data,
            expenseCount: results.reduce((sum, result) => sum + result.data.expenseCount, 0),
            installmentCount: results.reduce(
              (sum, result) => sum + result.data.installmentCount,
              0,
            ),
            references,
            payers,
          });
          setReferenceMap(Object.fromEntries(references.map((entry) => [entry.sourceId, ""])));
          setPayerMap(Object.fromEntries(payers.map((entry) => [entry.sourceId, ""])));
        } catch (cause) {
          if (!canceled) setError(friendlyError(cause));
        } finally {
          if (!canceled) setLoading(false);
        }
      })();
    });
    return () => {
      canceled = true;
    };
  }, [bucket.id, id, kind, records, revision, targetId]);

  const mapped =
    preview &&
    preview.targetBucketId === targetId &&
    preview.references.every((entry) => referenceMap[entry.sourceId]) &&
    preview.payers.every((entry) => payerMap[entry.sourceId]);

  async function move() {
    if (!preview || !mapped || saving) return;
    setSaving(true);
    setError("");
    try {
      const selected = records ?? [{ id, revision }];
      const movedIds: string[] = [];
      let failedCount = 0;
      let firstError = "";
      for (const [index, record] of selected.entries()) {
        try {
          await api(`buckets/${bucket.id}/moves/${kind}/${record.id}`, {
            method: "POST",
            revision: record.revision,
            key: crypto.randomUUID(),
            body: { targetBucketId: targetId, referenceMap, payerMap },
          });
          movedIds.push(record.id);
        } catch (cause) {
          failedCount++;
          if (!firstError) firstError = friendlyError(cause);
        }
        setProgress(index + 1);
      }
      invalidate(`buckets/${bucket.id}/`);
      invalidate(`buckets/${targetId}/`);
      if (movedIds.length) onMoved(targetId, movedIds, failedCount);
      else setError(firstError || "No records could be moved.");
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      title="Move to another bucket"
      subtitle={
        records
          ? `Move ${records.length} selected expenses and their linked history.`
          : "Choose the destination and match its references before moving the full record history."
      }
      onClose={onClose}
    >
      <div className="space-y-4">
        {error && <Notice>{error}</Notice>}
        {saving && records && (
          <p className="text-xs text-[var(--muted)]">
            Moving {progress} of {records.length}…
          </p>
        )}
        <label className="block text-xs font-semibold">
          Destination bucket
          <Dropdown
            value={targetId}
            onValueChange={setTargetId}
            placeholder={loading ? "Loading buckets…" : "Choose a bucket"}
            options={buckets.map((item) => ({ value: item.id, label: item.name }))}
          />
        </label>
        {!loading && !buckets.length && (
          <p className="text-xs text-[var(--muted)]">
            Join or create another active bucket to move this record.
          </p>
        )}
        {loading && (
          <p className="inline-flex items-center gap-2 text-xs text-[var(--muted)]">
            <LoaderCircle size={15} className="animate-spin" /> Checking destination…
          </p>
        )}
        {preview && !loading && (
          <>
            <p className="rounded-lg bg-[var(--soft)] p-3 text-xs">
              {preview.expenseCount} linked {preview.expenseCount === 1 ? "expense" : "expenses"}
              {preview.installmentCount ? ` · ${preview.installmentCount} installments` : ""} will
              move with this record.
            </p>
            {preview.references.map((entry) => (
              <label key={entry.sourceId} className="block text-xs font-semibold">
                {entry.kind}: {entry.name}
                <Dropdown
                  value={referenceMap[entry.sourceId] ?? ""}
                  onValueChange={(value) =>
                    setReferenceMap((current) => ({ ...current, [entry.sourceId]: value }))
                  }
                  placeholder={`Choose ${entry.kind}`}
                  options={entry.choices.map((choice) => ({
                    value: choice.id,
                    label: choice.name,
                  }))}
                />
                {!entry.choices.length && (
                  <span className="mt-1 block text-[var(--error)]">
                    Add this reference in the destination bucket first.
                  </span>
                )}
              </label>
            ))}
            {preview.payers.map((entry) => (
              <label key={entry.sourceId} className="block text-xs font-semibold">
                Paid by: {entry.name}
                <Dropdown
                  value={payerMap[entry.sourceId] ?? ""}
                  onValueChange={(value) =>
                    setPayerMap((current) => ({ ...current, [entry.sourceId]: value }))
                  }
                  placeholder="Choose destination member"
                  options={entry.choices.map((choice) => ({
                    value: choice.id,
                    label: choice.name,
                  }))}
                />
              </label>
            ))}
          </>
        )}
        <div className="flex justify-end gap-2 border-t border-[var(--line)] pt-4">
          <button type="button" className={controls.secondary} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className={controls.primary}
            onClick={() => void move()}
            disabled={!mapped || saving}
          >
            {saving ? (
              <LoaderCircle size={15} className="animate-spin" />
            ) : (
              <ArrowRight size={15} />
            )}
            {saving ? "Moving…" : records ? `Move ${records.length} expenses` : "Move record"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
