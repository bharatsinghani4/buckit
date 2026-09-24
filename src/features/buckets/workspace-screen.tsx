"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, BookOpen, Check, Copy, FolderOpen, Home, HelpCircle, LayoutDashboard, Link2, LogOut, Mail, Plus, Settings2, ShieldCheck, Users, Wallet } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Brand } from "@/components/brand";
import { Dialog, Notice, Pending } from "@/components/ui";
import { AccessGate } from "@/features/identity/access-gate";
import { useAuth } from "@/features/identity/auth-provider";
import { type Bucket, type Invitation, type Profile, type Tour } from "@/features/identity/contracts";
import { api, ClientError, friendlyError, operationKey } from "@/lib/api/client";

export function WorkspaceScreen() { return <AccessGate><Workspace /></AccessGate>; }
function Workspace() {
  const auth = useAuth(); const profile = auth.profile!; const params = useSearchParams(); const router = useRouter();
  const [buckets, setBuckets] = useState<Bucket[]>([]); const [selected, setSelected] = useState<Bucket | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<"invite" | "profile" | "tour" | null>(null);
  const [invite, setInvite] = useState<Invitation | null>(null); const [copied, setCopied] = useState(false);
  const [step, setStep] = useState(profile.tour.lastStep);
  const tourPrompted = useRef(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const inviteKey = useRef<{ body: string; key: string } | null>(null); const profileKey = useRef<{ body: string; key: string } | null>(null);
  const bucketQuery = params.get("bucket");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const result = await api<Bucket[]>("buckets"); setBuckets(result.data); setCursor(result.meta.nextCursor ?? null);
      const target = bucketQuery || profile.lastBucketId || result.data[0]?.id;
      if (!target) { setSelected(null); return; }
      let bucket = result.data.find((b) => b.id === target);
      if (!bucket) {
        try { bucket = (await api<Bucket>(`buckets/${target}`)).data; }
        catch (e) { if (!(e instanceof ClientError) || e.status !== 404) throw e; bucket = result.data[0]; router.replace("/workspace"); }
      }
      if (bucket && !result.data.some((b) => b.id === bucket!.id)) setBuckets([...result.data, bucket]);
      setSelected(bucket ?? null);
    } catch (e) { setBuckets([]); setSelected(null); setError(friendlyError(e)); }
    finally { setLoading(false); }
  }, [bucketQuery, profile.lastBucketId, router]);
  useEffect(() => { queueMicrotask(() => { void load(); }); const onFocus = () => { void load(); }; window.addEventListener("focus", onFocus); return () => window.removeEventListener("focus", onFocus); }, [load]);
  useEffect(() => {
    if (selected && profile.tour.state === "not_started" && !tourPrompted.current) {
      tourPrompted.current = true;
      queueMicrotask(() => setModal("tour"));
    }
  }, [selected, profile.tour.state]);
  async function patchProfile(body: object) {
    try {
      const result = await api<Profile>("me", { method: "PATCH", body, revision: profile.revision, key: operationKey(profileKey, body) });
      auth.syncProfile(result.data); profileKey.current = null; return result.data;
    } catch (e) {
      if (e instanceof ClientError && e.status === 412) {
        profileKey.current = null;
        // Refresh in place so the dialog and its unsaved inputs remain available.
        const latest = await api<Profile>("me");
        auth.syncProfile(latest.data);
        throw new ClientError("Your profile changed in another session. The latest version is loaded; review your changes and try again, or close this dialog.", 412, "REVISION_MISMATCH");
      }
      throw e;
    }
  }
  async function selectBucket(id: string) {
    setBusy(true); setError("");
    try { await patchProfile({ lastBucketId: id }); router.replace(`/workspace?bucket=${id}`); }
    catch (e) { setError(friendlyError(e)); } finally { setBusy(false); }
  }
  async function moreBuckets() {
    if (!cursor) return; setBusy(true);
    try { const result = await api<Bucket[]>(`buckets?cursor=${encodeURIComponent(cursor)}`); setBuckets((items) => [...items, ...result.data.filter((b) => !items.some((existing) => existing.id === b.id))]); setCursor(result.meta.nextCursor ?? null); }
    catch (e) { setError(friendlyError(e)); } finally { setBusy(false); }
  }
  async function generateInvite() {
    if (!selected) return; setBusy(true); setError("");
    try { const result = await api<Invitation>(`buckets/${selected.id}/invitations`, { method: "POST", body: {}, key: operationKey(inviteKey, { bucketId: selected.id }) }); setInvite(result.data); }
    catch (e) { setError(friendlyError(e)); } finally { setBusy(false); }
  }
  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); const form = new FormData(event.currentTarget);
    try { await patchProfile({ displayName: String(form.get("displayName")).trim(), timezone: String(form.get("timezone")), theme: String(form.get("theme")) }); setModal(null); }
    catch (e) { setError(friendlyError(e)); } finally { setBusy(false); }
  }
  const steps = [{ title: "Your bucket, your space", text: "The bucket selector keeps each part of your life separate. Switch between the spaces you belong to, or create a new one.", icon: FolderOpen }, ...(selected?.isOwner ? [{ title: "Bring your people", text: "Use Invite people to copy a seven-day link, show its QR code, or share it through WhatsApp. People join only after signing in and confirming.", icon: Users }] : []), { title: "Make yourself at home", text: "Your profile menu holds your name, timezone, and appearance. You can replay this tour from Help whenever you need.", icon: Settings2 }];
  const currentStep = Math.min(step, steps.length - 1);
  async function tour(nextStep: number, state: Tour["state"] = "in_progress") {
    setBusy(true); setError("");
    try { await patchProfile({ tour: { version: 1, state, lastStep: nextStep } }); setStep(nextStep); if (state === "completed" || state === "skipped") setModal(null); }
    catch (e) { setError(friendlyError(e)); } finally { setBusy(false); }
  }
  function closeModal() { if (busy) return; if (modal === "tour" && !error) void tour(currentStep, "skipped"); else { setModal(null); setError(""); } }
  return <div className="workspace-layout"><aside className="sidebar"><Brand /><div className="sidebar-section"><span className="eyebrow">YOUR SPACE</span><label className="sr-only" htmlFor="bucket-picker">Current bucket</label><select id="bucket-picker" value={selected?.id ?? ""} disabled={busy || loading} onChange={(e) => selectBucket(e.target.value)}>{!selected && <option value="">Choose a bucket</option>}{buckets.map((b) => <option key={b.id} value={b.id}>{b.name}{b.status === "archived" ? " (archived)" : ""}</option>)}</select>{cursor && <button className="text-link" onClick={moreBuckets} disabled={busy}>Load more buckets</button>}<Link className="sidebar-create" href="/buckets/new"><Plus size={15} /> Create a bucket</Link></div>
    <nav aria-label="Workspace"><Link href="/workspace" className="nav-item active"><LayoutDashboard size={18} /> Overview</Link><div className="nav-item unavailable"><Wallet size={18} /> Expenses <small>Coming next</small></div><div className="nav-item unavailable"><BookOpen size={18} /> Budgets <small>Later</small></div></nav><div className="sidebar-bottom"><button className="nav-item" onClick={() => { setStep(0); setModal("tour"); }} disabled={!selected}><HelpCircle size={18} /> Help & tour</button><button className="nav-item" onClick={() => setModal("profile")}><Settings2 size={18} /> Profile & appearance</button><button className="nav-item" onClick={() => auth.logout()}><LogOut size={18} /> Sign out</button></div></aside>
    <div className="workspace-main"><header className="workspace-header"><span>{selected?.name ?? "Your workspace"}</span><button className="profile-chip" onClick={() => setModal("profile")}><span>{profile.displayName.charAt(0).toUpperCase()}</span>{profile.displayName}</button></header><main id="main" className="workspace-content">
      {!profile.emailVerified && <Notice kind="info"><Mail size={16} /> Your email isn’t verified yet. <Link href="/verify-email">Verify email</Link></Notice>}
      {error && !modal && <><Notice>{error}</Notice><button className="button secondary" onClick={() => { void auth.refresh(); }}>Refresh workspace</button></>}
      {loading ? <Pending /> : <><div className="workspace-title"><div><span className="eyebrow">A LITTLE MORE CLARITY</span><h1>Welcome, {profile.displayName.split(" ")[0]}.</h1><p>{selected ? "A fresh space for your everyday spending." : "Everyday clarity starts with your first bucket."}</p></div>{selected?.isOwner && selected.status === "active" && <button className="button primary" onClick={() => { setInvite(null); inviteKey.current = null; setCopied(false); setModal("invite"); }}><Users size={17} /> Invite people</button>}</div>
      {selected ? <><section className="bucket-summary"><span className="large-icon"><Home size={27} /></span><div><h2>{selected.name}</h2><p>{selected.primaryCurrency} <span>·</span> {selected.timezone} <span>·</span> {selected.memberCount} {selected.memberCount === 1 ? "member" : "members"}</p></div><span className="pill">{selected.status === "archived" ? "Archived · read only" : selected.isOwner ? "Owner" : "Member"}</span></section><section className="workspace-empty"><span className="empty-art"><FolderOpen size={52} strokeWidth={1.2} /></span><h2>Your bucket is ready.</h2><p>Make it your own, or invite someone to share it.<br />Expense entry is coming in the next phase.</p>{selected.isOwner && selected.status === "active" ? <button className="button secondary" onClick={() => { setInvite(null); inviteKey.current = null; setModal("invite"); }}>Invite your people <ArrowRight size={16} /></button> : <button className="button secondary" onClick={() => { setStep(0); setModal("tour"); }}>Take a look around</button>}</section><div className="workspace-tip"><ShieldCheck size={20} /><p>Only current members of this bucket can access its spending. Your other buckets stay separate.</p></div></> : !error && <section className="workspace-empty"><span className="empty-art"><FolderOpen size={52} /></span><h2>One bucket. A fresh beginning.</h2><p>Start with personal spending, a shared home, or something else.</p><Link className="button primary" href="/onboarding">Create your first bucket <Plus size={16} /></Link><Link className="text-link" href="/join">Join with an invitation</Link></section>}</>}
    </main></div>
    {modal && <Dialog title={modal === "invite" ? "A space to share" : modal === "profile" ? "Make yourself at home" : steps[currentStep].title} onClose={closeModal}>{error && <Notice>{error}</Notice>}
      {modal === "invite" && <div className="form-stack"><p>Invite someone to <b>{selected?.name}</b>. The link works for seven days and can be used by more than one person.</p>{!invite ? <button className="button primary full" disabled={busy} onClick={generateInvite}>{busy ? "Creating link…" : "Create invitation link"}<Link2 size={16} /></button> : invite.secretUnavailable ? <><Notice kind="info">This link was created, but its one-time response was lost. Create a new link to share; the original expires in seven days.</Notice><button className="button primary" disabled={busy} onClick={() => { inviteKey.current = null; void generateInvite(); }}>Create a new link</button></> : invite.shareUrl && <><div className="qr-wrap"><QRCodeSVG value={invite.shareUrl} size={168} title={`Invitation to ${selected?.name}`} /></div><label>Invitation link<input value={invite.shareUrl} readOnly onFocus={(e) => e.target.select()} /></label><button className="button primary full" onClick={async () => { try { await navigator.clipboard.writeText(invite.shareUrl!); setCopied(true); } catch { setError("Copy the link from the field above."); } }}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "Copied" : "Copy link"}</button><a className="button secondary full" href={`https://wa.me/?text=${encodeURIComponent(`Join my Buckit bucket:\n ${invite.shareUrl}`)}`} target="_blank" rel="noopener noreferrer">Share on WhatsApp</a><p className="field-hint">Expires {new Date(invite.expiresAt).toLocaleDateString()}. Anyone with this link can join after signing in.</p></>}</div>}
      {modal === "profile" && <form className="form-stack" onSubmit={saveProfile}><label>Display name<input name="displayName" defaultValue={profile.displayName} required maxLength={80} /></label><label>Timezone<input name="timezone" defaultValue={profile.timezone} list="profile-zones" required /><datalist id="profile-zones">{Intl.supportedValuesOf("timeZone").map((zone) => <option key={zone} value={zone} />)}</datalist></label><label>Appearance<select name="theme" defaultValue={profile.theme}><option value="system">Match device</option><option value="light">Light</option><option value="dark">Dark</option></select></label><button className="button primary full" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button><p className="field-hint">{profile.email}</p></form>}
      {modal === "tour" && <div className="tour-body"><span className="large-icon">{currentStep === 0 ? <FolderOpen size={32} /> : <HelpCircle size={32} />}</span><p>{steps[currentStep].text}</p><div className="tour-progress">{steps.map((item, index) => <span key={item.title} className={index === currentStep ? "active" : ""} />)}<small>{currentStep + 1} of {steps.length}</small></div><div className="tour-actions"><button className="text-link" disabled={busy} onClick={() => tour(currentStep, "skipped")}>Skip tour</button><div>{currentStep > 0 && <button className="button secondary" disabled={busy} onClick={() => tour(currentStep - 1)}>Back</button>}<button className="button primary" disabled={busy} onClick={() => tour(currentStep === steps.length - 1 ? currentStep : currentStep + 1, currentStep === steps.length - 1 ? "completed" : "in_progress")}>{currentStep === steps.length - 1 ? "All set" : "Next"}<ArrowRight size={15} /></button></div></div></div>}
    </Dialog>}
  </div>;
}
