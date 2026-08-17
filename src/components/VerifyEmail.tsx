import React, { useEffect, useRef, useState } from "react";
import { verifyEmail, sendVerificationEmail, isAuthenticated } from "../api";

type State = "working" | "verified" | "invalid" | "missing";

/**
 * Standalone email-confirmation page, shown when the app is opened at
 * /verify-email?token=... from the emailed link. Mirrors ResetPassword: not
 * part of the Screen-enum flow — App.tsx renders it before auth, because the
 * link is often opened in a different browser than the one that signed up.
 */
export default function VerifyEmail() {
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const [state, setState] = useState<State>(token ? "working" : "missing");
  const [message, setMessage] = useState("");
  const [resendNote, setResendNote] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  // The link is single-use, so a double-invoke (React StrictMode mounts twice
  // in development) would burn the token and show a spurious failure.
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;
    verifyEmail(token)
      .then((result) => {
        setState("verified");
        setMessage(result.message);
      })
      .catch((err: any) => {
        setState("invalid");
        setMessage(err?.message || "This verification link is invalid or has expired.");
      });
  }, [token]);

  const goHome = () => {
    window.history.replaceState({}, document.title, "/");
    window.location.href = "/";
  };

  const resend = async () => {
    setResending(true);
    setResendNote(null);
    try {
      setResendNote(await sendVerificationEmail());
    } catch (err: any) {
      setResendNote(err?.message || "Could not send a new link. Please try again shortly.");
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-surface">
      <div className="w-full max-w-sm bg-surface-container-high border border-outline-variant/40 rounded-2xl p-6 shadow-sm text-center">
        {state === "working" && (
          <>
            <span className="text-4xl" role="img" aria-label="Paw print">🐾</span>
            <h1 className="text-xl font-extrabold text-on-surface mt-3 mb-1">Confirming your email…</h1>
            <p className="text-sm text-on-surface-variant">One moment.</p>
          </>
        )}

        {state === "verified" && (
          <>
            <span className="text-4xl" role="img" aria-label="Party popper">🎉</span>
            <h1 className="text-xl font-extrabold text-on-surface mt-3 mb-1">Email confirmed!</h1>
            <p className="text-sm text-on-surface-variant mb-6">{message}</p>
            <button
              onClick={goHome}
              className="w-full py-3 rounded-full bg-primary text-on-primary font-bold active:scale-95 transition-all"
            >
              Create my free image
            </button>
          </>
        )}

        {(state === "invalid" || state === "missing") && (
          <>
            <span className="text-4xl" role="img" aria-label="Broken link">🔗</span>
            <h1 className="text-xl font-extrabold text-on-surface mt-3 mb-1">This link didn't work</h1>
            <p className="text-sm text-on-surface-variant mb-6">
              {state === "missing"
                ? "This link is missing its token. Please use the full link from your email."
                : message}
            </p>
            {/* Requesting a new link needs a session, since the server derives
                the address from the signed-in account rather than trusting
                anything in the URL. */}
            {isAuthenticated() ? (
              <button
                onClick={resend}
                disabled={resending}
                className="w-full py-3 rounded-full bg-primary text-on-primary font-bold active:scale-95 transition-all disabled:opacity-60"
              >
                {resending ? "Sending…" : "Send me a new link"}
              </button>
            ) : (
              <button
                onClick={goHome}
                className="w-full py-3 rounded-full bg-primary text-on-primary font-bold active:scale-95 transition-all"
              >
                Sign in to resend
              </button>
            )}
            {resendNote && <p className="text-sm text-on-surface-variant mt-3">{resendNote}</p>}
            <button
              type="button"
              onClick={goHome}
              className="w-full text-sm text-on-surface-variant hover:text-primary mt-3"
            >
              Back to Pawsome3D
            </button>
          </>
        )}
      </div>
    </div>
  );
}
