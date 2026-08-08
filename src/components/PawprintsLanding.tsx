import React from "react";
import { ArrowLeft, User, Users, PawPrint } from "lucide-react";

export type PawprintMode = "single_pet" | "owner_pet" | "multi_pet";

interface PawprintsLandingProps {
  onSelectMode: (mode: PawprintMode) => void;
  onBack: () => void;
}

export default function PawprintsLanding({ onSelectMode, onBack }: PawprintsLandingProps) {
  return (
    <div className="flex h-full flex-col bg-surface text-on-surface">
      <header className="flex min-h-16 shrink-0 items-center gap-4 border-b border-outline-variant/30 px-4 md:px-6">
        <button
          type="button"
          onClick={onBack}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-container-high transition hover:bg-surface-container-highest"
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </button>
        <div>
          <h1 className="text-xl font-black">Pawprints Studio</h1>
          <p className="text-xs font-medium text-on-surface-variant">Turn your photos into royal portraits.</p>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="mx-auto max-w-5xl">
          <div className="mb-10 text-center">
            <h2 className="text-3xl font-black text-primary md:text-4xl">Choose Your Subject</h2>
            <p className="mt-3 text-sm text-on-surface-variant md:text-base">
              Select who will be starring in this masterpiece. Our AI preserves the exact face, coat, and features.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-3">
            {/* Pet Portrait Card */}
            <button
              onClick={() => onSelectMode("single_pet")}
              className="group flex flex-col overflow-hidden rounded-3xl border-2 border-transparent bg-surface-container-low text-left transition hover:border-primary hover:shadow-xl"
            >
              <div className="aspect-[4/3] w-full bg-[#f8efe8] p-8 text-center flex flex-col items-center justify-center">
                <div className="grid h-20 w-20 place-items-center rounded-full bg-white shadow-sm transition-transform group-hover:scale-110">
                  <PawPrint size={40} className="text-[#b7795d]" />
                </div>
              </div>
              <div className="p-6">
                <h3 className="text-xl font-black">Pet Portrait</h3>
                <p className="mt-2 text-sm text-on-surface-variant">
                  A stunning solo portrait of your best friend in historical attire, Halloween costumes, or classic settings.
                </p>
                <div className="mt-4 font-black text-primary">50 Pup Coins</div>
              </div>
            </button>

            {/* Owner/Pet Portrait Card */}
            <button
              onClick={() => onSelectMode("owner_pet")}
              className="group flex flex-col overflow-hidden rounded-3xl border-2 border-transparent bg-surface-container-low text-left transition hover:border-primary hover:shadow-xl"
            >
              <div className="aspect-[4/3] w-full bg-[#e3f1ff] p-8 text-center flex flex-col items-center justify-center">
                <div className="grid h-20 w-20 place-items-center rounded-full bg-white shadow-sm transition-transform group-hover:scale-110">
                  <User size={40} className="text-[#5689bd]" />
                </div>
              </div>
              <div className="p-6">
                <h3 className="text-xl font-black">Owner & Pet</h3>
                <p className="mt-2 text-sm text-on-surface-variant">
                  You and your pet exploring famous landmarks or wearing matching Halloween costumes.
                </p>
                <div className="mt-4 font-black text-primary">70 Pup Coins</div>
              </div>
            </button>

            {/* Multi-Pet Portrait Card */}
            <button
              onClick={() => onSelectMode("multi_pet")}
              className="group flex flex-col overflow-hidden rounded-3xl border-2 border-transparent bg-surface-container-low text-left transition hover:border-primary hover:shadow-xl"
            >
              <div className="aspect-[4/3] w-full bg-[#e3f2df] p-8 text-center flex flex-col items-center justify-center">
                <div className="grid h-20 w-20 place-items-center rounded-full bg-white shadow-sm transition-transform group-hover:scale-110">
                  <Users size={40} className="text-[#5c9563]" />
                </div>
              </div>
              <div className="p-6">
                <h3 className="text-xl font-black">Multi-Pet Portrait</h3>
                <p className="mt-2 text-sm text-on-surface-variant">
                  Two of your furry friends side-by-side in matching historical roles or festive themes.
                </p>
                <div className="mt-4 font-black text-primary">70 Pup Coins</div>
              </div>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
