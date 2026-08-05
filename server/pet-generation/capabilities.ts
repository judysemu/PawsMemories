import { selectedPaws3dProvider } from "../model-builds/configuredProvider";
import { PET_GLB_STAGE_PRICES } from "../../src/pricing";
import { PetGenerationError } from "./provider";
import type {
  PetGlbOrderConfiguration,
  PetGlbStageKind,
  SubjectProfile,
} from "./types";

export interface PetGlbProductCapabilities {
  providerId: string;
  texture: {
    includedInBase: boolean;
    separateStageAvailable: boolean;
    defaultSelected: boolean;
    priceCredits: number;
    styleDirectionAvailable: boolean;
    reason: string | null;
  };
  subjectProfiles: ReadonlyArray<{
    id: SubjectProfile;
    label: string;
    rigType: "quadruped" | "biped";
  }>;
  reference: {
    requiredViewKinds: ReadonlyArray<"front" | "left" | "right" | "rear">;
    generatedForApproval: ReadonlyArray<"left" | "right" | "rear">;
    canRegenerate: boolean;
  };
}

/**
 * Customer-facing capabilities are selected without constructing a provider.
 * GET /product therefore stays safe while a private worker is intentionally
 * off, and the quote/order contract reflects the provider actually selected.
 */
export function petGlbProductCapabilities(
  env: NodeJS.ProcessEnv = process.env,
): PetGlbProductCapabilities {
  const providerId = selectedPaws3dProvider(env);
  if (providerId === "trellis2") {
    return {
      providerId,
      texture: {
        includedInBase: true,
        separateStageAvailable: false,
        defaultSelected: false,
        priceCredits: 0,
        styleDirectionAvailable: false,
        reason: "PBR color and materials are included in the TRELLIS base model.",
      },
      subjectProfiles: [
        { id: "pet", label: "Pet / animal", rigType: "quadruped" },
      ],
      reference: {
        requiredViewKinds: ["front"],
        generatedForApproval: [],
        canRegenerate: false,
      },
    };
  }

  // Preserve the existing Tripo product contract exactly. Unknown providers
  // fail closed rather than inheriting either provider's paid capabilities.
  if (providerId === "tripo") {
    return {
      providerId,
      texture: {
        includedInBase: false,
        separateStageAvailable: true,
        defaultSelected: true,
        priceCredits: PET_GLB_STAGE_PRICES.TEXTURE,
        styleDirectionAvailable: true,
        reason: null,
      },
      subjectProfiles: [
        { id: "pet", label: "Pet / animal", rigType: "quadruped" },
        { id: "humanoid", label: "Humanoid character", rigType: "biped" },
      ],
      reference: {
        requiredViewKinds: ["front", "left", "right", "rear"],
        generatedForApproval: ["left", "right", "rear"],
        canRegenerate: true,
      },
    };
  }

  throw new PetGenerationError(
    "UNSUPPORTED_PROVIDER",
    `Provider '${providerId}' does not publish paid pet-product capabilities`,
  );
}

export function assertPetGlbConfigurationSupported(
  configuration: PetGlbOrderConfiguration,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const capabilities = petGlbProductCapabilities(env);
  if (!capabilities.subjectProfiles.some(({ id }) => id === configuration.subjectProfile)) {
    throw new PetGenerationError(
      "SUBJECT_PROFILE_UNSUPPORTED",
      `${configuration.subjectProfile} models are not supported by the selected ${capabilities.providerId} product`,
    );
  }
  if (configuration.includeTexture && !capabilities.texture.separateStageAvailable) {
    throw new PetGenerationError(
      "TEXTURE_INCLUDED_IN_BASE",
      capabilities.texture.reason || "A separately priced texture stage is unavailable",
    );
  }
  if (configuration.styleDirection && !capabilities.texture.styleDirectionAvailable) {
    throw new PetGenerationError(
      "STYLE_DIRECTION_UNAVAILABLE",
      "Separate texture styling is unavailable because PBR materials are included in the base model",
    );
  }
}

/** Convert old persisted selections to the current provider's honest product. */
export function normalizeHistoricalConfiguration(
  configuration: PetGlbOrderConfiguration,
  env: NodeJS.ProcessEnv = process.env,
): PetGlbOrderConfiguration {
  const capabilities = petGlbProductCapabilities(env);
  if (capabilities.texture.separateStageAvailable) return { ...configuration };
  return {
    ...configuration,
    includeTexture: false,
    textureQuality: "standard",
    styleDirection: null,
  };
}

export function nextPetGlbStage(
  configuration: Pick<PetGlbOrderConfiguration, "includeTexture" | "includeRig">,
  current: PetGlbStageKind,
  env: NodeJS.ProcessEnv = process.env,
): Exclude<PetGlbStageKind, "reference"> | null {
  const capabilities = petGlbProductCapabilities(env);
  if (current === "reference") return "base";
  if (current === "base") {
    if (configuration.includeTexture && capabilities.texture.separateStageAvailable) return "texture";
    if (configuration.includeRig) return "rig_check";
    return null;
  }
  if (current === "texture") return configuration.includeRig ? "rig_check" : null;
  if (current === "rig_check") return "rig";
  return null;
}
