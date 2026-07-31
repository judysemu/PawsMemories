import React, { useEffect, useState } from "react";
import { Screen, UserProfile } from "../../types";
import { useCreateFlow } from "./CreateFlowContext";
import { ChevronLeft, Check, RefreshCw, AlertTriangle, ShieldCheck } from "lucide-react";
import { CREDIT_PRICES, createModelCost } from "../../pricing";
import { authedFetch, getModelBuildQuote, startModelBuild } from "../../api";
import FriendlyError from "../FriendlyError";

interface CreateCheckoutScreenProps {
  onNavigate: (screen: Screen) => void;
  userProfile: UserProfile;
}

export default function CreateCheckoutScreen({ onNavigate, userProfile }: CreateCheckoutScreenProps) {
  const { state, setState, resetState } = useCreateFlow();
  const [isApproving, setIsApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [p3Quote, setP3Quote] = useState<any>(null);

  const isP3Enabled = import.meta.env.VITE_MODEL_BUILD_V3_ENABLED === "true";

  useEffect(() => {
    if (isP3Enabled && state.sessionId) {
      getModelBuildQuote(state.sessionId)
        .then((res) => {
          const q = res.data;
          setP3Quote(q);
          setState((s) => ({ ...s, buildQuote: q }));
        })
        .catch(() => { /* non-fatal preflight fallback */ });
    }
  }, [state.sessionId, isP3Enabled]);

  // P3/P4: authoritative price includes optional rigging selections made
  // on the customize screen or returned by Phase 3 quote.
  const MODEL_COST = p3Quote?.quotedCredits ?? createModelCost(state.customizationState?.rigging);
  const hasEnoughCredits = userProfile.isAdmin || userProfile.credits >= MODEL_COST;

  const handleApproveAndBuild = async () => {
    setIsApproving(true);
    setError(null);
    try {
      const idempotencyKey = `build_${crypto.randomUUID()}`;

      if (isP3Enabled && state.sessionId) {
        const res = await startModelBuild(state.sessionId, idempotencyKey);
        const job = res.data;
        setState((s) => ({ ...s, activeJobUuid: job.jobUuid }));
        onNavigate(Screen.CREATE_BUILD_PROGRESS);
        return;
      }

      // Legacy fallback
      const res = await authedFetch("/api/create-pipeline/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId, idempotencyKey }),
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to start build.");
      }

      resetState();
      setTimeout(() => {
        onNavigate(Screen.FURBIN);
      }, 500);

    } catch (err: any) {
      setError(err.message || "Failed to start build.");
      setIsApproving(false);
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-8 animate-in fade-in zoom-in duration-500">
      <div className="mb-6 flex items-center justify-between">
        <button 
          onClick={() => onNavigate(Screen.CREATE_VALIDATE)}
          className="flex items-center gap-1 text-on-surface-variant hover:text-primary font-medium"
        >
          <ChevronLeft size={20} /> Back
        </button>
      </div>

      <div className="text-center mb-8">
        <h1 className="text-3xl font-black text-on-surface mb-2">Checkout</h1>
        <p className="text-on-surface-variant text-lg">Approve the blueprint and start the 3D build process.</p>
      </div>

      <div className="glass-panel p-8 rounded-3xl max-w-2xl mx-auto">
        <div className="flex gap-6 mb-8 border-b border-outline-variant pb-8">
          <div className="w-32 h-32 rounded-2xl overflow-hidden shadow-lg border-2 border-primary/20 shrink-0">
            <img src={state.candidateImageUrl} alt="Model Blueprint" className="w-full h-full object-cover" />
          </div>
          <div className="flex flex-col justify-center">
            <h3 className="text-xl font-bold text-on-surface capitalize">{state.species} 3D Model</h3>
            <p className="text-on-surface-variant mt-1">
              Pose: {state.customizationState?.pose || "Sitting"}
            </p>
            {state.customizationState?.engraving && (
              <p className="text-on-surface-variant text-sm mt-1">
                Engraving: "{state.customizationState.engraving}"
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4 mb-8">
          <div className="flex justify-between items-center text-lg">
            <span className="text-on-surface-variant font-medium">3D Model Generation</span>
            <span className="font-bold text-on-surface flex items-center gap-1">
              {MODEL_COST} <span className="text-xs uppercase font-black text-primary">PupCoins</span>
            </span>
          </div>
          
          <div className="flex justify-between items-center text-sm p-4 rounded-xl bg-surface-variant/30 border border-outline-variant">
            <span className="text-on-surface-variant">Your Balance</span>
            <span className={`font-bold flex items-center gap-1 ${hasEnoughCredits ? 'text-emerald-500' : 'text-error'}`}>
              {userProfile.isAdmin ? 'Unlimited (Admin)' : userProfile.credits}
            </span>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-4 rounded-xl bg-error/10 border border-error/20 flex items-start gap-3">
            <AlertTriangle className="text-error shrink-0 mt-0.5" size={20} />
            <p className="text-error text-sm font-medium">{error}</p>
          </div>
        )}

        {hasEnoughCredits ? (
          <button
            onClick={handleApproveAndBuild}
            disabled={isApproving}
            className={`w-full py-4 rounded-xl font-black text-lg text-on-primary bg-primary shadow-lg shadow-primary/25 hover:scale-[1.02] transition-transform flex justify-center items-center gap-2 ${isApproving ? 'opacity-80 pointer-events-none' : ''}`}
          >
            {isApproving ? (
              <><RefreshCw size={20} className="animate-spin" /> Preparing your pet...</>
            ) : (
              <><Check size={20} /> Create my pet</>
            )}
          </button>
        ) : (
          <div className="text-center">
            <FriendlyError message={`You need ${MODEL_COST - userProfile.credits} more PupCoins to create this pet.`} action="Add PupCoins, then come back when you’re ready." className="mb-4 text-left" />
            <button
              onClick={() => onNavigate(Screen.STORE)}
              className="px-6 py-3 rounded-xl font-bold text-primary border-2 border-primary hover:bg-primary/5 transition-colors"
            >
              Get More PupCoins
            </button>
          </div>
        )}
        
        <p className="text-center text-xs text-on-surface-variant mt-4">
          Creating this pet uses {MODEL_COST} PupCoins. It usually takes a few minutes.
        </p>
      </div>
    </div>
  );
}
