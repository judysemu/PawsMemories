---
name: visual-adherence-gate
description: Implement or review pre-build evidence checks, fixed Blender draft renders, Gemini visual comparison, threshold decisions, human approval, correction feedback, and evaluation records. Use whenever a generated 3D asset may be finalized, published, charged, rigged, or manufactured based on visual similarity.
---

# Visual Adherence Gate

Read the architecture and SPAT-004. Apply SPAT-006 to render/export behavior.

## Two Independent Gates

1. **Numerical gate:** dimensions, bounds, units, attachment clearance, topology, and
   manufacturing metrics from deterministic code.
2. **Visual gate:** Gemini comparison plus explicit human approval of the exact draft.

Neither gate substitutes for the other. A visually similar model may be the wrong
size; a dimensionally correct model may omit identity-defining features.

## Pre-Build Stop

- Validate full image decode and canonical ownership before model calls.
- Require one scale anchor for image-based generation.
- Record occlusions, ambiguous views, conflicting references, and confidence.
- Stop before billing/build when subject identity, coverage, or scale evidence is
  insufficient.

## Draft Render Contract

Render front, right, back, left, and three-quarter views with fixed:

- camera orientation and focal length
- framing and safe margins
- neutral background
- color management and lighting
- resolution and file format

Detect blank, clipped, transparent, tiny, corrupt, or duplicate renders before
Gemini. Store each render privately with role and hash.

## Gemini Report

Use strict bounded JSON and temperature 0.1. Scores:

- silhouette >= 0.88
- proportion >= 0.90
- feature presence >= 0.90
- view consistency >= 0.92

Automated pass requires every threshold and zero critical issues. Scores are
advisory evidence; they never finalize an asset.

Critical issues include missing major feature, gross proportion error, contradictory
views, clipping/render failure, or attachment-interface mismatch.

## Human Stop

The review UI must pair references and draft views, show target/measured dimensions,
show automated issues, and offer only:

- Approve draft
- Request correction

Approval includes job, current attempt hash, and report hash. The server locks and
rechecks all three. Stale, replayed, foreign, fabricated, or failed-report approval
returns conflict/forbidden and triggers no finalization.

Correction requires at least one tag: proportions, missing feature, placement,
thickness, material, attachment fit, or other. `other` requires a comment. Cap at
three attempts.

## Feedback Is Not Training

Store immutable review/evaluation evidence. Do not automatically fine-tune, retrieve
unreviewed comments into later user jobs, or treat approval as objective ground truth.

Before training, require consent/license review, de-identification, human cause
labels, identity-grouped train/test split, and a frozen evaluation set.

## Tests

- Every below-threshold metric and critical issue blocks approval.
- Missing/duplicate/corrupt views block Gemini.
- Old attempt/report hash cannot approve rebuilt output.
- Cross-owner review is forbidden.
- Correction creates a new immutable attempt and preserves the previous one.
- Fourth correction is rejected/manual-CAD state.
- No charge/final export/publication occurs before both gates.
- Mobile layout exposes complete views and controls at 320/360/390/430 px.

## Owner Review Guidance

Ask the owner to compare silhouette and attachment points first, then dimensions,
thickness, details, and materials. Capture one concrete correction sentence; do not
ask the owner to explain machine learning or write model prompts.
