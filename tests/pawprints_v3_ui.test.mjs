import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  ANNOTATED_SAMPLE_PROMPT,
  PLAIN_SAMPLE_PROMPT,
  IDEA_CHIPS,
  OCCASION_PRESETS,
  PERSONAL_TEXT_MAX_LENGTH,
  composeSamplePrompt,
} from "../shared/pawprintCatalog2.ts";

const panel = fs.readFileSync("src/components/pawprints/PromptTeachingPanel.tsx", "utf8");
const field = fs.readFileSync("src/components/pawprints/PersonalTextField.tsx", "utf8");
const step = fs.readFileSync("src/components/pawprints/CustomPromptStep.tsx", "utf8");
const studio = fs.readFileSync("src/components/PawprintsStudio.tsx", "utf8");
const envExample = fs.readFileSync(".env.example", "utf8");

test("the annotated sample explains every section it shows", () => {
  assert.ok(ANNOTATED_SAMPLE_PROMPT.sections.length >= 4);
  for (const section of ANNOTATED_SAMPLE_PROMPT.sections) {
    assert.ok(section.label.trim(), "section needs a label");
    assert.ok(section.text.trim(), `${section.id} needs prompt text`);
    assert.ok(section.explanation.trim().length > 20, `${section.id} needs a real explanation`);
  }
});

test("there are two samples: one dissected, one whole", () => {
  assert.ok(composeSamplePrompt(ANNOTATED_SAMPLE_PROMPT).length > 60);
  assert.ok(PLAIN_SAMPLE_PROMPT.length > 60);
  assert.notEqual(composeSamplePrompt(ANNOTATED_SAMPLE_PROMPT), PLAIN_SAMPLE_PROMPT);
});

test("the four requested idea categories are all present", () => {
  const ids = IDEA_CHIPS.map((chip) => chip.id);
  for (const required of ["famous_location", "historical_figure", "occupation", "holiday"]) {
    assert.ok(ids.includes(required), `missing idea chip: ${required}`);
  }
  for (const chip of IDEA_CHIPS) assert.ok(chip.seed.length > 20, `${chip.id} needs a usable seed`);
});

test("the six requested occasions are all present", () => {
  const ids = OCCASION_PRESETS.map((preset) => preset.id);
  for (const required of ["birthday", "framed", "holiday", "congrats", "get_well", "missing_you"]) {
    assert.ok(ids.includes(required), `missing occasion: ${required}`);
  }
});

test("the teaching UI is behind a flag that is off unless explicitly enabled", () => {
  assert.match(panel, /VITE_PAWPRINTS_V3_UI === "true"/);
  assert.match(envExample, /VITE_PAWPRINTS_V3_UI="false"/);
});

test("v2 remains intact when the flag is off", () => {
  // The old Story-format panel must still render on the else branch.
  assert.match(step, /STORY_PROMPT_TEMPLATE/);
  assert.match(step, /isPawprintsV3UiEnabled/);
});

test("seeding a prompt never destroys text the customer already typed", () => {
  const seed = step.slice(step.indexOf("const seedPrompt"));
  const body = seed.slice(0, seed.indexOf("};"));
  assert.match(body, /current \?/, "must append when a prompt already exists");
  assert.match(body, /CUSTOM_PROMPT_MAX_LENGTH/, "must respect the length cap");
});

test("choosing an occasion does not overwrite a typed message", () => {
  assert.match(field, /if \(!value\.trim\(\)\) onChange\(defaultText\)/);
  // Re-tapping the active occasion clears it.
  assert.match(field, /occasionId === id/);
});

test("the caption is folded into the prompt verbatim, with no backend change", () => {
  assert.match(studio, /Render the exact text/);
  assert.match(studio, /effectivePrompt/);
  assert.match(studio, /customPrompt=\{effectivePrompt\}/);
});

test("the caption is length-capped on the client", () => {
  assert.ok(PERSONAL_TEXT_MAX_LENGTH > 0 && PERSONAL_TEXT_MAX_LENGTH <= 200);
  assert.match(field, /maxLength=\{PERSONAL_TEXT_MAX_LENGTH\}/);
});
