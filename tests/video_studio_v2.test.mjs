import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  ANNOTATED_VIDEO_SAMPLE_8S, ANNOTATED_VIDEO_SAMPLE_15S,
  PLAIN_VIDEO_SAMPLE_8S, PLAIN_VIDEO_SAMPLE_15S,
  VIDEO_IDEA_CHIPS, VIDEO_DURATION_NOTES,
  annotatedVideoSampleFor, plainVideoSampleFor,
} from "../src/aiVideoScripts.ts";

const panel = fs.readFileSync("src/components/video/VideoTeachingPanel.tsx", "utf8");
const studio = fs.readFileSync("src/components/AnimationStudio.tsx", "utf8");
const envExample = fs.readFileSync(".env.example", "utf8");

test("both durations get an annotated sample and a plain one", () => {
  assert.equal(annotatedVideoSampleFor(8).id, ANNOTATED_VIDEO_SAMPLE_8S.id);
  assert.equal(annotatedVideoSampleFor(15).id, ANNOTATED_VIDEO_SAMPLE_15S.id);
  assert.equal(plainVideoSampleFor(8), PLAIN_VIDEO_SAMPLE_8S);
  assert.equal(plainVideoSampleFor(15), PLAIN_VIDEO_SAMPLE_15S);
  assert.notEqual(PLAIN_VIDEO_SAMPLE_8S, PLAIN_VIDEO_SAMPLE_15S);
});

test("the annotated sections ARE the script schema fields", () => {
  // If these drift from AiVideoScriptTemplate the panel stops explaining the
  // form the customer is actually filling in.
  const expected = ["setting", "characters", "motions", "stageDirections", "lighting", "filter", "camera"];
  for (const sample of [ANNOTATED_VIDEO_SAMPLE_8S, ANNOTATED_VIDEO_SAMPLE_15S]) {
    assert.deepEqual(sample.sections.map((s) => s.id), expected, `${sample.id} section ids`);
  }
});

test("every section carries a real explanation", () => {
  for (const sample of [ANNOTATED_VIDEO_SAMPLE_8S, ANNOTATED_VIDEO_SAMPLE_15S]) {
    for (const section of sample.sections) {
      assert.ok(section.text.trim(), `${sample.id}/${section.id} text`);
      assert.ok(section.explanation.trim().length > 20, `${sample.id}/${section.id} explanation`);
    }
  }
});

test("the annotated beats split cleanly into the four the form holds", () => {
  for (const sample of [ANNOTATED_VIDEO_SAMPLE_8S, ANNOTATED_VIDEO_SAMPLE_15S]) {
    const beats = sample.sections.find((s) => s.id === "stageDirections").text
      .split("→").map((b) => b.trim()).filter(Boolean);
    assert.equal(beats.length, 4, `${sample.id} must yield exactly 4 beats`);
  }
});

test("the four requested idea categories are present and set both fields", () => {
  const ids = VIDEO_IDEA_CHIPS.map((c) => c.id);
  for (const required of ["famous_location", "historical_figure", "occupation", "holiday"]) {
    assert.ok(ids.includes(required), `missing ${required}`);
  }
  for (const chip of VIDEO_IDEA_CHIPS) {
    assert.ok(chip.setting.length > 20, `${chip.id} setting`);
    assert.ok(chip.characters.length > 20, `${chip.id} characters`);
  }
});

test("the duration picker explains the trade honestly", () => {
  assert.match(VIDEO_DURATION_NOTES[8].detail, /Veo 3/);
  assert.match(VIDEO_DURATION_NOTES[8].detail, /audio/i);
  assert.match(VIDEO_DURATION_NOTES[15].detail, /Kling/);
});

test("an idea chip does not clobber lighting, camera or beats", () => {
  const fn = studio.slice(studio.indexOf("const applyTeachingIdea"));
  const body = fn.slice(0, fn.indexOf("\n  };"));
  assert.match(body, /setting: idea\.setting, characters: idea\.characters/);
  for (const field of ["lighting", "camera", "stageDirections", "filter"]) {
    assert.doesNotMatch(body, new RegExp(`${field}:`), `chip must not touch ${field}`);
  }
});

test("applying a sample preserves any field the sample omits", () => {
  const fn = studio.slice(studio.indexOf("const applyTeachingSample"));
  const body = fn.slice(0, fn.indexOf("\n  };"));
  // Every mapped field falls back to the current value.
  for (const field of ["setting", "characters", "motions", "lighting", "filter", "camera"]) {
    assert.match(body, new RegExp(`${field}: byId\\.${field} \\?\\? current\\.${field}`), field);
  }
  // A malformed beat list leaves the existing beats alone rather than truncating.
  assert.match(body, /beats\.length === 4[\s\S]*: current\.stageDirections/);
});

test("the panel follows the selected duration", () => {
  assert.match(studio, /durationSeconds=\{duration\}/);
  assert.match(panel, /annotatedVideoSampleFor\(durationSeconds\)/);
  assert.match(panel, /plainVideoSampleFor\(durationSeconds\)/);
});

test("v2 is dark by default and v1 is untouched when off", () => {
  assert.match(panel, /VITE_VIDEO_STUDIO_V2 === "true"/);
  assert.match(envExample, /VITE_VIDEO_STUDIO_V2="false"/);
  assert.match(studio, /isVideoStudioV2Enabled\(\) && \(/);
  // The original template dropdown still exists.
  assert.match(studio, /AI_VIDEO_SCRIPTS\.map/);
});
