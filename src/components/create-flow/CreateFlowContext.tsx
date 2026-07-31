import React, { createContext, useCallback, useContext, useMemo, useState, ReactNode } from "react";
import type { RigJobResponse } from "../../api";

interface CreateFlowState {
  sessionId?: string;
  species: string;
  breed?: string;
  petName?: string;
  intent?: string; // "memorial", "figurine", "avatar"
  inputPhotoUrl?: string; // Base64 or object URL of user's uploaded photo
  /** "image" = from a photo, "text" = from a written description. The server
   *  has supported both since the original create dialog; the newer create flow
   *  dropped the text branch, orphaning a paid, working code path. */
  inputMode?: "image" | "text";
  /** Free-text subject description, used when inputMode === "text". */
  textPrompt?: string;
  candidateImageUrl?: string; // Generated AI reference image
  customizationState?: any; // Poses, colors, etc.
  validationState?: { passed: boolean; checks: { rule: string; pass: boolean; detail: string; }[] };
  style?: string; // e.g. "Realistic", "Cartoon"
  activeJobUuid?: string;
  rigJobUuid?: string;
  rigJob?: RigJobResponse;
  buildQuote?: any;
  buildJobDetail?: any;
}

interface CreateFlowContextValue {
  state: CreateFlowState;
  setState: React.Dispatch<React.SetStateAction<CreateFlowState>>;
  resetState: () => void;
  rigJobUuid?: string;
  rigJob?: RigJobResponse;
  setRigJobUuid: (uuid: string) => void;
  setRigJob: (job: RigJobResponse) => void;
}

const CreateFlowContext = createContext<CreateFlowContextValue | undefined>(undefined);

const ACTIVE_JOB_KEY = "pawsome3d_active_model_build_job_uuid";

export function CreateFlowProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CreateFlowState>(() => {
    const savedJob = typeof window !== "undefined" ? sessionStorage.getItem(ACTIVE_JOB_KEY) : null;
    return {
      species: "dog",
      inputMode: "image",
      activeJobUuid: savedJob || undefined,
    };
  });

  const handleSetState: React.Dispatch<React.SetStateAction<CreateFlowState>> = useCallback((action) => {
    setState((prev) => {
      const next = typeof action === "function" ? action(prev) : action;
      if (typeof window !== "undefined") {
        if (next.activeJobUuid) sessionStorage.setItem(ACTIVE_JOB_KEY, next.activeJobUuid);
        else sessionStorage.removeItem(ACTIVE_JOB_KEY);
      }
      return next;
    });
  }, []);

  const resetState = useCallback(() => {
    if (typeof window !== "undefined") sessionStorage.removeItem(ACTIVE_JOB_KEY);
    setState({ species: "dog", inputMode: "image" });
  }, []);

  const setRigJobUuid = useCallback((uuid: string) => {
    setState((prev) => ({ ...prev, rigJobUuid: uuid }));
  }, []);

  const setRigJob = useCallback((job: RigJobResponse) => {
    setState((prev) => ({ ...prev, rigJob: job, rigJobUuid: job?.jobUuid || prev.rigJobUuid }));
  }, []);

  const value = useMemo<CreateFlowContextValue>(() => ({
    state,
    setState: handleSetState,
    resetState,
    rigJobUuid: state.rigJobUuid,
    rigJob: state.rigJob,
    setRigJobUuid,
    setRigJob,
  }), [handleSetState, resetState, setRigJob, setRigJobUuid, state]);

  return (
    <CreateFlowContext.Provider
      value={value}
    >
      {children}
    </CreateFlowContext.Provider>
  );
}

export function useCreateFlow() {
  const ctx = useContext(CreateFlowContext);
  if (!ctx) {
    throw new Error("useCreateFlow must be used within a CreateFlowProvider");
  }
  return ctx;
}
