import React, { useEffect, useState } from "react";
import type { Creation, PublicUser, UserProfile } from "../types";
import type { PawprintCategoryDef, PawprintPrintProduct } from "../../shared/pawprintCatalog2";
import type { StudioPhoto } from "../pawprints/renderPawprint";
import { EntryStep, type PawprintEntryMode } from "./pawprints/EntryStep";
import { DigitalCategoryStep } from "./pawprints/DigitalCategoryStep";
import { PrintProductStep } from "./pawprints/PrintProductStep";
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
}

type WizardStage = "entry" | "category" | "custom-prompt" | "photo" | "finish";

export default function PawprintsStudio(props: PawprintsStudioProps) {
  const [entry, setEntry] = useState<PawprintEntryMode | null>(null);
  const [digitalCategories, setDigitalCategories] = useState<PawprintCategoryDef[]>([]);
  const [printProducts, setPrintProducts] = useState<PawprintPrintProduct[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");

  const [shopifyProductId, setShopifyProductId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [optionId, setOptionId] = useState("");
  const [customizeChosen, setCustomizeChosen] = useState<boolean | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [photos, setPhotos] = useState<StudioPhoto[]>([]);
  const [stage, setStage] = useState<WizardStage>("entry");

  useEffect(() => {
    let active = true;
    setCatalogLoading(true);
    setCatalogError("");
    fetch("/api/pawprints/templates").then((response) => response.json()).then((data) => {
      if (!active) return;
      setDigitalCategories(Array.isArray(data.digitalCategories) ? data.digitalCategories : []);
      setPrintProducts(Array.isArray(data.printProducts) ? data.printProducts : []);
    }).catch(() => {
      if (active) setCatalogError("Pawprint themes could not be loaded.");
    }).finally(() => {
      if (active) setCatalogLoading(false);
    });
    return () => { active = false; };
  }, []);

  const shopifyProduct = printProducts.find((item) => item.shopifyProductId === shopifyProductId) || null;
  const selectedCategory = (entry === "print" ? shopifyProduct?.categories : digitalCategories)?.find((item) => item.id === categoryId);
  const categoryLabel = selectedCategory?.options.find((item) => item.id === optionId)?.label || selectedCategory?.label || "Pawprint";

  const resetSelection = () => {
    setShopifyProductId("");
    setCategoryId("");
    setOptionId("");
    setCustomizeChosen(null);
    setCustomPrompt("");
    setPhotos([]);
  };

  const chooseEntry = (mode: PawprintEntryMode) => {
    resetSelection();
    setEntry(mode);
    setStage("category");
  };

  const chooseOption = (nextCategoryId: string, nextOptionId: string) => {
    setCategoryId(nextCategoryId);
    setOptionId(nextOptionId);
  };

  const continueFromCategory = () => {
    setStage(customizeChosen ? "custom-prompt" : "photo");
  };

  const wizardSteps = [
    { id: "entry", label: "Keepsake", done: Boolean(entry) },
    { id: "category", label: "Theme", done: Boolean(categoryId && optionId && customizeChosen !== null) },
    { id: "photo", label: "Photo", done: photos.length > 0 },
    { id: "finish", label: "Finish", done: false },
  ];
  const activeStepIndex = stage === "entry" ? 0 : stage === "category" || stage === "custom-prompt" ? 1 : stage === "photo" ? 2 : 3;
  const goToStep = (index: number) => {
    if (index >= activeStepIndex) return;
    if (index === 0) { setEntry(null); resetSelection(); setStage("entry"); return; }
    if (index === 1) { setPhotos([]); setStage("category"); return; }
    if (index === 2) setStage("photo");
  };

  return (
    <div className="flex h-full flex-col bg-surface text-on-surface">
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[1500px] px-3 pt-4 sm:px-5">
          <WizardSteps steps={wizardSteps} activeIndex={activeStepIndex} onSelect={goToStep} />
        </div>

        {stage === "entry" && <EntryStep onChoose={chooseEntry} />}

        {stage === "category" && entry === "digital" && (
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
              onBack={() => { setEntry(null); resetSelection(); setStage("entry"); }}
            />
          )
        )}

        {stage === "category" && entry === "print" && (
          <PrintProductStep
            products={printProducts}
            productsLoading={catalogLoading}
            productsError={catalogError}
            shopifyProductId={shopifyProductId}
            categoryId={categoryId}
            optionId={optionId}
            customizeChosen={customizeChosen}
            onChooseProduct={(id) => { setShopifyProductId(id); setCategoryId(""); setOptionId(""); }}
            onChooseOption={chooseOption}
            onChooseCustomize={setCustomizeChosen}
            onContinue={continueFromCategory}
            onBack={() => { setEntry(null); resetSelection(); setStage("entry"); }}
          />
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
            error=""
            onError={() => {}}
            onContinue={() => setStage("finish")}
            onBack={() => setStage(customizeChosen ? "custom-prompt" : "category")}
          />
        )}

        {stage === "finish" && entry && (
          <FinishStep
            entry={entry}
            categoryId={categoryId}
            optionId={optionId}
            categoryLabel={categoryLabel}
            shopifyProduct={shopifyProduct}
            customPrompt={customPrompt}
            customized={Boolean(customizeChosen)}
            photos={photos}
            onPhotosChange={setPhotos}
            userProfile={props.userProfile}
            onOpenCreditStore={props.onOpenCreditStore}
            onUserUpdate={props.onUserUpdate}
            onCreationSaved={props.onCreationSaved}
            onBack={() => setStage("photo")}
          />
        )}
      </div>
    </div>
  );
}
