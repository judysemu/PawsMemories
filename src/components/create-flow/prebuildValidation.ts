export interface PrebuildValidationInput {
  candidateImageUrl?: string;
  pose?: string;
  engraving?: string;
}

export interface PrebuildValidationResult {
  rule: string;
  pass: boolean;
  detail: string;
}

/** Exact UI-input identity. This is a change detector, not a security hash. */
export function buildPrebuildValidationFingerprint(input: PrebuildValidationInput): string {
  return JSON.stringify([
    input.candidateImageUrl || "",
    input.pose || "",
    input.engraving || "",
  ]);
}

/**
 * These are pre-build eligibility checks only. They intentionally do not claim
 * wall-thickness, overhang, manifold, support, or stability measurements; those
 * require the generated mesh and the post-build validators.
 */
export function evaluatePrebuildValidation(input: PrebuildValidationInput): {
  passed: boolean;
  checks: PrebuildValidationResult[];
} {
  const checks: PrebuildValidationResult[] = [];

  checks.push(input.candidateImageUrl
    ? { rule: "Approved Reference", pass: true, detail: "An approved visual reference is ready for the build." }
    : { rule: "Approved Reference", pass: false, detail: "Approve a visual reference before starting the build." });

  checks.push(input.pose === "Standing"
    ? { rule: "Pose Plan", pass: true, detail: "Standing pose selected; the build will include a base plan for later mesh validation." }
    : { rule: "Pose Plan", pass: true, detail: "Pose selection recorded for the build. Physical support is checked after the mesh exists." });

  if (input.engraving) {
    checks.push(input.engraving.length > 24
      ? { rule: "Engraving Text", pass: false, detail: "Engraving must be 24 characters or fewer." }
      : { rule: "Engraving Text", pass: true, detail: "Engraving length is within the pre-build limit." });
  }

  return { passed: checks.every((check) => check.pass), checks };
}
