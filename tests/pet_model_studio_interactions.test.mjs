import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const studio = await readFile(new URL("../src/components/PetModelStudio.tsx", import.meta.url), "utf8");
const studioModule = await import("../src/components/PetModelStudio.tsx");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const printShop = await readFile(new URL("../src/components/PrintShopScreen.tsx", import.meta.url), "utf8");

test("model generation owns a visible busy state before reference generation starts", () => {
  const start = studio.indexOf("const start = async () =>");
  const busy = studio.indexOf("setBusy(true)", start);
  const generation = studio.indexOf("startReferenceAttempt(", start);
  assert.ok(start >= 0 && busy > start && generation > busy);
  assert.match(studio, /Generating left, right, and rear views/);
  assert.match(studio, /aria-live="polite"/);
});

test("every uploaded model reference can be removed", () => {
  assert.match(studio, /const removeReference = \(key: string\)/);
  assert.match(studio, /aria-label=\{`Remove \$\{label\} image`\}/);
  assert.match(studio, /delete next\[key\]/);
});

test("sidebar Pawprints uses the pawprint icon instead of the question-mark fallback", () => {
  assert.match(app, /pawprints:\s*PawPrint/);
});

test("printed examples live in the print shop while the builder introduces collars", () => {
  assert.doesNotMatch(studio, /PrintGallery|PRINT_EXAMPLES/);
  assert.match(studio, /Custom-fit collars/);
  assert.match(printShop, /const PRINT_EXAMPLES/);
  assert.match(printShop, /Printed examples/);
});

test("body rigging is selectable without texture and facial blendshapes stay separate", () => {
  assert.match(studio, /Animation-ready body rig · \{product\.prices\.rig\} PupCoins/);
  assert.doesNotMatch(studio, /checked=\{includeRig\}\s+disabled=\{!includeTexture\}/);
  assert.doesNotMatch(studio, /setIncludeRig\(false\)/);
  assert.match(studio, /Facial blendshapes are separate from the body\/skeletal rig above/i);
});

test("collar submission stays disabled until the production worker chain is ready", () => {
  assert.match(studio, /fetchCollarReadiness\(\)/);
  assert.match(studio, /collarReadiness\?\.ready !== true/);
  assert.match(studio, /disabled=\{busy \|\| collarReadiness\?\.ready !== true\}/);
  assert.match(studio, /disabled before any PupCoins can be charged/i);
});

test("collar build revalidates readiness and never submits from a stale green state", async () => {
  const runReadyCollarBuild = studioModule.runReadyCollarBuild;
  assert.equal(typeof runReadyCollarBuild, "function");

  let submitCalls = 0;
  const result = await runReadyCollarBuild(
    async () => {
      submitCalls += 1;
      return { jobUuid: "must-not-be-created" };
    },
    async (path) => {
      assert.equal(path, "/api/spatial-generator/health");
      return new Response(JSON.stringify({
        ready: false,
        featureEnabled: true,
        layer8Configured: true,
        pixelWorkerOnline: false,
        blenderWorkerHealthy: false,
        orchestratorReady: false,
        blockers: ["pixel_worker", "blender_worker", "orchestrator"],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  assert.deepEqual(result, {
    status: "unready",
    readiness: {
      ready: false,
      blockers: ["pixel_worker", "blender_worker", "orchestrator"],
    },
  });
  assert.equal(submitCalls, 0);
});

test("collar build clears readiness when submission reports a stale 503", async () => {
  const runReadyCollarBuild = studioModule.runReadyCollarBuild;
  assert.equal(typeof runReadyCollarBuild, "function");

  const staleError = Object.assign(new Error("Spatial generation is temporarily unavailable."), {
    status: 503,
    code: "SPATIAL_PIPELINE_NOT_READY",
  });
  const result = await runReadyCollarBuild(
    async () => {
      throw staleError;
    },
    async () => new Response(JSON.stringify({
      ready: true,
      featureEnabled: true,
      layer8Configured: true,
      pixelWorkerOnline: true,
      blenderWorkerHealthy: true,
      orchestratorReady: true,
      blockers: [],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );

  assert.deepEqual(result, {
    status: "stale",
    readiness: {
      ready: false,
      blockers: ["readiness_stale"],
    },
  });
});
