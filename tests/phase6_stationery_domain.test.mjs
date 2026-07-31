import test from "node:test";
import assert from "node:assert/strict";

import { TemplateVersionSpecSchema } from "../server/stationery-v2/contracts.ts";
import { hashTemplateSpec, sealPrintManifest, sealRenderManifest, verifyPrintManifest, verifyRenderManifest } from "../server/stationery-v2/manifests.ts";
import { findTextOverflow, validateTemplateSpec } from "../server/stationery-v2/validation.ts";

const TEMPLATE_UUID = "11111111-1111-4111-8111-111111111111";
const ASSET_UUID = "22222222-2222-4222-8222-222222222222";
const OUTPUT_UUID = "33333333-3333-4333-8333-333333333333";
const ORDER_UUID = "44444444-4444-4444-8444-444444444444";
const PAYMENT_UUID = "55555555-5555-4555-8555-555555555555";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function validTemplate() {
  return {
    schemaVersion: "stationery.template.v1",
    templateUuid: TEMPLATE_UUID,
    versionNumber: 3,
    topic: "Pet birthday",
    event: "Birthday",
    locale: "en-US",
    orientation: "portrait",
    trimIn: { width: 5, height: 7 },
    bleedIn: { top: 0.125, right: 0.125, bottom: 0.125, left: 0.125 },
    safeAreaIn: { top: 0.25, right: 0.25, bottom: 0.25, left: 0.25 },
    backgroundAsset: { assetUuid: ASSET_UUID, versionNumber: 2, sha256: HASH_A },
    backgroundCoverageIn: { x: -0.125, y: -0.125, width: 5.25, height: 7.25 },
    fontLicenses: [{ family: "Fraunces", licenseId: "OFL-1.1", commercialUse: true, embeddingAllowed: true }],
    slots: [
      { slotId: "headline", kind: "text", boundsIn: { x: 0.25, y: 0.25, width: 4.5, height: 1 }, required: true, fontFamily: "Fraunces", minFontSizePt: 12, maxLines: 2 },
      { slotId: "pet_photo", kind: "image", boundsIn: { x: 0.5, y: 1.5, width: 4, height: 4 }, required: true, allowBleed: false },
    ],
    presets: [
      { presetId: "digital_png", purpose: "digital", format: "png", widthPx: 1500, heightPx: 2100, targetDpi: 300, includeBleed: false, minimumBleedIn: 0, colorProfile: "sRGB IEC61966-2.1" },
      { presetId: "print_pdf", purpose: "print", format: "pdf", widthPx: 1575, heightPx: 2175, targetDpi: 300, includeBleed: true, minimumBleedIn: 0.125, colorProfile: "CMYK provider-profile-v1" },
    ],
    accessibilityLabel: "Birthday card with a centered pet portrait and editable headline.",
  };
}

test("Phase 6 template contracts are strict and the valid fixture passes", () => {
  const spec = validTemplate();
  assert.equal(validateTemplateSpec(spec).overallPass, true);
  assert.throws(() => TemplateVersionSpecSchema.parse({ ...spec, clientClaimsPrintReady: true }));
  assert.throws(() => TemplateVersionSpecSchema.parse({ ...spec, orientation: "landscape" }));
});

test("Phase 6 rejects bad DPI and insufficient pixel dimensions", () => {
  const spec = validTemplate();
  spec.presets[1] = { ...spec.presets[1], widthPx: 1000, heightPx: 1200 };
  const report = validateTemplateSpec(spec);
  assert.equal(report.overallPass, false);
  assert.ok(report.findings.some((finding) => finding.ruleId === "pixels.exact_dimensions"));
  const dpi = report.findings.find((finding) => finding.ruleId === "pixels.minimum_dpi");
  assert.ok(dpi);
  assert.ok(dpi.measured < dpi.required);
});

