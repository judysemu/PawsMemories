import { PAWS_3D_PROVIDER_ID } from "../model-builds/configuredProvider";
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
 * Customer-facing capabilities, published without constructing a provider.
 * GET /product therefore stays safe while credentials are intentionally blank.
 *
 * This is the Tripo contract unconditionally. It used to branch on a provider
 * resolved from the environment, which meant the contract a customer was
 * quoted could disagree with the adapter that would actually run the build if
 * the two were configured inconsistently. With one provider bound at the
 * module level that disagreement is no longer expressible.
 *
 * `env` is retained for the TRIPO_MODEL_VERSION lookups in callers and for the
 * existing signature; nothing here selects on it.
 */
export function petGlbProductCapabilities(
  _env: NodeJS.ProcessEnv = process.env,
): PetGlbProductCapabilities {
  return {
      providerId: PAWS_3D_PROVIDER_ID,
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
