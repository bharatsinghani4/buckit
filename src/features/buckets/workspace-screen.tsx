"use client";
import Link from "next/link";
import { controls } from "@/components/control-styles";
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
  Bell,
  ContactRound,
  FileDown,
  FileUp,
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
import { PhaseFiveScreen } from "@/features/notifications/phase-five-screen";
import { PhaseSixContacts } from "@/features/contacts/phase-six-contacts";
import { PhaseSixCsv } from "@/features/csv/phase-six-csv";
import { PhaseSevenScreen } from "@/features/lifecycle/phase-seven-screen";
import { WorkspaceDataProvider, useWorkspaceData } from "./workspace-data-context";
import { LedgerMonthPicker } from "./ledger-month-picker";
import { BucketSelector } from "./bucket-selector";

const navItem =
  "nav-item flex w-full items-center gap-3 rounded-lg border-0 bg-transparent px-3 py-3 text-left text-xs text-[var(--muted)] hover:bg-[var(--soft)] [&.active]:bg-[var(--sage)] [&.active]:font-semibold [&.active]:text-[var(--green)]";

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
      className={`workspace-layout block min-h-svh ${sidebarExpanded ? "sidebar-expanded max-[767px]:[&_.sidebar]:[width:min(248px,_85vw)] max-[767px]:[&_.sidebar-top]:flex-row max-[767px]:[&_.sidebar_.sidebar-section]:flex max-[767px]:[&_.sidebar_.nav-item]:[justify-content:flex-start] max-[767px]:[&_.sidebar_.nav-item]:[gap:11px] max-[767px]:[&_.sidebar_.nav-item]:text-xs max-[767px]:[&_.sidebar_.nav-item]:[padding:13px_12px] max-[767px]:[&_.sidebar_.compact-create]:hidden" : "sidebar-collapsed [&_.compact-create]:flex [&_.workspace-main]:[margin-left:68px] [&_.sidebar]:[width:68px] [&_.sidebar]:[padding-left:9px] [&_.sidebar]:[padding-right:9px] [&_.sidebar-top]:flex-col [&_.sidebar-top]:[gap:12px] [&_.sidebar-section]:hidden [&_.sidebar_nav_.nav-item_small]:hidden [&_.nav-item]:justify-center [&_.nav-item]:[gap:0] [&_.nav-item]:[font-size:0] [&_.nav-item]:[padding:13px_0] [&_.nav-item_svg]:[width:20px] [&_.nav-item_svg]:[height:20px] max-[767px]:[&_.sidebar]:flex max-[767px]:[&_.sidebar]:fixed max-[767px]:[&_.sidebar]:[inset:0_auto_0_0] max-[767px]:[&_.sidebar]:[width:68px] max-[767px]:[&_.sidebar]:[padding:14px_9px] max-[767px]:[&_.sidebar]:[border-right:1px_solid_var(--line)] max-[767px]:[&_.sidebar]:[border-bottom:0] max-[767px]:[&_.workspace-main]:[margin-left:68px]"}`}
    >
      <aside
        ref={sidebarRef}
        className={`sidebar bg-[var(--surface)] [border-right:1px_solid_var(--line)] [padding:22px_16px_18px] flex flex-col [gap:22px] fixed [inset:0_auto_0_0] [width:248px] [z-index:30] [transition:width_.2s] overflow-y-auto overflow-x-hidden [&_>_.brand]:[margin:0_10px] [&_nav]:flex [&_nav]:flex-col [&_nav]:[gap:5px] max-[767px]:[padding:18px_20px] max-[767px]:[gap:17px] max-[767px]:[border-right:0] max-[767px]:[border-bottom:1px_solid_var(--line)] max-[767px]:[&_>_.brand]:[margin:0] max-[767px]:flex max-[767px]:fixed max-[767px]:[inset:0_auto_0_0] max-[767px]:[width:68px] max-[767px]:[padding:14px_9px] max-[767px]:[border-right:1px_solid_var(--line)] max-[767px]:[border-bottom:0] max-[767px]:[&_.sidebar-section]:hidden max-[767px]:[&_.compact-create]:flex max-[767px]:[&_.sidebar-top]:flex-col max-[767px]:[&_.sidebar-top]:[gap:12px] max-[767px]:[&_.nav-item]:flex max-[767px]:[&_.nav-item]:justify-center max-[767px]:[&_.nav-item]:[gap:0] max-[767px]:[&_.nav-item]:[padding:13px_0] max-[767px]:[&_.sidebar-bottom_.nav-item_svg]:[width:20px] max-[767px]:[&_.sidebar-bottom_.nav-item_svg]:[height:20px] ${sidebarExpanded ? "max-[767px]:[&_.nav-item]:!text-xs" : "[&_.nav-item]:!text-[0px]"}`}
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
        <div className="sidebar-top flex items-center justify-between [min-height:38px] [&_.brand]:[margin:0]">
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
              className="icon-button inline-flex items-center justify-center [width:44px] [height:44px] border-0 bg-transparent text-[var(--muted)] [&:hover]:bg-[var(--soft)] sidebar-toggle [width:34px] [height:34px] [flex:none]"
              onClick={minimizeSidebar}
              aria-label="Minimize sidebar"
              title="Minimize sidebar"
            >
              <PanelLeftClose size={18} />
            </button>
          )}
        </div>
        <div className="sidebar-section flex flex-col [gap:12px] max-[767px]:grid max-[767px]:[grid-template-columns:minmax(0,1fr)_auto] max-[767px]:items-center max-[767px]:[gap:10px]">
          <div className="sidebar-heading flex items-center justify-between pl-[10px]">
            <span className="eyebrow inline-flex items-center [gap:8px] text-[var(--muted)] text-xs [font-weight:650] [letter-spacing:.13em]">
              YOUR SPACE
            </span>
            <button
              type="button"
              className="sidebar-pin-icon inline-grid size-[30px] place-items-center rounded-md text-[var(--muted)] hover:bg-[var(--soft)] hover:text-[var(--green)]"
              onClick={togglePin}
              aria-label={sidebarPinned ? "Unpin sidebar" : "Pin sidebar"}
              aria-pressed={sidebarPinned}
              title={sidebarPinned ? "Unpin sidebar" : "Pin sidebar"}
            >
              {sidebarPinned ? <Pin size={16} /> : <PinOff size={16} />}
            </button>
          </div>
          <label
            className="sr-only absolute [width:1px] [height:1px] [padding:0] [margin:-1px] [clip:rect(0,0,0,0)] overflow-hidden"
            htmlFor="bucket-picker"
          >
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
            <button
              className="text-link [background:none] border-0 [padding:0] inline-flex items-center [gap:8px] text-[var(--green)] font-semibold text-xs [&:hover]:[text-decoration:underline] [&:hover]:[text-underline-offset:4px]"
              onClick={moreBuckets}
              disabled={busy}
            >
              Load more buckets
            </button>
          )}
          <Link
            className="sidebar-create flex items-center [gap:9px] text-xs [padding:0_11px] text-[var(--muted)]"
            href="/buckets/new"
          >
            <Plus size={15} /> Create a bucket
          </Link>
        </div>
        <Link
          className="compact-create hidden items-center justify-center rounded-lg p-3 text-[var(--green)] hover:bg-[var(--soft)]"
          href="/buckets/new"
          aria-label="Create a bucket"
          title="Create a bucket"
        >
          <Plus size={20} />
        </Link>
        <nav aria-label="Workspace" className="!flex flex-col gap-1">
          <Link
            href={selected ? `/workspace?bucket=${selected.id}` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`${navItem} ${!phaseView ? "active" : ""}`}
          >
            <LayoutDashboard size={18} /> Overview
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=expenses` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`${navItem} ${["expenses", "deleted", "add-expense", "expense"].includes(phaseView ?? "") ? "active" : ""}`}
          >
            <Wallet size={18} /> Expenses
          </Link>
          {sidebarExpanded && (
            <div className="sidebar-heading flex items-center justify-between pl-[10px] mt-4">
              <span className="eyebrow inline-flex items-center [gap:8px] text-[var(--muted)] text-xs [font-weight:650] [letter-spacing:.13em]">
                MANAGEMENT
              </span>
            </div>
          )}
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=references` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`${navItem} ${phaseView === "references" ? "active" : ""}`}
          >
            <SlidersHorizontal size={18} /> Reference settings
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=members` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`${navItem} ${phaseView === "members" ? "active" : ""}`}
          >
            <Users size={18} /> Members
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=reports` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`${navItem} ${phaseView === "reports" ? "active" : ""}`}
          >
            <BarChart3 size={18} /> Reports
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=budgets` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`${navItem} ${["budgets", "budget", "budget-form"].includes(phaseView ?? "") ? "active" : ""}`}
          >
            <BookOpen size={18} /> Budgets
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=emis` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`${navItem} ${["emis", "emi-plan"].includes(phaseView ?? "") ? "active" : ""}`}
          >
            <CreditCard size={18} /> EMIs
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=scheduled` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`${navItem} ${phaseView === "scheduled" ? "active" : ""}`}
          >
            <CalendarClock size={18} /> Scheduled
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=notifications` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`${navItem} ${phaseView === "notifications" ? "active" : ""}`}
          >
            <Bell size={18} /> Notifications
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=reminders` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`${navItem} ${phaseView === "reminders" ? "active" : ""}`}
          >
            <CalendarClock size={18} /> Reminders & cadence
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=contacts` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`${navItem} ${phaseView === "contacts" ? "active" : ""}`}
          >
            <ContactRound size={18} /> Contacts
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=csv-import` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`${navItem} ${phaseView === "csv-import" ? "active" : ""}`}
          >
            <FileUp size={18} /> Import CSV
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=csv-export` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`${navItem} ${phaseView === "csv-export" ? "active" : ""}`}
          >
            <FileDown size={18} /> Export CSV
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}&view=bucket-settings` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`${navItem} ${phaseView === "bucket-settings" ? "active" : ""}`}
          >
            <Settings2 size={18} /> Bucket settings
          </Link>
        </nav>
        <div className="sidebar-bottom mt-auto flex flex-col gap-1 pt-10 max-[767px]:!flex max-[767px]:!flex-col max-[767px]:!gap-1 max-[767px]:!p-0">
          <button
            className={navItem}
            onClick={() => {
              setStep(0);
              setModal("tour");
            }}
            disabled={!selected}
          >
            <HelpCircle size={18} /> Help & tour
          </button>
          <button className={navItem} onClick={() => setModal("profile")}>
            <Settings2 size={18} /> Profile & appearance
          </button>
          <Link
            href={
              selected
                ? `/workspace?bucket=${selected.id}&view=account-settings`
                : "/workspace?view=account-settings"
            }
            onClick={navigateWithinWorkspace}
            className={`${navItem} ${phaseView === "account-settings" ? "active" : ""}`}
          >
            <ShieldCheck size={18} /> Account settings
          </Link>
          <button className={navItem} onClick={() => auth.logout()}>
            <LogOut size={18} /> Sign out
          </button>
        </div>
      </aside>
      <div className="workspace-main [margin-left:248px] [min-width:0] [transition:margin-left_.2s] max-[767px]:[margin-left:68px]">
        <header className="workspace-header flex [min-height:64px] justify-between items-center [padding:0_32px] [border-bottom:1px_solid_var(--line)] text-xs [gap:16px] sticky [top:0] [z-index:20] [background:var(--canvas)] max-[767px]:[padding:15px_20px] max-[767px]:[padding:12px_16px]">
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
                              : phaseView === "notifications"
                                ? "Notifications & channels"
                                : phaseView === "reminders"
                                  ? "Reminders & cadence"
                                  : phaseView === "contacts"
                                    ? "Contacts & directory"
                                    : phaseView === "csv-import"
                                      ? "Import CSV"
                                      : phaseView === "csv-export"
                                        ? "Export CSV"
                                        : phaseView === "bucket-settings"
                                          ? "Bucket settings"
                                          : phaseView === "account-settings"
                                            ? "Account settings"
                                            : "Expenses"}
                </span>
              </>
            )}
          </nav>
          <div className="workspace-header-actions flex items-center justify-between [gap:14px] max-sm:!gap-2">
            {phaseView === "expenses" && (
              <LedgerMonthPicker value={ledgerMonth} onChange={setLedgerMonth} />
            )}
            <ThemeToggle />
            {selected?.isOwner && selected.status === "active" && phaseView && (
              <button
                className={`${controls.primary} button max-sm:!size-9 max-sm:!min-h-9 max-sm:!p-0`}
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
            <button
              className="profile-chip border-0 flex items-center [gap:9px] bg-transparent text-xs [&_>_span]:grid [&_>_span]:[place-items:center] [&_>_span]:[width:31px] [&_>_span]:[height:31px] [&_>_span]:rounded-full [&_>_span]:bg-[var(--sage)] [&_>_span]:text-[var(--green)] max-[767px]:[font-size:0] max-sm:!hidden"
              onClick={() => setModal("profile")}
            >
              <span>{profile.displayName.charAt(0).toUpperCase()}</span>
              {profile.displayName}
            </button>
          </div>
        </header>
        <main
          id="main"
          className="workspace-content [max-width:1160px] m-auto [padding:24px] max-[1000px]:[padding:24px] max-[767px]:[padding:20px] max-[767px]:[padding:16px]"
        >
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
                className={`${controls.secondary} button`}
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
          ) : phaseView === "account-settings" || (phaseView === "bucket-settings" && selected) ? (
            <PhaseSevenScreen
              bucket={selected}
              view={phaseView as "bucket-settings" | "account-settings"}
              onBucketUpdated={(next) => {
                loadedBuckets.current = loadedBuckets.current.map((item) =>
                  item.id === next.id ? next : item,
                );
                setBuckets(loadedBuckets.current);
                setSelected(next);
              }}
              onBucketGone={(id) => {
                loadedBuckets.current = loadedBuckets.current.filter((item) => item.id !== id);
                setBuckets(loadedBuckets.current);
                setSelected(loadedBuckets.current[0] ?? null);
                requestedBucketTarget.current = loadedBuckets.current[0]?.id ?? "";
                void auth.refresh();
              }}
            />
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
          ) : selected && ["notifications", "reminders"].includes(phaseView ?? "") ? (
            <PhaseFiveScreen
              key={selected.id}
              bucket={selected}
              buckets={buckets}
              profile={profile}
              view={phaseView as "notifications" | "reminders"}
            />
          ) : selected && phaseView === "contacts" ? (
            <PhaseSixContacts contactId={params.get("contact")} />
          ) : selected && ["csv-import", "csv-export"].includes(phaseView ?? "") ? (
            <PhaseSixCsv
              key={`${selected.id}:${phaseView}:${phaseView === "csv-export" ? params.toString() : (params.get("import") ?? "")}`}
              bucket={selected}
              view={phaseView as "csv-import" | "csv-export"}
              importId={params.get("import")}
              exportFilters={params.toString()}
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
              <div className="workspace-title flex justify-between items-center [gap:20px] [margin-bottom:32px] [&_h1]:[font-size:31px] [&_h1]:[margin:11px_0_10px] [&_p]:text-xs max-[1000px]:items-start max-[1000px]:[&_h1]:[font-size:26px] max-[1000px]:[&_>_.button]:[padding:10px_14px] max-[1000px]:[&_>_.button]:text-xs max-[767px]:flex-col max-[767px]:[gap:20px]">
                <div>
                  <span className="eyebrow inline-flex items-center [gap:8px] text-[var(--muted)] text-xs [font-weight:650] [letter-spacing:.13em]">
                    A LITTLE MORE CLARITY
                  </span>
                  <h1>Welcome, {profile.displayName.split(" ")[0]}.</h1>
                  <p>
                    {selected
                      ? "A fresh space for your everyday spending."
                      : "Everyday clarity starts with your first bucket."}
                  </p>
                </div>
                {selected?.isOwner && selected.status === "active" && (
                  <button
                    className={`${controls.primary} button`}
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
                  <section className="bucket-summary flex [gap:20px] items-center bg-[var(--surface)] [border:1px_solid_var(--line)] [border-radius:12px] [padding:24px] [&_h2]:[font-size:20px] [&_h2]:[overflow-wrap:anywhere] [&_p]:text-xs [&_p]:[margin-top:7px] [&_p_span]:[margin:0_5px] [&_>_.pill]:ml-auto max-[767px]:[padding:18px] max-[767px]:flex-wrap max-[767px]:[gap:14px] max-[767px]:[&_.large-icon]:[width:46px] max-[767px]:[&_.large-icon]:[height:46px] max-[767px]:[&_.large-icon]:[border-radius:12px] max-[767px]:[&_h2]:[font-size:17px] max-[767px]:[&_>_.pill]:[margin-left:0]">
                    <span className="large-icon [width:66px] [height:66px] inline-flex items-center justify-center bg-[var(--sage)] [border-radius:16px] text-[var(--green)]">
                      <Home size={27} />
                    </span>
                    <div>
                      <h2>{selected.name}</h2>
                      <p>
                        {selected.primaryCurrency} <span>·</span> {selected.timezone} <span>·</span>{" "}
                        {selected.memberCount} {selected.memberCount === 1 ? "member" : "members"}
                      </p>
                    </div>
                    <span className="pill text-xs font-semibold bg-[var(--soft)] text-[var(--muted)] [padding:3px_8px] [border-radius:5px] whitespace-nowrap">
                      {selected.status === "archived"
                        ? "Archived · read only"
                        : selected.isOwner
                          ? "Owner"
                          : "Member"}
                    </span>
                  </section>
                  <section className="workspace-empty flex flex-col items-center text-center [padding:64px_24px] [gap:20px] [&_h2]:[font-size:26px] [&_p]:text-xs [&_p]:[line-height:1.9] max-[767px]:[padding:44px_12px] max-[767px]:[&_h2]:[font-size:23px]">
                    <span className="empty-art [padding:25px] text-[var(--green)] bg-[var(--sage)] [border-radius:28px]">
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
                        className={`${controls.secondary} button`}
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
                        className={`${controls.secondary} button`}
                        onClick={() => {
                          setStep(0);
                          setModal("tour");
                        }}
                      >
                        Take a look around
                      </button>
                    )}
                  </section>
                  <div className="workspace-tip bg-[var(--soft)] flex items-center [gap:14px] [padding:20px_24px] [border-radius:9px] text-[var(--green)] [&_p]:text-xs max-[767px]:[padding:16px]">
                    <ShieldCheck size={20} />
                    <p>
                      Only current members of this bucket can access its spending. Your other
                      buckets stay separate.
                    </p>
                  </div>
                </>
              ) : (
                !error && (
                  <section className="workspace-empty flex flex-col items-center text-center [padding:64px_24px] [gap:20px] [&_h2]:[font-size:26px] [&_p]:text-xs [&_p]:[line-height:1.9] max-[767px]:[padding:44px_12px] max-[767px]:[&_h2]:[font-size:23px]">
                    <span className="empty-art [padding:25px] text-[var(--green)] bg-[var(--sage)] [border-radius:28px]">
                      <FolderOpen size={52} />
                    </span>
                    <h2>One bucket. A fresh beginning.</h2>
                    <p>Start with personal spending, a shared home, or something else.</p>
                    <Link className={`${controls.primary} button`} href="/onboarding">
                      Create your first bucket <Plus size={16} />
                    </Link>
                    <Link
                      className="text-link [background:none] border-0 [padding:0] inline-flex items-center [gap:8px] text-[var(--green)] font-semibold text-xs [&:hover]:[text-decoration:underline] [&:hover]:[text-underline-offset:4px]"
                      href="/join"
                    >
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
            <div className="form-stack flex flex-col [gap:16px] [&_>_.notice]:[margin-bottom:0]">
              <p>
                Invite someone to <b>{selected?.name}</b>. The link works for seven days and can be
                used by more than one person.
              </p>
              {!invite ? (
                <button
                  className={`${controls.primary} button w-full`}
                  disabled={busy}
                  onClick={generateInvite}
                >
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
                    className={`${controls.primary} button`}
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
                    <div className="qr-wrap flex justify-center [padding:20px] [background:white] rounded-lg">
                      <QRCodeSVG
                        value={invite.shareUrl}
                        size={168}
                        title={`Invitation to ${selected?.name}`}
                      />
                    </div>
                    <label className="flex flex-col gap-[7px] text-xs font-medium">
                      Invitation link
                      <input
                        className={controls.input}
                        value={invite.shareUrl}
                        readOnly
                        onFocus={(e) => e.target.select()}
                      />
                    </label>
                    <button
                      className={`${controls.primary} button w-full`}
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
                      className={`${controls.secondary} button w-full`}
                      href={`https://wa.me/?text=${encodeURIComponent(`Join my Buckit bucket:\n ${invite.shareUrl}`)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Share on WhatsApp
                    </a>
                    <p className="field-hint flex items-center [gap:6px] text-xs [line-height:1.7] text-[var(--muted)]">
                      Expires {new Date(invite.expiresAt).toLocaleDateString()}. Anyone with this
                      link can join after signing in.
                    </p>
                  </>
                )
              )}
            </div>
          )}
          {modal === "profile" && (
            <form
              className="form-stack flex flex-col [gap:16px] [&_>_.notice]:[margin-bottom:0]"
              onSubmit={saveProfile}
            >
              <label className="flex flex-col gap-[7px] text-xs font-medium">
                Display name
                <input
                  className={controls.input}
                  name="displayName"
                  defaultValue={profile.displayName}
                  required
                  maxLength={80}
                />
              </label>
              <label className="flex flex-col gap-[7px] text-xs font-medium">
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
              <label className="flex flex-col gap-[7px] text-xs font-medium">
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
              <button className={`${controls.primary} button w-full`} disabled={busy}>
                {busy ? "Saving…" : "Save changes"}
              </button>
              <p className="field-hint flex items-center [gap:6px] text-xs [line-height:1.7] text-[var(--muted)]">
                {profile.email}
              </p>
            </form>
          )}
          {modal === "tour" && (
            <div className="tour-body flex flex-col [gap:22px] [&_>_p]:[line-height:1.9]">
              <span className="large-icon [width:66px] [height:66px] inline-flex items-center justify-center bg-[var(--sage)] [border-radius:16px] text-[var(--green)]">
                {currentStep === 0 ? <FolderOpen size={32} /> : <HelpCircle size={32} />}
              </span>
              <p>{steps[currentStep].text}</p>
              <div className="tour-progress flex items-center [gap:6px] [&_>_span]:[width:20px] [&_>_span]:[height:4px] [&_>_span]:[border-radius:4px] [&_>_span]:[background:var(--line)] [&_>_span.active]:[background:var(--green)] [&_>_small]:ml-auto [&_>_small]:text-xs [&_>_small]:text-[var(--muted)]">
                {steps.map((item, index) => (
                  <span key={item.title} className={index === currentStep ? "active" : ""} />
                ))}
                <small>
                  {currentStep + 1} of {steps.length}
                </small>
              </div>
              <div className="tour-actions flex justify-between items-center [gap:10px] [&_>_div]:flex [&_>_div]:justify-between [&_>_div]:items-center [&_>_div]:[gap:10px] max-[767px]:[&_.button]:[padding:10px_14px]">
                <button
                  className="text-link [background:none] border-0 [padding:0] inline-flex items-center [gap:8px] text-[var(--green)] font-semibold text-xs [&:hover]:[text-decoration:underline] [&:hover]:[text-underline-offset:4px]"
                  disabled={busy}
                  onClick={() => tour(currentStep, "skipped")}
                >
                  Skip tour
                </button>
                <div>
                  {currentStep > 0 && (
                    <button
                      className={`${controls.secondary} button`}
                      disabled={busy}
                      onClick={() => tour(currentStep - 1)}
                    >
                      Back
                    </button>
                  )}
                  <button
                    className={`${controls.primary} button`}
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
