"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  Copy,
  FolderOpen,
  Home,
  HelpCircle,
  LayoutDashboard,
  Link2,
  LogOut,
  Mail,
  PanelLeftClose,
  Pin,
  PinOff,
  Plus,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  Wallet,
  BarChart3,
  CalendarClock,
  CreditCard,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Dropdown } from "@/components/dropdown";
import { Dialog, Notice, Pending } from "@/components/ui";
import { AccessGate } from "@/features/identity/access-gate";
import { useAuth } from "@/features/identity/auth-provider";
import {
  type Bucket,
  type Invitation,
  type Profile,
  type Tour,
} from "@/features/identity/contracts";
import { api, ClientError, friendlyError, operationKey } from "@/lib/api/client";
import { getPreference, setPreference } from "@/lib/browser-preferences";
import { PhaseTwoScreen } from "@/features/expenses/phase-two-screen";
import { PhaseThreeScreen } from "@/features/insights/phase-three-screen";
import { PhaseFourScreen } from "@/features/scheduling/phase-four-screen";
import { WorkspaceDataProvider, useWorkspaceData } from "./workspace-data-context";
import { LedgerMonthPicker } from "./ledger-month-picker";
import { BucketSelector } from "./bucket-selector";

export function WorkspaceScreen() {
  return (
    <AccessGate>
      <WorkspaceDataProvider>
        <Workspace />
      </WorkspaceDataProvider>
    </AccessGate>
  );
}
function Workspace() {
  const { read, invalidate } = useWorkspaceData();
  const auth = useAuth();
  const profile = auth.profile!;
  const params = useSearchParams();
  const router = useRouter();
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [selected, setSelected] = useState<Bucket | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<"invite" | "profile" | "tour" | null>(null);
  const [invite, setInvite] = useState<Invitation | null>(null);
  const [copied, setCopied] = useState(false);
  const [step, setStep] = useState(profile.tour.lastStep);
  const tourPrompted = useRef(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [ledgerMonth, setLedgerMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [sidebarPinned, setSidebarPinned] = useState(true);
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bucketPickerOpen = useRef(false);
  const requestedBucketTarget = useRef<string | null>(null);
  const loadedBuckets = useRef<Bucket[]>([]);
  function navigateWithinWorkspace(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    window.history.pushState(null, "", event.currentTarget.href);
  }
  useEffect(() => {
    const saved = getPreference("buckit-sidebar-pinned");
    if (saved === "false" || (saved === null && window.matchMedia("(max-width: 767px)").matches)) {
      queueMicrotask(() => {
        setSidebarPinned(false);
        setSidebarExpanded(false);
      });
    }
  }, []);
  function minimizeSidebar() {
    setSidebarPinned(false);
    setSidebarExpanded(false);
    setPreference("buckit-sidebar-pinned", "false");
  }
  function togglePin() {
    const next = !sidebarPinned;
    setSidebarPinned(next);
    if (next) setSidebarExpanded(true);
    setPreference("buckit-sidebar-pinned", String(next));
  }
  const inviteKey = useRef<{ body: string; key: string } | null>(null);
  const profileKey = useRef<{ body: string; key: string } | null>(null);
  const bucketQuery = params.get("bucket");
  const phaseView = params.get("view");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await read<Bucket[]>("buckets");
      loadedBuckets.current = result.data;
      setBuckets(result.data);
      setCursor(result.meta.nextCursor ?? null);
      const target = bucketQuery || profile.lastBucketId || result.data[0]?.id;
      if (!target) {
        setSelected(null);
        return;
      }
      let bucket = result.data.find((b) => b.id === target);
      if (!bucket) {
        try {
          bucket = (await read<Bucket>(`buckets/${target}`)).data;
        } catch (e) {
          if (!(e instanceof ClientError) || e.status !== 404) throw e;
          bucket = result.data[0];
          router.replace("/workspace");
        }
      }
      if (bucket && !result.data.some((b) => b.id === bucket!.id)) {
        loadedBuckets.current = [...result.data, bucket];
        setBuckets(loadedBuckets.current);
      }
      setSelected(bucket ?? null);
    } catch (e) {
      loadedBuckets.current = [];
      setBuckets([]);
      setSelected(null);
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, [bucketQuery, profile.lastBucketId, read, router]);
  useEffect(() => {
    const target = bucketQuery || profile.lastBucketId || "";
    if (requestedBucketTarget.current === target) return;
    requestedBucketTarget.current = target;
    const cached = loadedBuckets.current.find((bucket) => bucket.id === target);
    if (cached) {
      queueMicrotask(() => setSelected(cached));
      return;
    }
    queueMicrotask(() => {
      void load();
    });
  }, [bucketQuery, profile.lastBucketId, load]);
  useEffect(() => {
    if (
      selected &&
      profile.tour.state === "not_started" &&
      getPreference("buckit-tour-seen") !== "true" &&
      !tourPrompted.current
    ) {
      tourPrompted.current = true;
      queueMicrotask(() => setModal("tour"));
    }
  }, [selected, profile.tour.state]);
  async function patchProfile(body: object) {
    let revision = profile.revision;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await api<Profile>("me", {
          method: "PATCH",
          body,
          revision,
          key: operationKey(profileKey, body),
        });
        auth.syncProfile(result.data);
        profileKey.current = null;
        return result.data;
      } catch (e) {
        if (!(e instanceof ClientError) || e.status !== 412) throw e;
        profileKey.current = null;
        const latest = (await api<Profile>("me")).data;
        auth.syncProfile(latest);
        const changedField = Object.keys(body).some(
          (field) =>
            JSON.stringify(latest[field as keyof Profile]) !==
            JSON.stringify(profile[field as keyof Profile]),
        );
        if (changedField)
          throw new ClientError(
            "Your profile changed in another session. Review the latest values before saving again.",
            412,
            "REVISION_MISMATCH",
          );
        revision = latest.revision;
      }
    }
    throw new ClientError(
      "Your profile changed again. Review the latest values and try once more.",
      412,
      "REVISION_MISMATCH",
    );
  }
  async function selectBucket(id: string) {
    setBusy(true);
    setError("");
    try {
      await patchProfile({ lastBucketId: id });
      requestedBucketTarget.current = id;
      setSelected(loadedBuckets.current.find((bucket) => bucket.id === id) ?? null);
      router.replace(`/workspace?bucket=${id}${phaseView ? `&view=${phaseView}` : ""}`);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  async function moreBuckets() {
    if (!cursor) return;
    setBusy(true);
    try {
      const result = await api<Bucket[]>(`buckets?cursor=${encodeURIComponent(cursor)}`);
      setBuckets((items) => {
        const updated = [
          ...items,
          ...result.data.filter((b) => !items.some((existing) => existing.id === b.id)),
        ];
        loadedBuckets.current = updated;
        return updated;
      });
      setCursor(result.meta.nextCursor ?? null);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  async function generateInvite() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<Invitation>(`buckets/${selected.id}/invitations`, {
        method: "POST",
        body: {},
        key: operationKey(inviteKey, { bucketId: selected.id }),
      });
      setInvite(result.data);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const theme = String(form.get("theme")) as Profile["theme"];
      await patchProfile({
        displayName: String(form.get("displayName")).trim(),
        timezone: String(form.get("timezone")),
        theme,
      });
      auth.setTheme(theme);
      setModal(null);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  const steps = [
    {
      title: "Your bucket, your space",
      text: "The bucket selector keeps each part of your life separate. Switch between the spaces you belong to, or create a new one.",
      icon: FolderOpen,
    },
    ...(selected?.isOwner
      ? [
          {
            title: "Bring your people",
            text: "Use Invite people to copy a seven-day link, show its QR code, or share it through WhatsApp. People join only after signing in and confirming.",
            icon: Users,
          },
        ]
      : []),
    {
      title: "Make yourself at home",
      text: "Your profile menu holds your name, timezone, and appearance. You can replay this tour from Help whenever you need.",
      icon: Settings2,
    },
  ];
  const currentStep = Math.min(step, steps.length - 1);
  function tour(nextStep: number, state: Tour["state"] = "in_progress") {
    setStep(nextStep);
    if (state === "completed" || state === "skipped") {
      setPreference("buckit-tour-seen", "true");
      setModal(null);
    }
  }
  function closeModal() {
    if (busy) return;
    if (modal === "tour" && !error) tour(currentStep, "skipped");
    else {
      setModal(null);
      setError("");
    }
  }
  return (
    <div
      className={`workspace-layout ${sidebarExpanded ? "sidebar-expanded" : "sidebar-collapsed"}`}
    >
      <aside
        ref={sidebarRef}
        className="sidebar"
        onMouseEnter={() => {
          if (!sidebarPinned) {
            sidebarHoverTimer.current = setTimeout(() => setSidebarExpanded(true), 250);
          }
        }}
        onMouseLeave={() => {
          if (sidebarHoverTimer.current) clearTimeout(sidebarHoverTimer.current);
          if (!sidebarPinned && !bucketPickerOpen.current) setSidebarExpanded(false);
        }}
      >
        <div className="sidebar-top">
          <Brand
            compact={!sidebarExpanded}
            ariaLabel={sidebarExpanded ? "Buckit home" : "Expand sidebar"}
            onClick={(event) => {
              if (!sidebarExpanded) {
                event.preventDefault();
                setSidebarExpanded(true);
              }
            }}
          />
          {sidebarExpanded && (
            <button
              type="button"
              className="icon-button sidebar-toggle"
              onClick={minimizeSidebar}
              aria-label="Minimize sidebar"
              title="Minimize sidebar"
            >
              <PanelLeftClose size={18} />
            </button>
          )}
        </div>
        <div className="sidebar-section">
          <div className="sidebar-heading">
            <span className="eyebrow">YOUR SPACE</span>
            <button
              type="button"
              className="sidebar-pin-icon"
              onClick={togglePin}
              aria-label={sidebarPinned ? "Unpin sidebar" : "Pin sidebar"}
              aria-pressed={sidebarPinned}
              title={sidebarPinned ? "Unpin sidebar" : "Pin sidebar"}
            >
              {sidebarPinned ? <Pin size={16} /> : <PinOff size={16} />}
            </button>
          </div>
          <label className="sr-only" htmlFor="bucket-picker">
            Current bucket
          </label>
          <BucketSelector
            buckets={buckets}
            selected={selected}
            disabled={busy || loading || !buckets.length}
            onValueChange={selectBucket}
            onOpenChange={(open) => {
              bucketPickerOpen.current = open;
              if (open) setSidebarExpanded(true);
              else if (!sidebarPinned && !sidebarRef.current?.matches(":hover"))
                setSidebarExpanded(false);
            }}
          />
          {cursor && (
            <button className="text-link" onClick={moreBuckets} disabled={busy}>
              Load more buckets
            </button>
          )}
          <Link className="sidebar-create" href="/buckets/new">
            <Plus size={15} /> Create a bucket
          </Link>
        </div>
        <Link
          className="compact-create"
          href="/buckets/new"
          aria-label="Create a bucket"
          title="Create a bucket"
        >
          <Plus size={20} />
        </Link>
        <nav aria-label="Workspace">
          <Link
            href={selected ? `/workspace?bucket=${selected.id}` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`nav-item ${!phaseView ? "active" : ""}`}
          >
            <LayoutDashboard size={18} /> Overview
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=expenses` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`nav-item ${["expenses", "deleted", "add-expense", "expense"].includes(phaseView ?? "") ? "active" : ""}`}
          >
            <Wallet size={18} /> Expenses
          </Link>
          {sidebarExpanded && (
            <div className="sidebar-heading mt-4">
              <span className="eyebrow">MANAGEMENT</span>
            </div>
          )}
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=references` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`nav-item ${phaseView === "references" ? "active" : ""}`}
          >
            <SlidersHorizontal size={18} /> Reference settings
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=members` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`nav-item ${phaseView === "members" ? "active" : ""}`}
          >
            <Users size={18} /> Members
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=reports` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`nav-item ${phaseView === "reports" ? "active" : ""}`}
          >
            <BarChart3 size={18} /> Reports
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=budgets` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`nav-item ${["budgets", "budget", "budget-form"].includes(phaseView ?? "") ? "active" : ""}`}
          >
            <BookOpen size={18} /> Budgets
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=emis` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`nav-item ${["emis", "emi-plan"].includes(phaseView ?? "") ? "active" : ""}`}
          >
            <CreditCard size={18} /> EMIs
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=scheduled` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`nav-item ${phaseView === "scheduled" ? "active" : ""}`}
          >
            <CalendarClock size={18} /> Scheduled
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <button
            className="nav-item"
            onClick={() => {
              setStep(0);
              setModal("tour");
            }}
            disabled={!selected}
          >
            <HelpCircle size={18} /> Help & tour
          </button>
          <button className="nav-item" onClick={() => setModal("profile")}>
            <Settings2 size={18} /> Profile & appearance
          </button>
          <button className="nav-item" onClick={() => auth.logout()}>
            <LogOut size={18} /> Sign out
          </button>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="workspace-header">
          <nav
            aria-label="Breadcrumb"
            className="flex min-w-0 items-center gap-2 whitespace-nowrap text-xs font-medium"
          >
            <Link
              href={selected ? `/workspace?bucket=${selected.id}` : "/workspace"}
              onClick={navigateWithinWorkspace}
              className={`truncate text-[var(--muted)] hover:text-[var(--ink)] ${phaseView ? "max-sm:hidden" : ""}`}
            >
              {selected?.name ?? "Your workspace"}
            </Link>
            {phaseView && (
              <>
                <span className="text-[var(--line)] max-sm:hidden" aria-hidden="true">
                  /
                </span>
                <span className="truncate font-semibold text-[var(--ink)]" aria-current="page">
                  {phaseView === "references"
                    ? "Reference settings"
                    : phaseView === "members"
                      ? "Members & invitations"
                      : phaseView === "reports"
                        ? "Reports"
                        : ["budgets", "budget", "budget-form"].includes(phaseView)
                          ? "Budgets"
                          : ["emis", "emi-plan"].includes(phaseView)
                            ? "EMIs"
                            : phaseView === "scheduled"
                              ? "Scheduled expenses"
                              : "Expenses"}
                </span>
              </>
            )}
          </nav>
          <div className="workspace-header-actions max-sm:!gap-2">
            {phaseView === "expenses" && (
              <LedgerMonthPicker value={ledgerMonth} onChange={setLedgerMonth} />
            )}
            <ThemeToggle />
            {selected?.isOwner && selected.status === "active" && phaseView && (
              <button
                className="button primary max-sm:!size-9 max-sm:!min-h-9 max-sm:!p-0"
                aria-label="Invite people"
                onClick={() => {
                  setInvite(null);
                  inviteKey.current = null;
                  setCopied(false);
                  setModal("invite");
                }}
              >
                <Users size={16} /> <span className="max-sm:hidden">Invite people</span>
              </button>
            )}
            <button className="profile-chip max-sm:!hidden" onClick={() => setModal("profile")}>
              <span>{profile.displayName.charAt(0).toUpperCase()}</span>
              {profile.displayName}
            </button>
          </div>
        </header>
        <main id="main" className="workspace-content">
          {!profile.emailVerified && (
            <Notice kind="info">
              <Mail size={16} /> Your email isn’t verified yet.{" "}
              <Link href="/verify-email">Verify email</Link>
            </Notice>
          )}
          {error && !modal && (
            <>
              <Notice>{error}</Notice>
              <button
                className="button secondary"
                onClick={() => {
                  requestedBucketTarget.current = bucketQuery || profile.lastBucketId || "";
                  invalidate("buckets");
                  void load();
                }}
              >
                Refresh workspace
              </button>
            </>
          )}
          {loading ? (
            <Pending />
          ) : selected &&
            ["expenses", "deleted", "add-expense", "expense", "references", "members"].includes(
              phaseView ?? "",
            ) ? (
            <PhaseTwoScreen
              key={`${selected.id}:${phaseView}:${params.get("expense") ?? ""}`}
              bucket={selected}
              profile={profile}
              view={
                phaseView as
                  "expenses" | "deleted" | "add-expense" | "expense" | "references" | "members"
              }
              expenseId={params.get("expense")}
              refundOf={params.get("refundOf")}
              month={ledgerMonth}
              onClearMonth={() => setLedgerMonth("")}
              resolveRequested={params.get("resolve") === "1"}
              refundMode={params.get("mode") === "refund"}
            />
          ) : selected && ["emis", "emi-plan", "scheduled"].includes(phaseView ?? "") ? (
            <PhaseFourScreen
              key={`${selected.id}:${phaseView}:${params.get("plan") ?? ""}`}
              bucket={selected}
              view={phaseView as "emis" | "emi-plan" | "scheduled"}
              planId={params.get("plan")}
            />
          ) : selected &&
            (!phaseView || ["reports", "budgets", "budget", "budget-form"].includes(phaseView)) ? (
            <PhaseThreeScreen
              key={selected.id}
              bucket={selected}
              view={
                (phaseView || "dashboard") as
                  "dashboard" | "reports" | "budgets" | "budget" | "budget-form"
              }
              budgetId={params.get("budget")}
            />
          ) : (
            <>
              <div className="workspace-title">
                <div>
                  <span className="eyebrow">A LITTLE MORE CLARITY</span>
                  <h1>Welcome, {profile.displayName.split(" ")[0]}.</h1>
                  <p>
                    {selected
                      ? "A fresh space for your everyday spending."
                      : "Everyday clarity starts with your first bucket."}
                  </p>
                </div>
                {selected?.isOwner && selected.status === "active" && (
                  <button
                    className="button primary"
                    onClick={() => {
                      setInvite(null);
                      inviteKey.current = null;
                      setCopied(false);
                      setModal("invite");
                    }}
                  >
                    <Users size={17} /> Invite people
                  </button>
                )}
              </div>
              {selected ? (
                <>
                  <section className="bucket-summary">
                    <span className="large-icon">
                      <Home size={27} />
                    </span>
                    <div>
                      <h2>{selected.name}</h2>
                      <p>
                        {selected.primaryCurrency} <span>·</span> {selected.timezone} <span>·</span>{" "}
                        {selected.memberCount} {selected.memberCount === 1 ? "member" : "members"}
                      </p>
                    </div>
                    <span className="pill">
                      {selected.status === "archived"
                        ? "Archived · read only"
                        : selected.isOwner
                          ? "Owner"
                          : "Member"}
                    </span>
                  </section>
                  <section className="workspace-empty">
                    <span className="empty-art">
                      <FolderOpen size={52} strokeWidth={1.2} />
                    </span>
                    <h2>Your bucket is ready.</h2>
                    <p>
                      Make it your own, or invite someone to share it.
                      <br />
                      Add an expense to start keeping track.
                    </p>
                    {selected.status === "active" ? (
                      <button
                        className="button secondary"
                        onClick={() =>
                          window.history.pushState(
                            null,
                            "",
                            `/workspace?bucket=${selected.id}&view=add-expense`,
                          )
                        }
                      >
                        Add an expense <ArrowRight size={16} />
                      </button>
                    ) : (
                      <button
                        className="button secondary"
                        onClick={() => {
                          setStep(0);
                          setModal("tour");
                        }}
                      >
                        Take a look around
                      </button>
                    )}
                  </section>
                  <div className="workspace-tip">
                    <ShieldCheck size={20} />
                    <p>
                      Only current members of this bucket can access its spending. Your other
                      buckets stay separate.
                    </p>
                  </div>
                </>
              ) : (
                !error && (
                  <section className="workspace-empty">
                    <span className="empty-art">
                      <FolderOpen size={52} />
                    </span>
                    <h2>One bucket. A fresh beginning.</h2>
                    <p>Start with personal spending, a shared home, or something else.</p>
                    <Link className="button primary" href="/onboarding">
                      Create your first bucket <Plus size={16} />
                    </Link>
                    <Link className="text-link" href="/join">
                      Join with an invitation
                    </Link>
                  </section>
                )
              )}
            </>
          )}
        </main>
      </div>
      {modal && (
        <Dialog
          title={
            modal === "invite"
              ? "A space to share"
              : modal === "profile"
                ? "Make yourself at home"
                : steps[currentStep].title
          }
          subtitle=""
          onClose={closeModal}
        >
          {error && <Notice>{error}</Notice>}
          {modal === "invite" && (
            <div className="form-stack">
              <p>
                Invite someone to <b>{selected?.name}</b>. The link works for seven days and can be
                used by more than one person.
              </p>
              {!invite ? (
                <button className="button primary full" disabled={busy} onClick={generateInvite}>
                  {busy ? "Creating link…" : "Create invitation link"}
                  <Link2 size={16} />
                </button>
              ) : invite.secretUnavailable ? (
                <>
                  <Notice kind="info">
                    This link was created, but its one-time response was lost. Create a new link to
                    share; the original expires in seven days.
                  </Notice>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => {
                      inviteKey.current = null;
                      void generateInvite();
                    }}
                  >
                    Create a new link
                  </button>
                </>
              ) : (
                invite.shareUrl && (
                  <>
                    <div className="qr-wrap">
                      <QRCodeSVG
                        value={invite.shareUrl}
                        size={168}
                        title={`Invitation to ${selected?.name}`}
                      />
                    </div>
                    <label>
                      Invitation link
                      <input value={invite.shareUrl} readOnly onFocus={(e) => e.target.select()} />
                    </label>
                    <button
                      className="button primary full"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(invite.shareUrl!);
                          setCopied(true);
                        } catch {
                          setError("Copy the link from the field above.");
                        }
                      }}
                    >
                      {copied ? <Check size={16} /> : <Copy size={16} />}
                      {copied ? "Copied" : "Copy link"}
                    </button>
                    <a
                      className="button secondary full"
                      href={`https://wa.me/?text=${encodeURIComponent(`Join my Buckit bucket:\n ${invite.shareUrl}`)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Share on WhatsApp
                    </a>
                    <p className="field-hint">
                      Expires {new Date(invite.expiresAt).toLocaleDateString()}. Anyone with this
                      link can join after signing in.
                    </p>
                  </>
                )
              )}
            </div>
          )}
          {modal === "profile" && (
            <form className="form-stack" onSubmit={saveProfile}>
              <label>
                Display name
                <input
                  name="displayName"
                  defaultValue={profile.displayName}
                  required
                  maxLength={80}
                />
              </label>
              <label>
                Timezone
                <Dropdown
                  name="timezone"
                  defaultValue={profile.timezone}
                  options={[
                    ...new Set([profile.timezone, "UTC", ...Intl.supportedValuesOf("timeZone")]),
                  ].map((zone) => ({ value: zone, label: zone }))}
                  placeholder="Choose timezone"
                />
              </label>
              <label>
                Appearance
                <Dropdown
                  name="theme"
                  defaultValue={auth.theme}
                  options={[
                    { value: "system", label: "Match device" },
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                  ]}
                  placeholder="Appearance"
                />
              </label>
              <button className="button primary full" disabled={busy}>
                {busy ? "Saving…" : "Save changes"}
              </button>
              <p className="field-hint">{profile.email}</p>
            </form>
          )}
          {modal === "tour" && (
            <div className="tour-body">
              <span className="large-icon">
                {currentStep === 0 ? <FolderOpen size={32} /> : <HelpCircle size={32} />}
              </span>
              <p>{steps[currentStep].text}</p>
              <div className="tour-progress">
                {steps.map((item, index) => (
                  <span key={item.title} className={index === currentStep ? "active" : ""} />
                ))}
                <small>
                  {currentStep + 1} of {steps.length}
                </small>
              </div>
              <div className="tour-actions">
                <button
                  className="text-link"
                  disabled={busy}
                  onClick={() => tour(currentStep, "skipped")}
                >
                  Skip tour
                </button>
                <div>
                  {currentStep > 0 && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => tour(currentStep - 1)}
                    >
                      Back
                    </button>
                  )}
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      tour(
                        currentStep === steps.length - 1 ? currentStep : currentStep + 1,
                        currentStep === steps.length - 1 ? "completed" : "in_progress",
                      )
                    }
                  >
                    {currentStep === steps.length - 1 ? "All set" : "Next"}
                    <ArrowRight size={15} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
