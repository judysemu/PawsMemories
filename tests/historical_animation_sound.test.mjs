import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  HISTORICAL_PET_CATALOG,
  HISTORICAL_PET_CATALOG_SCHEMA,
} from "../shared/historicalPetCatalog.ts";
import {
  HISTORICAL_SCENE_SCRIPTS,
  PRESET_SCRIPTS,
  SCENE_SCRIPT_V2_SCHEMA,
  parseSceneScript,
  validateSceneScriptReferences,
} from "../server/animator/sceneScripts.ts";
import {
  ANIMATOR_SOUND_MANIFEST,
  readWavMetadata,
  verifySoundManifestAssets,
} from "../shared/animatorSoundManifest.ts";
import {
  buildFfmpegMuxArgs,
  muxAudioBed,
  validateMuxRequest,
} from "../server/animator/audioMux.ts";
import { detectRecordingMime, getOwnedRecording, saveRecording, validateRecordingUpload } from "../server/animator/recordings.ts";
import { decodeAnimatorOperationMetadata, encodeAnimatorOperationMetadata } from "../server/animator/operationMetadata.ts";
import { getOwnedVoicedResult, persistVoicedResult } from "../server/animator/voicedResults.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

test("historical collection is an owned preview catalog with exact reviewed assets", () => {
  const catalog = HISTORICAL_PET_CATALOG_SCHEMA.parse(HISTORICAL_PET_CATALOG);
  assert.equal(catalog.length, 4);
  assert.deepEqual(catalog.map((entry) => entry.id), [
    "the-composer",
    "the-naturalist",
    "the-novelist",
    "the-lamplight-healer",
  ]);
  for (const entry of catalog) {
    assert.equal(entry.availability, "preview");
    assert.equal(entry.rightsStatus, "owned-generated");
    assert.equal(entry.provenance, "OpenAI imagegen, generated for Pawsome3D on 2026-07-31");
    assert.ok(!/\bb\.?\s*\d{4}\b/i.test(entry.stylePeriod));
    assert.ok(entry.directorScriptIds.length > 0);
    for (const asset of [entry.previewAsset, entry.sourceAsset]) {
      const absolute = path.join(ROOT, asset.publicPath.replace(/^\//, "public/"));
      assert.ok(fs.existsSync(absolute), absolute);
      assert.equal(crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"), asset.sha256);
    }
  }
});

test("HeroScroller describes previews and uses the reviewed images without sales claims", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/components/HeroScroller.tsx"), "utf8");
  const catalogSource = fs.readFileSync(path.join(ROOT, "shared/historicalPetCatalog.ts"), "utf8");
  for (const entry of HISTORICAL_PET_CATALOG) assert.match(catalogSource, new RegExp(entry.previewAsset.publicPath));
  assert.match(source, /collection preview/i);
  assert.doesNotMatch(source, /\bLIMITED\b|from \$\d+|b\.\s*\d{4}|To Pawprints|Browse the collection/);
  assert.match(source, /loading="lazy"/);
  assert.match(source, /decoding="async"/);
  assert.match(source, /onError=/);
});

test("V2 historical scripts are typed, ordered, compatible, and fully referential", () => {
  assert.deepEqual(HISTORICAL_SCENE_SCRIPTS.map((script) => script.id), [
    "composer-overture",
    "naturalist-discovery",
    "novelist-midnight-draft",
    "lamplight-healer-vigil",
  ]);
  for (const script of HISTORICAL_SCENE_SCRIPTS) {
    const parsed = SCENE_SCRIPT_V2_SCHEMA.parse(script);
    assert.equal(parsed.schemaVersion, "2");
    assert.equal(parsed.category, "Historical Pet Stories");
    assert.ok(parsed.durationSeconds >= 8 && parsed.durationSeconds <= 10);
    assert.deepEqual(parseSceneScript(parsed), parsed);
    assert.deepEqual(validateSceneScriptReferences(parsed), []);
    assert.deepEqual([...parsed.events].sort((a, b) => a.startTime - b.startTime), parsed.events);
    assert.ok(parsed.events.some((event) => event.type === "camera"));
    assert.ok(parsed.events.some((event) => event.type === "clip"));
    assert.ok(parsed.events.some((event) => event.type === "sound"));
  }
});

test("every enabled director script resolves against its environment and AnimationSetV2", () => {
  assert.ok(PRESET_SCRIPTS.length >= 112);
  for (const script of PRESET_SCRIPTS) assert.deepEqual(validateSceneScriptReferences(script), [], script.id);
});

test("V2 reference validation rejects missing collection, clip, sound, and environment", () => {
  const base = structuredClone(HISTORICAL_SCENE_SCRIPTS[0]);
  assert.ok(validateSceneScriptReferences({ ...base, collectionId: "missing" }).some((e) => e.includes("collection")));
  assert.ok(validateSceneScriptReferences({ ...base, environmentId: "missing" }).some((e) => e.includes("environment")));
  const clipBad = structuredClone(base);
  clipBad.events.find((event) => event.type === "clip").clipId = "missing-clip";
  assert.ok(validateSceneScriptReferences(clipBad).some((e) => e.includes("clip")));
  const soundBad = structuredClone(base);
  soundBad.events.find((event) => event.type === "sound").assetId = "https://example.com/injected.wav";
  assert.ok(validateSceneScriptReferences(soundBad).some((e) => e.includes("sound")));
});

test("historical sound validation accepts the production dist asset layout", () => {
  const deployRoot = fs.mkdtempSync(path.join(os.tmpdir(), "historical-sound-deploy-"));
  try {
    for (const asset of ANIMATOR_SOUND_MANIFEST.assets) {
      const destination = path.join(deployRoot, "dist", asset.publicUrl.replace(/^\//, ""));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(ROOT, "public", asset.publicUrl.replace(/^\//, "")), destination);
    }
    for (const script of HISTORICAL_SCENE_SCRIPTS) {
      assert.ok(
        !validateSceneScriptReferences(script, deployRoot).some((error) => error.includes("sound") && error.includes("missing on disk")),
        script.id,
      );
    }
  } finally {
    fs.rmSync(deployRoot, { recursive: true, force: true });
  }
});

test("sound manifest hashes and decoded mono WAV metadata match bounded declarations", () => {
  assert.equal(ANIMATOR_SOUND_MANIFEST.version, "1");
  assert.equal(ANIMATOR_SOUND_MANIFEST.assets.length, 4);
  assert.deepEqual(verifySoundManifestAssets(ROOT), []);
  for (const asset of ANIMATOR_SOUND_MANIFEST.assets) {
    const bytes = fs.readFileSync(path.join(ROOT, "public", asset.publicUrl));
    const metadata = readWavMetadata(bytes);
    assert.equal(metadata.channels, 1);
    assert.equal(metadata.sampleRate, asset.sampleRate);
    assert.ok(Math.abs(metadata.durationSeconds - asset.durationSeconds) < 0.001);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), asset.sha256);
    assert.ok(bytes.length < 500_000);
  }
});

test("sound generator is deterministic", async () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), "historical-sound-a-"));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), "historical-sound-b-"));
  const { spawnSync } = await import("node:child_process");
  for (const output of [first, second]) {
    const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/generate-historical-sounds.mjs"), output], { shell: false });
    assert.equal(result.status, 0, result.stderr?.toString());
  }
  for (const asset of ANIMATOR_SOUND_MANIFEST.assets) {
    const name = path.basename(asset.publicUrl);
    assert.deepEqual(fs.readFileSync(path.join(first, name)), fs.readFileSync(path.join(second, name)));
  }
  fs.rmSync(first, { recursive: true, force: true });
  fs.rmSync(second, { recursive: true, force: true });
});

