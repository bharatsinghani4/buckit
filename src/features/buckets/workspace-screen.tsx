"use client";
import Image from "next/image";
import Link from "next/link";
import { controls } from "@/components/control-styles";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import {
  ArrowRight,
  BookOpen,
  FolderOpen,
  Home,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Mail,
  MoreHorizontal,
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
  Camera,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Dropdown } from "@/components/dropdown";
import { Dialog, Notice, Pending } from "@/components/ui";
import { AccessGate } from "@/features/identity/access-gate";
import { useAuth } from "@/features/identity/auth-provider";
import { type Bucket, type Profile, type Tour } from "@/features/identity/contracts";
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
const profileMenuItem =
  "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs text-[var(--ink)] hover:bg-[var(--soft)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--green)]";

type SidebarGroupId = "spending" | "insights" | "manage";
type SidebarLink = { label: string; view: string; activeViews: string[]; icon: LucideIcon };
const sidebarGroups: {
  id: SidebarGroupId;
  label: string;
  icon: LucideIcon;
  items: SidebarLink[];
}[] = [
  {
    id: "spending",
    label: "Spending",
    icon: Wallet,
    items: [
      {
        label: "Expenses",
        view: "expenses",
        activeViews: ["expenses", "deleted", "add-expense", "expense"],
        icon: Wallet,
      },
      { label: "EMIs", view: "emis", activeViews: ["emis", "emi-plan"], icon: CreditCard },
      { label: "Scheduled", view: "scheduled", activeViews: ["scheduled"], icon: CalendarClock },
    ],
  },
  {
    id: "insights",
    label: "Insights",
    icon: BarChart3,
    items: [
      { label: "Reports", view: "reports", activeViews: ["reports"], icon: BarChart3 },
      {
        label: "Budgets",
        view: "budgets",
        activeViews: ["budgets", "budget", "budget-form"],
        icon: BookOpen,
      },
    ],
  },
  {
    id: "manage",
    label: "Manage",
    icon: SlidersHorizontal,
    items: [
      {
        label: "Reference settings",
        view: "references",
        activeViews: ["references"],
        icon: SlidersHorizontal,
      },
      { label: "Members", view: "members", activeViews: ["members"], icon: Users },
      { label: "Notifications", view: "notifications", activeViews: ["notifications"], icon: Bell },
      {
        label: "Reminders & cadence",
        view: "reminders",
        activeViews: ["reminders"],
        icon: CalendarClock,
      },
      { label: "Contacts", view: "contacts", activeViews: ["contacts"], icon: ContactRound },
      { label: "Import CSV", view: "csv-import", activeViews: ["csv-import"], icon: FileUp },
      { label: "Export CSV", view: "csv-export", activeViews: ["csv-export"], icon: FileDown },
      {
        label: "Bucket settings",
        view: "bucket-settings",
        activeViews: ["bucket-settings"],
        icon: Settings2,
      },
    ],
  },
];

function ProfileAvatar({ profile, size = 34 }: { profile: Profile; size?: 34 | 38 | 56 }) {
  const dimensions = size === 56 ? "size-14" : size === 38 ? "size-[38px]" : "size-[34px]";
  return profile.avatarDataUrl ? (
    <Image
      src={profile.avatarDataUrl}
      alt=""
      width={size}
      height={size}
      unoptimized
      className={`${dimensions} shrink-0 rounded-full object-cover`}
    />
  ) : (
    <span
      className={`${dimensions} grid shrink-0 place-items-center rounded-full bg-[var(--sage)] font-semibold text-[var(--green)]`}
      aria-hidden="true"
    >
      {profile.displayName.charAt(0).toUpperCase()}
    </span>
  );
}

