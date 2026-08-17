import React from "react";
import {
  ANNOTATED_SAMPLE_PROMPT,
  PLAIN_SAMPLE_PROMPT,
  IDEA_CHIPS,
  composeSamplePrompt,
  type PromptSection,
} from "../../../shared/pawprintCatalog2";

/** True when the v3 teaching UI is enabled. Server flag is authoritative for
 *  anything paid; this only gates presentation, so the build-time flag is
 *  sufficient. Defaults ON only when explicitly set, matching flag discipline. */
export function isPawprintsV3UiEnabled(): boolean {
  return import.meta.env.VITE_PAWPRINTS_V3_UI === "true";
}

/**
 * Each section gets its own tint so the eye can separate the parts of a prompt
 * at a glance. These are deliberately fixed rather than themed: the point is
 * that "Scene" is always the same colour wherever the customer sees it.
 */
const SECTION_TINT: Record<string, string> = {
  scene: "bg-amber-500/15 border-amber-500/40",
  subject: "bg-rose-500/15 border-rose-500/40",
  personal: "bg-emerald-500/15 border-emerald-500/40",
  mood: "bg-indigo-500/15 border-indigo-500/40",
  composition: "bg-fuchsia-500/15 border-fuchsia-500/40",
};

function SectionRow({ section }: { section: PromptSection }) {
  const tint = SECTION_TINT[section.id] || "bg-primary/10 border-primary/30";
  return (
    <li className="list-none">
      <div className={`rounded-xl border px-3 py-2 ${tint}`}>
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
 * The teaching panel: one dissected sample, one whole sample, and idea chips.
 * Both samples are insertable — reading about a prompt is weaker than starting
 * from one and editing it.
 */
export function PromptTeachingPanel({ onUsePrompt, onAppendIdea }: {
  onUsePrompt: (prompt: string) => void;
  onAppendIdea: (seed: string) => void;
}) {
  const sample = ANNOTATED_SAMPLE_PROMPT;

  return (
    <section className="mt-6 space-y-6">
      <div className="rounded-2xl border border-outline-variant/30 bg-surface-container-low p-4">
        <p className="text-xs font-black uppercase tracking-[.15em] text-primary">
          Sample 1 · what each part does
        </p>
        <h2 className="mt-1 text-sm font-black text-on-surface">{sample.title}</h2>
        <ul className="mt-3">
          {sample.sections.map((section) => (
            <SectionRow key={section.id} section={section} />
          ))}
        </ul>
        <button
          type="button"
          onClick={() => onUsePrompt(composeSamplePrompt(sample))}
          className="min-h-10 rounded-xl border border-primary/40 px-3 text-xs font-black text-primary"
        >
          Start from this prompt
        </button>
      </div>

      <div className="rounded-2xl border border-outline-variant/30 bg-surface-container-low p-4">
        <p className="text-xs font-black uppercase tracking-[.15em] text-primary">
          Sample 2 · now read it as one sentence
        </p>
        <p className="mt-2 text-sm text-on-surface">{PLAIN_SAMPLE_PROMPT}</p>
        <button
          type="button"
          onClick={() => onUsePrompt(PLAIN_SAMPLE_PROMPT)}
          className="mt-3 min-h-10 rounded-xl border border-primary/40 px-3 text-xs font-black text-primary"
        >
          Start from this prompt
        </button>
      </div>

      <div>
        <p className="text-xs font-black uppercase tracking-[.15em] text-primary">
          Need an idea? Tap one to start
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {IDEA_CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => onAppendIdea(chip.seed)}
              className="min-h-10 rounded-full border border-outline-variant bg-surface-container px-3 text-xs font-bold text-on-surface"
            >
              <span aria-hidden="true">{chip.emoji}</span> {chip.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-on-surface-variant">
          Chips fill the box with editable text — change any of it.
        </p>
      </div>
    </section>
  );
}