test("safe mux rejects untrusted paths, symlinks, remote sources, excessive gain/count/duration", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "animator-mux-"));
  fs.writeFileSync(path.join(workspace, "video.webm"), Buffer.from("fixture"));
  fs.writeFileSync(path.join(workspace, "sound.wav"), Buffer.from("fixture"));
  fs.symlinkSync(path.join(workspace, "sound.wav"), path.join(workspace, "linked.wav"));
  const good = { workspaceRoot: workspace, videoPath: "video.webm", outputPath: "result.webm", maxDuration: 9, audioSources: [{ path: "sound.wav", gain: 0.5 }] };
  assert.doesNotThrow(() => validateMuxRequest(good));
  assert.throws(() => validateMuxRequest({ ...good, videoPath: "../../etc/passwd" }), /path|traversal/i);
  assert.throws(() => validateMuxRequest({ ...good, audioSources: [{ path: "https://example.com/a.wav", gain: 0.5 }] }), /remote|path/i);
  assert.throws(() => validateMuxRequest({ ...good, audioSources: [{ path: "linked.wav", gain: 0.5 }] }), /symlink/i);
  assert.throws(() => validateMuxRequest({ ...good, audioSources: [{ path: "sound.wav", gain: 2 }] }), /gain/i);
  assert.throws(() => validateMuxRequest({ ...good, maxDuration: 31 }), /duration/i);
  assert.throws(() => validateMuxRequest({ ...good, audioSources: Array.from({ length: 9 }, () => ({ path: "sound.wav", gain: 0.5 })) }), /source/i);
  const args = buildFfmpegMuxArgs(validateMuxRequest(good));
  assert.ok(Array.isArray(args));
  assert.equal(args.at(-1), path.join(workspace, "result.webm"));
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("real ffmpeg mux produces exactly one video stream and at least one audio stream", { timeout: 20_000 }, async (t) => {
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("ffmpeg", ["-version"], { shell: false }).status !== 0 || spawnSync("ffprobe", ["-version"], { shell: false }).status !== 0) {
    t.skip("ffmpeg/ffprobe unavailable");
    return;
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "animator-real-mux-"));
  const fixture = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1", "-an", "-c:v", "libvpx-vp9", path.join(workspace, "video.webm")], { shell: false });
  assert.equal(fixture.status, 0, fixture.stderr?.toString());
  fs.copyFileSync(path.join(ROOT, "public", ANIMATOR_SOUND_MANIFEST.assets[0].publicUrl), path.join(workspace, "sound.wav"));
  const result = await muxAudioBed({ workspaceRoot: workspace, videoPath: "video.webm", outputPath: "result.webm", maxDuration: 1, audioSources: [{ path: "sound.wav", gain: 0.35 }] });
  assert.equal(result.videoStreams, 1);
  assert.ok(result.audioStreams >= 1);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("recording uploads use MIME magic, opaque IDs, workspace placement, and owner checks", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "animator-recordings-"));
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 1)]);
  assert.equal(detectRecordingMime(webm), "video/webm");
  assert.equal(validateRecordingUpload(webm, "video/webm;codecs=vp9"), "video/webm");
  assert.throws(() => validateRecordingUpload(webm, "video/mp4"), /MIME/i);
  assert.throws(() => validateRecordingUpload(Buffer.from("not video"), "video/webm"), /magic/i);
  const saved = saveRecording({ ownerId: "owner-a", buffer: webm, claimedMime: "video/webm", workspaceRoot: workspace });
  assert.match(saved.recordingId, /^[0-9a-f-]{36}$/i);
  assert.ok(!saved.url.includes("owner-a"));
  assert.equal(getOwnedRecording(saved.recordingId, "owner-a", workspace)?.recordingId, saved.recordingId);
  assert.equal(getOwnedRecording(saved.recordingId, "owner-b", workspace), null);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("Animator operation metadata is versioned and delimiter-safe", () => {
  const recordingId = "7d79b47a-f8f1-46ae-98f2-d30aaee5440a";
  const encoded = encodeAnimatorOperationMetadata({ providerOperationName: "heygen:provider:id:with:colons", recordingId });
  assert.ok(encoded.startsWith("heygen:animator-v1:"));
  assert.deepEqual(decodeAnimatorOperationMetadata(encoded), { version: 1, kind: "animator-voiceover", providerOperationName: "heygen:provider:id:with:colons", recordingId });
  assert.equal(decodeAnimatorOperationMetadata("heygen:legacy-id"), null);
  assert.equal(decodeAnimatorOperationMetadata("heygen:animator-v1:not-json"), null);
});

