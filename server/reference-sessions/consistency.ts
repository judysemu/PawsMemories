import crypto from "node:crypto";
import {
  ConsistencyReportPayloadSchema,
  type ConsistencyReportPayload,
} from "./schemas";
import type { GeneratedViewPayload, ScaleConfidence, ReportStatus, ViewKind } from "./types";
import { ORDERED_VIEW_KINDS } from "./types";
import { MIN_REFERENCE_DIMENSION_PX } from "./provider";

export function computeReportHash(payload: ConsistencyReportPayload): string {
  const jsonStr = JSON.stringify(payload);
  return crypto.createHash("sha256").update(jsonStr).digest("hex");
}

export function evaluateReferenceConsistency(
  views: GeneratedViewPayload[],
  inputMode: "text" | "photo",
  declaredScale?: string | null,
  requiredViewKinds: readonly ViewKind[] = ORDERED_VIEW_KINDS,
): { payload: ConsistencyReportPayload; hash: string } {
  const required = [...requiredViewKinds];
  const viewKinds = new Set(views.map((v) => v.viewKind));
  const hasAllViews = views.length === required.length
    && viewKinds.size === required.length
    && required.every((kind) => viewKinds.has(kind));
  const dimensionsValid = views.every((view) => view.widthPx >= MIN_REFERENCE_DIMENSION_PX && view.heightPx >= MIN_REFERENCE_DIMENSION_PX);
  const isFrontOnly = required.length === 1 && required[0] === "front";

  let scaleConfidence: ScaleConfidence = "unknown";
  if (declaredScale) scaleConfidence = "declared";

  const metrics = [
    {
      name: "Required View Coverage",
      status: (hasAllViews ? "pass" : "fail") as ReportStatus,
      score: hasAllViews ? 1 : 0,
      details: hasAllViews
        ? isFrontOnly
          ? "The uploaded front reference is present; no additional views were synthesized."
          : "The uploaded front and all three generated views are present."
        : "One or more provider-required view kinds are missing or duplicated.",
    },
    {
      name: "Decoded Image Resolution",
      status: (dimensionsValid ? "pass" : "fail") as ReportStatus,
      score: dimensionsValid ? 1 : 0,
      details: dimensionsValid ? `Every image decodes at or above ${MIN_REFERENCE_DIMENSION_PX}x${MIN_REFERENCE_DIMENSION_PX} pixels.` : "At least one image is below the minimum decoded resolution.",
    },
    {
      name: isFrontOnly ? "Subject Identity Review" : "Cross-View Identity Review",
      status: "warn" as ReportStatus,
      score: 0,
      details: isFrontOnly
        ? "Identity, anatomy, markings, and framing require human approval of the uploaded front image."
        : "Identity, anatomy, markings, and framing require human approval; no automated visual evaluator has verified them.",
    },
  ];

  const payload: ConsistencyReportPayload = {
    status: hasAllViews && dimensionsValid ? "warn" : "fail",
    scaleConfidence,
    summaryNote: isFrontOnly
      ? "One uploaded front reference was canonicalized without synthesizing additional views. Customer approval accepts that exact image as the build reference."
      : inputMode === "photo"
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
