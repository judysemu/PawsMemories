import React from "react";
import { ChevronLeft } from "lucide-react";
import { CUSTOM_PROMPT_MAX_LENGTH } from "../../pawprints/renderPawprint";
import { STORY_PROMPT_TEMPLATE } from "../../../shared/pawprintCatalog2";
import { PromptTeachingPanel, isPawprintsV3UiEnabled } from "./PromptTeachingPanel";
import { PersonalTextField } from "./PersonalTextField";

export function CustomPromptStep({
  customPrompt,
  onChange,
  onContinue,
  onBack,
  personalText = "",
  occasionId = null,
  onPersonalTextChange,
  onOccasionChange,
}: {
  customPrompt: string;
  onChange: (value: string) => void;
  onContinue: () => void;
  onBack: () => void;
  /** v3 only. Optional so the v2 call site keeps working unchanged. */
  personalText?: string;
  occasionId?: string | null;
  onPersonalTextChange?: (value: string) => void;
  onOccasionChange?: (occasionId: string | null) => void;
}) {
  const v3 = isPawprintsV3UiEnabled();

  /** Chips and samples seed the box, but must never silently destroy typed
   *  work — if there is already a prompt, append instead of replacing. */
  const seedPrompt = (seed: string) => {
    const current = customPrompt.trim();
    const next = current ? `${current}. ${seed}` : seed;
    onChange(next.slice(0, CUSTOM_PROMPT_MAX_LENGTH));
  };

  const replacePrompt = (prompt: string) => onChange(prompt.slice(0, CUSTOM_PROMPT_MAX_LENGTH));

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-28 pt-8">
      <button onClick={onBack} className="mb-6 flex min-h-11 items-center gap-2 text-sm font-black text-primary"><ChevronLeft size={18} /> Back</button>
      <h1 className="text-3xl font-black text-on-surface">Describe your Pawprint</h1>
      <p className="mt-2 text-on-surface-variant">
        {v3
          ? "Tell us what you'd like to see. The samples below break a good prompt into its parts, so you can see what each one does."
          : "Tell us exactly what you'd like to see. Want a narrative \"Story\" style portrait? Use the suggested format below."}
      </p>

      {v3 ? (
        <PromptTeachingPanel onUsePrompt={replacePrompt} onAppendIdea={seedPrompt} />
      ) : (
        <div className="mt-6 rounded-2xl border border-outline-variant/30 bg-surface-container-low p-4">
          <p className="text-xs font-black uppercase tracking-[.15em] text-primary">Suggested "Story" format</p>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-xs text-on-surface-variant">{STORY_PROMPT_TEMPLATE}</pre>
          <button
            type="button"
            onClick={() => onChange(STORY_PROMPT_TEMPLATE)}
            className="mt-3 min-h-10 rounded-xl border border-primary/40 px-3 text-xs font-black text-primary"
          >
            Use this format
          </button>
        </div>
      )}

      <label htmlFor="pawprint-custom-prompt" className="mt-6 block text-xs font-bold text-on-surface-variant">Your prompt</label>
      <textarea
        id="pawprint-custom-prompt"
        value={customPrompt}
        maxLength={CUSTOM_PROMPT_MAX_LENGTH}
        rows={6}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Describe the scene, mood, and moments you want to see…"
        className="mt-1 w-full resize-none rounded-xl border border-outline-variant bg-surface-container p-3"
      />
      <p className="mt-1 text-right text-[10px] text-on-surface-variant">{customPrompt.length}/{CUSTOM_PROMPT_MAX_LENGTH}</p>

      {v3 && onPersonalTextChange && onOccasionChange && (
        <PersonalTextField
          value={personalText}
          occasionId={occasionId}
          onChange={onPersonalTextChange}
          onOccasionChange={onOccasionChange}
        />
      )}

      <button
        type="button"
        onClick={onContinue}
        disabled={!customPrompt.trim()}
        className="mt-6 flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-6 font-black text-on-primary disabled:opacity-40 sm:w-auto"
      >
        Continue
      </button>
    </div>
  );
}
