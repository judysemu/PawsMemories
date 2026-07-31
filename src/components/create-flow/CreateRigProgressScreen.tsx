import React, { useEffect, useRef, useState } from "react";
import { useCreateFlow } from "./CreateFlowContext";
import { getRigJob } from "../../api";
import { Screen } from "../../types";

interface Props {
  onNavigate: (screen: Screen) => void;
}

export const CreateRigProgressScreen: React.FC<Props> = ({ onNavigate }) => {
  const { rigJobUuid, setRigJob } = useCreateFlow();
  const [job, setLocalJob] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const navigateRef = useRef(onNavigate);
  const setRigJobRef = useRef(setRigJob);

  useEffect(() => { navigateRef.current = onNavigate; }, [onNavigate]);
  useEffect(() => { setRigJobRef.current = setRigJob; }, [setRigJob]);

  useEffect(() => {
    if (!rigJobUuid) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const terminal = (state: string) =>
      state === "ready" || state === "accepted" || state === "cancelled" || state.startsWith("failed_");

    const poll = async () => {
      try {
        const data = await getRigJob(rigJobUuid);
        if (stopped) return;
        setLocalJob(data);
        setRigJobRef.current(data);
        setError(null);

        if (terminal(String(data.state || "")) && (data.state === "ready" || data.state === "accepted")) {
          stopped = true;
          navigateRef.current(Screen.CREATE_RIG_REVIEW);
        } else if (terminal(String(data.state || ""))) {
          stopped = true;
          setError(`Rigging stopped: ${data.failureCode || data.state}. Your accepted static model is unchanged.`);
        }
      } catch (err: any) {
        if (!stopped) setError(err.message || "Failed to poll rig status");
      } finally {
        // Sequential recursive timeout: the 2.5-second delay starts only after
        // the prior request settles, so slow requests can never overlap.
        if (!stopped) {
          timer = setTimeout(() => { void poll(); }, 2500);
        }
      }
    };

    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [rigJobUuid]);

  const stateLabels: Record<string, string> = {
    draft: "Initializing Rig Pipeline...",
    classifying: "Analyzing Model Geometry & Proportions...",
    classified: "Skeleton Profile Selected",
    queued: "Queued for Rig Worker...",
    submitted: "Processing Rig Skeleton...",
    rigging: "Generating Bone Weights & Kinematics...",
    validating_rig: "Validating Deformations & Skin Weights...",
    inventorying_facial: "Inventorying Facial Morphs & Visemes...",
    fitting_accessories: "Fitting Accessory Attachments...",
    ready: "Rigging Complete — Ready for Review",
    failed_rig: "Rigging Validation Failed",
  };

  return (
    <div className="max-w-3xl mx-auto p-6 bg-slate-900 text-white rounded-xl shadow-2xl border border-slate-800 my-8">
      <h2 className="text-2xl font-bold mb-4 text-emerald-400">Phase 4: Rig & Facial Pipeline</h2>
      <p className="text-slate-300 mb-6">Generating skeleton, calculating skin weights, inventorying facial morph targets, and verifying joint performance.</p>

      {error && (
        <div className="p-4 bg-rose-900/50 border border-rose-700 text-rose-200 rounded-lg mb-6">
          {error}
        </div>
      )}

      <div className="bg-slate-800/80 p-6 rounded-lg border border-slate-700 mb-6 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-slate-400">Current Phase:</span>
          <span className="font-semibold text-emerald-300">{stateLabels[job?.state || "queued"]}</span>
        </div>

        {job?.classification && (
          <div className="flex items-center justify-between pt-2 border-t border-slate-700">
            <span className="text-slate-400">Classification:</span>
            <span className="capitalize font-mono text-cyan-300">{job.classification} ({job.selectedProfile})</span>
          </div>
        )}

        <div className="w-full bg-slate-700 h-3 rounded-full overflow-hidden mt-4">
          <div
            className="bg-emerald-500 h-full transition-all duration-500"
            style={{
              width:
                job?.state === "ready"
                  ? "100%"
                  : job?.state === "inventorying_facial"
                  ? "80%"
                  : job?.state === "rigging"
                  ? "50%"
                  : "25%",
            }}
          />
        </div>
      </div>

      <div className="flex justify-between items-center text-sm text-slate-400">
        <span>Job UUID: <code className="text-slate-300">{rigJobUuid || "..."}</code></span>
        <button
          onClick={() => onNavigate(Screen.CREATE_BUILD_REVIEW)}
          className="text-slate-400 hover:text-white underline"
        >
          Back to 3D Model Review
        </button>
      </div>
    </div>
  );
};
