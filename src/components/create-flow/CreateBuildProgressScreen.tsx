import React, { useEffect, useState } from "react";
import { Screen } from "../../types";
import { useCreateFlow } from "./CreateFlowContext";
import { ChevronLeft, RefreshCw, AlertTriangle, XCircle, CheckCircle2, RotateCcw, ArrowRight } from "lucide-react";
import { getModelBuildDetail, cancelModelBuild, retryModelBuild } from "../../api";
import FriendlyError from "../FriendlyError";

interface CreateBuildProgressScreenProps {
  onNavigate: (screen: Screen) => void;
}

export default function CreateBuildProgressScreen({ onNavigate }: CreateBuildProgressScreenProps) {
  const { state, setState } = useCreateFlow();
  const [jobData, setJobData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryNotes, setRetryNotes] = useState("");

  const jobUuid = state.activeJobUuid;

  const fetchJobDetail = async () => {
    if (!jobUuid) return;
    try {
      const res = await getModelBuildDetail(jobUuid);
      const detail = res.data;
      setJobData(detail);
      setState((s) => ({ ...s, buildJobDetail: detail }));

      if (detail?.job?.state === "ready" || detail?.job?.state === "accepted") {
        onNavigate(Screen.CREATE_BUILD_REVIEW);
      }
    } catch (err: any) {
      setError(err.message || "Failed to load model build status.");
    }
  };

  useEffect(() => {
    if (!jobUuid) {
      onNavigate(Screen.CREATE_CHECKOUT);
      return;
    }

    let isMounted = true;
    const loadDetail = async () => {
      try {
        const res = await getModelBuildDetail(jobUuid);
        if (!isMounted) return;
        const detail = res.data;
        setJobData(detail);
        setState((s) => ({ ...s, buildJobDetail: detail }));

        if (detail?.job?.state === "ready" || detail?.job?.state === "accepted") {
          onNavigate(Screen.CREATE_BUILD_REVIEW);
        }
      } catch (err: any) {
        if (isMounted) setError(err.message || "Failed to load model build status.");
      }
    };

    loadDetail();

    const interval = setInterval(() => {
      if (jobData?.job?.state && ["accepted", "failed_provider", "failed_validation", "cancelled"].includes(jobData.job.state)) {
        clearInterval(interval);
        return;
      }
      loadDetail();
    }, 3000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [jobUuid, jobData?.job?.state]);

  const handleCancel = async () => {
    if (!jobUuid) return;
    setIsCancelling(true);
    setError(null);
    try {
      await cancelModelBuild(jobUuid);
      await fetchJobDetail();
    } catch (err: any) {
      setError(err.message || "Failed to cancel build.");
    } finally {
      setIsCancelling(false);
    }
  };

  const handleRetry = async () => {
    if (!jobUuid) return;
    setIsRetrying(true);
    setError(null);
    try {
      const idempotencyKey = `retry_${crypto.randomUUID()}`;
      await retryModelBuild(jobUuid, idempotencyKey, retryNotes);
      setRetryNotes("");
      await fetchJobDetail();
    } catch (err: any) {
      setError(err.message || "Failed to retry model build.");
    } finally {
      setIsRetrying(false);
    }
  };

  const jobState = jobData?.job?.state || "queued";
  const isTerminal = ["ready", "accepted", "failed_provider", "failed_validation", "cancelled"].includes(jobState);
  const isFailed = ["failed_provider", "failed_validation"].includes(jobState);
  const canCancel = ["queued", "submitted", "draft", "preflight", "reserving"].includes(jobState);

  const stateLabels: Record<string, { title: string; desc: string }> = {
    draft: { title: "Drafting", desc: "Initializing build job..." },
    preflight: { title: "Preflight Checks", desc: "Verifying the approved 4-view reference session..." },
    reserving: { title: "Reserving Credits", desc: "Authorizing PupCoins reservation..." },
    queued: { title: "Queued", desc: "Build request queued for provider execution..." },
    submitted: { title: "Submitted", desc: "Sent to 3D generation worker..." },
    processing: { title: "Processing 3D Mesh", desc: "Synthesizing high-resolution geometry and textures..." },
    downloading: { title: "Downloading Model", desc: "Streaming GLB to private storage..." },
    validating: { title: "Validating Geometry", desc: "Running post-build mesh and topological verification..." },
    ready: { title: "Build Ready", desc: "3D model validated and ready for review." },
    accepted: { title: "Accepted", desc: "Build accepted by user." },
    failed_provider: { title: "Provider Generation Failed", desc: "3D provider could not construct the mesh." },
    failed_validation: { title: "Post-Build Validation Failed", desc: "Model did not pass geometric quality rules." },
    cancelled: { title: "Build Cancelled", desc: "Job cancelled and credits refunded." },
  };

  const currentInfo = stateLabels[jobState] || { title: jobState, desc: "Processing model build..." };

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-8 animate-in fade-in zoom-in duration-500 overflow-x-hidden">
      <div className="mb-6 flex items-center justify-between">
        <button
          onClick={() => onNavigate(Screen.CREATE_CHECKOUT)}
          className="flex items-center gap-1 text-on-surface-variant hover:text-primary font-medium"
        >
          <ChevronLeft size={20} /> Back to Checkout
        </button>
        <span className="text-xs font-mono text-on-surface-variant">
          Job: {jobUuid ? `${jobUuid.slice(0, 8)}...` : "—"}
        </span>
      </div>

      <div className="text-center mb-8">
        <h1 className="text-3xl font-black text-on-surface mb-2">3D Model Generation</h1>
        <p className="text-on-surface-variant text-lg">Durable background build and authoritative validation.</p>
      </div>

      <div className="glass-panel p-8 rounded-3xl max-w-2xl mx-auto flex flex-col items-center justify-center min-h-[380px]">
        {!isTerminal ? (
          <div className="flex flex-col items-center text-center py-6">
            <RefreshCw className="animate-spin text-primary mb-6" size={56} />
            <h3 className="text-2xl font-black text-on-surface mb-2">{currentInfo.title}</h3>
            <p className="text-on-surface-variant mb-6 max-w-md">{currentInfo.desc}</p>

            {/* State Progress Indicators */}
            <div className="w-full max-w-md bg-surface-variant/40 p-4 rounded-2xl border border-outline-variant/30 mb-6">
              <div className="flex justify-between text-xs font-bold text-on-surface-variant mb-2">
                <span>Attempt #{jobData?.job?.currentAttemptNumber || 1}</span>
                <span className="uppercase text-primary">{jobState}</span>
              </div>
              <div className="w-full bg-surface-variant h-2 rounded-full overflow-hidden">
                <div
                  className="bg-primary h-full transition-all duration-500"
                  style={{
                    width:
                      jobState === "queued" ? "15%" :
                      jobState === "submitted" ? "35%" :
                      jobState === "processing" ? "60%" :
                      jobState === "downloading" ? "80%" :
                      jobState === "validating" ? "92%" : "5%",
                  }}
                />
              </div>
            </div>

            {canCancel && (
              <button
                onClick={handleCancel}
                disabled={isCancelling}
                aria-label="Cancel model build before processing"
                className="px-6 py-2.5 rounded-xl font-bold text-error bg-error/10 hover:bg-error/20 border border-error/30 transition-colors text-sm flex items-center gap-2"
              >
                {isCancelling ? <RefreshCw className="animate-spin" size={16} /> : <XCircle size={16} />}
                Cancel Build
              </button>
            )}
          </div>
        ) : isFailed ? (
          <div className="flex flex-col items-center text-center py-6 w-full">
            <div className="w-16 h-16 rounded-full bg-error/10 flex items-center justify-center mb-4">
              <AlertTriangle className="text-error" size={36} />
            </div>
            <h3 className="text-2xl font-black text-on-surface mb-2">{currentInfo.title}</h3>
            <p className="text-on-surface-variant mb-4">{currentInfo.desc}</p>

            {jobData?.job?.failureCode && (
              <div className="p-4 rounded-xl bg-error/10 border border-error/20 text-xs text-error font-mono mb-6 w-full text-left">
                Error Code: {jobData.job.failureCode}
              </div>
            )}

            {jobData?.job?.billingDisposition === "refunded" && (
              <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-400 font-bold mb-6 w-full flex items-center gap-2">
                <CheckCircle2 size={18} />
                <span>PupCoins for this failed attempt have been automatically refunded to your credit balance.</span>
              </div>
            )}

            {jobData?.job?.billingDisposition === "refund_pending" && (
              <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400 font-bold mb-6 w-full flex items-center gap-2">
                <AlertTriangle size={18} />
                <span>Refund processing is pending review. If your balance does not update shortly, please contact customer support.</span>
              </div>
            )}

            {/* Retry Form */}
            <div className="w-full flex flex-col gap-3 border-t border-outline-variant/30 pt-6">
              <input
                type="text"
                placeholder="Optional adjustment notes for retry..."
                value={retryNotes}
                onChange={(e) => setRetryNotes(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-surface-variant/40 border border-outline-variant text-on-surface text-sm focus:outline-none focus:border-primary"
              />
              <button
                onClick={handleRetry}
                disabled={isRetrying}
                className="w-full py-4 rounded-xl font-bold text-on-primary bg-primary shadow-md hover:scale-[1.01] transition-transform flex items-center justify-center gap-2"
              >
                {isRetrying ? <RefreshCw className="animate-spin" size={20} /> : <RotateCcw size={20} />}
                Retry 3D Build
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center text-center py-6">
            <CheckCircle2 className="text-emerald-500 mb-4" size={56} />
            <h3 className="text-2xl font-black text-on-surface mb-2">Your pet is ready!</h3>
            <p className="text-on-surface-variant mb-6">Your creation is ready for a final look.</p>
            <button
              onClick={() => onNavigate(Screen.CREATE_BUILD_REVIEW)}
              className="px-8 py-4 rounded-2xl font-black text-on-primary bg-primary shadow-lg shadow-primary/25 hover:scale-105 transition-transform flex items-center gap-2"
            >
              Review my pet <ArrowRight size={20} />
            </button>
          </div>
        )}

        {error && (
          <FriendlyError message={error} action="Try again when you’re ready. Your progress is safe." className="mt-4 w-full text-left" />
        )}
      </div>
    </div>
  );
}
