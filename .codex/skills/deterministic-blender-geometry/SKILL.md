---
name: deterministic-blender-geometry
description: Safely compile validated declarative spatial plans into Blender 5.1 geometry and verify draft/final GLB or STL outputs. Use for primitive allowlists, units, booleans, modifiers, serialized worker execution, scene isolation, bounds/topology checks, render fixtures, exact export reopening, and manufacturing validation.
---

# Deterministic Blender Geometry

Read the architecture and SPAT-004. Apply SPAT-005 for review renders.

## Non-Negotiable Boundary

Never execute Python, shell, paths, URLs, imports, drivers, expressions, or node code
returned by Gemini, GPT, Gemma, or the browser. Models return declarative JSON only.
Static application templates compile validated operations into Blender commands.

## Allowed Version 1 Operations

- box, cylinder, UV sphere, cone, torus, capsule
- additive/subtractive boolean in stable declared order
- bounded bevel
- one-axis mirror
- bounded curve sweep
- bounded array
- allowlisted material color/properties

Reject unknown shapes/modifiers/fields. Enforce architecture limits for primitives,
booleans, vertices, coordinates, dimensions, rotations, wall thickness, and output
size before worker execution.

## Units And Coordinates

- Authoritative contract uses millimeters.
- Convert to Blender meters exactly once at the compiler boundary.
- Record up-axis, handedness, origin, envelope, and transform policy.
- Apply/normalize transforms before bounds and export.
- Compare expected and actual world bounds; fail beyond 0.5 mm or 0.5 percent,
  whichever is larger.

## Worker Execution

- Require `WORKER_SHARED_SECRET` on every endpoint.
- Serialize the complete draft/final operation; do not interleave shared scene calls.
- Start from a clean scene and verify it is empty before creation.
- Use deterministic names containing no user prompt text.
- Capture stdout/stderr internally but expose only stable errors.
- Clear temporary objects/files on success and failure.
- Enforce request, script/program, response, GLB, render, and duration limits.

## Boolean And Modifier Safety

- Preserve plan order in the program hash.
- Apply subtractive objects only after their source geometry exists.
- Verify modifier application succeeded and temporary cutters are removed.
- Recalculate normals and reject non-finite/non-manifold output according to target
  use.
- Avoid context-sensitive Blender operators where data API equivalents are safer.
- Follow existing Blender 5.1 background-safe conventions; do not reintroduce removed
  animation/light/context APIs.

## Draft Versus Final

Draft uses review topology/materials and produces private GLB plus five fixed renders.
Finalization rebuilds from the accepted plan/math/program hashes; it does not mutate
the draft manually.

Final GLB must be reopened and remeasured. Print STL must use the repository's exact
export repair/validation contract and validate the final bytes, not the pre-export
scene.

## Reports

Return strict measured evidence:

- compiler/program version and hash
- object/mesh/vertex/face counts
- expected and actual world bounds
- finite transforms and unit metadata
- modifier/boolean outcomes
- manifold, watertight, component, edge, thickness, and volume metrics as applicable
- render roles/hashes
- export size/hash and reopen result

Never report fabricated capability, topology, or manufacturing success.

## Tests

- Golden compile output for each primitive/modifier.
- Injection strings remain inert data or are rejected.
- Unit conversion and rotated bounds fixtures.
- Boolean order determinism.
- Shared-scene/concurrency isolation.
- Empty/clipped/oversize/non-finite/non-manifold failure fixtures.
- GLB exact reopen and STL exact-byte validation.
- Worker auth and response-size/time limits.
- Zero Blender calls when upstream schemas/math/hashes fail.

## Exit

Ten known-dimension accessory fixtures must remain within tolerance through compile,
Blender build, GLB reopen, and optional STL validation. Record Render/Blender version
and actual fixture artifacts; local mocks are insufficient for production approval.
