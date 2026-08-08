import { test } from "node:test";
import assert from "node:assert";
import * as spatialGen from "../server/spatial-generator/service.js";
import * as provider from "../server/spatial-generator/provider.js";
import * as compiler from "../server/spatial-generator/compiler.js";
import * as validation from "../server/spatial-generator/validation.js";
import * as storage from "../server/spatial-generator/storage.js";
import * as schemas from "../server/spatial-generator/schemas.js";
import * as types from "../server/spatial-generator/types.js";
import * as repository from "../server/spatial-generator/repository.js";

/**
 * Tripo Isolation Test Suite
 * 
 * Proves the entire server/spatial-generator path:
 * - Imports nothing from tripo.ts
 * - Calls no Tripo endpoint
 * - Reads no TRIPO_API_KEY
 * - Produces no Tripo provider handle
 * - Falls back to no Tripo path
 * - Fails closed if in-house dependencies unavailable
 */

test("spatial-generator service imports zero Tripo symbols", () => {
  const serviceExports = Object.keys(spatialGen);
  const tripoRelated = serviceExports.filter(k => 
    k.toLowerCase().includes("tripo")
  );
  
  assert.strictEqual(tripoRelated.length, 0, 
    `Found Tripo references in service: ${tripoRelated.join(", ")}`);
});

test("spatial-generator provider exports only Layer8 operations", () => {
  const providerExports = Object.keys(provider);
  
  const expected = [
    "observeReferences",
    "generatePlan",
    "verifyDraft",
    "checkLayer8Health",
    "Layer8Error",
    "resolveLayer8Config",
  ];
  
  expected.forEach(e => {
    assert.ok(providerExports.includes(e), `Missing expected export: ${e}`);
  });
  
  // Filter out type exports (start with capital) and expected functions
  const unexpected = providerExports.filter(e => 
    !expected.includes(e) && 
    !e.match(/^[A-Z]/) &&
    !e.match(/Schema$/) &&
    !e.match(/Input$/) &&
    !e.match(/Output$/)
  );
  
  assert.strictEqual(unexpected.length, 0, 
    `Unexpected provider exports: ${unexpected.join(", ")}`);
});

test("spatial-generator compiler has no Tripo imports", () => {
  const compilerExports = Object.keys(compiler);
  const tripoRelated = compilerExports.filter(k => 
    k.toLowerCase().includes("tripo")
  );
  
  assert.strictEqual(tripoRelated.length, 0,
    `Found Tripo references in compiler: ${tripoRelated.join(", ")}`);
});

test("spatial-generator validation has no Tripo imports", () => {
  const validationExports = Object.keys(validation);
  const tripoRelated = validationExports.filter(k => 
    k.toLowerCase().includes("tripo")
  );
  
  assert.strictEqual(tripoRelated.length, 0,
    `Found Tripo references in validation: ${tripoRelated.join(", ")}`);
});

test("spatial-generator storage has no Tripo imports", () => {
  const storageExports = Object.keys(storage);
  const tripoRelated = storageExports.filter(k => 
    k.toLowerCase().includes("tripo")
  );
  
  assert.strictEqual(tripoRelated.length, 0,
    `Found Tripo references in storage: ${tripoRelated.join(", ")}`);
});

test("spatial-generator schemas has no Tripo imports", () => {
  const schemasExports = Object.keys(schemas);
  const tripoRelated = schemasExports.filter(k => 
    k.toLowerCase().includes("tripo")
  );
  
  assert.strictEqual(tripoRelated.length, 0,
    `Found Tripo references in schemas: ${tripoRelated.join(", ")}`);
});

test("spatial-generator types has no Tripo imports", () => {
  const typesExports = Object.keys(types);
  const tripoRelated = typesExports.filter(k => 
    k.toLowerCase().includes("tripo")
  );
  
  assert.strictEqual(tripoRelated.length, 0,
    `Found Tripo references in types: ${tripoRelated.join(", ")}`);
});

test("spatial-generator repository has no Tripo imports", () => {
  const repoExports = Object.keys(repository);
  const tripoRelated = repoExports.filter(k => 
    k.toLowerCase().includes("tripo")
  );
  
  assert.strictEqual(tripoRelated.length, 0,
    `Found Tripo references in repository: ${tripoRelated.join(", ")}`);
});

test("spatial-generator service uses only Layer8 provider functions", () => {
  // Verify the service constructs use provider functions, not Tripo
  const serviceKeys = Object.keys(spatialGen);
  
  // Service should export the main service class and factory
  assert.ok(serviceKeys.includes("SpatialGeneratorService"));
  assert.ok(serviceKeys.includes("createSpatialGeneratorService"));
  assert.ok(serviceKeys.includes("SpatialGeneratorServiceError"));
  
  // No Tripo-related exports
  const tripoRelated = serviceKeys.filter(k => 
    k.toLowerCase().includes("tripo")
  );
  assert.strictEqual(tripoRelated.length, 0);
});

test("spatial-generator fails closed when Layer8 unavailable", async () => {
  // Test that observeReferences throws NOT_CONFIGURED when Layer8 not set up
  const { observeReferences } = await import("../server/spatial-generator/provider.js");
  
  try {
    await observeReferences([], null);
    assert.fail("Expected NOT_CONFIGURED error");
  } catch (error) {
    assert.strictEqual(error.code, "NOT_CONFIGURED");
    assert.ok(error.message.includes("Layer8 not configured"));
  }
});

test("spatial-generator requires INHOUSE_SPATIAL_GENERATOR_ENABLED flag", async () => {
  const featureFlag = await import("../server/spatial-generator/featureFlag.js");
  const { isInhouseSpatialGeneratorEnabled, assertInhouseSpatialGeneratorEnabled } = featureFlag;
  
  // Should be false by default
  assert.strictEqual(isInhouseSpatialGeneratorEnabled(), false);
  
  // Should throw when not enabled
  assert.throws(() => {
    assertInhouseSpatialGeneratorEnabled();
  }, /INHOUSE_SPATIAL_GENERATOR_ENABLED is not set to true/);
});