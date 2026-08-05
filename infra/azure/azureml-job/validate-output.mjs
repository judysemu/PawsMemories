#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { validatePetGlbStage } from "../../../server/pet-generation/validation.ts";

const { values } = parseArgs({
  options: {
    directory: { type: "string" },
    "repository-revision": { type: "string" },
  },
  strict: true,
});
if (!values.directory || !/^[0-9a-f]{40}$/.test(values["repository-revision"] || "")) {
  throw new Error("--directory and a full --repository-revision are required");
}
const directory = path.resolve(values.directory);
const finalPath = path.join(directory, "final.glb");
const acceptancePath = path.join(directory, "acceptance.json");
const final = fs.readFileSync(finalPath);
const acceptance = JSON.parse(fs.readFileSync(acceptancePath, "utf8"));
const sha256 = crypto.createHash("sha256").update(final).digest("hex");
if (
  acceptance.status !== "PASS"
  || acceptance.provider !== "trellis2"
  || acceptance.runtimeRepositoryRevision !== values["repository-revision"]
  || acceptance.finalSha256 !== sha256
  || acceptance.finalBytes !== final.length
  || acceptance.externalGenerativeProviderCalls !== 0
) throw new Error("AZUREML_ACCEPTANCE_ENVELOPE_INVALID");
const validation = validatePetGlbStage(final, { stage: "rig", meshProfile: "smart_mesh", requireTexture: true });
if (!validation.operatorReady) {
  throw new Error(`AZUREML_FINAL_GLB_REJECTED:${validation.reasonCodes.join(",") || "critical gate"}`);
}
const report = {
  schemaVersion: "paws.azureml-local-validation.v1",
  status: "PASS",
  finalSha256: sha256,
  finalBytes: final.length,
  checks: validation.checks.length,
  triangleCount: validation.triangleCount,
  unmeasuredCount: validation.unmeasuredCount,
};
fs.writeFileSync(path.join(directory, "local-validation.json"), `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
  flag: "wx",
});
console.log(JSON.stringify(report));
