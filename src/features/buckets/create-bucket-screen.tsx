"use client";
import Link from "next/link";
import { controls } from "@/components/control-styles";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Clock3, Home, Info, Link2, LockKeyhole, UserRound } from "lucide-react";
import { Brand, Wordmark } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Dropdown } from "@/components/dropdown";
import { Notice } from "@/components/ui";
import { useAuth } from "@/features/identity/auth-provider";
import { AccessGate } from "@/features/identity/access-gate";
import { currencies, type Bucket } from "@/features/identity/contracts";
import { api, ClientError, friendlyError, operationKey } from "@/lib/api/client";

export function CreateBucketScreen({ additional = false }: { additional?: boolean }) {
  return (
    <AccessGate preview>
      <CreateBucketForm additional={additional} />
    </AccessGate>
  );
}
function CreateBucketForm({ additional }: { additional: boolean }) {
  const { profile, user, configured, refresh } = useAuth();
  const router = useRouter();
  const [name, setName] = useState("House Expenses");
  const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [zones, setZones] = useState([
    "Asia/Kolkata",
    "UTC",
    "Asia/Dubai",
    "Europe/London",
    "America/New_York",
    "Asia/Singapore",
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const createKey = useRef<{ body: string; key: string } | null>(null);
  const profileKey = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    const zone =
      profile?.timezone !== "UTC" && profile?.timezone
        ? profile.timezone
        : Intl.DateTimeFormat().resolvedOptions().timeZone;
    queueMicrotask(() => {
      setTimezone(zone);
      setZones([...new Set([zone, "UTC", ...Intl.supportedValuesOf("timeZone")])]);
    });
  }, [profile?.timezone]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || busy) return;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const profileInput = { displayName: String(form.get("displayName")).trim(), timezone };
      if (profileInput.displayName !== profile.displayName || timezone !== profile.timezone)
        await api("me", {
          method: "PATCH",
          body: profileInput,
          revision: profile.revision,
          key: operationKey(profileKey, profileInput),
        });
      const input = {
        name: name.trim(),
        primaryCurrency: String(form.get("primaryCurrency")),
        timezone,
      };
      const { data } = await api<Bucket>("buckets", {
        method: "POST",
        body: input,
        key: operationKey(createKey, input),
      });
      await refresh();
      router.push(`/workspace?bucket=${data.id}`);
    } catch (e) {
      if (e instanceof ClientError && e.status === 412) {
        profileKey.current = null;
        await refresh();
      }
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main
      id="main"
      className="onboarding-page [padding:25px_24px_50px] max-[767px]:[padding:22px_20px_40px]"
    >
      <div className="onboarding-top [max-width:1180px] m-auto flex items-center justify-between max-[767px]:[&_>_.brand]:m-auto max-[767px]:[&_.text-link]:hidden sticky top-0 z-20 bg-[var(--canvas)] py-2">
        <Brand />
        <div className="onboarding-actions flex items-center justify-between [gap:14px]">
          <ThemeToggle />
          {profile && (
            <Link
              href="/workspace"
              className="text-link [background:none] border-0 [padding:0] inline-flex items-center [gap:8px] text-[var(--green)] font-semibold text-xs [&:hover]:[text-decoration:underline] [&:hover]:[text-underline-offset:4px]"
            >
              Your workspace
            </Link>
          )}
        </div>
      </div>
      <div className="onboarding-content [max-width:600px] [margin:36px_auto_0] max-[767px]:[margin-top:30px]">
        <header className="onboarding-heading text-left [margin:0_0_28px] [&_h1]:[margin:13px_0_10px] [&_h1]:[font-size:30px] [&_.wordmark]:[font-size:33px] [&_p]:text-xs max-[767px]:[&_h1]:[font-size:24px] max-[420px]:[&_.wordmark]:[font-size:29px]">
          <span className="eyebrow inline-flex items-center [gap:8px] text-[var(--muted)] text-xs [font-weight:650] [letter-spacing:.13em]">
            {additional ? "A NEW SPACE" : "INITIAL SETUP · STEP 1 OF 1"}
          </span>
          <h1>
            {additional ? (
              "Make room for a new bucket."
            ) : (
              <>
                Welcome to <Wordmark />
              </>
            )}
          </h1>
          <p>Create a space for the spending you want to track.</p>
        </header>
        <form
          className="onboarding-card [padding:36px] [border-radius:11px] bg-[var(--surface)] [box-shadow:var(--shadow)] [gap:26px] max-[767px]:[padding:24px_20px] form-stack flex flex-col [gap:16px] [&_>_.notice]:[margin-bottom:0]"
          onSubmit={submit}
        >
          {error && <Notice>{error}</Notice>}
          <section>
            <div className="section-label flex items-center [gap:10px] [margin-bottom:18px] [&_h2]:[font-size:15px] [&_h2]:[letter-spacing:-.02em] [&_.pill]:ml-auto">
              <span className="step-number grid [place-items:center] [width:22px] [height:22px] rounded-full bg-[var(--soft)] text-[var(--green)] text-xs [&.filled]:[background:var(--green)] [&.filled]:[color:var(--surface)]">
                1
              </span>
              <h2>Your identity</h2>
              <span className="pill text-xs font-semibold bg-[var(--soft)] text-[var(--muted)] [padding:3px_8px] [border-radius:5px] whitespace-nowrap">
                Your profile
              </span>
            </div>
            <div className="form-grid grid [grid-template-columns:1fr_1fr] [gap:16px] max-[420px]:[grid-template-columns:1fr]">
              <label className="flex flex-col gap-[7px] text-xs font-medium">
                Display name
                <input
                  className={controls.input}
                  name="displayName"
                  placeholder="Your name"
                  defaultValue={profile?.displayName || user?.displayName || ""}
                  required
                  maxLength={80}
                  autoComplete="name"
                />
              </label>
              <label className="flex flex-col gap-[7px] text-xs font-medium">
                Your timezone
                <Dropdown
                  value={timezone}
                  onValueChange={setTimezone}
                  options={zones.map((zone) => ({ value: zone, label: zone }))}
                  placeholder="Choose timezone"
                />
              </label>
            </div>
          </section>
          <div className="rule [height:1px] [background:var(--line)]" />
          <section>
            <div className="section-label flex items-center [gap:10px] [margin-bottom:18px] [&_h2]:[font-size:15px] [&_h2]:[letter-spacing:-.02em] [&_.pill]:ml-auto">
              <span className="step-number grid [place-items:center] [width:22px] [height:22px] rounded-full bg-[var(--soft)] text-[var(--green)] text-xs [&.filled]:[background:var(--green)] [&.filled]:[color:var(--surface)] filled">
                2
              </span>
              <h2>{additional ? "Your new bucket" : "Your first bucket"}</h2>
            </div>
            <p className="section-description text-xs [margin-top:-9px] [margin-bottom:18px] [padding-left:32px]">
              A bucket keeps spending for one part of your life together.
            </p>
            <div className="suggestions flex flex-wrap items-center [gap:8px] [margin-bottom:22px] [&_>_span]:text-xs [&_>_span]:text-[var(--muted)] [&_>_span]:[letter-spacing:.08em] [&_>_span]:[margin-right:3px] [&_button]:bg-[var(--soft)] [&_button]:[border:none] [&_button]:[padding:7px_11px] [&_button]:text-xs [&_button]:inline-flex [&_button]:items-center [&_button]:[gap:5px] [&_button.selected]:[background:var(--ink)] [&_button.selected]:[color:var(--surface)] max-[420px]:[gap:6px] max-[420px]:[&_>_span]:w-full">
              <span>SUGGESTIONS</span>
              <button
                type="button"
                aria-pressed={name === "House Expenses"}
                className={name === "House Expenses" ? "selected" : ""}
                onClick={() => setName("House Expenses")}
              >
                <Home size={14} /> House Expenses
              </button>
              <button
                type="button"
                aria-pressed={name === "Personal"}
                className={name === "Personal" ? "selected" : ""}
                onClick={() => setName("Personal")}
              >
                <UserRound size={14} /> Personal
              </button>
            </div>
            <div className="form-stack flex flex-col [gap:16px] [&_>_.notice]:[margin-bottom:0]">
              <label className="flex flex-col gap-[7px] text-xs font-medium">
                Bucket name
                <input
                  className={controls.input}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={80}
                  placeholder="e.g. House Expenses, Personal, Travel"
                />
              </label>
              <label className="flex flex-col gap-[7px] text-xs font-medium">
                <span className="label-row flex items-center justify-between [gap:8px] [&_>_a]:text-xs [&_>_a]:text-[var(--green)] [&_small]:text-[var(--muted)] [&_small]:text-xs [&_small]:[font-weight:400]">
                  Primary currency<small>Fixed after first expense</small>
                </span>
                <Dropdown
                  name="primaryCurrency"
                  defaultValue="INR"
                  options={currencies.map((currency) => ({
                    value: currency.code,
                    label: `${currency.code} (${currency.symbol}) — ${currency.name}`,
                  }))}
                  placeholder="Choose currency"
                />
              </label>
              <div className="timezone-note flex items-center justify-between [gap:12px] bg-[var(--soft)] [border-radius:7px] [padding:11px_13px] text-xs [&_>_span]:flex [&_>_span]:[gap:8px] [&_>_span]:items-center [&_>_span]:text-[var(--muted)] [&_b]:[font-weight:500] [&_b]:[overflow-wrap:anywhere]">
                <span>
                  <Clock3 size={16} /> Bucket timezone
                </span>
                <b>{timezone}</b>
              </div>
              <p className="field-hint flex items-center [gap:6px] text-xs [line-height:1.7] text-[var(--muted)]">
                <Info size={14} /> Currency is fixed after your first expense.
              </p>
            </div>
          </section>
          <button
            className={`${controls.primary} button bg-[var(--ink)] w-full`}
            disabled={!configured || !profile || busy}
          >
            {busy ? "Creating your bucket…" : "Create bucket"}
            <ArrowRight size={16} />
          </button>
          <Link
            className="join-link flex justify-between items-center [gap:10px] bg-[var(--soft)] [padding:14px] text-xs [border-radius:7px] [&_>_span]:flex [&_>_span]:items-center [&_>_span]:[gap:7px] [&_>_b]:flex [&_>_b]:items-center [&_>_b]:[gap:7px] [&_>_b]:font-semibold max-[767px]:items-start max-[767px]:flex-col max-[767px]:[gap:12px] max-[767px]:[&_>_b]:[margin-left:23px]"
            href="/join"
          >
            <span>
              <Link2 size={16} /> Have an invite link?
            </span>
            <b>
              Join with an invite <ArrowRight size={14} />
            </b>
          </Link>
        </form>
        <div className="onboarding-trust flex items-center justify-center [gap:20px] [margin-top:24px] text-[var(--muted)] text-xs [&_span]:flex [&_span]:items-center [&_span]:[gap:5px] max-[767px]:[gap:12px] max-[767px]:flex-wrap">
          <span>
            <LockKeyhole size={13} /> Private by design
          </span>
          <span>No bank linking required</span>
          <span>Your spaces, your choice</span>
        </div>
      </div>
    </main>
  );
}
