# Builder and Collar Production Repair Plan

**Goal:** Stop malformed pet builds from being auto-labeled successful, restore reliable reference-image generation, and activate collar ordering only after the complete production chain proves ready.

## 1. Lock the observed regressions with tests

- Add coverage for Blender engine fallback and the correct camera-up convention.
- Add coverage that customer review pauses polling and that paid model stages cannot auto-advance before exact-artifact approval.
- Add coverage for normalized, runtime Layer8 configuration.
- Restore coverage for the explicit body-rig availability flag.

## 2. Repair the model and image builders

- Make the Blender review renderer select an engine supported by the running Blender version.
- Correct the standard-view camera orientation in both render and texture-rebake jobs.
- Retry one no-image Gemini response with a smaller, image-only request while keeping calls bounded.
- Keep the existing workspace layout and expose the existing exact-artifact approval action in the current build panel.
- Default new builds to the HD profile while retaining SmartMesh as an explicit choice.

## 3. Restore fail-closed paid-stage behavior

- Save generated references without starting a paid stage.
- Require the customer to approve the exact reference or model artifact before the next paid stage is queued.
- Stop background polling while a stage awaits review.
- Honor the explicit production body-rig flag.

## 4. Repair collar readiness and deploy safely

- Normalize Layer8 configuration at request time and verify the live Layer8 and Blender dependencies.
- Deploy the code repair before enabling the production collar flag.
- Enable the collar flag only if authenticated health reports no blockers.
- Run a no-charge readiness check and verify the live UI; do not submit a paid collar job without an explicit customer order.

## 5. Verify and release

- Run the targeted tests, the repository verification suite, a Node 24 production build, and the Blender render smoke test against the supplied GLB.
- Commit and push the repair, verify the deployed commit and fresh authenticated health, then report PASS/FAIL/BLOCKED separately for model building, image generation, and collar activation.
