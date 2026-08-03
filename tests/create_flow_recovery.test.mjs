import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  buildPrebuildValidationFingerprint,
  evaluatePrebuildValidation,
} from "../src/components/create-flow/prebuildValidation.ts";

const read = (relative) => fs.readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("pre-build validation is deterministic and truthfully limited to known inputs", () => {
  const input = {
    candidateImageUrl: "https://assets.example.test/reference.png",
    pose: "Standing",
    engraving: "Always loved",
  };
  const first = evaluatePrebuildValidation(input);
  const second = evaluatePrebuildValidation({ ...input });
  assert.deepEqual(first, second);
  assert.equal(first.passed, true);
  assert.equal(buildPrebuildValidationFingerprint(input), buildPrebuildValidationFingerprint({ ...input }));
  assert.equal(
    buildPrebuildValidationFingerprint(input),
    buildPrebuildValidationFingerprint({ ...input, unrelatedRenderState: "ignored" }),
  );
  assert.equal(evaluatePrebuildValidation({ ...input, engraving: "x".repeat(25) }).passed, false);
  assert.ok(first.checks.every((check) => !/wall thickness|overhang|mesh analysis/i.test(check.detail)));
});

test("reference replacement resets only source allowance while preserving monotonic history", async () => {
  const [types, repository, service, migrations] = await Promise.all([
    read("server/reference-sessions/types.ts"),
    read("server/reference-sessions/repository.ts"),
    read("server/reference-sessions/service.ts"),
    read("server/migrations/runner.ts"),
  ]);

  assert.match(types, /source_attempt_count: number/);
  assert.match(repository, /approved_attempt_id = NULL/);
  assert.match(repository, /source_attempt_count = 0/);
  assert.match(service, /session\.source_attempt_count >= maxAttempts/);
  assert.match(service, /nextAttemptNumber = session\.retry_count \+ 1/);
  assert.match(service, /incrementSourceAttempt: true/);
  assert.match(service, /Replace the source photo or create a new session/);
  assert.match(migrations, /version: 41/);
  assert.match(migrations, /reference_source_attempt_allowance/);
});

test("Create validation effect fingerprints meaningful inputs instead of depending on mutable flow state", async () => {
  const source = await read("src/components/create-flow/CreateValidateScreen.tsx");
  assert.match(source, /buildPrebuildValidationFingerprint/);
  assert.match(source, /evaluatePrebuildValidation/);
  assert.doesNotMatch(source, /\}, \[state, setState\]\)/);
  assert.match(source, /Final mesh and print checks run after the model is built/);
  assert.doesNotMatch(source, /Checking overhangs, wall thickness/);
});

test("rig polling is sequential, paced after settlement, and insulated from callback identities", async () => {
  const [progress, context] = await Promise.all([
    read("src/components/create-flow/CreateRigProgressScreen.tsx"),
    read("src/components/create-flow/CreateFlowContext.tsx"),
  ]);
  assert.doesNotMatch(progress, /setInterval\(/);
  assert.match(progress, /setTimeout\([^,]+, 2500\)/s);
  assert.match(progress, /navigateRef/);
  assert.match(progress, /setRigJobRef/);
  assert.match(progress, /\}, \[rigJobUuid\]\)/);
  assert.match(context, /useCallback/);
  assert.match(context, /useMemo/);
});

test("credit recovery and reference retry preserve the current Create branch", async () => {
  const [checkout, reference] = await Promise.all([
    read("src/components/create-flow/CreateCheckoutScreen.tsx"),
    read("src/components/create-flow/CreateReferenceScreen.tsx"),
  ]);
  assert.match(checkout, /onClick=\{\(\) => onNavigate\(Screen\.STORE\)\}/);
  assert.match(reference, /automaticStartRef/);
  assert.match(reference, /multiviewSessionUuid \? handleMultiviewRetry\(\) : initMultiviewSession\(\)/);
  assert.match(reference, /Replace Source Photo/);
  assert.match(reference, /approveReferenceManifest\(multiviewSessionUuid, manifestHash\)/);
  assert.match(reference, /Generating Three Additional Views/);
});
