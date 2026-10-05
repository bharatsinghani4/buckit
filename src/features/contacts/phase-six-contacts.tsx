"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Check,
  ContactRound,
  LockKeyhole,
  Pencil,
  Plus,
  Search,
  Share2,
  Trash2,
  UserRoundX,
} from "lucide-react";
import { controls } from "@/components/control-styles";
import { Notice, Pending } from "@/components/ui";
import { useWorkspaceData } from "@/features/buckets/workspace-data-context";
import { api, friendlyError } from "@/lib/api/client";

type Contact = {
  id: string;
  name: string;
  serviceType: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  ownerName: string | null;
  isOwner: boolean;
  revision: number;
  shareRevision: number | null;
};
type Share = { id: string; recipientUserId: string; displayName: string; revision: number };
type Candidate = { id: string; displayName: string; commonBuckets: string[] };
const card = "rounded-xl border border-[var(--line)] bg-[var(--surface)]";
const label = "mb-1.5 block text-xs font-semibold text-[var(--ink)]";
const fields = ["name", "serviceType", "phone", "email", "address", "notes"] as const;

export function PhaseSixContacts({ contactId }: { contactId: string | null }) {
  const { read, invalidate } = useWorkspaceData();
  const [view, setView] = useState("all");
  const [query, setQuery] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(contactId);
  const [shares, setShares] = useState<Share[]>([]);
  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [mode, setMode] = useState<"read" | "new" | "edit">("read");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const selected = contacts.find((row) => row.id === selectedId) ?? null;
  const path = `contacts?view=${view}&q=${encodeURIComponent(settledQuery)}`;

  useEffect(() => {
    const timer = setTimeout(() => setSettledQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await read<Contact[]>(path);
      setContacts(result.data);
      setCursor(result.meta.nextCursor ?? null);
      setError("");
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setLoading(false);
    }
  }, [path, read]);
  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);
  useEffect(() => {
    if (!contactId) return;
    let active = true;
    void read<Contact>(`contacts/${contactId}`)
      .then((result) => {
        if (!active) return;
        setContacts((old) =>
          old.some((row) => row.id === contactId) ? old : [result.data, ...old],
        );
        setSelectedId(contactId);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [contactId, read]);
  useEffect(() => {
    if (!selected?.isOwner) {
      queueMicrotask(() => setShares([]));
      return;
    }
    void read<Share[]>(`contacts/${selected.id}/shares`)
      .then((result) => setShares(result.data))
      .catch(() => setShares([]));
  }, [selected?.id, selected?.isOwner, read]);
  useEffect(() => {
    if (!candidateQuery.trim()) {
      queueMicrotask(() => setCandidates([]));
      return;
    }
    const timer = setTimeout(() => {
      void api<Candidate[]>(`contacts/share-candidates?q=${encodeURIComponent(candidateQuery)}`)
        .then((result) => setCandidates(result.data))
        .catch(() => setCandidates([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [candidateQuery]);
  async function more() {
    if (!cursor) return;
    try {
      const result = await api<Contact[]>(`${path}&cursor=${encodeURIComponent(cursor)}`);
      setContacts((old) => [...old, ...result.data]);
      setCursor(result.meta.nextCursor ?? null);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(
      fields.map((field) => [field, String(form.get(field) ?? "").trim()]),
    );
    setBusy(true);
    setError("");
    try {
      const result =
        mode === "edit" && selected
          ? await api<Contact>(`contacts/${selected.id}`, {
              method: "PATCH",
              body,
              revision: selected.revision,
              key: crypto.randomUUID(),
            })
          : await api<Contact>("contacts", { method: "POST", body, key: crypto.randomUUID() });
      setContacts((old) => [result.data, ...old.filter((row) => row.id !== result.data.id)]);
      setSelectedId(result.data.id);
      setMode("read");
      setNotice(mode === "edit" ? "Contact updated." : "Private contact added.");
      invalidate("contacts");
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!selected || !window.confirm(`Delete ${selected.name}? Shared access will end.`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`contacts/${selected.id}`, {
        method: "DELETE",
        revision: selected.revision,
        key: crypto.randomUUID(),
      });
      setContacts((old) => old.filter((row) => row.id !== selected.id));
      setSelectedId(null);
      setNotice("Contact deleted.");
      invalidate("contacts");
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function grant() {
    if (!selected || recipients.length === 0) return;
    setBusy(true);
    setError("");
    try {
      await api(`contacts/${selected.id}/shares`, {
        method: "POST",
        body: { recipientUserIds: recipients },
        key: crypto.randomUUID(),
      });
      invalidate(`contacts/${selected.id}/shares`);
      const result = await api<Share[]>(`contacts/${selected.id}/shares`);
      setShares(result.data);
      setRecipients([]);
      setCandidateQuery("");
      setNotice("Contact shared with selected members.");
      invalidate("contacts");
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(share: Share) {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await api(`contacts/${selected.id}/shares/${share.id}`, {
        method: "DELETE",
        revision: share.revision,
        key: crypto.randomUUID(),
      });
      setShares((old) => old.filter((row) => row.id !== share.id));
      setNotice("Access ended.");
      invalidate("contacts");
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function hide() {
    if (!selected?.shareRevision) return;
    setBusy(true);
    setError("");
    try {
      await api(`contacts/${selected.id}/hide`, {
        method: "POST",
        revision: selected.shareRevision,
        key: crypto.randomUUID(),
      });
      setContacts((old) => old.filter((row) => row.id !== selected.id));
      setSelectedId(null);
      setNotice("Shared contact hidden from your list.");
      invalidate("contacts");
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1400px] pb-12">
      <div
        className={`mb-6 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 ${mode !== "read" || selectedId ? "max-[767px]:hidden" : ""}`}
      >
        <Link
          href="/workspace"
          className="col-span-2 inline-flex h-7 items-center gap-1 text-[11px] font-semibold text-[var(--green)] min-[768px]:hidden"
        >
          <ArrowLeft size={15} aria-hidden="true" /> Back to Overview
        </Link>
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold tracking-tight text-[var(--ink)] max-[767px]:text-2xl">
            Contacts & Directory
          </h1>
        </div>
        <button
          className={controls.primary}
          onClick={() => {
            setMode("new");
            setSelectedId(null);
          }}
        >
          <Plus size={16} /> Add contact
        </button>
        <p className="col-span-2 mt-1 text-xs text-[var(--muted)]">
          Keep useful contacts private, then share them with people you choose.
        </p>
      </div>
      <div
        className={`${card} mb-5 flex items-start gap-3 bg-[var(--sage)] p-4 max-[767px]:hidden`}
      >
        <LockKeyhole size={18} className="mt-0.5 shrink-0 text-[var(--green)]" />
        <p className="text-xs leading-relaxed text-[var(--ink)]">
          <strong>Private by default.</strong> A contact is visible only to you until you explicitly
          share it. People can view a shared contact, but cannot edit or share it again.
        </p>
      </div>
      {mode === "read" && !selectedId && (
        <details className="mb-4 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-xs min-[768px]:hidden">
          <summary className="cursor-pointer font-semibold text-[var(--green)]">
            Private by default
          </summary>
          <p className="mt-2">
            Only you see a contact until you share it. Recipients can view it but cannot edit or
            reshare it.
          </p>
        </details>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}
      <div className="grid gap-5 lg:grid-cols-[minmax(300px,410px)_minmax(0,1fr)]">
        <section
          className={`${card} min-w-0 overflow-hidden ${mode !== "read" || selectedId ? "max-[767px]:hidden" : ""}`}
        >
          <div className="border-b border-[var(--line)] p-4">
            <label className="relative block">
              <Search size={16} className="absolute left-3 top-2.5 text-[var(--muted)]" />
              <input
                className={controls.search}
                placeholder="Search name or service"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search contacts"
              />
            </label>
            <div className="mt-3 flex gap-2">
              {["all", "owned", "shared"].map((option) => (
                <button
                  key={option}
                  onClick={() => {
                    setView(option);
                    setSelectedId(null);
                    setMode("read");
                  }}
                  className={`${controls.secondary} ${view === option ? "!border-[var(--green)] !bg-[var(--sage)] !text-[var(--green)]" : ""}`}
                >
                  {option === "all" ? "All" : option === "owned" ? "Mine" : "Shared"}
                </button>
              ))}
            </div>
          </div>
          {loading ? (
            <div className="p-6">
              <Pending layout="inline" />
            </div>
          ) : contacts.length === 0 ? (
            <div className="p-8 text-center text-xs text-[var(--muted)]">
              <ContactRound className="mx-auto mb-3" size={28} />
              No contacts here yet.
            </div>
          ) : (
            <div className="divide-y divide-[var(--line)]">
              {contacts.map((contact) => (
                <button
                  key={contact.id}
                  onClick={() => {
                    setSelectedId(contact.id);
                    setMode("read");
                    setNotice("");
                  }}
                  className={`flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-[var(--soft)] ${selectedId === contact.id ? "bg-[var(--sage)]" : ""}`}
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-[var(--soft)] text-[var(--green)]">
                    <ContactRound size={20} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm text-[var(--ink)]">
                      {contact.name}
                    </strong>
                    <span className="block truncate text-xs text-[var(--muted)]">
                      {contact.serviceType} · {contact.phone}
                    </span>
                  </span>
                  <span className="text-[10px] font-semibold text-[var(--muted)]">
                    {contact.isOwner ? "PRIVATE" : "SHARED"}
                  </span>
                </button>
              ))}
            </div>
          )}
          {cursor && (
            <button className={`${controls.quietAction} m-4`} onClick={() => void more()}>
              Load more
            </button>
          )}
        </section>
        <section
          className={`${card} min-w-0 p-5 sm:p-6 ${mode === "read" && !selectedId ? "max-[767px]:hidden" : ""}`}
        >
          {(mode !== "read" || selectedId) && (
            <button
              type="button"
              className="mb-4 inline-flex min-h-10 items-center gap-2 text-xs font-semibold text-[var(--green)] min-[768px]:hidden"
              onClick={() => {
                setMode("read");
                setSelectedId(null);
              }}
            >
              ← All contacts
            </button>
          )}
          {mode === "new" || (mode === "edit" && selected) ? (
            <form onSubmit={(event) => void submit(event)} className="space-y-4">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-[var(--ink)]">
                    {mode === "new" ? "New contact" : "Edit contact"}
                  </h2>
                  <p className="text-xs text-[var(--muted)]">
                    Add clear details for the people you trust.
                  </p>
                </div>
                <button
                  type="button"
                  className={controls.quietAction}
                  onClick={() => setMode("read")}
                >
                  Cancel
                </button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 min-[768px]:max-[1024px]:!grid-cols-1">
                <label>
                  <span className={label}>Name *</span>
                  <input
                    name="name"
                    className={controls.input}
                    defaultValue={selected?.name ?? ""}
                    required
                    maxLength={120}
                  />
                </label>
                <label>
                  <span className={label}>Service type *</span>
                  <input
                    name="serviceType"
                    className={controls.input}
                    defaultValue={selected?.serviceType ?? ""}
                    required
                    maxLength={80}
                    placeholder="Plumber, electrician…"
                  />
                </label>
                <label>
                  <span className={label}>Phone *</span>
                  <input
                    name="phone"
                    type="tel"
                    className={controls.input}
                    defaultValue={selected?.phone ?? ""}
                    required
                    maxLength={40}
                  />
                </label>
                <label>
                  <span className={label}>Email</span>
                  <input
                    name="email"
                    type="email"
                    className={controls.input}
                    defaultValue={selected?.email ?? ""}
                  />
                </label>
              </div>
              <label className="block">
                <span className={label}>Address</span>
                <input
                  name="address"
                  className={controls.input}
                  defaultValue={selected?.address ?? ""}
                  maxLength={500}
                />
              </label>
              <label className="block">
                <span className={label}>Notes</span>
                <textarea
                  name="notes"
                  className={`${controls.input} h-24 py-2`}
                  defaultValue={selected?.notes ?? ""}
                  maxLength={2000}
                />
              </label>
              <div className="sticky bottom-[calc(68px+env(safe-area-inset-bottom))] z-10 -mx-5 border-t border-[var(--line)] bg-[var(--surface)] px-5 py-3 min-[768px]:static min-[768px]:mx-0 min-[768px]:border-0 min-[768px]:bg-transparent min-[768px]:p-0">
                <button disabled={busy} className={`${controls.primary} max-[767px]:w-full`}>
                  <Check size={16} /> {mode === "new" ? "Save contact" : "Save changes"}
                </button>
              </div>
            </form>
          ) : selected ? (
            <div>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--line)] pb-5">
                <div className="flex items-center gap-3">
                  <span className="grid size-12 place-items-center rounded-xl bg-[var(--sage)] text-[var(--green)]">
                    <ContactRound size={23} />
                  </span>
                  <div>
                    <h2 className="text-xl font-bold text-[var(--ink)] max-[767px]:text-lg">
                      {selected.name}
                    </h2>
                    <p className="text-xs text-[var(--muted)]">
                      {selected.serviceType} ·{" "}
                      {selected.isOwner
                        ? "Your private contact"
                        : `Shared by ${selected.ownerName ?? "a member"}`}
                    </p>
                  </div>
                </div>
                {selected.isOwner ? (
                  <div className="flex gap-1">
                    <button className={controls.quietAction} onClick={() => setMode("edit")}>
                      <Pencil size={15} /> Edit
                    </button>
                    <button
                      className={controls.dangerAction}
                      disabled={busy}
                      onClick={() => void remove()}
                    >
                      <Trash2 size={15} /> Delete
                    </button>
                  </div>
                ) : (
                  <button
                    className={controls.quietAction}
                    disabled={busy}
                    onClick={() => void hide()}
                  >
                    <UserRoundX size={15} /> Hide
                  </button>
                )}
              </div>
              <dl className="grid gap-4 border-b border-[var(--line)] py-5 sm:grid-cols-2 min-[768px]:max-[1024px]:!grid-cols-1">
                {[
                  ["Phone", selected.phone],
                  ["Email", selected.email],
                  ["Address", selected.address],
                  ["Notes", selected.notes],
                ]
                  .filter(([, value]) => value)
                  .map(([term, value]) => (
                    <div key={term}>
                      <dt className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted)]">
                        {term}
                      </dt>
                      <dd className="mt-1 break-words text-sm text-[var(--ink)]">{value}</dd>
                    </div>
                  ))}
              </dl>
              {selected.isOwner && (
                <div className="pt-5">
                  <div className="mb-4 flex items-center gap-2">
                    <Share2 size={17} className="text-[var(--green)]" />
                    <h3 className="text-base font-bold text-[var(--ink)] max-[767px]:text-sm">
                      Share this contact
                    </h3>
                  </div>
                  <p className="mb-4 text-xs text-[var(--muted)]">
                    Only people who currently share a bucket with you can receive a new grant.
                    Existing grants remain after bucket membership changes.
                  </p>
                  <label className="block">
                    <span className={label}>Find a member</span>
                    <input
                      className={controls.input}
                      value={candidateQuery}
                      onChange={(event) => setCandidateQuery(event.target.value)}
                      placeholder="Search a member’s name"
                    />
                  </label>
                  {candidates.length > 0 && (
                    <div className="mt-2 max-h-44 overflow-auto rounded-lg border border-[var(--line)]">
                      {candidates
                        .filter(
                          (candidate) =>
                            !shares.some((share) => share.recipientUserId === candidate.id),
                        )
                        .map((candidate) => (
                          <label
                            key={candidate.id}
                            className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2 text-xs text-[var(--ink)] last:border-0"
                          >
                            <input
                              type="checkbox"
                              className={controls.checkbox}
                              checked={recipients.includes(candidate.id)}
                              onChange={() =>
                                setRecipients((old) =>
                                  old.includes(candidate.id)
                                    ? old.filter((id) => id !== candidate.id)
                                    : [...old, candidate.id],
                                )
                              }
                            />
                            <span>
                              <strong className="block">{candidate.displayName}</strong>
                              <span className="text-[10px] text-[var(--muted)]">
                                {candidate.commonBuckets.join(", ")}
                              </span>
                            </span>
                          </label>
                        ))}
                    </div>
                  )}
                  <button
                    className={`${controls.primary} mt-3`}
                    disabled={busy || recipients.length === 0}
                    onClick={() => void grant()}
                  >
                    <Share2 size={15} /> Share with {recipients.length || "selected"}
                  </button>
                  <div className="mt-6">
                    <h4 className="mb-2 text-xs font-bold text-[var(--ink)]">People with access</h4>
                    {shares.length === 0 ? (
                      <p className="text-xs text-[var(--muted)]">Only you can see this contact.</p>
                    ) : (
                      <div className="divide-y divide-[var(--line)] rounded-lg border border-[var(--line)]">
                        {shares.map((share) => (
                          <div
                            key={share.id}
                            className="flex items-center justify-between gap-3 p-3"
                          >
                            <span className="text-xs text-[var(--ink)]">{share.displayName}</span>
                            <button
                              className={controls.dangerAction}
                              disabled={busy}
                              onClick={() => void revoke(share)}
                            >
                              Remove access
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="grid min-h-72 place-items-center text-center">
              <div>
                <ContactRound size={30} className="mx-auto mb-3 text-[var(--green)]" />
                <h2 className="text-base font-bold text-[var(--ink)]">Select a contact</h2>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Details and sharing controls appear here.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
