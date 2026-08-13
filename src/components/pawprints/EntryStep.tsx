import React from "react";
import { CREDIT_PRICES } from "../../pricing";

export type PawprintEntryMode = "digital" | "print";

export function EntryStep({ onChoose }: { onChoose: (entry: PawprintEntryMode) => void }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-8">
      <div className="mb-8 max-w-2xl">
        <h1 className="text-2xl font-black text-on-surface sm:text-3xl">How will you celebrate your pet?</h1>
        <p className="mt-2 text-sm text-on-surface-variant">Choose Digital to design and save a keepsake instantly, or Print to design one and have it shipped.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onChoose("digital")}
          className="group flex flex-col gap-2 rounded-2xl border-2 border-outline-variant/40 p-5 text-left transition hover:border-primary/60"
        >
          <span className="text-2xl">🎨</span>
          <span className="font-black text-on-surface">Digital Pawprint</span>
          <span className="text-xs text-on-surface-variant">Instant download · Share or print at home · {CREDIT_PRICES.PAWPRINT_DIGITAL} PupCoins</span>
        </button>
        <button
          type="button"
          onClick={() => onChoose("print")}
          className="group flex flex-col gap-2 rounded-2xl border-2 border-outline-variant/40 p-5 text-left transition hover:border-primary/60"
        >
          <span className="text-2xl">🖼️</span>
          <span className="font-black text-on-surface">Print Pawprint</span>
          <span className="text-xs text-on-surface-variant">Printed &amp; shipped to your door · {CREDIT_PRICES.PAWPRINT_PRINT} PupCoins</span>
        </button>
      </div>
    </div>
  );
}
