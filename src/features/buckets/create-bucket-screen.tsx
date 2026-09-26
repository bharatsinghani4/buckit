"use client";
import Link from "next/link";
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
  return <AccessGate preview><CreateBucketForm additional={additional} /></AccessGate>;
}
function CreateBucketForm({ additional }: { additional: boolean }) {
  const { profile, user, configured, refresh } = useAuth(); const router = useRouter();
  const [name, setName] = useState("House Expenses"); const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [zones, setZones] = useState(["Asia/Kolkata", "UTC", "Asia/Dubai", "Europe/London", "America/New_York", "Asia/Singapore"]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const createKey = useRef<{ body: string; key: string } | null>(null); const profileKey = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => { const zone = profile?.timezone !== "UTC" && profile?.timezone ? profile.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone; queueMicrotask(() => { setTimezone(zone); setZones([...new Set([zone, "UTC", ...Intl.supportedValuesOf("timeZone")])]); }); }, [profile?.timezone]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!profile || busy) return; setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    try {
      const profileInput = { displayName: String(form.get("displayName")).trim(), timezone };
      if (profileInput.displayName !== profile.displayName || timezone !== profile.timezone) await api("me", { method: "PATCH", body: profileInput, revision: profile.revision, key: operationKey(profileKey, profileInput) });
      const input = { name: name.trim(), primaryCurrency: String(form.get("primaryCurrency")), timezone };
      const { data } = await api<Bucket>("buckets", { method: "POST", body: input, key: operationKey(createKey, input) });
      await refresh(); router.push(`/workspace?bucket=${data.id}`);
    } catch (e) { if (e instanceof ClientError && e.status === 412) { profileKey.current = null; await refresh(); } setError(friendlyError(e)); }
    finally { setBusy(false); }
  }
  return <main id="main" className="onboarding-page"><div className="onboarding-top"><Brand /><div className="onboarding-actions"><ThemeToggle />{profile && <Link href="/workspace" className="text-link">Your workspace</Link>}</div></div><div className="onboarding-content"><header className="onboarding-heading"><span className="eyebrow">{additional ? "A NEW SPACE" : "INITIAL SETUP · STEP 1 OF 1"}</span><h1>{additional ? "Make room for a new bucket." : <>Welcome to <Wordmark /></>}</h1><p>Let’s set up your profile and create a space<br className="desktop-break" /> for the spending that matters to you.</p></header>
    <form className="onboarding-card form-stack" onSubmit={submit}>{error && <Notice>{error}</Notice>}<section><div className="section-label"><span className="step-number">1</span><h2>Your identity</h2><span className="pill">Your profile</span></div><div className="form-grid"><label>Display name<input name="displayName" placeholder="Your name" defaultValue={profile?.displayName || user?.displayName || ""} required maxLength={80} autoComplete="name" /></label><label>Your timezone<Dropdown value={timezone} onValueChange={setTimezone} options={zones.map((zone) => ({ value: zone, label: zone }))} placeholder="Choose timezone" /></label></div></section>
    <div className="rule" /><section><div className="section-label"><span className="step-number filled">2</span><h2>{additional ? "Your new bucket" : "Your first bucket"}</h2></div><p className="section-description">A bucket keeps spending for one part of your life together.</p><div className="suggestions"><span>SUGGESTIONS</span><button type="button" aria-pressed={name === "House Expenses"} className={name === "House Expenses" ? "selected" : ""} onClick={() => setName("House Expenses")}><Home size={14} /> House Expenses</button><button type="button" aria-pressed={name === "Personal"} className={name === "Personal" ? "selected" : ""} onClick={() => setName("Personal")}><UserRound size={14} /> Personal</button></div><div className="form-stack"><label>Bucket name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="e.g. House Expenses, Personal, Travel" /></label><label><span className="label-row">Primary currency<small>Fixed after first expense</small></span><Dropdown name="primaryCurrency" defaultValue="INR" options={currencies.map((currency) => ({ value: currency.code, label: `${currency.code} (${currency.symbol}) — ${currency.name}` }))} placeholder="Choose currency" /></label><div className="timezone-note"><span><Clock3 size={16} /> Bucket timezone</span><b>{timezone}</b></div><p className="field-hint"><Info size={14} /> Currency is fixed after your first expense.</p></div></section>
    <button className="button primary forest full" disabled={!configured || !profile || busy}>{busy ? "Creating your bucket…" : "Create bucket"}<ArrowRight size={16} /></button><Link className="join-link" href="/join"><span><Link2 size={16} /> Have an invite link?</span><b>Join with an invite <ArrowRight size={14} /></b></Link></form><div className="onboarding-trust"><span><LockKeyhole size={13} /> Private by design</span><span>No bank linking required</span><span>Your spaces, your choice</span></div></div></main>;
}
