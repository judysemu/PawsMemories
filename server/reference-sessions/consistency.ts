import crypto from "node:crypto";
import {
  ConsistencyReportPayloadSchema,
  type ConsistencyReportPayload,
} from "./schemas";
import type { GeneratedViewPayload, ScaleConfidence, ReportStatus } from "./types";
import { MIN_REFERENCE_DIMENSION_PX } from "./provider";

export function computeReportHash(payload: ConsistencyReportPayload): string {
  const jsonStr = JSON.stringify(payload);
  return crypto.createHash("sha256").update(jsonStr).digest("hex");
}

export function evaluateReferenceConsistency(
  views: GeneratedViewPayload[],
  inputMode: "text" | "photo",
  declaredScale?: string | null,
): { payload: ConsistencyReportPayload; hash: string } {
  const required = ["front", "left", "right", "rear"];
  const viewKinds = new Set(views.map((v) => v.viewKind));
  const hasAllViews = views.length === 4 && required.every((kind) => viewKinds.has(kind as any));
  const dimensionsValid = views.every((view) => view.widthPx >= MIN_REFERENCE_DIMENSION_PX && view.heightPx >= MIN_REFERENCE_DIMENSION_PX);

  let scaleConfidence: ScaleConfidence = "unknown";
  if (declaredScale) scaleConfidence = "declared";

  const metrics = [
    {
      name: "Required View Coverage",
      status: (hasAllViews ? "pass" : "fail") as ReportStatus,
      score: hasAllViews ? 1 : 0,
      details: hasAllViews ? "The uploaded front and all three generated views are present." : "One or more required view kinds are missing or duplicated.",
    },
    {
      name: "Decoded Image Resolution",
      status: (dimensionsValid ? "pass" : "fail") as ReportStatus,
      score: dimensionsValid ? 1 : 0,
      details: dimensionsValid ? `Every image decodes at or above ${MIN_REFERENCE_DIMENSION_PX}x${MIN_REFERENCE_DIMENSION_PX} pixels.` : "At least one image is below the minimum decoded resolution.",
    },
    {
      name: "Cross-View Identity Review",
      status: "warn" as ReportStatus,
      score: 0,
      details: "Identity, anatomy, markings, and framing require human approval; no automated visual evaluator has verified them.",
    },
  ];

  const payload: ConsistencyReportPayload = {
    status: hasAllViews && dimensionsValid ? "warn" : "fail",
    scaleConfidence,
    summaryNote:
      inputMode === "photo"
        ? "Four-view photo set prepared. Automated checks cover file validity and resolution; customer approval accepts the generated views as the build references."
        : "Four-view reference set prepared. Automated checks cover file validity and resolution; customer approval accepts the generated views as the build references.",
    metrics,
    crossViewIdentityScore: 0,
    cropSuitabilityScore: 0,
  };

  // Validate with Zod
  const validated = ConsistencyReportPayloadSchema.parse(payload);
  const hash = computeReportHash(validated);

  return { payload: validated, hash };
}
