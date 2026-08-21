import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Regression cover for the rig_check failure of 2026-08-21.
//
// Tripo's rig endpoints take the task id of a 3D GENERATION task. After a
// texture stage a chained record's own handle is a `texture_model` handle,
// which Tripo rejects, so tripoAdapter carries the originating base handle
// down the chain and rigSourceHandle() submits that instead.
//
// That carry was implemented in the adapter but had nowhere to live: the
// column did not exist, the INSERT did not write it, and the SELECT did not
// read it. The value was computed and discarded on every chained job, so
// rigSourceHandle() threw for every order that purchased a texture and the
// stage failed as PROVIDER_START_FAILED with no detail.
//
// These assert the persistence path specifically, because the adapter logic
// was already correct and still produced the failure.

const store = fs.readFileSync("server/pet-generation/jobStore.ts", "utf8");
const runner = fs.readFileSync("server/migrations/runner.ts", "utf8");
const adapter = fs.readFileSync("server/pet-generation/tripoAdapter.ts", "utf8");

test("the schema has somewhere to put the originating base handle", () => {
  assert.match(runner, /ADD COLUMN base_model_task_handle/,
    "without the column the adapter's carry is discarded on write");
});

test("the insert writes it", () => {
  const putBody = store.slice(store.indexOf("async put("), store.indexOf("async get("));
  assert.match(putBody, /base_model_task_handle/,
    "an INSERT that omits the column silently drops the value");
  const columns = /INSERT INTO provider_generation_jobs\s*\(([^)]*)\)/s.exec(putBody);
  const values = /VALUES \(([^)]*)\)/.exec(putBody);
  assert.ok(columns && values, "insert shape should be readable");
  const columnCount = columns[1].split(",").length;
  const placeholderCount = values[1].split(",").filter((v) => v.trim() === "?").length;
  // NOW(), NOW() supply created_at and updated_at, so placeholders trail by two.
  assert.equal(placeholderCount, columnCount - 2,
    "column count and placeholder count must agree or the insert binds the wrong values");
});

test("the select reads it back and maps it onto the record", () => {
  const getBody = store.slice(store.indexOf("async get("), store.indexOf("async update("));
  assert.match(getBody, /SELECT[\s\S]*base_model_task_handle/,
    "a column that is written but never selected is still invisible to the adapter");
  assert.match(getBody, /baseModelTaskHandle:\s*r\.base_model_task_handle/,
    "the row must be mapped onto the field rigSourceHandle reads");
});

test("existing base rows are backfilled, chained rows are not invented", () => {
  // A base job is its own base handle, so that much is recoverable. A chained
  // row written before the fix never persisted its originating handle, and
  // guessing one would rig from the wrong Tripo task.
  assert.match(runner, /UPDATE provider_generation_jobs[\s\S]*base_model_task_handle = provider_task_handle[\s\S]*stage = 'base'/,
    "base rows should become self-consistent");
  assert.doesNotMatch(runner, /base_model_task_handle = provider_task_handle\s*WHERE stage = 'texture'/,
    "a texture handle must never be backfilled as a base handle");
});

test("the adapter still refuses to rig from a chained task with no base handle", () => {
  // Failing loudly is correct here: submitting a texture_model handle would be
  // rejected by Tripo anyway, and silently substituting one would rig the
  // wrong asset.
  assert.match(adapter, /Cannot start a rig stage from a \$\{source\.stage\} task without the originating base model task handle/);
});
