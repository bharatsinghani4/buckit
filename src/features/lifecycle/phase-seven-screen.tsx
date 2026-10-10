"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
} from "firebase/auth";
import { Archive, ArrowRightLeft, RotateCcw, ShieldAlert, Trash2, Users } from "lucide-react";
import { Dialog, Notice, Pending } from "@/components/ui";
import { Dropdown } from "@/components/dropdown";
import { controls } from "@/components/control-styles";
import { GoogleMark } from "@/components/google-mark";
import { useAuth } from "@/features/identity/auth-provider";
import { currencies, type Bucket } from "@/features/identity/contracts";
import { api, ClientError, friendlyError } from "@/lib/api/client";
import { useWorkspaceData } from "@/features/buckets/workspace-data-context";

type Settings = Bucket & { currencyLocked: boolean; canLeave: boolean };
type Member = {
  id: string;
  displayName: string;
  membershipId: string;
  revision: number;
  isOwner: boolean;
  state: string;
};
type Preview = {
  name: string;
  revision: number;
  expenses: number;
  members: number;
  budgets: number;
  plans: number;
  comments: number;
};
type AccountPreview = {
  sharedBuckets: { id: string; name: string }[];
  soleOwnedBuckets: { id: string; name: string }[];
};

export function PhaseSevenScreen({
  bucket,
  view,
  onBucketUpdated,
  onBucketGone,
}: {
  bucket: Bucket | null;
  view: "bucket-settings" | "account-settings";
  onBucketUpdated: (bucket: Bucket) => void;
  onBucketGone: (id: string) => void;
}) {
  const auth = useAuth();
  const router = useRouter();
  const { read, invalidate } = useWorkspaceData();
  const bucketId = bucket?.id;
  const [settings, setSettings] = useState<Settings | null>(
    bucket ? { ...bucket, currencyLocked: true, canLeave: !bucket.isOwner } : null,
  );
  const [members, setMembers] = useState<Member[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [accountPreview, setAccountPreview] = useState<AccountPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [name, setName] = useState(bucket?.name ?? "");
  const [timezone, setTimezone] = useState(bucket?.timezone ?? "UTC");
  const [currency, setCurrency] = useState(bucket?.primaryCurrency ?? "INR");
  const [newOwnerId, setNewOwnerId] = useState("");
  const [confirmationName, setConfirmationName] = useState("");
  const [accountConfirmation, setAccountConfirmation] = useState("");
  const [reauth, setReauth] = useState<{ label: string; run: () => Promise<void> } | null>(null);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const key = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (view === "account-settings") {
        setAccountPreview((await read<AccountPreview>("me/deletion-preview")).data);
      } else if (bucketId) {
        const [next, people] = await Promise.all([
          read<Settings>(`buckets/${bucketId}/settings`),
          read<Member[]>(`buckets/${bucketId}/members`),
        ]);
        setSettings(next.data);
        setName(next.data.name);
        setTimezone(next.data.timezone);
        setCurrency(next.data.primaryCurrency);
        setMembers(people.data);
      }
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setLoading(false);
    }
  }, [bucketId, read, view]);
  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  async function mutate(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (cause) {
      if (cause instanceof ClientError && cause.code === "REAUTHENTICATION_REQUIRED") throw cause;
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function update(action: "settings" | "archive" | "restore") {
    if (!bucket || !settings) return;
    const body =
      action === "settings"
        ? {
            name: name.trim(),
            timezone,
            ...(!settings.currencyLocked ? { primaryCurrency: currency } : {}),
          }
        : undefined;
    await mutate(async () => {
      const result = await api<Bucket & { pendingCreatorReview?: number }>(
        action === "settings" ? `buckets/${bucket.id}` : `buckets/${bucket.id}/${action}`,
        {
          method: action === "settings" ? "PATCH" : "POST",
          body,
          revision: settings.revision,
          key: (key.current ??= crypto.randomUUID()),
        },
      );
      key.current = null;
      setSettings({ ...settings, ...result.data });
      onBucketUpdated(result.data);
      invalidate(`buckets/${bucket.id}`);
      invalidate("buckets");
      setMessage(
        action === "restore"
          ? `Bucket restored. ${result.data.pendingCreatorReview ?? 0} overdue entries need their creators’ review.`
          : action === "archive"
            ? "Bucket archived. Spending and reminders are paused."
            : "Bucket settings saved.",
      );
    });
  }

  async function sensitive(label: string, action: () => Promise<void>) {
    try {
      await action();
    } catch (cause) {
      if (cause instanceof ClientError && cause.code === "REAUTHENTICATION_REQUIRED") {
        setReauth({ label, run: action });
        return;
      }
      setError(friendlyError(cause));
    }
  }

  async function reauthenticate(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!auth.user || !reauth) return;
    setBusy(true);
    setError("");
    try {
      const google = auth.user.providerData.some(
        (provider) => provider.providerId === "google.com",
      );
      if (google) await reauthenticateWithPopup(auth.user, new GoogleAuthProvider());
      else {
        const password = new FormData(event!.currentTarget).get("password")?.toString() ?? "";
        if (!auth.user.email || !password) throw new Error("Enter your password.");
        await reauthenticateWithCredential(
          auth.user,
          EmailAuthProvider.credential(auth.user.email, password),
        );
      }
      await auth.user.getIdToken(true);
      const run = reauth.run;
      setReauth(null);
      await run();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function transfer() {
    if (!bucket || !settings || !newOwnerId) return;
    await sensitive("Transfer ownership", async () => {
      await mutate(async () => {
        const result = await api<Bucket>(`buckets/${bucket.id}/ownership-transfer`, {
          method: "POST",
          body: { newOwnerUserId: newOwnerId },
          revision: settings.revision,
          key: (key.current ??= crypto.randomUUID()),
        });
        key.current = null;
        setSettings({ ...settings, ...result.data });
        onBucketUpdated(result.data);
        invalidate("buckets");
        invalidate("me/deletion-preview");
        setMessage("Ownership transferred. You can now leave this bucket.");
      });
    });
  }

  async function leave() {
    if (!bucket || !settings) return;
    const ownMembership = members.find((member) => member.id === auth.profile?.id);
    if (!ownMembership) return;
    await mutate(async () => {
      await api(`buckets/${bucket.id}/leave`, {
        method: "POST",
        revision: ownMembership.revision,
        key: (key.current ??= crypto.randomUUID()),
      });
      key.current = null;
      setLeaveConfirm(false);
      onBucketGone(bucket.id);
      invalidate("buckets");
      invalidate("me/deletion-preview");
      router.replace("/workspace");
    });
  }

  async function showDeletionPreview() {
    if (!bucket) return;
    await mutate(async () =>
      setPreview((await read<Preview>(`buckets/${bucket.id}/deletion-preview`)).data),
    );
  }

  async function removeBucket() {
    if (!bucket || !preview) return;
    await sensitive("Delete bucket", async () => {
      await mutate(async () => {
        await api(`buckets/${bucket.id}/deletion`, {
          method: "POST",
          body: { confirmationName },
          revision: preview.revision,
          key: (key.current ??= crypto.randomUUID()),
        });
        key.current = null;
        onBucketGone(bucket.id);
        invalidate("buckets");
        invalidate("me/deletion-preview");
        router.replace("/workspace");
      });
    });
  }

  async function removeAccount() {
    await sensitive("Delete account", async () => {
      await mutate(async () => {
        await api("me/deletion", {
          method: "POST",
          body: { confirmation: "DELETE MY ACCOUNT" },
          key: (key.current ??= crypto.randomUUID()),
        });
        key.current = null;
        await auth.logout({ skipPushRevoke: true });
      });
    });
  }

  const section =
    "rounded-xl border border-[var(--line)] bg-[var(--surface)] p-6 shadow-sm max-sm:p-4";
  const label = "mb-1.5 block text-xs font-semibold text-[var(--ink)]";
  const muted = "text-xs leading-5 text-[var(--muted)]";
  if (loading) return <Pending layout="workspace" />;

  return (
    <div className="space-y-6 pb-12">
      <div>
        <h1 className="text-[29px] font-semibold tracking-tight text-[var(--ink)] max-[767px]:text-2xl">
          {view === "bucket-settings" ? "Bucket Settings" : "Account Settings"}
        </h1>
        <p className={`mt-1 ${muted}`}>
          {view === "bucket-settings"
            ? "Manage this bucket’s details, people, and lifecycle."
            : "Review your account and the data it owns."}
        </p>
      </div>
      {error && <Notice>{error}</Notice>}
      {message && <Notice kind="info">{message}</Notice>}
      {view === "bucket-settings" && settings && bucket ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(260px,310px)]">
          <div className="min-w-0 space-y-5">
            <section className={section} aria-labelledby="bucket-general-title">
              <div className="mb-5 flex items-center justify-between gap-3 border-b border-[var(--line)] pb-4">
                <div>
                  <h2
                    id="bucket-general-title"
                    className="text-base font-semibold text-[var(--ink)]"
                  >
                    Bucket details
                  </h2>
                  <p className={muted}>The name and timezone shown to everyone in this bucket.</p>
                </div>
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void update("settings");
                }}
                className="space-y-4"
              >
                <div>
                  <label htmlFor="bucket-name" className={label}>
                    Bucket name
                  </label>
                  <input
                    id="bucket-name"
                    className={controls.input}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={80}
                    required
                    disabled={!settings.isOwner || settings.status === "archived" || busy}
                  />
                </div>
                <div>
                  <label htmlFor="bucket-timezone" className={label}>
                    Timezone
                  </label>
                  <Dropdown
                    id="bucket-timezone"
                    value={timezone}
                    onValueChange={setTimezone}
                    options={[
                      ...new Set([timezone, "UTC", ...Intl.supportedValuesOf("timeZone")]),
                    ].map((zone) => ({ value: zone, label: zone }))}
                    disabled={!settings.isOwner || settings.status === "archived" || busy}
                  />
                </div>
                {settings.isOwner && settings.status === "active" && (
                  <button
                    className={`${controls.primary} max-[767px]:w-full`}
                    disabled={
                      busy ||
                      !name.trim() ||
                      (name.trim() === settings.name &&
                        timezone === settings.timezone &&
                        currency === settings.primaryCurrency)
                    }
                  >
                    Save changes
                  </button>
                )}
              </form>
            </section>
            <section className={section} aria-labelledby="currency-title">
              <h2 id="currency-title" className="text-base font-semibold text-[var(--ink)]">
                Primary currency
              </h2>
              <p className={`mt-2 ${muted}`}>The base currency for reports and budgets.</p>
              <div className="mt-4 flex items-center justify-between rounded-lg bg-[var(--soft)] p-4 text-sm font-semibold text-[var(--ink)]">
                <span>{settings.primaryCurrency}</span>
                <span className="text-xs font-medium text-[var(--muted)]">
                  {settings.currencyLocked
                    ? "Locked after first expense"
                    : "Set when bucket was created"}
                </span>
              </div>
              {settings.isOwner && settings.status === "active" && !settings.currencyLocked && (
                <div className="mt-4 space-y-2 min-[768px]:max-[1024px]:grid min-[768px]:max-[1024px]:grid-cols-[minmax(0,1fr)_auto] min-[768px]:max-[1024px]:items-end min-[768px]:max-[1024px]:gap-2 min-[768px]:max-[1024px]:space-y-0">
                  <label
                    htmlFor="bucket-currency"
                    className={`${label} min-[768px]:max-[1024px]:col-span-2`}
                  >
                    Choose primary currency before your first expense
                  </label>
                  <Dropdown
                    id="bucket-currency"
                    value={currency}
                    onValueChange={setCurrency}
                    options={currencies.map((item) => ({
                      value: item.code,
                      label: `${item.code} · ${item.name}`,
                    }))}
                    disabled={busy}
                  />
                  <button
                    className={`${controls.secondary} max-[767px]:w-full min-[768px]:max-[1024px]:col-start-2 min-[768px]:max-[1024px]:row-start-2`}
                    disabled={busy || currency === settings.primaryCurrency}
                    onClick={() => void update("settings")}
                  >
                    Save currency
                  </button>
                </div>
              )}
            </section>
            <section className={section} aria-labelledby="archive-title">
              <div className="flex items-start gap-3">
                <Archive size={19} className="mt-0.5 shrink-0 text-[var(--green)]" />
                <div>
                  <h2 id="archive-title" className="text-base font-semibold text-[var(--ink)]">
                    Archive status
                  </h2>
                  <p className={`mt-1 ${muted}`}>
                    Archived buckets stay readable for reports and export. Posting and bucket
                    reminders pause. On restoration, creators review overdue entries before they
                    post.
                  </p>
                </div>
              </div>
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--line)] bg-[var(--soft)] p-4">
                <span className="text-xs font-semibold text-[var(--ink)]">
                  {settings.status === "archived"
                    ? "Archived · read only"
                    : "Active · posting enabled"}
                </span>
                {settings.isOwner && (
                  <button
                    className={controls.secondary}
                    disabled={busy}
                    onClick={() =>
                      void update(settings.status === "active" ? "archive" : "restore")
                    }
                  >
                    {settings.status === "active" ? (
                      <>
                        <Archive size={15} /> Archive bucket
                      </>
                    ) : (
                      <>
                        <RotateCcw size={15} /> Restore bucket
                      </>
                    )}
                  </button>
                )}
              </div>
            </section>
          </div>
          <div className="min-w-0 space-y-5">
            <section className={section} aria-labelledby="participants-title">
              <div className="mb-4 flex items-center gap-2">
                <Users size={18} className="text-[var(--green)]" />
                <h2 id="participants-title" className="text-base font-semibold text-[var(--ink)]">
                  Members
                </h2>
              </div>
              <ul className="divide-y divide-[var(--line)]">
                {members.map((member) => (
                  <li key={member.membershipId} className="flex items-center gap-3 py-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--sage)] text-xs font-semibold text-[var(--green)]">
                      {member.displayName.charAt(0)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--ink)]">
                      {member.displayName}
                    </span>
                    <span className="text-[11px] text-[var(--muted)]">
                      {member.isOwner ? "Owner" : "Member"}
                    </span>
                  </li>
                ))}
              </ul>
              {settings.isOwner && members.length > 1 && (
                <div className="mt-4 space-y-2 border-t border-[var(--line)] pt-4">
                  <label htmlFor="new-owner" className={label}>
                    Transfer ownership
                  </label>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 max-[767px]:grid-cols-1">
                    <Dropdown
                      id="new-owner"
                      value={newOwnerId}
                      onValueChange={setNewOwnerId}
                      placeholder="Choose a member"
                      options={members
                        .filter((member) => !member.isOwner)
                        .map((member) => ({ value: member.id, label: member.displayName }))}
                    />
                    <button
                      className={controls.secondary}
                      disabled={!newOwnerId || busy}
                      onClick={() => void transfer()}
                    >
                      <ArrowRightLeft size={15} /> Transfer ownership
                    </button>
                  </div>
                </div>
              )}
              {!settings.isOwner && (
                <button
                  className={`${controls.secondary} mt-4`}
                  disabled={busy}
                  onClick={() => setLeaveConfirm(true)}
                >
                  Leave this bucket
                </button>
              )}
            </section>
            {settings.isOwner && (
              <section
                className={`${section} border-[var(--error)]/30`}
                aria-labelledby="danger-title"
              >
                <div className="flex items-center gap-2">
                  <ShieldAlert size={18} className="text-[var(--error)]" />
                  <h2 id="danger-title" className="text-base font-semibold text-[var(--ink)]">
                    Delete bucket
                  </h2>
                </div>
                <p className={`mt-2 ${muted}`}>
                  Permanently delete this bucket and all its expenses, comments, budgets, EMI plans,
                  and history. This cannot be undone. Global contacts and shares remain.
                </p>
                {!preview ? (
                  <button
                    className={`${controls.dangerAction} mt-4`}
                    onClick={() => void showDeletionPreview()}
                    disabled={busy}
                  >
                    Review deletion
                  </button>
                ) : (
                  <div className="mt-4 space-y-3">
                    <p className={muted}>
                      Includes {preview.expenses} expenses, {preview.comments} comments,{" "}
                      {preview.budgets} budgets, {preview.plans} EMI plans, and {preview.members}{" "}
                      membership records.
                    </p>
                    <label htmlFor="confirm-bucket-name" className={label}>
                      Type “{preview.name}” to confirm
                    </label>
                    <input
                      id="confirm-bucket-name"
                      className={controls.input}
                      value={confirmationName}
                      onChange={(event) => setConfirmationName(event.target.value)}
                      autoComplete="off"
                    />
                    <button
                      className={controls.dangerAction}
                      disabled={busy || confirmationName !== preview.name}
                      onClick={() => void removeBucket()}
                    >
                      <Trash2 size={15} /> Permanently delete bucket
                    </button>
                  </div>
                )}
              </section>
            )}
          </div>
        </div>
      ) : view === "account-settings" && accountPreview ? (
        <div className="max-w-2xl space-y-5">
          <section className={section}>
            <h2 className="text-base font-semibold text-[var(--ink)]">Your Buckit account</h2>
            <p className={`mt-2 ${muted}`}>
              Deleting your account removes sign-in access, personal contacts, shares, reminders,
              and push devices. Shared history remains attributed to “Deleted user”.
            </p>
            <div className="mt-5 space-y-3">
              {accountPreview.sharedBuckets.length > 0 && (
                <Notice>
                  Transfer ownership of:{" "}
                  {accountPreview.sharedBuckets.map((item) => item.name).join(", ")}.
                </Notice>
              )}
              {accountPreview.soleOwnedBuckets.length > 0 && (
                <Notice>
                  Delete your sole-owned buckets first:{" "}
                  {accountPreview.soleOwnedBuckets.map((item) => item.name).join(", ")}.
                </Notice>
              )}
            </div>
          </section>
          <section className={`${section} border-[var(--error)]/30`}>
            <h2 className="text-base font-semibold text-[var(--ink)]">Delete account</h2>
            <p className={`mt-2 ${muted}`}>
              This action is permanent. Type the exact confirmation below, then sign in again to
              verify it is you.
            </p>
            <label htmlFor="confirm-account" className={`${label} mt-4`}>
              Type “DELETE MY ACCOUNT”
            </label>
            <input
              id="confirm-account"
              className={controls.input}
              value={accountConfirmation}
              onChange={(event) => setAccountConfirmation(event.target.value)}
              autoComplete="off"
            />
            <button
              className={`${controls.dangerAction} mt-3`}
              disabled={
                busy ||
                accountConfirmation !== "DELETE MY ACCOUNT" ||
                !!accountPreview.sharedBuckets.length ||
                !!accountPreview.soleOwnedBuckets.length
              }
              onClick={() => void removeAccount()}
            >
              <Trash2 size={15} /> Delete my account
            </button>
          </section>
        </div>
      ) : null}
      {leaveConfirm && (
        <Dialog
          title="Leave this bucket?"
          subtitle={bucket?.name ?? ""}
          onClose={() => setLeaveConfirm(false)}
        >
          {error && <Notice>{error}</Notice>}
          <p className={muted}>
            You will lose access immediately. Your past contributions remain; your future schedules
            and personal budgets in this bucket will stop.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button className={controls.secondary} onClick={() => setLeaveConfirm(false)}>
              Stay
            </button>
            <button className={controls.dangerAction} disabled={busy} onClick={() => void leave()}>
              Leave bucket
            </button>
          </div>
        </Dialog>
      )}
      {reauth && (
        <Dialog
          title="Confirm your identity"
          subtitle={reauth.label}
          onClose={() => setReauth(null)}
        >
          <form onSubmit={(event) => void reauthenticate(event)} className="space-y-4">
            <p className={muted}>For your security, sign in again before this change.</p>
            {auth.user?.providerData.some((provider) => provider.providerId === "google.com") ? (
              <button
                type="button"
                className={controls.primary}
                disabled={busy}
                onClick={() => void reauthenticate()}
              >
                <GoogleMark />
                Continue with Google
              </button>
            ) : (
              <>
                <label htmlFor="reauth-password" className={label}>
                  Password
                </label>
                <input
                  id="reauth-password"
                  name="password"
                  type="password"
                  className={controls.input}
                  autoComplete="current-password"
                  required
                />
                <button className={controls.primary} disabled={busy}>
                  Confirm and continue
                </button>
              </>
            )}
            {error && <Notice>{error}</Notice>}
          </form>
        </Dialog>
      )}
    </div>
  );
}
