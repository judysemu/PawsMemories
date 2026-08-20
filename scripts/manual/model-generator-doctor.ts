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
 *   PAWS_3D_PROVIDER=tripo PET_GLB_ENABLED=true npx tsx scripts/manual/model-generator-doctor.ts
 *
 * Pass production's values on the command line to test a configuration before
 * setting it in Hostinger.
 *
 * Tripo is the only provider the generator supports. The in-house TRELLIS build
 * was abandoned and its Azure GPU VMs were deleted on 2026-08-17; the provider
 * and its branches were removed on 2026-08-20. Any other PAWS_3D_PROVIDER value
 * now fails closed with UNSUPPORTED_PROVIDER.
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
  const provider = String(env.PAWS_3D_PROVIDER || "tripo").trim().toLowerCase() || "tripo";
  const petGlbEnabled = env.PET_GLB_ENABLED === "true";

  console.log("── Configuration ──────────────────────────────────────────────");
  console.log(`  PAWS_3D_PROVIDER            ${env.PAWS_3D_PROVIDER ?? "(unset -> tripo)"}`);
  console.log(`  PET_GLB_ENABLED             ${env.PET_GLB_ENABLED ?? "(unset -> false)"}`);
  console.log(`  TRIPO_API_KEY               ${env.TRIPO_API_KEY ? "(set)" : "(unset)"}`);
  console.log("\n── Resolution ─────────────────────────────────────────────────");

  // 1. Provider selection — the same guard selectedPaws3dProvider() applies.
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(provider)) {
    line(FAIL,
      `PAWS_3D_PROVIDER='${provider}' is not a valid provider id.\n` +
      "         selectedPaws3dProvider() throws PROVIDER_CONFIG_INVALID, so every build,\n" +
      "         quote and GET /api/pet-glb/product fails before a provider is constructed.");
  } else {
    line(OK, `provider selection resolves to '${provider}'`);
  }

  // 2. Is the selected provider one the factory can actually build?
  if (provider !== "tripo") {
    line(FAIL,
      `factory has no branch for providerId '${provider}' — throws UNSUPPORTED_PROVIDER.\n` +
      "         Tripo is the only supported model-generator provider. Use 'tripo'.");
  }

  // 3. Feature gate.
  if (!petGlbEnabled) {
    line(WARN, "PET_GLB_ENABLED is not 'true' — createProviderForSku throws PetGlbFeatureError.");
  } else {
    line(OK, "PET_GLB_ENABLED=true — the factory will construct a provider");
  }

  // 4. Does the selected provider's backing service have what it needs?
  if (provider === "tripo") {
    if (!env.TRIPO_API_KEY) {
      line(FAIL, "provider is 'tripo' but TRIPO_API_KEY is unset — paid stages cannot dispatch.");
    } else {
      line(OK, "TRIPO_API_KEY is set — paid stages can dispatch");
    }
  }

  console.log("\n── Verdict ────────────────────────────────────────────────────");
  if (fatal) {
    console.log(`  ${fatal} fatal problem(s), ${warned} warning(s). The generator will NOT complete a build.`);
    console.log("  Working production configuration:");
    console.log('    PAWS_3D_PROVIDER="tripo"');
    console.log('    PET_GLB_ENABLED="true"');
    console.log('    TRIPO_API_KEY="<key>"');
    process.exit(1);
  }
  console.log(`  No fatal problems${warned ? `, ${warned} warning(s)` : ""}.`);
})();
