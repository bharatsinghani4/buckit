"use client";
import Link from "next/link";
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
    <main id="main" className="join-page">
      <div className="join-top">
        <Brand />
        <ThemeToggle />
      </div>
      <section className="join-card">
        <span className="large-icon">
          <Users size={30} />
        </span>
        <span className="eyebrow">BETTER, TOGETHER</span>
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
          <form onSubmit={pasteLink} className="form-stack">
            <label>
              Invitation link
              <input name="link" type="url" required placeholder="Paste your invitation link" />
            </label>
            <button className="button primary full">
              <Link2 size={16} /> Continue with link
            </button>
          </form>
        )}
        {token && !auth.user && (
          <>
            <p className="muted small-text">
              Sign in to view this invitation. Nothing is joined until you confirm.
            </p>
            <Link className="button primary full" href={authHref("/sign-in", next)}>
              Sign in to continue <ArrowRight size={16} />
            </Link>
            <Link className="text-link centered" href={authHref("/sign-up", next)}>
              Create an account
            </Link>
          </>
        )}
        {token && auth.user && auth.loading && <Pending label="Checking your invitation…" />}
        {auth.error && (
          <>
            <Notice>{auth.error}</Notice>
            <button className="button secondary" onClick={() => auth.refresh()}>
              Try again
            </button>
          </>
        )}
        {preview && (
          <>
            <p className="field-hint">
              Link expires {new Date(preview.expiresAt).toLocaleDateString()}.
            </p>
            <button className="button primary full" disabled={busy} onClick={join}>
              {busy ? "Joining…" : preview.alreadyMember ? "Open bucket" : "Join bucket"}
              <ArrowRight size={16} />
            </button>
          </>
        )}
        <Link className="back-link" href={auth.profile ? "/workspace" : "/"}>
          Back to {auth.profile ? "your workspace" : "home"}
        </Link>
      </section>
    </main>
  );
}
