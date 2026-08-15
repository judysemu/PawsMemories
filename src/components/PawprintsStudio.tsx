import React, { useEffect, useState } from "react";
import type { Creation, PublicUser, UserProfile } from "../types";
import type { PawprintCategoryDef } from "../../shared/pawprintCatalog2";
import type { StudioPhoto } from "../pawprints/renderPawprint";
import { DigitalCategoryStep } from "./pawprints/DigitalCategoryStep";
import { CustomPromptStep } from "./pawprints/CustomPromptStep";
import { PhotoStep } from "./pawprints/PhotoStep";
import { FinishStep } from "./pawprints/FinishStep";
import { WizardSteps } from "./pawprints/WizardSteps";

interface PawprintsStudioProps {
  userProfile: UserProfile;
  creations: Creation[];
  onOpenCreditStore: () => void;
  onUserUpdate: (user: PublicUser) => void;
  onCreationSaved?: () => Promise<void> | void;
  onPawprintComplete: (pawprintId: number) => void;
}

type WizardStage = "category" | "custom-prompt" | "photo" | "finish";

export default function PawprintsStudio(props: PawprintsStudioProps) {
  const [digitalCategories, setDigitalCategories] = useState<PawprintCategoryDef[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");

  const [categoryId, setCategoryId] = useState("");
  const [optionId, setOptionId] = useState("");
  const [customizeChosen, setCustomizeChosen] = useState<boolean | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [photos, setPhotos] = useState<StudioPhoto[]>([]);
  const [photoError, setPhotoError] = useState("");
  const [stage, setStage] = useState<WizardStage>("category");

  useEffect(() => {
    let active = true;
    setCatalogLoading(true);
    setCatalogError("");
    fetch("/api/pawprints/templates").then((response) => response.json()).then((data) => {
      if (!active) return;
      setDigitalCategories(Array.isArray(data.digitalCategories) ? data.digitalCategories : []);
    }).catch(() => {
      if (active) setCatalogError("Pawprint themes could not be loaded.");
    }).finally(() => {
      if (active) setCatalogLoading(false);
    });
    return () => { active = false; };
  }, []);

  const selectedCategory = digitalCategories.find((item) => item.id === categoryId);
  const categoryLabel = selectedCategory?.options.find((item) => item.id === optionId)?.label || selectedCategory?.label || "Pawprint";

  const chooseOption = (nextCategoryId: string, nextOptionId: string) => {
    setCategoryId(nextCategoryId);
    setOptionId(nextOptionId);
  };

  const continueFromCategory = () => {
    setStage(customizeChosen ? "custom-prompt" : "photo");
  };

  const wizardSteps = [
    { id: "category", label: "Theme", done: Boolean(categoryId && optionId && customizeChosen !== null) },
    { id: "photo", label: "Photo", done: photos.length > 0 },
    { id: "finish", label: "Finish", done: false },
  ];
  const activeStepIndex = stage === "category" || stage === "custom-prompt" ? 0 : stage === "photo" ? 1 : 2;
  const goToStep = (index: number) => {
    if (index >= activeStepIndex) return;
    if (index === 0) { setPhotos([]); setPhotoError(""); setStage("category"); return; }
    if (index === 1) setStage("photo");
  };

  return (
    <div className="flex h-full flex-col bg-surface text-on-surface">
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[1500px] px-3 pt-4 sm:px-5">
          <WizardSteps steps={wizardSteps} activeIndex={activeStepIndex} onSelect={goToStep} />
        </div>

        {stage === "category" && (
          catalogLoading ? (
            <p className="mx-auto max-w-3xl px-4 py-8 text-sm font-bold text-on-surface-variant">Loading themes…</p>
          ) : catalogError ? (
            <p className="mx-auto max-w-3xl px-4 py-8 text-sm font-bold text-error">{catalogError}</p>
          ) : (
            <DigitalCategoryStep
              categories={digitalCategories}
              categoryId={categoryId}
              optionId={optionId}
              customizeChosen={customizeChosen}
              onChooseOption={chooseOption}
              onChooseCustomize={setCustomizeChosen}
              onContinue={continueFromCategory}
            />
          )
        )}

        {stage === "custom-prompt" && (
          <CustomPromptStep
            customPrompt={customPrompt}
            onChange={setCustomPrompt}
            onContinue={() => setStage("photo")}
            onBack={() => setStage("category")}
          />
        )}

        {stage === "photo" && (
          <PhotoStep
            photos={photos}
            onPhotosChange={setPhotos}
            error={photoError}
            onError={setPhotoError}
            onContinue={() => setStage("finish")}
            onBack={() => setStage(customizeChosen ? "custom-prompt" : "category")}
          />
        )}

        {stage === "finish" && (
          <FinishStep
            categoryId={categoryId}
            optionId={optionId}
            categoryLabel={categoryLabel}
            customPrompt={customPrompt}
            customized={Boolean(customizeChosen)}
            photos={photos}
            onPhotosChange={setPhotos}
            userProfile={props.userProfile}
            onOpenCreditStore={props.onOpenCreditStore}
            onUserUpdate={props.onUserUpdate}
            onCreationSaved={props.onCreationSaved}
            onPawprintComplete={props.onPawprintComplete}
            onBack={() => setStage("photo")}
          />
        )}
      </div>
    </div>
  );
}
