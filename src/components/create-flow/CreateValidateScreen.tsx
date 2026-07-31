import React, { useEffect, useState } from "react";
import { Screen } from "../../types";
import { useCreateFlow } from "./CreateFlowContext";
import { ChevronLeft, ChevronRight, CheckCircle2, XCircle, AlertTriangle, RefreshCw } from "lucide-react";
import { authedFetch } from "../../api";
import {
  buildPrebuildValidationFingerprint,
  evaluatePrebuildValidation,
  type PrebuildValidationResult,
} from "./prebuildValidation";

interface CreateValidateScreenProps {
  onNavigate: (screen: Screen) => void;
}

export default function CreateValidateScreen({ onNavigate }: CreateValidateScreenProps) {
  const { state, setState } = useCreateFlow();
  const [isValidating, setIsValidating] = useState(true);
  const [results, setResults] = useState<PrebuildValidationResult[]>([]);
  const [isPrintable, setIsPrintable] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const candidateImageUrl = state.candidateImageUrl;
  const pose = state.customizationState?.pose;
  const engraving = state.customizationState?.engraving;
  const validationFingerprint = buildPrebuildValidationFingerprint({ candidateImageUrl, pose, engraving });

  useEffect(() => {
    setIsValidating(true);
    setResults([]);
    const runValidation = () => {
      const { passed, checks } = evaluatePrebuildValidation({ candidateImageUrl, pose, engraving });

      setResults(checks);
      setIsPrintable(passed);
      setIsValidating(false);

      // Save validation state
      setState(s => ({
        ...s,
        validationState: { passed, checks }
      }));
    };

    const timer = setTimeout(runValidation, 1500);
    return () => clearTimeout(timer);
  }, [validationFingerprint, setState]);

  const handleContinue = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const res = await authedFetch("/api/create-pipeline/update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: state.sessionId,
          customizationState: state.customizationState,
          validationState: state.validationState ? {
             isPrintable: state.validationState.passed,
             errors: state.validationState.checks.filter(c => !c.pass).map(c => c.detail),
             warnings: [],
          } : undefined
        })
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to save validation state.");
      }
      onNavigate(Screen.CREATE_CHECKOUT);
    } catch (err: any) {
      setSaveError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-8 animate-in fade-in zoom-in duration-500">
      <div className="mb-6 flex items-center justify-between">
        <button 
          onClick={() => onNavigate(Screen.CREATE_CUSTOMIZE)}
          className="flex items-center gap-1 text-on-surface-variant hover:text-primary font-medium"
        >
          <ChevronLeft size={20} /> Back
        </button>
        <div className="flex gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-primary/30"></div>
          <div className="w-2.5 h-2.5 rounded-full bg-primary/30"></div>
          <div className="w-2.5 h-2.5 rounded-full bg-primary/30"></div>
          <div className="w-2.5 h-2.5 rounded-full bg-primary"></div>
        </div>
      </div>

      <div className="text-center mb-8">
        <h1 className="text-3xl font-black text-on-surface mb-2">Pre-Build Check</h1>
        <p className="text-on-surface-variant text-lg">Confirming your approved reference and customization choices before the model is built.</p>
      </div>

      <div className="glass-panel p-8 rounded-3xl max-w-2xl mx-auto min-h-[400px]">
        {isValidating ? (
          <div className="flex flex-col items-center justify-center py-12 text-center h-full">
            <RefreshCw className="animate-spin text-primary mb-6" size={48} />
            <h3 className="text-xl font-bold text-on-surface mb-2">Running Diagnostics...</h3>
            <p className="text-on-surface-variant">Reviewing the reference, pose plan, and engraving limits.</p>
          </div>
        ) : (
          <div className="flex flex-col h-full">
            <div className="flex items-center gap-4 mb-8 p-6 rounded-2xl bg-surface-variant/30 border border-outline-variant">
              {isPrintable ? (
                <>
                  <CheckCircle2 size={48} className="text-emerald-500 shrink-0" />
                  <div>
                    <h3 className="text-xl font-bold text-on-surface">Ready to Build</h3>
                    <p className="text-on-surface-variant">Pre-build inputs are complete. Final mesh and print checks run after the model is built.</p>
                  </div>
                </>
              ) : (
                <>
                  <XCircle size={48} className="text-error shrink-0" />
                  <div>
                    <h3 className="text-xl font-bold text-on-surface">Input Needs Attention</h3>
                    <p className="text-on-surface-variant">Please fix the pre-build issue below to continue.</p>
                  </div>
                </>
              )}
            </div>

            <div className="space-y-4 mb-8 flex-1">
              <h4 className="font-bold text-on-surface px-2 text-sm uppercase tracking-wider">Pre-Build Rules</h4>
              {results.map((res, i) => (
                <div key={i} className="flex items-start gap-4 p-4 rounded-xl bg-surface border border-outline-variant">
                  {res.pass ? (
                    <CheckCircle2 size={24} className="text-emerald-500 shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle size={24} className="text-error shrink-0 mt-0.5" />
                  )}
                  <div>
                    <h5 className="font-bold text-on-surface">{res.rule}</h5>
                    <p className="text-sm text-on-surface-variant mt-1">{res.detail}</p>
                  </div>
                </div>
              ))}
            </div>

            {saveError && (
              <div className="mb-4 p-4 rounded-xl bg-error/10 border border-error/20 flex items-start gap-3">
                <AlertTriangle className="text-error shrink-0 mt-0.5" size={20} />
                <p className="text-error text-sm font-medium">{saveError}</p>
              </div>
            )}

            <button
              onClick={handleContinue}
              disabled={!isPrintable || isSaving}
              className={`py-4 rounded-xl font-black text-lg flex justify-center items-center gap-2 w-full transition-all ${
                isPrintable && !isSaving
                  ? 'bg-primary text-on-primary shadow-lg shadow-primary/25 hover:scale-[1.02]' 
                  : 'bg-surface-variant text-on-surface-variant/50 cursor-not-allowed'
              }`}
            >
              {isSaving ? (
                <><RefreshCw className="animate-spin" size={20} /> Saving...</>
              ) : (
                <>Continue to Checkout <ChevronRight size={20} /></>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
