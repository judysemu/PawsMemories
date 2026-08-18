import React from "react";
import {
  annotatedVideoSampleFor,
  plainVideoSampleFor,
  VIDEO_IDEA_CHIPS,
  VIDEO_DURATION_NOTES,
  type VideoPromptSection,
} from "../../aiVideoScripts";

/** Build-time flag, matching the PawPrints v3 pattern. Presentation only —
 *  nothing paid changes — so the client flag is sufficient. */
export function isVideoStudioV2Enabled(): boolean {
  return import.meta.env.VITE_VIDEO_STUDIO_V2 === "true";
}

/**
 * One tint per section, held constant across both durations and shared in
 * spirit with the PawPrints panel: a customer who learns "Setting is amber"
 * once should not have to relearn it on the video screen.
 */
const SECTION_TINT: Record<VideoPromptSection["id"], string> = {
  setting: "bg-amber-500/15 border-amber-500/40",
  characters: "bg-rose-500/15 border-rose-500/40",
  motions: "bg-emerald-500/15 border-emerald-500/40",
  stageDirections: "bg-violet-500/15 border-violet-500/40",
  lighting: "bg-sky-500/15 border-sky-500/40",
  filter: "bg-fuchsia-500/15 border-fuchsia-500/40",
  camera: "bg-orange-500/15 border-orange-500/40",
};

function SectionRow({ section }: { section: VideoPromptSection }) {
  return (
    <li className="list-none">
      <div className={`rounded-xl border px-3 py-2 ${SECTION_TINT[section.id]}`}>
        <span className="text-[10px] font-black uppercase tracking-[.14em] text-on-surface">
          {section.label}
        </span>
        <p className="mt-0.5 text-sm text-on-surface">{section.text}</p>
      </div>
      <p className="mt-1 mb-3 pl-3 text-xs text-on-surface-variant">{section.explanation}</p>
    </li>
  );
}

/**
 * Two samples for the selected duration: the first dissected section by
 * section, the second shown whole. The sections ARE the fields of the script
 * form below, so explaining them explains the form itself.
 */
export function VideoTeachingPanel({ durationSeconds, onApplySample, onApplyIdea }: {
  durationSeconds: 8 | 15;
  /** Applies a whole sample to the script fields. */
  onApplySample: (sample: ReturnType<typeof annotatedVideoSampleFor>) => void;
  /** Applies only Setting and Characters, leaving the rest as-is. */
  onApplyIdea: (idea: { setting: string; characters: string }) => void;
}) {
  const sample = annotatedVideoSampleFor(durationSeconds);
  const plain = plainVideoSampleFor(durationSeconds);
  const note = VIDEO_DURATION_NOTES[durationSeconds];

  return (
    <section className="mt-6 space-y-6">
      <div className="rounded-2xl border border-outline-variant/30 bg-surface-container-low p-4">
        <p className="text-xs font-black uppercase tracking-[.15em] text-primary">{note.headline}</p>
        <p className="mt-1 text-xs text-on-surface-variant">{note.detail}</p>
      </div>

      <div className="rounded-2xl border border-outline-variant/30 bg-surface-container-low p-4">
        <p className="text-xs font-black uppercase tracking-[.15em] text-primary">
          Sample 1 · what each part does
        </p>
        <h3 className="mt-1 text-sm font-black text-on-surface">{sample.title}</h3>
        <ul className="mt-3">
          {sample.sections.map((section) => (
            <SectionRow key={section.id} section={section} />
          ))}
        </ul>
        <button
          type="button"
          onClick={() => onApplySample(sample)}
          className="min-h-10 rounded-xl border border-primary/40 px-3 text-xs font-black text-primary"
        >
          Fill the script with this
        </button>
      </div>

      <div className="rounded-2xl border border-outline-variant/30 bg-surface-container-low p-4">
        <p className="text-xs font-black uppercase tracking-[.15em] text-primary">
          Sample 2 · read as one piece
        </p>
        <p className="mt-2 text-sm text-on-surface">{plain}</p>
      </div>

      <div>
        <p className="text-xs font-black uppercase tracking-[.15em] text-primary">
          Starring you and your pet — tap an idea
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {VIDEO_IDEA_CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => onApplyIdea({ setting: chip.setting, characters: chip.characters })}
              className="min-h-10 rounded-full border border-outline-variant bg-surface-container px-3 text-xs font-bold text-on-surface"
            >
              <span aria-hidden="true">{chip.emoji}</span> {chip.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-on-surface-variant">
          Chips set the Setting and Characters only — your lighting, camera and beats stay as you left them.
        </p>
      </div>
    </section>
  );
}
