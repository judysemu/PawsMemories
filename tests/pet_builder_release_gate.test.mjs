import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const service = await readFile(new URL("../server/pet-generation/service.ts", import.meta.url), "utf8");
const routes = await readFile(new URL("../server/pet-generation/routes.ts", import.meta.url), "utf8");
const studio = await readFile(new URL("../src/components/PetModelStudio.tsx", import.meta.url), "utf8");

test("saving generated references pauses before the first paid stage", () => {
  const method = service.slice(
    service.indexOf("async submitReferenceManifest"),
    service.indexOf("async approveCustomerStage"),
  );
  assert.doesNotMatch(method, /approveCustomerStage/);
  assert.match(method, /buildView/);
});

test("exact-artifact customer approval endpoint remains live", () => {
  const approveRoute = routes.slice(
    routes.indexOf('router.post("/orders/:orderUuid/stages/:stage/approve"'),
    routes.indexOf('router.post("/orders/:orderUuid/stages/:stage/reject"'),
  );
  assert.match(approveRoute, /StageApprovalSchema\.safeParse/);
  assert.match(approveRoute, /approveCustomerStage/);
  assert.doesNotMatch(approveRoute, /CUSTOMER_APPROVAL_RETIRED/);
});

test("current studio keeps its layout but exposes approval and defaults new quality builds to HD", () => {
  assert.match(studio, /useState<MeshProfile>\("hd"\)/);
  assert.match(studio, /Approve (?:generated views|this model|and continue)/);
  assert.match(studio, /approveCustomerStage|\/approve/);
});
