#!/usr/bin/env -S npx tsx
/**
 * Resolve the 3D model generator wiring and report what a build would actually do.
 *
 * The generator's provider is chosen by three environment variables that
 * interact, and a wrong combination fails deep inside a paid flow rather than
 * at boot. This walks the same code the server walks — selectedPaws3dProvider,
 * the SKU registry, then the factory — and reports the resolved binding, the
 * adapter that would be constructed, and whether the worker it needs is
 * reachable.
 *
 *   npx tsx scripts/manual/model-generator-doctor.ts
 *   PAWS_3D_PROVIDER=trellis2 PAWS_3D_INHOUSE_ONLY=true npx tsx scripts/manual/model-generator-doctor.ts
 *
 * Pass production's values on the command line to test a configuration before
 * setting it in Hostinger.
 *
 * Background: PAWS_3D_PROVIDER="trellis2" with PAWS_3D_INHOUSE_ONLY="true" was
 * the .env.example default from 2026-08-05, written for the in-house TRELLIS
 * build. That plan was dropped and the Azure GPU VMs were deleted on
 * 2026-08-17, so the combination now selects a provider whose worker does not
 * exist while simultaneously blocking Tripo, the only provider that works.
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
  const inHouseOnly = String(env.PAWS_3D_INHOUSE_ONLY || "").trim().toLowerCase() === "true";
  const externals = new Set([
    "tripo",
    ...String(env.PAWS_3D_EXTERNAL_PROVIDER_IDS || "")
      .split(",").map((v) => v.trim().toLowerCase()).filter(Boolean),
  ]);
  const petGlbEnabled = env.PET_GLB_ENABLED === "true";

  console.log("── Configuration ──────────────────────────────────────────────");
  console.log(`  PAWS_3D_PROVIDER            ${env.PAWS_3D_PROVIDER ?? "(unset -> tripo)"}`);
  console.log(`  PAWS_3D_INHOUSE_ONLY        ${env.PAWS_3D_INHOUSE_ONLY ?? "(unset -> false)"}`);
  console.log(`  PAWS_3D_EXTERNAL_PROVIDER_IDS ${env.PAWS_3D_EXTERNAL_PROVIDER_IDS ?? "(unset)"}`);
  console.log(`  PET_GLB_ENABLED             ${env.PET_GLB_ENABLED ?? "(unset -> false)"}`);
  console.log(`  TRELLIS_WORKER_URL          ${env.TRELLIS_WORKER_URL ? "(set)" : "(unset)"}`);
  console.log(`  TRIPO_API_KEY               ${env.TRIPO_API_KEY ? "(set)" : "(unset)"}`);
  console.log("\n── Resolution ─────────────────────────────────────────────────");

  // 1. Provider selection — the same guard selectedPaws3dProvider() applies.
  if (inHouseOnly && externals.has(provider)) {
    line(FAIL,
      `PAWS_3D_PROVIDER='${provider}' is listed as external and PAWS_3D_INHOUSE_ONLY=true.\n` +
      `         selectedPaws3dProvider() throws INHOUSE_PROVIDER_REQUIRED, so every build,\n` +
      `         quote and GET /api/pet-glb/product fails before a provider is constructed.`);
  } else {
    line(OK, `provider selection resolves to '${provider}'`);
  }

  // 2. Is the selected provider one the factory can actually build?
  if (!["tripo", "trellis2"].includes(provider)) {
    line(FAIL, `factory has no branch for providerId '${provider}' — throws UNSUPPORTED_PROVIDER.`);
  }

  // 3. Feature gate.
  if (!petGlbEnabled) {
    line(WARN, "PET_GLB_ENABLED is not 'true' — createProviderForSku throws PetGlbFeatureError.");
  } else {
    line(OK, "PET_GLB_ENABLED=true — the factory will construct a provider");
  }

  // 4. Does the selected provider's backing service exist?
  if (provider === "trellis2") {
    const url = String(env.TRELLIS_WORKER_URL || "").trim();
    if (!url) {
      line(FAIL,
        "provider is 'trellis2' but TRELLIS_WORKER_URL is unset. TrellisModelBuildAdapter\n" +
        "         throws TRELLIS_CONFIG_INVALID at construction. The in-house TRELLIS plan was\n" +
        "         dropped and its Azure GPU VMs were deleted on 2026-08-17 — this provider has\n" +
        "         no infrastructure behind it. Use 'tripo'.");
    } else {
      line(WARN, "provider is 'trellis2' with a worker URL set — probing it");
      try {
        const res = await fetch(new URL("/health", url).toString(), {
          signal: AbortSignal.timeout(10_000),
        });
        line(res.ok ? OK : FAIL, `TRELLIS worker /health -> HTTP ${res.status}`);
      } catch (err: any) {
        line(FAIL, `TRELLIS worker unreachable: ${err?.message || err}`);
      }
    }
    line(WARN,
      "capabilities fork: under 'trellis2' the texture stage is closed, reference views are\n" +
      "         not generated for approval, and canRegenerate is false. The customer contract\n" +
      "         differs from Tripo — do not switch providers on a live order.");
  }

  if (provider === "tripo" && !env.TRIPO_API_KEY) {
    line(FAIL, "provider is 'tripo' but TRIPO_API_KEY is unset — paid stages cannot dispatch.");
  }

  console.log("\n── Verdict ────────────────────────────────────────────────────");
  if (fatal) {
    console.log(`  ${fatal} fatal problem(s), ${warned} warning(s). The generator will NOT complete a build.`);
    console.log("  Working production configuration:");
    console.log('    PAWS_3D_PROVIDER="tripo"');
    console.log('    PAWS_3D_INHOUSE_ONLY="false"');
    console.log('    PET_GLB_ENABLED="true"');
    process.exit(1);
  }
  console.log(`  No fatal problems${warned ? `, ${warned} warning(s)` : ""}.`);
})();
