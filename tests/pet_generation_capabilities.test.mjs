import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import express from "express";

import {
  assertPetGlbConfigurationSupported,
  nextPetGlbStage,
  normalizeHistoricalConfiguration,
  petGlbProductCapabilities,
} from "../server/pet-generation/capabilities.ts";
import { productQuote, ReferenceSubmissionSchema, stagePrice } from "../server/pet-generation/contracts.ts";
import { PetGenerationError } from "../server/pet-generation/provider.ts";
import { createPetGenerationRouter } from "../server/pet-generation/routes.ts";
import { PetGlbService } from "../server/pet-generation/service.ts";
import { PET_GLB_STAGE_PRICES } from "../src/pricing.ts";

const BASE_CONFIGURATION = {
  meshProfile: "hd",
  subjectProfile: "pet",
  includeTexture: false,
  includeRig: true,
  textureQuality: "standard",
  styleDirection: null,
};

const TRIPO_ENV = {
  PAWS_3D_PROVIDER: "tripo",
};

// Tripo is bound at the module level as of 2026-08-21; PAWS_3D_PROVIDER is no
// longer read. A stale value in the environment must therefore be inert rather
// than able to change what a customer is quoted.
const STALE_PROVIDER_ENV = {
  PAWS_3D_PROVIDER: "trellis2",
};

test("a stale PAWS_3D_PROVIDER cannot change the published product", () => {
  // Provider selection previously lived in the environment, so a leftover
  // value could make GET /product disagree with the adapter that would
  // actually run the build. Binding the id removes that possibility: every
  // capability call returns the Tripo contract regardless of what is set.
  const stale = petGlbProductCapabilities(STALE_PROVIDER_ENV);
  const clean = petGlbProductCapabilities({});
  assert.equal(stale.providerId, "tripo");
  assert.deepEqual(stale, clean);

  for (const call of [
    () => assertPetGlbConfigurationSupported(BASE_CONFIGURATION, STALE_PROVIDER_ENV),
    () => normalizeHistoricalConfiguration(BASE_CONFIGURATION, STALE_PROVIDER_ENV),
    () => nextPetGlbStage(BASE_CONFIGURATION, "base", STALE_PROVIDER_ENV),
    () => stagePrice("texture", STALE_PROVIDER_ENV),
    () => productQuote(BASE_CONFIGURATION, STALE_PROVIDER_ENV),
  ]) {
    assert.doesNotThrow(call);
  }
});

test("an unregistered SKU still fails closed at the factory", async () => {
  // Fail-closed did not disappear with provider selection -- it moved. The
  // factory is now the only place a bad binding can be rejected, so that
  // guarantee is asserted here rather than through the environment.
  const { createProviderForSku, resetProviderFactoryForTests } =
    await import("../server/pet-generation/factory.ts");
  const previous = process.env.PET_GLB_ENABLED;
  process.env.PET_GLB_ENABLED = "true";
  resetProviderFactoryForTests();
  try {
    assert.throws(
      () => createProviderForSku("NO_SUCH_SKU"),
      (error) => error instanceof PetGenerationError,
    );
  } finally {
    if (previous === undefined) delete process.env.PET_GLB_ENABLED;
    else process.env.PET_GLB_ENABLED = previous;
    resetProviderFactoryForTests();
  }
});

