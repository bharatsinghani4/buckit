"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import {
  applyActionCode,
  confirmPasswordReset,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
  verifyPasswordResetCode,
} from "firebase/auth";
import { ArrowLeft, ArrowRight, LockKeyhole, Mail, ShieldCheck, Wallet } from "lucide-react";
import { Brand, Wordmark } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Notice, PasswordField, Pending } from "@/components/ui";
import { getFirebaseClientAuth } from "@/lib/firebase/client";
import { friendlyError } from "@/lib/api/client";
import { useAuth } from "./auth-provider";
import { authHref, safeNext } from "./contracts";

export type AuthMode = "sign-in" | "sign-up" | "forgot-password" | "verify-email" | "auth-action";
export function AuthScreen({ mode }: { mode: AuthMode }) {
  const auth = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const authPage = mode === "sign-in" || mode === "sign-up";
  useEffect(() => {
    if (authPage && !auth.loading && auth.user) router.replace("/workspace");
  }, [authPage, auth.loading, auth.user, router]);
  const [inviteFragment, setInviteFragment] = useState("");
  useEffect(() => {
    const read = () => setInviteFragment(window.location.hash);
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const destination = safeNext(params.get("next"));
  const next = destination === "/join" ? safeNext(`/join${inviteFragment}`) : destination;
  const signup = mode === "sign-up";
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [resetEmail, setResetEmail] = useState("");
  const [actionReady, setActionReady] = useState(false);
  const action = params.get("mode");
  const code = params.get("oobCode");
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  useEffect(() => {
    if (mode !== "auth-action" || !auth.configured) return;
    let alive = true;
    if (!code || !["resetPassword", "verifyEmail"].includes(action ?? "")) {
      queueMicrotask(() =>
        setError("This email link is incomplete or unsupported. Request a new one."),
      );
      return;
    }
    if (action === "resetPassword")
      void verifyPasswordResetCode(getFirebaseClientAuth(), code)
        .then((email) => {
          if (alive) {
            setResetEmail(email);
            setActionReady(true);
          }
        })
        .catch((e) => {
          if (alive) setError(friendlyError(e));
        });
    // Verification is an explicit button action, avoiding double-consuming a link in Strict Mode.
    else
      queueMicrotask(() => {
        if (alive) setActionReady(true);
      });
    return () => {
      alive = false;
    };
  }, [mode, action, code, auth.configured]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    try {
      const firebase = getFirebaseClientAuth();
      if (mode === "forgot-password") {
        try {
          await sendPasswordResetEmail(firebase, email, { url: `${location.origin}/sign-in` });
        } catch (e) {
          if ((e as { code?: string }).code !== "auth/user-not-found") throw e;
        }
        setMessage(
          "If an account uses that email, a reset link is on its way. Check your inbox and spam folder.",
        );
        setCooldown(60);
      } else if (mode === "auth-action" && action === "resetPassword" && code) {
        if (password !== form.get("confirmPassword")) throw new Error("password-mismatch");
        await confirmPasswordReset(firebase, code, password);
        setMessage("Your password has been reset. You can now sign in.");
        setActionReady(false);
      } else if (signup) {
        const result = await createUserWithEmailAndPassword(firebase, email, password);
        await updateProfile(result.user, { displayName: String(form.get("displayName")).trim() });
        try {
          await sendEmailVerification(result.user, { url: `${location.origin}/verify-email` });
        } catch {
          /* Account exists; the verification screen offers an explicit resend. */
        }
        router.push(authHref("/verify-email", next));
      } else {
        await signInWithEmailAndPassword(firebase, email, password);
        router.push(next);
      }
    } catch (e) {
      setError(
        e instanceof Error && e.message === "password-mismatch"
          ? "The passwords don’t match."
          : friendlyError(e),
      );
    } finally {
      setBusy(false);
    }
  }
  async function google() {
    setBusy(true);
    setError("");
    try {
      await signInWithPopup(getFirebaseClientAuth(), new GoogleAuthProvider());
      router.push(next);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  async function verify(resend: boolean) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (mode === "auth-action" && code) {
        await applyActionCode(getFirebaseClientAuth(), code);
        setActionReady(false);
        setMessage("Email verified. You’re ready to continue.");
      } else {
        const user = getFirebaseClientAuth().currentUser;
        if (!user) {
          router.push(authHref("/sign-in", next));
          return;
        }
        if (resend) {
          await sendEmailVerification(user, { url: `${location.origin}/verify-email` });
          setCooldown(60);
          setMessage("A fresh verification link is on its way.");
        } else {
          await user.reload();
          await user.getIdToken(true);
          if (!user.emailVerified)
            setMessage(
              "Your email hasn’t been verified yet. Open the link in your inbox, then check again.",
            );
          else {
            await auth.refresh();
            router.push(next);
          }
        }
      }
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  const title = signup ? (
    "Create your account"
  ) : mode === "forgot-password" ? (
    "Forgot your password?"
  ) : mode === "verify-email" ? (
    "Check your inbox"
  ) : mode === "auth-action" ? (
    action === "resetPassword" ? (
      "A fresh start"
    ) : (
      "Verify your email"
    )
  ) : (
    <>
      Sign in to <Wordmark />
    </>
  );
  const subtitle = signup
    ? "A little more clarity starts here."
    : mode === "forgot-password"
      ? "We’ll send you a link to reset it."
      : mode === "verify-email"
        ? `Open the verification link sent to ${auth.user?.email ?? "your email address"}.`
        : mode === "auth-action"
          ? "Finish securely setting up your account."
          : "Welcome back to your everyday spending.";
  const emailForm = ["sign-in", "sign-up", "forgot-password"].includes(mode);
  if (authPage && (auth.loading || auth.user))
    return (
      <main id="main">
        <Pending label="Checking your session…" />
      </main>
    );
  return (
    <main id="main" className="auth-page">
      <div className="auth-card">
        <section className="auth-form-panel">
          <div className="auth-top">
            <Brand />
            <ThemeToggle />
          </div>
          {next.startsWith("/join") && (
            <Notice kind="info">
              <Mail size={16} /> Sign in to continue to your invitation.
            </Notice>
          )}
          <div className="form-heading">
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
          {!auth.configured && (
            <Notice kind="info">
              Sign-in is not available yet. Please try again once Buckit is connected.
            </Notice>
          )}
          {error && <Notice>{error}</Notice>}
          {message && <Notice kind="success">{message}</Notice>}
          {(emailForm || (mode === "auth-action" && action === "resetPassword" && actionReady)) && (
            <form onSubmit={submit} className="form-stack">
              {signup && (
                <label>
                  Display name
                  <input
                    name="displayName"
                    autoComplete="name"
                    placeholder="Your name"
                    maxLength={80}
                    required
                  />
                </label>
              )}
              {emailForm && (
                <label>
                  Email address
                  <input
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    required
                    maxLength={254}
                  />
                </label>
              )}
              {mode !== "forgot-password" && (
                <label>
                  <span className="label-row">
                    Password
                    {mode === "sign-in" && <Link href="/forgot-password">Forgot password?</Link>}
                  </span>
                  <PasswordField
                    name="password"
                    autoComplete={
                      signup || mode === "auth-action" ? "new-password" : "current-password"
                    }
                    placeholder={signup ? "At least 8 characters" : "Enter your password"}
                    required
                    minLength={signup || mode === "auth-action" ? 8 : 1}
                    maxLength={128}
                  />
                </label>
              )}
              {mode === "auth-action" && (
                <>
                  <p className="muted small-text">Resetting the password for {resetEmail}</p>
                  <label>
                    Confirm password
                    <PasswordField
                      name="confirmPassword"
                      autoComplete="new-password"
                      required
                      minLength={8}
                    />
                  </label>
                </>
              )}
              <button
                className="button primary full"
                disabled={busy || !auth.configured || (mode === "forgot-password" && cooldown > 0)}
              >
                {busy
                  ? "Please wait…"
                  : signup
                    ? "Create account"
                    : mode === "forgot-password"
                      ? cooldown
                        ? `Send again in ${cooldown}s`
                        : "Send reset link"
                      : mode === "auth-action"
                        ? "Reset password"
                        : "Sign in"}
              </button>
            </form>
          )}
          {(signup || mode === "sign-in") && (
            <>
              <div className="divider">
                <span>OR</span>
              </div>
              <button
                onClick={google}
                disabled={busy || !auth.configured}
                className="button secondary full"
              >
                <span className="google-mark">G</span> Continue with Google
              </button>
              <p className="form-switch">
                {signup ? "Already have an account?" : "Don’t have an account?"}{" "}
                <Link href={authHref(`/${signup ? "sign-in" : "sign-up"}`, next)}>
                  {signup ? "Sign in" : "Create account"}
                </Link>
              </p>
            </>
          )}
          {mode === "verify-email" && (
            <div className="form-stack">
              <div className="email-illustration">
                <Mail size={34} />
              </div>
              <button
                className="button primary full"
                disabled={busy || !auth.user}
                onClick={() => verify(false)}
              >
                I’ve verified my email <ArrowRight size={16} />
              </button>
              <button
                className="button secondary full"
                disabled={busy || !auth.user || cooldown > 0}
                onClick={() => verify(true)}
              >
                {cooldown ? `Resend in ${cooldown}s` : "Resend verification email"}
              </button>
              <Link className="text-link centered" href={next}>
                Continue for now
              </Link>
            </div>
          )}
          {mode === "auth-action" && action === "verifyEmail" && actionReady && (
            <button className="button primary full" onClick={() => verify(false)} disabled={busy}>
              Verify email
            </button>
          )}
          {["forgot-password", "auth-action"].includes(mode) && (
            <Link className="back-link" href="/sign-in">
              <ArrowLeft size={16} /> Back to sign in
            </Link>
          )}
          <p className="trust-note">
            <LockKeyhole size={13} /> Your sign-in is secured by Firebase.
          </p>
        </section>
        <aside className="auth-art">
          <div className="art-heading">
            <span className="eyebrow">A SPACE FOR EVERYDAY LIFE</span>
            <span className="pill">A little clarity</span>
          </div>
          <div className="art-middle">
            <div className="mini-ledger">
              <div className="mini-ledger-top">
                <span className="tile-icon">
                  <Wallet size={19} />
                </span>
                <div>
                  <small>Example bucket</small>
                  <b>Shared Living</b>
                </div>
                <strong>₹4,850</strong>
              </div>
              <div className="meter-label">
                <span>Monthly spending</span>
                <span>In one place</span>
              </div>
              <div className="meter">
                <span />
              </div>
              <div className="mini-totals">
                <div>
                  <small>Groceries</small>
                  <b>₹3,200</b>
                </div>
                <div>
                  <small>Household</small>
                  <b>₹1,650</b>
                </div>
              </div>
            </div>
            <blockquote>
              “A little clarity for
              <br />
              everyday spending.”
            </blockquote>
            <p>Your spaces. Your people. Your pace.</p>
          </div>
          <div className="art-footer">
            <span>
              <ShieldCheck size={14} /> No bank linking required
            </span>
            <Wordmark />
          </div>
        </aside>
      </div>
      {!authPage && (
        <Link href="/" className="auth-home">
          <ArrowLeft size={14} /> Back to home
        </Link>
      )}
    </main>
  );
}
