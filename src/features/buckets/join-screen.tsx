"use client";
import Link from "next/link";
import { controls } from "@/components/control-styles";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Link2, Users } from "lucide-react";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Notice, Pending } from "@/components/ui";
import { useAuth } from "@/features/identity/auth-provider";
import { authHref, type Bucket } from "@/features/identity/contracts";
import { api, friendlyError, operationKey } from "@/lib/api/client";

type Preview = { bucketName: string; expiresAt: string; alreadyMember: boolean };
export function JoinScreen() {
  const auth = useAuth();
  const router = useRouter();
  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    const read = () => {
      setToken(window.location.hash.slice(1));
      setPreview(null);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  useEffect(() => {
    if (!token || !auth.profile) return;
    let alive = true;
    api<Preview>("invitations/preview", { method: "POST", body: { token } })
      .then((result) => {
        if (alive) {
          setPreview(result.data);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(friendlyError(e));
      });
    return () => {
      alive = false;
    };
  }, [token, auth.profile]);
  function pasteLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const value = String(new FormData(event.currentTarget).get("link")).trim();
    try {
      const url = new URL(value);
      if (
        url.origin !== location.origin ||
        url.pathname !== "/join" ||
        !/^[A-Za-z0-9_-]{43}$/.test(url.hash.slice(1))
      )
        throw new Error();
      location.hash = url.hash;
    } catch {
      setError("Paste a complete Buckit invitation link for this site.");
    }
  }
  async function join() {
    setBusy(true);
    setError("");
    const body = { token };
    try {
      const result = await api<Bucket>("invitations/join", {
        method: "POST",
        body,
        key: operationKey(key, body),
      });
      history.replaceState(null, "", "/join");
      await auth.refresh();
      router.push(`/workspace?bucket=${result.data.id}`);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  const next = `/join${token ? `#${token}` : ""}`;
  return (
    <main
      id="main"
      className="join-page [min-height:100svh] flex flex-col items-center justify-center [gap:24px] [padding:40px_20px] text-center"
    >
      <div className="join-top flex items-center justify-between [gap:14px] [width:min(480px,_100%)]">
        <Brand />
        <ThemeToggle />
      </div>
      <section className="join-card w-full [max-width:480px] [padding:40px] [border-radius:12px] bg-[var(--surface)] [border:1px_solid_var(--line)] flex flex-col [gap:20px] text-center [box-shadow:var(--shadow)] [&_label]:text-left [&_h1]:[font-size:27px] [&_h1]:[overflow-wrap:anywhere] [&_>_.eyebrow]:justify-center [&_>_p]:text-xs [&_>_.large-icon]:[align-self:center] max-[767px]:[padding:30px_24px] max-[767px]:[&_h1]:text-2xl">
        <span className="large-icon [width:66px] [height:66px] inline-flex items-center justify-center bg-[var(--sage)] [border-radius:16px] text-[var(--green)]">
          <Users size={30} />
        </span>
        <span className="eyebrow inline-flex items-center [gap:8px] text-[var(--muted)] text-xs [font-weight:650] [letter-spacing:.13em]">
          BETTER, TOGETHER
        </span>
        <h1>{preview ? `Join ${preview.bucketName}` : "A shared space awaits."}</h1>
        <p>
          {preview?.alreadyMember
            ? "You’re already a member of this bucket."
            : "Keep everyday spending in one place with your people."}
        </p>
        {error && <Notice>{error}</Notice>}
        {!auth.configured && (
          <Notice kind="info">
            Invitations will be available once Buckit’s services are connected.
          </Notice>
        )}
        {!token && (
          <form
            onSubmit={pasteLink}
            className="form-stack flex flex-col [gap:16px] [&_>_.notice]:[margin-bottom:0]"
          >
            <label className="flex flex-col gap-[7px] text-xs font-medium">
              Invitation link
              <input
                className={controls.input}
                name="link"
                type="url"
                required
                placeholder="Paste your invitation link"
              />
            </label>
            <button className={`${controls.primary} button w-full`}>
              <Link2 size={16} /> Continue with link
            </button>
          </form>
        )}
        {token && !auth.user && (
          <>
            <p className="muted text-[var(--muted)] small-text text-xs">
              Sign in to view this invitation. Nothing is joined until you confirm.
            </p>
            <Link className={`${controls.primary} button w-full`} href={authHref("/sign-in", next)}>
              Sign in to continue <ArrowRight size={16} />
            </Link>
            <Link
              className="text-link [background:none] border-0 [padding:0] inline-flex items-center [gap:8px] text-[var(--green)] font-semibold text-xs [&:hover]:[text-decoration:underline] [&:hover]:[text-underline-offset:4px] centered justify-center"
              href={authHref("/sign-up", next)}
            >
              Create an account
            </Link>
          </>
        )}
        {token && auth.user && auth.loading && (
          <Pending label="Checking your invitation…" layout="inline" />
        )}
        {auth.error && (
          <>
            <Notice>{auth.error}</Notice>
            <button className={`${controls.secondary} button`} onClick={() => auth.refresh()}>
              Try again
            </button>
          </>
        )}
        {preview && (
          <>
            <p className="field-hint flex items-center [gap:6px] text-xs [line-height:1.7] text-[var(--muted)]">
              Link expires {new Date(preview.expiresAt).toLocaleDateString()}.
            </p>
            <button className={`${controls.primary} button w-full`} disabled={busy} onClick={join}>
              {busy ? "Joining…" : preview.alreadyMember ? "Open bucket" : "Join bucket"}
              <ArrowRight size={16} />
            </button>
          </>
        )}
        <Link
          className="back-link [&:hover]:[text-decoration:underline] [&:hover]:[text-underline-offset:4px] flex justify-center items-center [gap:8px] [margin-top:26px] text-[var(--green)] text-xs"
          href={auth.profile ? "/workspace" : "/"}
        >
          Back to {auth.profile ? "your workspace" : "home"}
        </Link>
      </section>
    </main>
  );
}