async function prepareAvatar(file: File): Promise<string> {
  if (
    !(["image/png", "image/jpeg", "image/webp"] as string[]).includes(file.type) ||
    file.size > 5_000_000
  )
    throw new Error("Choose a PNG, JPEG, or WebP image under 5 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = new window.Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not prepare the image.");
    const edge = Math.min(image.naturalWidth, image.naturalHeight);
    if (!edge) throw new Error("Choose an image that can be opened.");
    context.drawImage(
      image,
      (image.naturalWidth - edge) / 2,
      (image.naturalHeight - edge) / 2,
      edge,
      edge,
      0,
      0,
      256,
      256,
    );
    const dataUrl = canvas.toDataURL("image/webp", 0.82);
    if (dataUrl.length > 120_000) throw new Error("Choose a less detailed image.");
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}

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
  const bucketQuery = params.get("bucket");
  const phaseView = params.get("view");
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [selected, setSelected] = useState<Bucket | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<"profile" | "tour" | null>(null);
  const [step, setStep] = useState(profile.tour.lastStep);
  const tourPrompted = useRef(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [ledgerMonth, setLedgerMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [sidebarPinned, setSidebarPinned] = useState(true);
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [openGroups, setOpenGroups] = useState<Record<SidebarGroupId, boolean>>(() => {
    const active = sidebarGroups.find((group) =>
      group.items.some((item) => item.activeViews.includes(phaseView ?? "")),
    )?.id;
    return {
      spending: !active || active === "spending",
      insights: active === "insights",
      manage: active === "manage",
    };
  });
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const mobileMoreDialogRef = useRef<HTMLDialogElement>(null);
  const [avatarDraft, setAvatarDraft] = useState<string | null>(profile.avatarDataUrl);
  const [avatarProcessing, setAvatarProcessing] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const profileButtonRef = useRef<HTMLButtonElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const sidebarHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestedBucketTarget = useRef<string | null>(null);
  const loadedBuckets = useRef<Bucket[]>([]);
  useEffect(() => {
    const active = sidebarGroups.find((group) =>
      group.items.some((item) => item.activeViews.includes(phaseView ?? "")),
    )?.id;
    if (active)
      queueMicrotask(() =>
        setOpenGroups((current) => (current[active] ? current : { ...current, [active]: true })),
      );
  }, [phaseView]);
  useEffect(() => {
    if (!profileMenuOpen) return;
    function closeOutside(event: PointerEvent) {
      if (!profileMenuRef.current?.contains(event.target as Node)) setProfileMenuOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setProfileMenuOpen(false);
        profileButtonRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [profileMenuOpen]);
  useEffect(() => {
    if (!mobileMoreOpen) return;
    const dialog = mobileMoreDialogRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog?.showModal();
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileMoreOpen]);
  function openProfile() {
    setAvatarDraft(profile.avatarDataUrl);
    setProfileMenuOpen(false);
    setError("");
    setModal("profile");
  }
  function focusMenuItem(index: number) {
    const items = profileMenuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']");
    if (items?.length) items[(index + items.length) % items.length].focus();
  }
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
  function togglePin() {
    const next = !sidebarPinned;
    setSidebarPinned(next);
    setSidebarExpanded(next);
    setPreference("buckit-sidebar-pinned", String(next));
  }
  const profileKey = useRef<{ body: string; key: string } | null>(null);
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
        ...(avatarDraft !== profile.avatarDataUrl ? { avatarDataUrl: avatarDraft } : {}),
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
            text: "Open Members to create and manage invitation links. People join only after signing in and confirming.",
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
  const mobileForm = ["add-expense", "budget-form"].includes(phaseView ?? "");
  const mobileNavItems = [
    { label: "Overview", view: "", icon: LayoutDashboard, active: !phaseView },
    {
      label: "Expenses",
      view: "expenses",
      icon: Wallet,
      active: ["expenses", "deleted", "expense"].includes(phaseView ?? ""),
    },
    { label: "Add", view: "add-expense", icon: Plus, active: phaseView === "add-expense" },
    {
      label: "Budgets",
      view: "budgets",
      icon: BookOpen,
      active: ["budgets", "budget", "budget-form"].includes(phaseView ?? ""),
    },
  ];
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
    <div className="workspace-layout min-h-svh">
      <aside
        className={`sidebar fixed inset-y-0 left-0 z-30 hidden flex-col gap-5 overflow-y-auto overflow-x-hidden border-r border-[var(--line)] bg-[var(--surface)] py-5 transition-[width,padding] duration-200 min-[768px]:flex ${sidebarExpanded ? "w-[248px] px-4" : "w-[68px] px-[9px] [&_.nav-item]:justify-center [&_.nav-item]:gap-0 [&_.nav-item]:px-0 [&_.nav-item]:text-[0px] [&_.nav-item_svg]:size-5"}`}
        onMouseEnter={() => {
          if (!sidebarPinned) {
            sidebarHoverTimer.current = setTimeout(() => setSidebarExpanded(true), 250);
          }
        }}
        onMouseLeave={() => {
          if (sidebarHoverTimer.current) clearTimeout(sidebarHoverTimer.current);
          if (!sidebarPinned) setSidebarExpanded(false);
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
              className="inline-grid size-[34px] shrink-0 place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--soft)] hover:text-[var(--green)]"
              onClick={togglePin}
              aria-label={sidebarPinned ? "Unpin sidebar" : "Pin sidebar"}
              aria-pressed={sidebarPinned}
              title={sidebarPinned ? "Unpin sidebar" : "Pin sidebar"}
            >
              {sidebarPinned ? <Pin size={16} /> : <PinOff size={16} />}
            </button>
          )}
        </div>
        <nav aria-label="Workspace" className="!flex flex-col gap-1">
          <Link
            className={navItem}
            href="/buckets/new"
            aria-label="Create a bucket"
            title="Create a bucket"
          >
            <Plus size={18} /> Create a bucket
          </Link>
          <Link
            href={selected ? `/workspace?bucket=${selected.id}` : "/workspace"}
            onClick={navigateWithinWorkspace}
            className={`${navItem} ${!phaseView ? "active" : ""}`}
            aria-label="Overview"
            title="Overview"
          >
            <LayoutDashboard size={18} /> Overview
          </Link>
          {sidebarGroups.map((group) => {
            const GroupIcon = group.icon;
            return (
              <div key={group.id} className="flex flex-col gap-1">
                {sidebarExpanded && (
                  <button
                    type="button"
                    className={`${navItem} font-semibold ${openGroups[group.id] ? "text-[var(--ink)]" : ""}`}
                    aria-expanded={openGroups[group.id]}
                    aria-controls={`sidebar-group-${group.id}`}
                    onClick={() =>
                      setOpenGroups((current) => ({ ...current, [group.id]: !current[group.id] }))
                    }
                  >
                    <GroupIcon size={18} /> {group.label}
                    <ChevronDown
                      size={15}
                      className={`ml-auto transition-transform ${openGroups[group.id] ? "rotate-180" : ""}`}
                    />
                  </button>
                )}
                <div
                  id={`sidebar-group-${group.id}`}
                  className={`${sidebarExpanded && !openGroups[group.id] ? "hidden" : "flex"} flex-col gap-1 ${sidebarExpanded ? "ml-5 border-l border-[var(--line)] pl-2" : ""}`}
                >
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.view}
                        href={
                          selected
                            ? `/workspace?bucket=${selected.id}&view=${item.view}`
                            : "/workspace"
                        }
                        onClick={navigateWithinWorkspace}
                        className={`${navItem} ${item.activeViews.includes(phaseView ?? "") ? "active" : ""}`}
                        aria-label={item.label}
                        title={item.label}
                      >
                        <Icon size={18} /> {item.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>
      </aside>
      <div
        className={`workspace-main min-w-0 transition-[margin-left] duration-200 max-[767px]:!ml-0 ${sidebarExpanded ? "ml-[248px]" : "ml-[68px]"}`}
      >
        <header className="workspace-header flex h-16 min-w-0 items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--canvas)] px-8 text-xs max-[767px]:gap-2 max-[767px]:px-4 sticky top-0 z-20">
          <nav
            aria-label="Breadcrumb"
            className="flex min-w-0 items-center gap-2 whitespace-nowrap text-xs font-medium max-[767px]:flex-1"
          >
            <label className="sr-only" htmlFor="bucket-picker">
              Current bucket
            </label>
            <BucketSelector
              buckets={buckets}
              selected={selected}
              disabled={busy || loading}
              onValueChange={selectBucket}
              onCreateBucket={() => router.push("/buckets/new")}
              hasMore={!!cursor}
              onLoadMore={() => void moreBuckets()}
            />
            {phaseView && (
              <>
                <span
                  className={`text-[var(--line)] ${sidebarExpanded ? "max-[1000px]:hidden" : "max-[640px]:hidden"}`}
                  aria-hidden="true"
                >
                  /
                </span>
                <span
                  className={`shrink-0 font-semibold text-[var(--ink)] ${sidebarExpanded ? "max-[1000px]:hidden" : "max-[640px]:hidden"}`}
                  aria-current="page"
                >
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
          <div className="workspace-header-actions flex shrink-0 items-center justify-between gap-3 max-sm:!gap-1">
            {phaseView === "expenses" && (
              <LedgerMonthPicker value={ledgerMonth} onChange={setLedgerMonth} />
            )}
            <ThemeToggle />
            <div ref={profileMenuRef} className="relative shrink-0">
              <button
                ref={profileButtonRef}
                type="button"
                className="profile-chip flex min-h-10 items-center gap-1 rounded-lg border-0 bg-transparent text-left text-xs text-[var(--ink)] hover:bg-[var(--soft)] focus-visible:outline-2 focus-visible:outline-[var(--green)] max-[767px]:min-h-11"
                aria-label={`Account menu for ${profile.displayName}`}
                aria-haspopup="menu"
                aria-expanded={profileMenuOpen}
                onClick={() => setProfileMenuOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setProfileMenuOpen(true);
                    requestAnimationFrame(() => focusMenuItem(0));
                  }
                }}
              >
                <ProfileAvatar profile={profile} size={34} />
                <ChevronDown size={12} className="text-[var(--muted)]" />
              </button>
              {profileMenuOpen && (
                <div
                  role="menu"
                  aria-label="Account"
                  className="absolute right-0 top-[calc(100%+10px)] z-50 w-60 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-2 shadow-[0_14px_38px_rgba(0,0,0,.15)]"
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                    event.preventDefault();
                    const items = Array.from(
                      profileMenuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ??
                        [],
                    );
                    const index = items.indexOf(document.activeElement as HTMLElement);
                    focusMenuItem(index + (event.key === "ArrowDown" ? 1 : -1));
                  }}
                >
                  <div className="flex items-center gap-3 border-b border-[var(--line)] px-2 py-2.5">
                    <ProfileAvatar profile={profile} size={38} />
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold text-[var(--ink)]">
                        {profile.displayName}
                      </div>
                      <div className="text-[11px] text-[var(--muted)]">
                        {selected ? (selected.isOwner ? "Owner" : "Member") : "Account"}
                      </div>
                    </div>
                  </div>
                  <div className="py-1">
                    <button
                      type="button"
                      role="menuitem"
                      className={profileMenuItem}
                      disabled={!selected}
                      onClick={() => {
                        setStep(0);
                        setProfileMenuOpen(false);
                        setModal("tour");
                      }}
                    >
                      <HelpCircle size={17} /> Help & tour
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className={profileMenuItem}
                      onClick={openProfile}
                    >
                      <Settings2 size={17} /> Profile & appearance
                    </button>
                    <Link
                      role="menuitem"
                      href={
                        selected
                          ? `/workspace?bucket=${selected.id}&view=account-settings`
                          : "/workspace?view=account-settings"
                      }
                      onClick={(event) => {
                        navigateWithinWorkspace(event);
                        setProfileMenuOpen(false);
                      }}
                      className={profileMenuItem}
                    >
                      <ShieldCheck size={17} /> Account settings
                    </Link>
                  </div>
                  <div className="border-t border-[var(--line)] pt-1">
                    <button
                      type="button"
                      role="menuitem"
                      className={profileMenuItem}
                      onClick={() => {
                        setProfileMenuOpen(false);
                        void auth.logout();
                      }}
                    >
                      <LogOut size={17} /> Sign out
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>
        <main
          id="main"
          className="workspace-content [max-width:1160px] m-auto [padding:24px] max-[1000px]:[padding:24px] max-[767px]:[padding:16px_16px_calc(94px+env(safe-area-inset-bottom))]"
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
      {!mobileForm && (
        <nav
          aria-label="Mobile workspace navigation"
          className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-[var(--line)] bg-[var(--surface)] px-2 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_28px_rgba(0,0,0,.08)] min-[768px]:hidden"
        >
          {mobileNavItems.map(({ label, view, icon: Icon, active }) => (
            <Link
              key={label}
              href={
                selected
                  ? `/workspace?bucket=${selected.id}${view ? `&view=${view}` : ""}`
                  : "/buckets/new"
              }
              onClick={navigateWithinWorkspace}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-[66px] min-w-0 flex-col items-center justify-center gap-1 rounded-lg text-xs font-medium ${active ? "text-[var(--green)]" : "text-[var(--muted)]"} ${label === "Add" ? "font-semibold" : ""}`}
            >
              <span
                className={`grid size-9 place-items-center rounded-xl ${label === "Add" ? "bg-[var(--button-primary)] text-[var(--button-primary-text)]" : active ? "bg-[var(--sage)]" : ""}`}
              >
                <Icon size={19} aria-hidden="true" />
              </span>
              <span>{label}</span>
            </Link>
          ))}
          <button
            type="button"
            onClick={() => setMobileMoreOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={mobileMoreOpen}
            className={`flex min-h-[66px] min-w-0 flex-col items-center justify-center gap-1 rounded-lg text-xs font-medium ${sidebarGroups.some((group) => group.items.some((item) => item.activeViews.includes(phaseView ?? ""))) && !mobileNavItems.some((item) => item.active) ? "text-[var(--green)]" : "text-[var(--muted)]"}`}
          >
            <span className="grid size-9 place-items-center rounded-xl">
              <MoreHorizontal size={21} aria-hidden="true" />
            </span>
            More
          </button>
        </nav>
      )}
      {mobileMoreOpen && (
        <dialog
          ref={mobileMoreDialogRef}
          aria-label="More workspace sections"
          onCancel={() => setMobileMoreOpen(false)}
          onClick={(event) => {
            if (event.target === event.currentTarget) setMobileMoreOpen(false);
          }}
          className="fixed inset-0 z-50 m-0 ml-auto h-full max-h-full w-full max-w-[420px] overflow-y-auto border-0 bg-[var(--surface)] px-5 pb-[calc(24px+env(safe-area-inset-bottom))] pt-[calc(20px+env(safe-area-inset-top))] text-[var(--ink)] shadow-2xl backdrop:bg-[#172f2870] min-[768px]:hidden"
        >
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-xl">Your workspace</h2>
            <button
              type="button"
              className="grid size-11 place-items-center rounded-xl bg-[var(--soft)]"
              onClick={() => setMobileMoreOpen(false)}
              aria-label="Close navigation"
            >
              <ChevronDown size={20} aria-hidden="true" />
            </button>
          </div>
          {sidebarGroups.map((group) => (
            <section key={group.id} className="mb-6">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--muted)]">
                {group.label}
              </h3>
              <div className="grid gap-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = item.activeViews.includes(phaseView ?? "");
                  return (
                    <Link
                      key={item.view}
                      href={
                        selected
                          ? `/workspace?bucket=${selected.id}&view=${item.view}`
                          : "/workspace"
                      }
                      onClick={(event) => {
                        navigateWithinWorkspace(event);
                        setMobileMoreOpen(false);
                      }}
                      aria-current={active ? "page" : undefined}
                      className={`flex min-h-12 items-center gap-3 rounded-xl px-3 text-sm ${active ? "bg-[var(--sage)] font-semibold text-[var(--green)]" : "text-[var(--ink)]"}`}
                    >
                      <Icon size={19} aria-hidden="true" />
                      {item.label}
                      <ArrowRight
                        size={16}
                        className="ml-auto text-[var(--muted)]"
                        aria-hidden="true"
                      />
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
          <Link
            href="/buckets/new"
            className="flex min-h-12 items-center gap-3 rounded-xl border border-[var(--line)] px-3 text-sm font-semibold text-[var(--green)]"
          >
            <Plus size={19} aria-hidden="true" /> Create a bucket
          </Link>
        </dialog>
      )}
      {modal && (
        <Dialog
          title={modal === "profile" ? "Make yourself at home" : steps[currentStep].title}
          subtitle=""
          onClose={closeModal}
        >
          {error && <Notice>{error}</Notice>}
          {modal === "profile" && (
            <form
              className="form-stack flex flex-col [gap:16px] [&_>_.notice]:[margin-bottom:0]"
              onSubmit={saveProfile}
            >
              <div className="flex items-center gap-4 rounded-xl border border-[var(--line)] bg-[var(--soft)] p-3">
                <ProfileAvatar profile={{ ...profile, avatarDataUrl: avatarDraft }} size={56} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-[var(--ink)]">Profile image</div>
                  <div className="mt-1 text-xs text-[var(--muted)]">
                    PNG, JPEG, or WebP. Cropped to a square.
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="sr-only"
                      aria-label="Choose profile image"
                      onChange={async (event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (!file) return;
                        setAvatarProcessing(true);
                        setError("");
                        try {
                          setAvatarDraft(await prepareAvatar(file));
                        } catch (error) {
                          setError(
                            error instanceof Error ? error.message : "Could not open that image.",
                          );
                        } finally {
                          setAvatarProcessing(false);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className={`${controls.secondary} button`}
                      disabled={avatarProcessing || busy}
                      onClick={() => avatarInputRef.current?.click()}
                    >
                      <Camera size={15} /> {avatarDraft ? "Change image" : "Add image"}
                    </button>
                    {avatarDraft && (
                      <button
                        type="button"
                        className={`${controls.secondary} button`}
                        disabled={avatarProcessing || busy}
                        onClick={() => setAvatarDraft(null)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>
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
              <button
                className={`${controls.primary} button w-full`}
                disabled={busy || avatarProcessing}
              >
                {busy ? "Saving…" : avatarProcessing ? "Preparing image…" : "Save changes"}
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
