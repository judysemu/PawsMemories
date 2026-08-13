import React from "react";
import { ChevronLeft } from "lucide-react";
import type { PawprintCategoryDef } from "../../../shared/pawprintCatalog2";
import { CREDIT_PRICES } from "../../pricing";

export function CategoryOptionPicker({
  categories, categoryId, optionId, onChoose, heading, subheading,
}: {
  categories: PawprintCategoryDef[];
  categoryId: string;
  optionId: string;
  onChoose: (categoryId: string, optionId: string) => void;
  heading: string;
  subheading: string;
}) {
  return (
    <div className="mb-8 max-w-2xl">
      <p className="text-xs font-black uppercase tracking-[.2em] text-primary">{heading}</p>
      <h1 className="mt-2 text-3xl font-black text-on-surface">{subheading}</h1>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {categories.map((category) => (
          <div key={category.id} className={`rounded-2xl border-2 p-4 transition ${categoryId === category.id ? "border-primary bg-primary/5" : "border-outline-variant/40"}`}>
            <label htmlFor={`pawprint-category-${category.id}`} className="block font-black text-on-surface">{category.label}</label>
            <select
              id={`pawprint-category-${category.id}`}
              value={categoryId === category.id ? optionId : ""}
              onChange={(event) => onChoose(category.id, event.target.value)}
              className="mt-2 min-h-11 w-full rounded-xl border border-outline-variant bg-surface px-3 text-sm font-semibold"
            >
              <option value="" disabled>Choose a theme…</option>
              {category.options.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CustomizeChoice({ customizeChosen, onChoose }: {
  customizeChosen: boolean | null;
  onChoose: (customize: boolean) => void;
}) {
  return (
    <div className="mb-8 max-w-2xl">
      <h2 className="text-xl font-black text-on-surface">Would you like to customize your print?</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onChoose(true)}
          className={`min-h-14 rounded-2xl border-2 px-4 font-black transition ${customizeChosen === true ? "border-primary bg-primary/5 text-primary" : "border-outline-variant/40 text-on-surface hover:border-primary/50"}`}
        >
          Customize · +{CREDIT_PRICES.PAWPRINT_CUSTOMIZE_ADDON} PupCoins
        </button>
        <button
          type="button"
          onClick={() => onChoose(false)}
          className={`min-h-14 rounded-2xl border-2 px-4 font-black transition ${customizeChosen === false ? "border-primary bg-primary/5 text-primary" : "border-outline-variant/40 text-on-surface hover:border-primary/50"}`}
        >
          No Custom Instructions
        </button>
      </div>
    </div>
  );
}

export function DigitalCategoryStep({
  categories, categoryId, optionId, customizeChosen, onChooseOption, onChooseCustomize, onContinue, onBack,
}: {
  categories: PawprintCategoryDef[];
  categoryId: string;
  optionId: string;
  customizeChosen: boolean | null;
  onChooseOption: (categoryId: string, optionId: string) => void;
  onChooseCustomize: (customize: boolean) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const canContinue = Boolean(categoryId && optionId && customizeChosen !== null);
  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-28 pt-8">
      <button onClick={onBack} className="mb-6 flex min-h-11 items-center gap-2 text-sm font-black text-primary"><ChevronLeft size={18} /> Back</button>
      <CategoryOptionPicker
        categories={categories}
        categoryId={categoryId}
        optionId={optionId}
        onChoose={onChooseOption}
        heading="Digital Pawprint"
        subheading="Choose a theme for your pet's portrait"
      />
      <CustomizeChoice customizeChosen={customizeChosen} onChoose={onChooseCustomize} />
      <button
        type="button"
        onClick={onContinue}
        disabled={!canContinue}
        className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-6 font-black text-on-primary disabled:opacity-40 sm:w-auto"
      >
        Continue
      </button>
    </div>
  );
}