test("Phase 6 reports provider bleed and background-coverage violations", () => {
  const spec = validTemplate();
  spec.bleedIn = { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 };
  spec.backgroundCoverageIn = { x: 0, y: 0, width: 5, height: 7 };
  spec.presets[1] = { ...spec.presets[1], widthPx: 1530, heightPx: 2130 };
  const report = validateTemplateSpec(spec);
  assert.ok(report.findings.some((finding) => finding.ruleId === "bleed.minimum_size"));
  assert.ok(report.findings.some((finding) => finding.ruleId === "geometry.background_covers_bleed"));
});

test("Phase 6 reports safe-area and font-rights failures", () => {
  const spec = validTemplate();
  spec.slots[0] = { ...spec.slots[0], boundsIn: { x: 0.05, y: 0.05, width: 4.9, height: 1 } };
  spec.fontLicenses = [{ ...spec.fontLicenses[0], embeddingAllowed: false }];
  const report = validateTemplateSpec(spec);
  assert.ok(report.findings.some((finding) => finding.ruleId === "geometry.text_safe_area"));
  assert.ok(report.findings.some((finding) => finding.ruleId === "rights.font_print_license"));
});

test("Phase 6 text overflow consumes measured layout evidence", () => {
  const findings = findTextOverflow([{
    slotId: "headline",
    content: "A very long birthday headline",
    measuredWidthPx: 601,
    measuredHeightPx: 151,
    boxWidthPx: 600,
    boxHeightPx: 150,
    lineCount: 3,
    maxLines: 2,
    clippedGlyphCount: 2,
    measurementEngine: "sharp-pango",
    measurementEngineVersion: "1.0.0",
  }]);
  assert.deepEqual(findings.map((finding) => finding.ruleId), [
    "text.width_overflow",
    "text.height_overflow",
    "text.line_overflow",
    "text.clipped_glyphs",
  ]);
});

test("Phase 6 render and print manifests are immutable and hash-verifiable", () => {
  const spec = validTemplate();
  const render = sealRenderManifest({
    schemaVersion: "stationery.render-manifest.v1",
    templateUuid: TEMPLATE_UUID,
    templateVersionNumber: 3,
    templateSpecHash: hashTemplateSpec(spec),
    presetId: "print_pdf",
    output: { assetUuid: OUTPUT_UUID, versionNumber: 1, sha256: HASH_B },
    format: "pdf",
    widthPx: 1575,
    heightPx: 2175,
    dpi: 300,
    colorProfile: "CMYK provider-profile-v1",
    renderer: { name: "stationery-worker", version: "1.0.0" },
    sourceVersions: [{ assetUuid: ASSET_UUID, versionNumber: 2, sha256: HASH_A }],
    fontFileHashes: [HASH_C],
    validationReportHash: HASH_A,
    frozenAt: "2026-07-22T12:00:00.000Z",
  });
  assert.equal(verifyRenderManifest(render), true);
  assert.equal(verifyRenderManifest({ ...render, widthPx: 1574 }), false);

  const print = sealPrintManifest({
    schemaVersion: "stationery.print-manifest.v1",
    localOrderUuid: ORDER_UUID,
    fulfillmentKind: "stationery_print",
    provider: "printful",
    providerSku: "PF-CARD-5X7",
    placement: "front",
    quantity: 2,
    recipient: {
      name: "Test Customer",
      email: "customer@example.com",
      address1: "1 Test Street",
      city: "Denver",
      stateCode: "CO",
      countryCode: "US",
      postalCode: "80202",
    },
    frozenFile: { assetUuid: OUTPUT_UUID, versionNumber: 1, sha256: HASH_B },
    renderManifestHash: render.manifestHash,
    validationReportHash: HASH_A,
    paidPaymentUuid: PAYMENT_UUID,
    frozenAt: "2026-07-22T12:01:00.000Z",
  });
  assert.equal(verifyPrintManifest(print), true);
  assert.equal(verifyPrintManifest({ ...print, quantity: 3 }), false);
});