test("voiced result records are owner-scoped and contain durable verification evidence", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "animator-results-"));
  const bytes = Buffer.from("verified media bytes");
  const result = persistVoicedResult({ jobId: 17, ownerId: "owner-a", recordingId: "7d79b47a-f8f1-46ae-98f2-d30aaee5440a", resultUrl: "https://assets.example.test/voiced.webm", mimeType: "video/webm", bytes }, workspace);
  assert.equal(result.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(getOwnedVoicedResult(17, "owner-a", workspace)?.resultUrl, result.resultUrl);
  assert.equal(getOwnedVoicedResult(17, "owner-b", workspace), null);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("playback, capture, finalizer, and UI sources preserve lifecycle and terminal-state boundaries", () => {
  const soundSource = fs.readFileSync(path.join(ROOT, "src/animator/scenes/sound/SoundSystem.tsx"), "utf8");
  assert.match(soundSource, /stopAndDisconnect/);
  assert.match(soundSource, /generation\.current/);
  assert.match(soundSource, /unlocked && ready && !muted/);
  assert.doesNotMatch(soundSource, /rain_loop\.mp3|wind_snow_loop\.mp3/);
  const captureSource = fs.readFileSync(path.join(ROOT, "src/animator/capture/useCaptureSession.ts"), "utf8");
  assert.match(captureSource, /Authorization.*Bearer/);
  assert.match(captureSource, /data\.recordingId|recordingId/);
  const routeSource = fs.readFileSync(path.join(ROOT, "server/animator/routes.ts"), "utf8");
  assert.match(routeSource, /getOwnedRecording/);
  assert.match(routeSource, /recordingId: recording\.recordingId/);
  assert.doesNotMatch(routeSource, /res\.json\(\{\s*filename/);
  const serverSource = fs.readFileSync(path.join(ROOT, "server.ts"), "utf8");
  assert.ok(serverSource.indexOf("persistVoicedResult({") < serverSource.indexOf("markVoiceoverDone(job.id"));
  assert.match(serverSource, /claimVoiceoverFinalizer/);
  const finalizerSource = fs.readFileSync(path.join(ROOT, "server/animator/voicedResults.ts"), "utf8");
  assert.match(finalizerSource, /status IN \('queued','running'\).*recovery_lease_owner IS NULL/s);
  assert.match(finalizerSource, /failGenerationJobAndRefundOnce/);
  const refundSource = fs.readFileSync(path.join(ROOT, "server/generationRefunds.ts"), "utf8");
  assert.match(refundSource, /generation_refunded_at/);
  assert.match(refundSource, /FOR UPDATE/);
  const uiSource = fs.readFileSync(path.join(ROOT, "src/animator/components/AnimatorScreen.tsx"), "utf8");
  assert.match(uiSource, /voiceover-jobs/);
  assert.match(uiSource, /Verified voiced video ready/);
  assert.match(uiSource, /Download voiced video/);
  assert.doesNotMatch(uiSource, /find\(\(clip\) => clip\.name\.toLowerCase\(\) === "idle"\)/);
  const muxSource = fs.readFileSync(path.join(ROOT, "server/animator/audioMux.ts"), "utf8");
  assert.match(muxSource, /spawn\(executable, args, \{ shell: false/);
});
