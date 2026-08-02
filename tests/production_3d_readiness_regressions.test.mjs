import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("legacy presigned reference URLs recover only owned reference object keys", async () => {
  const { privateReferenceObjectKey } = await import("../server/assets/privateObjectReference.ts");
  const url = "https://s3.example.test/pawsmemories-private/references/session/front.jpg?X-Amz-Signature=secret";
  assert.equal(
    privateReferenceObjectKey(url, "pawsmemories-private"),
    "references/session/front.jpg",
  );
  assert.equal(privateReferenceObjectKey("asset://private/version/1", "pawsmemories-private"), null);
  assert.equal(privateReferenceObjectKey("https://s3.example.test/private/models/pet.glb", "pawsmemories-private"), null);
});

test("Studio binds orders to durable reference sessions and never treats signed URLs as canonical", () => {
  const studio = read("src/components/PetModelStudio.tsx");
  const service = read("server/pet-generation/service.ts");
  const wiring = read("server/pet-generation/wiring.ts");
  const repository = read("server/pet-generation/stageRepository.ts");

  assert.match(studio, /referenceSessionUuid:\s*session\.sessionUuid/);
  assert.match(service, /persistedManifest = resolved\.durableManifest/);
  assert.match(service, /return resolved\.signedManifest/);
  assert.match(wiring, /asset:\/\/\$\{asset\.asset_uuid\}\/versions\/\$\{version\.version_number\}/);
  assert.match(repository, /reference_session_id = COALESCE/);
});

test("an unrefreshable legacy capability URL is never returned as a poster", async () => {
  const { containsEphemeralReferenceUrl } = await import("../server/pet-generation/service.ts");
  assert.equal(containsEphemeralReferenceUrl({
    frontUrl: "https://s3.example.test/references/front.jpg?X-Amz-Signature=expired",
  }), true);
  assert.equal(containsEphemeralReferenceUrl({
    frontUrl: "https://static.example.test/references/front.jpg",
  }), false);

  const service = read("server/pet-generation/service.ts");
  assert.match(service, /referenceManifest:\s*referenceManifest[\s\S]*?: null/);
  assert.match(service, /containsEphemeralReferenceUrl\(order\.referenceManifest\)/);
});

test("Fur Bin cards remain static even when a poster is unavailable", () => {
  const experience = read("src/components/fur-bin-v5/FurBinV5Experience.tsx");
  const preview = experience.slice(
    experience.indexOf("function Preview"),
    experience.indexOf("function ItemCard"),
  );
  assert.match(preview, /if \(detail && item\.signedViewUrl\)/);
  assert.match(preview, /thumbnail=\{false\}/);
  assert.doesNotMatch(preview, /if \(item\.signedViewUrl\)/);
  assert.match(preview, /Open to view in 3D/);
});

test("clean sign-up is a public deep link and authenticated users do not remain there", () => {
  const app = read("src/App.tsx");
  const publicScreens = app.slice(
    app.indexOf("const PUBLIC_SCREENS"),
    app.indexOf("const getBackgroundImage"),
  );
  assert.match(publicScreens, /Screen\.SIGN_UP/);
  assert.match(app, /restoredScreen === Screen\.SIGN_UP \? Screen\.DASHBOARD/);
});

test("the delivered-model viewer uses the verified Tripo front axis and safe framing", () => {
  const viewer = read("src/components/PetModelViewer.tsx");
  assert.match(viewer, /const FRONT_ORBIT = "90deg 80deg 120%"/);
  assert.match(viewer, /camera-orbit=\{FRONT_ORBIT\}/);
  assert.match(viewer, /interaction-prompt="none"/);
});

test("rig approval requires explicit multi-angle deformation review", () => {
  const studio = read("src/components/PetModelStudio.tsx");
  const repository = read("server/pet-generation/stageRepository.ts");
  const contracts = read("server/pet-generation/contracts.ts");
  assert.match(studio, /No limb is bent, splayed, detached, or clipping through the body/);
  assert.match(studio, /visualReviewConfirmed: stage\.stage === "rig"/);
  assert.match(repository, /current\.stage === "rig" && approval\.visualReviewConfirmed !== true/);
  assert.match(contracts, /visualReviewConfirmed: z\.boolean\(\)/);
});

test("Blender bridge keeps health responsive and allows bounded long renders", () => {
  const bridge = read("blender-worker/bridge/tcp_server.py");
  const worker = read("blender-worker/server.js");
  assert.match(bridge, /BLENDER_BRIDGE_DISPATCH_TIMEOUT_SECONDS/);
  assert.match(bridge, /dispatch_cached_ping\(request\) if method == "ping"/);
  assert.match(worker, /BLENDER_RENDER_VIEWS_TIMEOUT_MS/);
  assert.match(worker, /if \(renderViewsActive\)/);
  assert.match(worker, /res\.status\(429\)/);
});
