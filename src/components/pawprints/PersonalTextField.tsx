import React from "react";
import { OCCASION_PRESETS, PERSONAL_TEXT_MAX_LENGTH } from "../../../shared/pawprintCatalog2";

/**
 * Optional printed caption plus occasion presets. Selecting an occasion fills
 * the field with an editable starting phrase rather than locking a template —
 * "Framed photo" deliberately fills nothing, because a framed portrait usually
 * wants a name or date the customer supplies, not a greeting.
 */
export function PersonalTextField({ value, occasionId, onChange, onOccasionChange }: {
  value: string;
  occasionId: string | null;
  onChange: (value: string) => void;
  onOccasionChange: (occasionId: string | null) => void;
}) {
  const selectOccasion = (id: string, defaultText: string) => {
    if (occasionId === id) {
      // Tapping the active occasion clears it, so the caption is easy to remove.
      onOccasionChange(null);
      onChange("");
      return;
    }
    onOccasionChange(id);
    // Never clobber wording the customer already typed.
    if (!value.trim()) onChange(defaultText);
  };

  return (
    <section className="mt-8">
      <p className="text-xs font-black uppercase tracking-[.15em] text-primary">
        Add a message (optional)
      </p>
      <p className="mt-1 text-xs text-on-surface-variant">
        Printed onto the artwork. Leave it blank for a plain portrait.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {OCCASION_PRESETS.map((preset) => {
          const active = occasionId === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              aria-pressed={active}
              onClick={() => selectOccasion(preset.id, preset.defaultText)}
              className={`min-h-10 rounded-full border px-3 text-xs font-bold ${
                active
                  ? "border-primary bg-primary/15 text-primary"
                  : "border-outline-variant bg-surface-container text-on-surface"
              }`}
            >
              <span aria-hidden="true">{preset.emoji}</span> {preset.label}
            </button>
          );
        })}
      </div>

      <label htmlFor="pawprint-personal-text" className="mt-4 block text-xs font-bold text-on-surface-variant">
        Your message
      </label>
      <input
        id="pawprint-personal-text"
        type="text"
        value={value}
        maxLength={PERSONAL_TEXT_MAX_LENGTH}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Happy Birthday, Grandma!"
        className="mt-1 w-full rounded-xl border border-outline-variant bg-surface-container p-3 text-sm"
      />
      <p className="mt-1 text-right text-[10px] text-on-surface-variant">
        {value.length}/{PERSONAL_TEXT_MAX_LENGTH}
      </p>
    </section>
  );
}
