import React, { useState } from "react";
import { Award, CheckCircle2, Image as ImageIcon, Mail, Sparkles } from "lucide-react";
import { sendVerificationEmail } from "../api";

interface TutorialProps {
  onComplete: () => void;
  /** The address the link will go to, so someone can spot a typo before sending. */
  email?: string;
  /** Skips the whole ask when the address is already confirmed. */
  emailVerified?: boolean;
}

type SendState = "idle" | "sending" | "sent" | "error";

/**
 * The screen a new account lands on after Welcome.
 *
 * It used to be onboarding copy from a different product entirely -- a Grand
 * Canyon hero hotlinked from Google's CDN, "pick a dream destination", a
 * progress bar hardcoded to 100%, and a "Finish & Claim 50 Credits" button that
 * called no API and granted nothing. Every new account was promised fifty
 * credits and given none.
 *
 * What a new account actually needs here is to confirm their email: it is the
 * gate on the free first image, and the only way we can reach them about a
 * build. So the screen asks for that one thing and explains the two steps of
 * the real product, rather than advertising a currency it cannot pay out.
 */
export default function Tutorial({ onComplete, email, emailVerified }: TutorialProps) {
  const [state, setState] = useState<SendState>("idle");
  const [message, setMessage] = useState("");

  const send = async () => {
    if (state === "sending") return;
    setState("sending");
    setMessage("");
    try {
      setMessage(await sendVerificationEmail());
      setState("sent");
    } catch (err: any) {
      // The server enforces its own resend floor, so a refusal here is usually
      // "you just asked" rather than a failure. Show what it said.
      setMessage(err?.message || "Could not send the verification email just now.");
      setState("error");
    }
  };

  return (
    <div className="w-full max-w-lg mx-auto flex flex-col px-6 py-6 relative z-10 min-h-[90vh]">
      <div className="relative w-full aspect-[4/3] rounded-3xl overflow-hidden soft-glow-shadow mb-6 border-4 border-white">
        <img
          alt="A 3D pet model created from a single photo with Pawsome3D"
          className="w-full h-full object-cover"
          src="/featured-models/shiba-inu.webp"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent"></div>
        <div className="absolute top-4 left-4 bg-white/90 backdrop-blur-md px-3.5 py-1.5 rounded-full flex items-center gap-2 border border-outline-variant/30 shadow-sm">
          <Sparkles size={14} className="text-secondary" fill="#964826" />
          <span className="text-xs font-bold text-on-surface font-sans">Sample model</span>
        </div>
      </div>

      <div className="flex flex-col gap-3 items-center text-center">
        <div className="w-14 h-14 rounded-full bg-primary-container flex items-center justify-center mb-1 floating text-white">
          <span className="text-2xl">🐾</span>
        </div>
        <h1 className="text-2xl font-bold text-on-surface tracking-tight">Welcome to Pawsome3D</h1>
        <p className="text-sm text-on-surface-variant max-w-[95%] leading-relaxed">
          One clear photo of your pet becomes a 3D model you can turn, animate, print, or stand in
          your living room in AR.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 mt-6">
        <div className="bg-surface-container-low p-4 rounded-2xl border border-outline-variant/40 flex flex-col gap-1.5">
          <ImageIcon size={20} className="text-primary" />
          <h3 className="text-sm font-semibold text-on-surface">1. Upload</h3>
          <p className="text-[11px] text-on-surface-variant leading-normal">
            One clear full-body photo of your pet.
          </p>
        </div>
        <div className="bg-surface-container-low p-4 rounded-2xl border border-outline-variant/40 flex flex-col gap-1.5 mt-3">
          <Award size={20} className="text-secondary" />
          <h3 className="text-sm font-semibold text-on-surface">2. Approve</h3>
          <p className="text-[11px] text-on-surface-variant leading-normal">
            You check every view before anything is built.
          </p>
        </div>
      </div>

      {emailVerified ? (
        <div className="mt-8 flex items-center gap-3 rounded-2xl border border-outline-variant/40 bg-surface-container-low p-4">
          <CheckCircle2 size={20} className="shrink-0 text-primary" />
          <p className="text-xs text-on-surface-variant">
            Your email is confirmed. You're all set.
          </p>
        </div>
      ) : (
        <div className="mt-8 rounded-2xl border border-primary/40 bg-primary/5 p-4">
          <div className="flex items-start gap-3">
            <Mail size={20} className="mt-0.5 shrink-0 text-primary" />
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-on-surface">Confirm your email</h2>
              <p className="mt-1 text-xs leading-relaxed text-on-surface-variant">
                It unlocks your free first model and is how we reach you when a build finishes.
                {email ? <> We'll send the link to <strong className="break-all">{email}</strong>.</> : null}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={send}
            disabled={state === "sending"}
            className="mt-3 w-full rounded-xl border border-primary bg-primary/10 p-3 text-sm font-black text-primary disabled:opacity-60"
          >
            {state === "sending"
              ? "Sending…"
              : state === "sent"
                ? "Send it again"
                : "Email me the verification link"}
          </button>
          {message && (
            <p
              className={`mt-2 text-[11px] leading-relaxed ${state === "error" ? "text-error" : "text-on-surface-variant"}`}
              role="status"
            >
              {message}
              {state === "sent" ? " Check your inbox, and your spam folder if it isn't there." : null}
            </p>
          )}
        </div>
      )}

      <div className="mt-6 pt-2 flex flex-col gap-3">
        <button
          onClick={onComplete}
          className="premium-shimmer w-full h-15 text-white font-bold text-base rounded-2xl flex items-center justify-center gap-2 hover:scale-[1.02] active:scale-95 transition-all duration-300 shadow-md cursor-pointer"
        >
          <span>Start building</span>
        </button>
        <button
          onClick={onComplete}
          className="w-full py-2.5 text-on-surface-variant text-xs font-semibold hover:text-primary transition-colors cursor-pointer"
        >
          I'll verify later
        </button>
      </div>
    </div>
  );
}
