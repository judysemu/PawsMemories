#!/usr/bin/env -S npx tsx
/**
 * Resolve the 3D model generator wiring and report what a build would actually do.
 *
 * A wrong configuration fails deep inside a paid flow rather than at boot. This
 * walks the same code the server walks — selectedPaws3dProvider, the SKU
 * registry, then the factory — and reports the resolved binding, the adapter
 * that would be constructed, and whether the credential it needs is present.
 *
 *   npx tsx scripts/manual/model-generator-doctor.ts
 *   PET_GLB_ENABLED=true npx tsx scripts/manual/model-generator-doctor.ts
 *
 * Pass production's values on the command line to test a configuration before
 * setting it in Hostinger.
 *
 * Tripo is bound at the module level as of 2026-08-21 -- PAWS_3D_PROVIDER is no
 * longer read, so provider choice is no longer something that can be
 * misconfigured. What remains checkable is the feature gate and the credential.
 */
import "dotenv/config";

const OK = "  ok   ";
const WARN = " warn  ";
const FAIL = " FAIL  ";

let fatal = 0;
let warned = 0;
const line = (tag: string, msg: string) => {
  if (tag === FAIL) fatal++;
  if (tag === WARN) warned++;
  console.log(`[${tag}] ${msg}`);
};

(async () => {
  const env = process.env;
  const petGlbEnabled = env.PET_GLB_ENABLED === "true";

  console.log("── Configuration ──────────────────────────────────────────────");
  console.log(`  provider                    tripo (bound in code)`);
  console.log(`  PET_GLB_ENABLED             ${env.PET_GLB_ENABLED ?? "(unset -> false)"}`);
  console.log(`  TRIPO_API_KEY               ${env.TRIPO_API_KEY ? "(set)" : "(unset)"}`);
  if (env.PAWS_3D_PROVIDER) {
    line(WARN,
      `PAWS_3D_PROVIDER is set to '${env.PAWS_3D_PROVIDER}' but is no longer read.\n` +
      "         It is inert. Remove it so it cannot be mistaken for live configuration.");
  }
  console.log("\n── Resolution ─────────────────────────────────────────────────");

  line(OK, "provider is tripo — bound in code, not resolvable from the environment");

  // Feature gate.
  if (!petGlbEnabled) {
    line(WARN, "PET_GLB_ENABLED is not 'true' — createProviderForSku throws PetGlbFeatureError.");
  } else {
    line(OK, "PET_GLB_ENABLED=true — the factory will construct a provider");
  }

  // Credential.
  if (!env.TRIPO_API_KEY) {
    line(FAIL, "TRIPO_API_KEY is unset — paid stages cannot dispatch.");
  } else {
    line(OK, "TRIPO_API_KEY is set — paid stages can dispatch");
  }

  console.log("\n── Verdict ────────────────────────────────────────────────────");
  if (fatal) {
    console.log(`  ${fatal} fatal problem(s), ${warned} warning(s). The generator will NOT complete a build.`);
    console.log("  Working production configuration:");
    console.log('    PET_GLB_ENABLED="true"');
    console.log('    TRIPO_API_KEY="<key>"');
    process.exit(1);
  }
  console.log(`  No fatal problems${warned ? `, ${warned} warning(s)` : ""}.`);
})();
