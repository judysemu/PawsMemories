import { reservePaidUsage } from "../db";
import {
  isEndpointEnabled,
  paidUsageLimitsFor,
  type PaidUsageReservation,
} from "./paidApiGuards";

type Env = Record<string, string | undefined>;
type ReserveUsage = (
  phone: string,
  endpoint: "image_generation",
  limits: ReturnType<typeof paidUsageLimitsFor>,
) => Promise<PaidUsageReservation>;

export class ImageGenerationBudgetError extends Error {
  constructor(
    public readonly code:
      | "IMAGE_GENERATION_DISABLED"
      | "IMAGE_GENERATION_USER_CAP"
      | "IMAGE_GENERATION_GLOBAL_CAP"
      | "IMAGE_GENERATION_GLOBAL_MINUTE_CAP"
      | "IMAGE_GENERATION_GLOBAL_COST_CAP",
    message: string,
  ) {
    super(message);
    this.name = "ImageGenerationBudgetError";
  }
}

/**
 * Optional image work may degrade on ordinary provider/storage failures, but a
 * spend-control denial must remain authoritative all the way to the HTTP edge.
 */
export function rethrowImageGenerationBudgetError(error: unknown): void {
  if (error instanceof ImageGenerationBudgetError) throw error;
}

export function createImageGenerationCallBudget(
  options: {
    env?: Env;
    reserveUsage?: ReserveUsage;
  } = {},
): (phone: string) => Promise<void> {
  const env = options.env || process.env;
  const reserveUsage = options.reserveUsage || reservePaidUsage;

  return async (phone: string) => {
    if (!isEndpointEnabled("image_generation", env)) {
      throw new ImageGenerationBudgetError(
        "IMAGE_GENERATION_DISABLED",
        "AI image generation is temporarily disabled.",
      );
    }

    const reservation = await reserveUsage(
      phone,
      "image_generation",
      paidUsageLimitsFor("image_generation", env),
    );
    if (reservation.allowed) return;

    if (reservation.reason === "user_cap") {
      throw new ImageGenerationBudgetError(
        "IMAGE_GENERATION_USER_CAP",
        "Your AI image-generation safety limit has been reached.",
      );
    }
    if (reservation.reason === "global_cost_cap") {
      throw new ImageGenerationBudgetError(
        "IMAGE_GENERATION_GLOBAL_COST_CAP",
        "The AI image-generation service has reached its cost safety limit.",
      );
    }
    if (reservation.reason === "global_minute_cap") {
      throw new ImageGenerationBudgetError(
        "IMAGE_GENERATION_GLOBAL_MINUTE_CAP",
        "The AI image-generation service has reached its minute safety limit.",
      );
    }
    throw new ImageGenerationBudgetError(
      "IMAGE_GENERATION_GLOBAL_CAP",
      "The AI image-generation service has reached its daily safety limit.",
    );
  };
}

export const reserveImageGenerationCall = createImageGenerationCallBudget();
