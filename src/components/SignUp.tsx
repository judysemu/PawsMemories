import React, { useState, useRef, useEffect } from "react";
import { User, RefreshCw, Mail, ArrowLeft, Lock, Calendar, MapPin, LogIn, UserPlus } from "lucide-react";
import { PublicUser } from "../types";
import { signup, completeProfile, login, requestPasswordReset } from "../api";
import { useJsApiLoader } from "@react-google-maps/api";

// IMPORTANT: keep this list identical to the one used in LocationPicker.tsx.
// @react-google-maps/api shares a single loader, and passing a new array
// reference on every render causes the "LoadScript reloaded unintentionally"
// performance warning and corrupts downstream maps state.
const LIBRARIES: "places"[] = ["places"];

interface SignUpProps {
  /** Called once the user is logged in AND has a complete profile. */
  onAuthenticated: (user: PublicUser, isNew: boolean) => void;
}

type Step = "login" | "signup" | "profile" | "pets" | "forgot";

export default function SignUp({ onAuthenticated }: SignUpProps) {
  const [step, setStep] = useState<Step>("signup");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [birthdate, setBirthdate] = useState("");
  const [city, setCity] = useState("");
  const [petCount, setPetCount] = useState(1);
  const [pets, setPets] = useState<{name: string, kind: string}[]>([{name: "", kind: "dog"}]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [forgotMsg, setForgotMsg] = useState("");

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) { setError("Please enter your email."); return; }
    setError("");
    setBusy(true);
    try {
      const msg = await requestPasswordReset(email.trim());
      setForgotMsg(msg);
    } catch {
      // Endpoint is intentionally non-revealing; show the generic message anyway.
      setForgotMsg("If that email is registered, a reset link is on its way.");
    } finally {
      setBusy(false);
    }
  };

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY_BROWSER;
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: apiKey || "",
    libraries: LIBRARIES,
  });

  const cityInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === "profile" && isLoaded && cityInputRef.current && window.google) {
      const autocomplete = new window.google.maps.places.Autocomplete(cityInputRef.current, {
        types: ['(cities)'],
      });
      autocomplete.addListener('place_changed', () => {
        const place = autocomplete.getPlace();
        if (place.formatted_address) {
          setCity(place.formatted_address);
        } else if (place.name) {
          setCity(place.name);
        }
      });
    }
  }, [step, isLoaded]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError("Please enter your email and password.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const user = await login(email.trim(), password);
      onAuthenticated(user, false);
    } catch (err: any) {
      setError(err.message || "Login failed.");
    } finally {
      setBusy(false);
    }
  };

  // Step 1 of sign-up: create the account, then move to the required profile.
  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password || !confirmPassword) {
      setError("Please fill out all fields.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (!acceptedTerms) {
      setError("Please agree to the Terms and Privacy Policy before creating your account.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await signup(email.trim(), password, confirmPassword, acceptedTerms);
      // Account created (profile still incomplete) — force the profile step.
      setStep("profile");
    } catch (err: any) {
      setError(err.message || "Could not create your account.");
    } finally {
      setBusy(false);
    }
  };

  const handleProfileNext = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim() || !birthdate || !city.trim()) {
      setError("Please fill out all fields.");
      return;
    }
    setError("");
    setStep("pets");
  };

  const handleCompleteProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const validPets = pets.slice(0, petCount).filter(p => p.name.trim() !== "");
      const user = await completeProfile(fullName.trim(), birthdate, city.trim(), validPets);
      onAuthenticated(user, true); // brand-new user
    } catch (err: any) {
      setError(err.message || "Could not save your profile.");
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "w-full pl-10 pr-3 py-3 rounded-xl border border-outline-variant bg-surface-container-low text-on-surface focus:outline-none focus:border-primary transition-all placeholder:text-on-surface-variant/50 text-sm";
  const labelClass = "text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant px-1";
  const iconWrap =
    "absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant opacity-50 group-focus-within:text-primary group-focus-within:opacity-100 transition-all";

  return (
    <div className="w-full mx-auto px-6 py-8 relative overflow-hidden flex flex-col justify-end min-h-[100dvh]">
      <div className="z-10 w-full max-w-md mx-auto relative pt-[80px]">
        {/* Header Section */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center p-3 mb-6 bg-primary/10 rounded-2xl backdrop-blur-md dog-float">
            <span className="text-primary text-4xl font-bold font-sans">🐾</span>
          </div>
          <h1 className="font-headline-lg-mobile text-headline-lg-mobile text-primary mb-2">
            {step === "login" ? "Welcome Back" : step === "signup" ? "Join Pawsome3D" : step === "profile" ? "Set Up Your Profile" : "About Your Pets"}
          </h1>
          <p className="text-xs font-medium text-on-surface-variant opacity-80">
            {step === "login" && "Log in with your email and password."}
            {step === "signup" && "Create your account to get started."}
            {step === "profile" && "Just a couple details and you're in."}
            {step === "pets" && "Tell us about your furry friends!"}
          </p>
        </div>

        {/* Step indicator (only during sign up) */}
        {step !== "login" && (
          <div className="flex items-center justify-center gap-2 mb-4">
            {(["signup", "profile", "pets"] as Step[]).map((s, i) => {
              const order = { signup: 0, profile: 1, pets: 2, login: -1 } as Record<Step, number>;
              const active = order[step] >= i;
              return (
                <div
                  key={s}
                  className={`h-1.5 rounded-full transition-all ${active ? "bg-primary w-8" : "bg-outline-variant/50 w-4"}`}
                />
              );
            })}
          </div>
        )}

        {/* Form Container */}
        <div className="glass-panel rounded-3xl p-8 space-y-6">

          {/* STEP: Login */}
          {step === "login" && (
            <form className="space-y-3" onSubmit={handleLogin}>
              <div className="space-y-1">
                <label htmlFor="login-email" className={labelClass}>Email</label>
                <div className="relative group">
                  <span className={iconWrap}><Mail size={16} /></span>
                  <input
                    id="login-email" type="email" required
                    placeholder="you@example.com"
                    value={email} onChange={(e) => setEmail(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label htmlFor="login-password" className={labelClass}>Password</label>
                <div className="relative group">
                  <span className={iconWrap}><Lock size={16} /></span>
                  <input
                    id="login-password" type="password" required
                    autoComplete="current-password"
                    placeholder="••••••••"
                    value={password} onChange={(e) => setPassword(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>

              {error && <p className="text-[10px] text-error font-medium px-1">{error}</p>}

              <button
                type="submit" disabled={busy}
                className="tactile-button w-full bg-primary text-on-primary font-headline-lg-mobile text-body-md py-4 rounded-xl flex items-center justify-center gap-2 group cursor-pointer disabled:opacity-70 mt-2"
              >
                {busy ? <RefreshCw className="animate-spin" size={14} /> : <LogIn size={18} />}
                Log In
              </button>
              <button
                type="button"
                onClick={() => { setError(""); setForgotMsg(""); setStep("forgot"); }}
                className="w-full text-center text-[11px] text-on-surface-variant hover:text-primary mt-1 cursor-pointer"
              >
                Forgot your password?
              </button>
            </form>
          )}

          {/* STEP: Forgot password */}
          {step === "forgot" && (
            <form className="space-y-3" onSubmit={handleForgot}>
              {forgotMsg ? (
                <>
                  <p className="text-body-sm text-on-surface-variant px-1">{forgotMsg}</p>
                  <button
                    type="button"
                    onClick={() => { setForgotMsg(""); setError(""); setStep("login"); }}
                    className="tactile-button w-full bg-primary text-on-primary text-body-md py-4 rounded-xl flex items-center justify-center gap-2 cursor-pointer mt-2"
                  >
                    <ArrowLeft size={16} /> Back to Log In
                  </button>
                </>
              ) : (
                <>
                  <p className="text-body-sm text-on-surface-variant px-1">Enter your email and we'll send you a link to reset your password.</p>
                  <div className="space-y-1">
                    <label htmlFor="forgot-email" className={labelClass}>Email</label>
                    <div className="relative group">
                      <span className={iconWrap}><Mail size={16} /></span>
                      <input
                        id="forgot-email" type="email" required
                        placeholder="you@example.com"
                        value={email} onChange={(e) => setEmail(e.target.value)}
                        className={inputClass}
                      />
                    </div>
                  </div>
                  {error && <p className="text-[10px] text-error font-medium px-1">{error}</p>}
                  <button
                    type="submit" disabled={busy}
                    className="tactile-button w-full bg-primary text-on-primary font-headline-lg-mobile text-body-md py-4 rounded-xl flex items-center justify-center gap-2 cursor-pointer disabled:opacity-70 mt-2"
                  >
                    {busy ? <RefreshCw className="animate-spin" size={14} /> : <Mail size={18} />}
                    Send reset link
                  </button>
                  <button
                    type="button"
                    onClick={() => { setError(""); setStep("login"); }}
                    className="w-full text-center text-[11px] text-on-surface-variant hover:text-primary cursor-pointer"
                  >
                    Back to Log In
                  </button>
                </>
              )}
            </form>
          )}

          {/* STEP 1 — Sign up (email + password) */}
          {step === "signup" && (
            <form className="space-y-3" onSubmit={handleSignup}>
              <div className="space-y-1">
                <label htmlFor="signup-email" className={labelClass}>Email Address</label>
                <div className="relative group">
                  <span className={iconWrap}><Mail size={16} /></span>
                  <input
                    id="signup-email" type="email" required
                    placeholder="you@example.com"
                    value={email} onChange={(e) => setEmail(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label htmlFor="signup-password" className={labelClass}>Password</label>
                <div className="relative group">
                  <span className={iconWrap}><Lock size={16} /></span>
                  <input
                    id="signup-password" type="password" required minLength={6}
                    placeholder="At least 6 characters"
                    value={password} onChange={(e) => setPassword(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label htmlFor="signup-confirm" className={labelClass}>Confirm Password</label>
                <div className="relative group">
                  <span className={iconWrap}><Lock size={16} /></span>
                  <input
                    id="signup-confirm" type="password" required minLength={6}
                    placeholder="••••••••"
                    value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>

              <label className="flex items-start gap-3 rounded-xl border border-outline-variant/40 bg-surface-container-low p-3 text-sm text-on-surface cursor-pointer">
                <input
                  type="checkbox"
                  checked={acceptedTerms}
                  onChange={(e) => setAcceptedTerms(e.target.checked)}
                  className="mt-1 h-5 w-5 accent-primary"
                  required
                />
                <span className="leading-relaxed">
                  I agree to the{" "}
                  <a href="/legal/terms" target="_blank" rel="noopener noreferrer" className="font-bold text-primary underline">
                    Terms
                  </a>{" "}
                  and{" "}
                  <a href="/legal/privacy" target="_blank" rel="noopener noreferrer" className="font-bold text-primary underline">
                    Privacy Policy
                  </a>
                  .
                </span>
              </label>

              {error && <p className="text-[10px] text-error font-medium px-1">{error}</p>}

              <button
                type="submit" disabled={busy}
                className="tactile-button w-full bg-primary text-on-primary font-headline-lg-mobile text-body-md py-4 rounded-xl flex items-center justify-center gap-2 group cursor-pointer disabled:opacity-70 mt-2"
              >
                {busy ? <RefreshCw className="animate-spin" size={14} /> : <span>Create Account</span>}
                <span className="material-symbols-outlined group-hover:translate-x-1 transition-transform">arrow_forward</span>
              </button>
            </form>
          )}

          {/* STEP 2 — Profile */}
          {step === "profile" && (
            <form className="space-y-3 max-h-[60vh] overflow-y-auto pr-2" onSubmit={handleProfileNext}>
              <div className="space-y-1">
                <label htmlFor="full-name" className={labelClass}>Full Name</label>
                <div className="relative group">
                  <span className={iconWrap}><User size={16} /></span>
                  <input
                    id="full-name" type="text" required
                    placeholder="Enter your name"
                    value={fullName} onChange={(e) => setFullName(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label htmlFor="birthdate" className={labelClass}>Date of Birth</label>
                <div className="relative group">
                  <span className={iconWrap}><Calendar size={16} /></span>
                  <input
                    id="birthdate" type="date" required
                    value={birthdate} onChange={(e) => setBirthdate(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <p className="text-[9px] text-on-surface-variant/70 px-1 pt-0.5">You must be 13 or older.</p>
              </div>

              <div className="space-y-1">
                <label htmlFor="city" className={labelClass}>City</label>
                <div className="relative group">
                  <span className={iconWrap}><MapPin size={16} /></span>
                  <input
                    ref={cityInputRef}
                    id="city" type="text" required
                    placeholder="Nearest major city"
                    value={city} onChange={(e) => setCity(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>

              {error && <p className="text-[10px] text-error font-medium px-1 pt-1">{error}</p>}

              <button
                type="submit"
                className="tactile-button w-full bg-primary text-on-primary font-headline-lg-mobile text-body-md py-4 rounded-xl flex items-center justify-center gap-2 group cursor-pointer mt-2"
              >
                <span>Continue</span>
                <span className="material-symbols-outlined group-hover:translate-x-1 transition-transform">arrow_forward</span>
              </button>
            </form>
          )}

          {/* STEP 3 — Pets */}
          {step === "pets" && (
            <form className="space-y-3 max-h-[60vh] overflow-y-auto pr-2" onSubmit={handleCompleteProfile}>
              <div className="space-y-1">
                <label className={labelClass}>How many pets do you have?</label>
                <select
                  value={petCount}
                  onChange={(e) => {
                    const c = Number(e.target.value);
                    setPetCount(c);
                    if (pets.length < c) {
                      setPets([...pets, ...Array(c - pets.length).fill({name: "", kind: "dog"})]);
                    }
                  }}
                  className={`${inputClass} pl-3`}
                >
                  <option value={1}>1 Pet</option>
                  <option value={2}>2 Pets</option>
                  <option value={3}>3 Pets</option>
                  <option value={4}>4+ Pets</option>
                </select>
              </div>

              {pets.slice(0, petCount).map((p, idx) => (
                <div key={idx} className="space-y-1 p-3 bg-surface-container-low rounded-xl border border-surface-variant/50">
                  <label className="text-[10px] font-semibold uppercase text-primary px-1">Pet {idx + 1}</label>
                  <input
                    type="text" required placeholder="Pet's Name"
                    value={p.name}
                    onChange={(e) => {
                      const newPets = [...pets];
                      newPets[idx] = { ...p, name: e.target.value };
                      setPets(newPets);
                    }}
                    className={`${inputClass} pl-3 mb-2 bg-surface-container-lowest`}
                  />
                  <div className="flex gap-2">
                    <label className="flex items-center gap-1 text-xs text-on-surface">
                      <input type="radio" checked={p.kind === "dog"} onChange={() => { const newPets = [...pets]; newPets[idx] = { ...p, kind: "dog" }; setPets(newPets); }} />
                      Dog
                    </label>
                    <label className="flex items-center gap-1 text-xs text-on-surface">
                      <input type="radio" checked={p.kind === "cat"} onChange={() => { const newPets = [...pets]; newPets[idx] = { ...p, kind: "cat" }; setPets(newPets); }} />
                      Cat
                    </label>
                    <label className="flex items-center gap-1 text-xs text-on-surface">
                      <input type="radio" checked={p.kind === "other"} onChange={() => { const newPets = [...pets]; newPets[idx] = { ...p, kind: "other" }; setPets(newPets); }} />
                      Other
                    </label>
                  </div>
                </div>
              ))}

              {error && <p className="text-[10px] text-error font-medium px-1 pt-1">{error}</p>}

              <button
                type="submit" disabled={busy}
                className="tactile-button w-full bg-primary text-on-primary font-headline-lg-mobile text-body-md py-4 rounded-xl flex items-center justify-center gap-2 group cursor-pointer disabled:opacity-70 mt-4"
              >
                {busy ? <RefreshCw className="animate-spin" size={14} /> : <span>Complete Setup</span>}
                <span className="material-symbols-outlined group-hover:translate-x-1 transition-transform">arrow_forward</span>
              </button>
            </form>
          )}
        </div>

        {/* Footer Help — toggle between Login and Sign up */}
        <p className="mt-6 text-center text-xs text-on-surface-variant font-medium">
          {step === "login" ? (
            <>
              Don't have an account?{" "}
              <button type="button" onClick={() => { setStep("signup"); setError(""); }} className="text-primary hover:underline font-bold cursor-pointer">
                Sign up
              </button>
            </>
          ) : step === "signup" ? (
            <>
              Already have an account?{" "}
              <button type="button" onClick={() => { setStep("login"); setError(""); }} className="text-primary hover:underline font-bold cursor-pointer inline-flex items-center gap-1">
                <ArrowLeft size={10} /> Log in
              </button>
            </>
          ) : (
            "We use your data securely to set up your account."
          )}
        </p>
      </div>
    </div>
  );
}
