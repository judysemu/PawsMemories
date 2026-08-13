import React from "react";
import { Check } from "lucide-react";

export function WizardSteps({ steps, activeIndex, onSelect }: {
  steps: Array<{ id: string; label: string; done: boolean }>;
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <nav aria-label="Pawprint progress" className="mb-6">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 text-xs font-black">
        {steps.map((step, index) => {
          const isActive = index === activeIndex;
          const reachable = index < activeIndex;
          return (
            <li key={step.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onSelect(index)}
                disabled={!reachable}
                aria-current={isActive ? "step" : undefined}
                className={`flex min-h-11 items-center gap-2 rounded-full px-3 transition ${
                  isActive
                    ? "bg-primary text-on-primary"
                    : reachable
                      ? "text-primary hover:bg-primary/10"
                      : "text-on-surface-variant opacity-60"
                }`}
              >
                <span className={`grid h-5 w-5 place-items-center rounded-full text-[10px] ${isActive ? "bg-on-primary/20" : "bg-outline-variant/30"}`}>
                  {step.done && !isActive ? <Check size={11} /> : index + 1}
                </span>
                {step.label}
              </button>
              {index < steps.length - 1 && <span aria-hidden className="text-on-surface-variant/50">·</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