test("pet product endpoint advertises the Tripo four-view contract", async (t) => {
  const previous = process.env.PAWS_3D_PROVIDER;
  process.env.PAWS_3D_PROVIDER = "tripo";
  t.after(() => {
    if (previous === undefined) delete process.env.PAWS_3D_PROVIDER;
    else process.env.PAWS_3D_PROVIDER = previous;
  });

  const frontOnly = {
    references: { frontUrl: "https://private.test/front.png" },
    referenceSessionUuid: "00000000-0000-4000-8000-000000000000",
  };
  assert.equal(ReferenceSubmissionSchema.safeParse(frontOnly).success, false);

  const app = express();
  app.use("/api/pet-glb", createPetGenerationRouter({
    getPool() { throw new Error("not used"); },
    async isAdmin() { return false; },
    async persistVersion() { throw new Error("not used"); },
    async signDownload() { throw new Error("not used"); },
  }));
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/pet-glb/product`);
  assert.equal(response.status, 200);
  const product = await response.json();
  assert.equal(product.providerId, "tripo");
  assert.equal(product.prices.texture, PET_GLB_STAGE_PRICES.TEXTURE);
  assert.equal(product.textureGeneration.includedInBase, false);
  assert.equal(product.textureGeneration.separateStageAvailable, true);
  assert.deepEqual(product.subjectProfiles.map(({ id }) => id), ["pet", "humanoid"]);
  assert.deepEqual(product.referenceRequirements.requiredViewKinds, ["front", "left", "right", "rear"]);
  assert.deepEqual(product.referenceRequirements.generatedForApproval, ["left", "right", "rear"]);
  assert.equal(product.referenceRequirements.canRegenerate, true);
});

test("Tripo manifest contract still requires all four approved views", () => {
  const previous = process.env.PAWS_3D_PROVIDER;
  process.env.PAWS_3D_PROVIDER = "tripo";
  try {
    assert.equal(ReferenceSubmissionSchema.safeParse({
      references: { frontUrl: "https://private.test/front.png" },
      referenceSessionUuid: "00000000-0000-4000-8000-000000000000",
    }).success, false);
    assert.equal(ReferenceSubmissionSchema.safeParse({
      references: {
        frontUrl: "https://private.test/front.png",
        leftUrl: "https://private.test/left.png",
        rightUrl: "https://private.test/right.png",
        rearUrl: "https://private.test/rear.png",
      },
      referenceSessionUuid: "00000000-0000-4000-8000-000000000000",
    }).success, true);
  } finally {
    if (previous === undefined) delete process.env.PAWS_3D_PROVIDER;
    else process.env.PAWS_3D_PROVIDER = previous;
  }
});

test("Tripo paid texture and humanoid behavior remains unchanged", () => {
  const capabilities = petGlbProductCapabilities(TRIPO_ENV);
  assert.deepEqual(capabilities.subjectProfiles.map(({ id }) => id), ["pet", "humanoid"]);
  assert.equal(capabilities.texture.includedInBase, false);
  assert.equal(capabilities.texture.separateStageAvailable, true);
  assert.equal(capabilities.texture.defaultSelected, true);
  assert.equal(stagePrice("texture", TRIPO_ENV), PET_GLB_STAGE_PRICES.TEXTURE);
  const configuration = { ...BASE_CONFIGURATION, subjectProfile: "humanoid", includeTexture: true };
  assert.doesNotThrow(() => assertPetGlbConfigurationSupported(configuration, TRIPO_ENV));
  assert.equal(nextPetGlbStage(configuration, "base", TRIPO_ENV), "texture");
  assert.deepEqual(productQuote(configuration, TRIPO_ENV), {
    base: PET_GLB_STAGE_PRICES.BASE,
    texture: PET_GLB_STAGE_PRICES.TEXTURE,
    rig: PET_GLB_STAGE_PRICES.RIG,
    total: PET_GLB_STAGE_PRICES.BASE + PET_GLB_STAGE_PRICES.TEXTURE + PET_GLB_STAGE_PRICES.RIG,
  });
});

test("service rejects an unsupported configuration before touching the database", async () => {
  // The rejection that matters is now about the configuration, not the
  // provider: an unsupported subject profile must be refused before any
  // connection is taken, so a bad request cannot consume a pool slot.
  let poolCalls = 0;
  const service = new PetGlbService({
    getPool() {
      poolCalls += 1;
      throw new Error("database must not be touched");
    },
    async isAdmin() { return false; },
    async persistVersion() { throw new Error("not used"); },
    async signDownload() { throw new Error("not used"); },
  });

  await assert.rejects(
    service.createConfiguredOrder("+15555550123", { ...BASE_CONFIGURATION, subjectProfile: "spaceship" }),
    (error) => error instanceof PetGenerationError && error.code === "SUBJECT_PROFILE_UNSUPPORTED",
  );
  assert.equal(poolCalls, 0, "an unsupported configuration must not reach the database");
});

test("model studio defaults texture off, gates styling, and carries no in-house copy", () => {
  const source = fs.readFileSync("src/components/PetModelStudio.tsx", "utf8");
  assert.match(source, /useState\(false\).*includeTexture|\[includeTexture, setIncludeTexture\] = useState\(false\)/s);
  assert.match(source, /product\.textureGeneration\.separateStageAvailable/);
  assert.match(source, /includeTexture && product\.textureGeneration\.styleDirectionAvailable/);
  // The PBR-included panel existed only for the removed in-house capability
  // shape; under Tripo separateStageAvailable is always true.
  assert.doesNotMatch(source, /Lifelike PBR color included/);
  assert.doesNotMatch(source, /in-house/i);
});
