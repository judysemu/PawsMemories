import React, { useEffect, useRef, useState } from "react";
import { claimPhoto, isAuthenticated } from "../api";

type State = "working" | "needs_account" | "ready" | "invalid" | "missing";

/**
 * Landing page for the one-time link the X bot DMs back after someone sends a
 * pet photo. Opened at /claim/<token>.
 *
 * What this page deliberately does NOT do: create an account, grant credits, or
 * start a generation. It spends the token for the photo and hands that photo to
 * the studio, where the existing gates take over. Someone arriving here with no
 * account sees a sign-in prompt, not a shortcut around one.
 *
 * Sibling of VerifyEmail and ResetPassword: rendered outside the Screen enum,
 * because the link is nearly always opened from a phone's X app in a browser
 * that has never held a session.
 */

/** Where the claimed photo waits for the studio to pick it up. */
export const CLAIMED_PHOTO_KEY = "paws_claimed_photo";
/** Survives the sign-in round trip so the link still works after signing up. */
export const PENDING_CLAIM_KEY = "paws_pending_claim";

export function readTokenFromPath(pathname: string): string {
  const match = pathname.match(/^\/claim\/([A-Za-z0-9_-]{16,128})\/?$/);
  return match ? match[1] : "";
}

function stash(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Private-mode browsers deny session storage. The flow still works, it just
    // cannot resume across the sign-in hop.
  }
}

export default function ClaimPhoto() {
  const token = readTokenFromPath(window.location.pathname);
  const [state, setState] = useState<State>(
    !token ? "missing" : isAuthenticated() ? "working" : "needs_account",
  );
  const [message, setMessage] = useState("");
  // The token is single-use, so React StrictMode's double mount in development
  // would spend it twice and show a spurious failure on the second pass.
  const attempted = useRef(false);

  useEffect(() => {
    if (!token) return;
    if (!isAuthenticated()) {
      stash(PENDING_CLAIM_KEY, token);
      return;
    }
    if (attempted.current) return;
    attempted.current = true;
    claimPhoto(token)
      .then((result) => {
        stash(CLAIMED_PHOTO_KEY, result.imageDataUrl);
        try {
          sessionStorage.removeItem(PENDING_CLAIM_KEY);
        } catch {
          // Nothing to clean up if storage is unavailable.
        }
        setState("ready");
      })
      .catch((err: any) => {
        setState("invalid");
        setMessage(err?.message || "This photo link is no longer available.");
      });
  }, [token]);

  const goToStudio = () => {
    window.location.href = "/pet-glb";
  };
  const goSignIn = () => {
    window.location.href = "/";
  };

  return (
    <div className="grid min-h-screen place-items-center bg-surface p-6">
      <div className="w-full max-w-md rounded-2xl border border-outline-variant/35 p-6 text-center">
        {state === "working" && (
          <p className="text-sm text-on-surface-variant">Getting your pet photo…</p>
        )}

        {state === "needs_account" && (
          <>
            <h1 className="text-lg font-black">Your photo is waiting</h1>
            <p className="mt-2 text-sm text-on-surface-variant">
              Sign in or create a free account and we'll drop it straight into the model studio —
              no need to send it again.
            </p>
            <button
              type="button"
              onClick={goSignIn}
              className="mt-4 w-full rounded-xl border border-primary bg-primary/10 p-3 text-sm font-black text-primary"
            >
              Continue
            </button>
          </>
        )}

        {state === "ready" && (
          <>
            <h1 className="text-lg font-black">Photo added 🐾</h1>
            <p className="mt-2 text-sm text-on-surface-variant">
              It's loaded in the studio. You'll choose the finish and approve the generated views
              before anything is built.
            </p>
            <button
              type="button"
              onClick={goToStudio}
              className="mt-4 w-full rounded-xl border border-primary bg-primary/10 p-3 text-sm font-black text-primary"
            >
              Open the studio
            </button>
          </>
        )}

        {(state === "invalid" || state === "missing") && (
          <>
            <h1 className="text-lg font-black">This link has expired</h1>
            <p className="mt-2 text-sm text-on-surface-variant">
              {state === "missing"
                ? "That link is incomplete."
                : message}{" "}
              Send the photo again and we'll reply with a fresh one.
            </p>
            <button
              type="button"
              onClick={goSignIn}
              className="mt-4 w-full rounded-xl border border-outline-variant/35 p-3 text-sm font-black"
            >
              Go to Pawsome3D
            </button>
          </>
        )}
      </div>
    </div>
  );
}
