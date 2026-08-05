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

const TRELLIS_ENV = {
  PAWS_3D_PROVIDER: "trellis2",
  PAWS_3D_INHOUSE_ONLY: "true",
  PAWS_3D_EXTERNAL_PROVIDER_IDS: "tripo,fal",
};

const TRIPO_ENV = {
  PAWS_3D_PROVIDER: "tripo",
};

test("TRELLIS publishes PBR in base with no separately priced texture product", () => {
  const capabilities = petGlbProductCapabilities(TRELLIS_ENV);
  assert.equal(capabilities.providerId, "trellis2");
  assert.deepEqual(capabilities.subjectProfiles.map(({ id }) => id), ["pet"]);
  assert.equal(capabilities.texture.includedInBase, true);
  assert.equal(capabilities.texture.separateStageAvailable, false);
  assert.equal(capabilities.texture.defaultSelected, false);
  assert.equal(capabilities.texture.priceCredits, 0);
  assert.equal(capabilities.texture.styleDirectionAvailable, false);
  assert.equal(stagePrice("texture", TRELLIS_ENV), 0);
  assert.deepEqual(productQuote({ ...BASE_CONFIGURATION, includeTexture: true }, TRELLIS_ENV), {
    base: PET_GLB_STAGE_PRICES.BASE,
    texture: 0,
    rig: PET_GLB_STAGE_PRICES.RIG,
    total: PET_GLB_STAGE_PRICES.BASE + PET_GLB_STAGE_PRICES.RIG,
  });
});

test("TRELLIS rejects separate texture, styling, and humanoid before persistence", () => {
  for (const [configuration, code] of [
    [{ ...BASE_CONFIGURATION, includeTexture: true }, "TEXTURE_INCLUDED_IN_BASE"],
    [{ ...BASE_CONFIGURATION, styleDirection: "toy finish" }, "STYLE_DIRECTION_UNAVAILABLE"],
    [{ ...BASE_CONFIGURATION, subjectProfile: "humanoid" }, "SUBJECT_PROFILE_UNSUPPORTED"],
  ]) {
    assert.throws(
      () => assertPetGlbConfigurationSupported(configuration, TRELLIS_ENV),
      (error) => error instanceof PetGenerationError && error.code === code,
    );
  }
});

test("TRELLIS skips texture for historical orders while preserving rig progression", () => {
  const historical = {
    ...BASE_CONFIGURATION,
    includeTexture: true,
    textureQuality: "detailed",
    styleDirection: "legacy style",
  };
  assert.equal(nextPetGlbStage(historical, "base", TRELLIS_ENV), "rig_check");
  assert.equal(nextPetGlbStage({ ...historical, includeRig: false }, "base", TRELLIS_ENV), null);
  assert.deepEqual(normalizeHistoricalConfiguration(historical, TRELLIS_ENV), {
    ...historical,
    includeTexture: false,
    textureQuality: "standard",
    styleDirection: null,
  });
});

test("pet product endpoint and manifest contract advertise exact TRELLIS front-only input", async (t) => {
  const previous = {
    provider: process.env.PAWS_3D_PROVIDER,
    inHouseOnly: process.env.PAWS_3D_INHOUSE_ONLY,
    externalIds: process.env.PAWS_3D_EXTERNAL_PROVIDER_IDS,
  };
  process.env.PAWS_3D_PROVIDER = "trellis2";
  process.env.PAWS_3D_INHOUSE_ONLY = "true";
  process.env.PAWS_3D_EXTERNAL_PROVIDER_IDS = "tripo,fal";
  t.after(() => {
    if (previous.provider === undefined) delete process.env.PAWS_3D_PROVIDER;
    else process.env.PAWS_3D_PROVIDER = previous.provider;
    if (previous.inHouseOnly === undefined) delete process.env.PAWS_3D_INHOUSE_ONLY;
    else process.env.PAWS_3D_INHOUSE_ONLY = previous.inHouseOnly;
    if (previous.externalIds === undefined) delete process.env.PAWS_3D_EXTERNAL_PROVIDER_IDS;
    else process.env.PAWS_3D_EXTERNAL_PROVIDER_IDS = previous.externalIds;
  });

  const frontOnly = {
    references: { frontUrl: "https://private.test/front.png" },
    referenceSessionUuid: "00000000-0000-4000-8000-000000000000",
  };
  assert.equal(ReferenceSubmissionSchema.safeParse(frontOnly).success, true);

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
  assert.equal(product.providerId, "trellis2");
  assert.equal(product.prices.texture, 0);
  assert.equal(product.textureGeneration.includedInBase, true);
  assert.equal(product.textureGeneration.separateStageAvailable, false);
  assert.deepEqual(product.subjectProfiles.map(({ id }) => id), ["pet"]);
  assert.deepEqual(product.referenceRequirements.requiredViewKinds, ["front"]);
  assert.deepEqual(product.referenceRequirements.generatedForApproval, []);
  assert.equal(product.referenceRequirements.canRegenerate, false);
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

test("service rejects unsupported TRELLIS configuration before touching the database", async (t) => {
  const previous = {
    provider: process.env.PAWS_3D_PROVIDER,
    inHouseOnly: process.env.PAWS_3D_INHOUSE_ONLY,
    externalIds: process.env.PAWS_3D_EXTERNAL_PROVIDER_IDS,
  };
  process.env.PAWS_3D_PROVIDER = "trellis2";
  process.env.PAWS_3D_INHOUSE_ONLY = "true";
  process.env.PAWS_3D_EXTERNAL_PROVIDER_IDS = "tripo,fal";
  t.after(() => {
    if (previous.provider === undefined) delete process.env.PAWS_3D_PROVIDER;
    else process.env.PAWS_3D_PROVIDER = previous.provider;
    if (previous.inHouseOnly === undefined) delete process.env.PAWS_3D_INHOUSE_ONLY;
    else process.env.PAWS_3D_INHOUSE_ONLY = previous.inHouseOnly;
    if (previous.externalIds === undefined) delete process.env.PAWS_3D_EXTERNAL_PROVIDER_IDS;
    else process.env.PAWS_3D_EXTERNAL_PROVIDER_IDS = previous.externalIds;
  });

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
    service.createConfiguredOrder("+15555550123", { ...BASE_CONFIGURATION, includeTexture: true }),
    (error) => error instanceof PetGenerationError && error.code === "TEXTURE_INCLUDED_IN_BASE",
  );
  await assert.rejects(
    service.createConfiguredOrder("+15555550123", { ...BASE_CONFIGURATION, subjectProfile: "humanoid" }),
    (error) => error instanceof PetGenerationError && error.code === "SUBJECT_PROFILE_UNSUPPORTED",
  );
  assert.equal(poolCalls, 0);
});

test("model studio defaults TRELLIS texture off and hides unavailable styling", () => {
  const source = fs.readFileSync("src/components/PetModelStudio.tsx", "utf8");
  assert.match(source, /useState\(false\).*includeTexture|\[includeTexture, setIncludeTexture\] = useState\(false\)/s);
  assert.match(source, /product\.textureGeneration\.separateStageAvailable/);
  assert.match(source, /includeTexture && product\.textureGeneration\.styleDirectionAvailable/);
  assert.match(source, /Lifelike PBR color included/);
});
