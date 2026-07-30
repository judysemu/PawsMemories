import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeModelBuildProvider, TripoModelBuildAdapter } from "../server/model-builds/provider.ts";
import { mintObjectKey } from "../server/model-builds/storage.ts";

describe("Phase 3 Provider Port and Adapter Test Suite", () => {
  it("FakeModelBuildProvider should return valid GLB bytes", async () => {
    const fake = new FakeModelBuildProvider();
    const startRes = await fake.start({
      frontUrl: "https://api.tripo3d.ai/fake/front.png",
      leftUrl: "https://api.tripo3d.ai/fake/left.png",
      rightUrl: "https://api.tripo3d.ai/fake/right.png",
      rearUrl: "https://api.tripo3d.ai/fake/rear.png",
      threeQuarterUrl: "https://api.tripo3d.ai/fake/tq.png",
    }, "config123");

    assert.ok(startRes.providerTaskHandle.startsWith("fake:"));
    assert.equal(startRes.provider, "fake");

    // Poll 1
    const poll1 = await fake.poll(startRes.providerTaskHandle);
    assert.equal(poll1.done, false);

    // Poll 2
    const poll2 = await fake.poll(startRes.providerTaskHandle);
    assert.equal(poll2.done, true);
    assert.ok(poll2.glbUrl);

    // Download
    const bytes = await fake.download(poll2.glbUrl);
    assert.ok(bytes.length >= 12);
    assert.equal(bytes.readUInt32LE(0), 0x46546C67); // "glTF"
  });

  it("TripoModelBuildAdapter download should reject URLs outside allowlist", async () => {
    const adapter = new TripoModelBuildAdapter();
    await assert.rejects(
      async () => {
        await adapter.download("https://evil.com/malicious.glb");
      },
      (err) => err.message.includes("Blocked download URL"),
    );
  });

  it("TripoModelBuildAdapter download should reject non-HTTPS URLs", async () => {
    const adapter = new TripoModelBuildAdapter();
    await assert.rejects(
      async () => {
        await adapter.download("http://api.tripo3d.ai/fake.glb");
      },
      (err) => err.message.includes("Blocked download URL"),
    );
  });

  it("TripoModelBuildAdapter accepts the current regional signed-download host", async () => {
    const originalFetch = globalThis.fetch;
    const glb = Buffer.alloc(12);
    glb.writeUInt32LE(0x46546C67, 0);
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(glb.length, 8);
    globalThis.fetch = async (url) => {
      assert.equal(new URL(String(url)).hostname, "tripo-data.rg1.data.tripo3d.com");
      return new Response(glb, {
        status: 200,
        headers: { "content-type": "model/gltf-binary" },
      });
    };
    try {
      const adapter = new TripoModelBuildAdapter();
      const downloaded = await adapter.download("https://tripo-data.rg1.data.tripo3d.com/task/model.glb");
      assert.deepEqual(downloaded, glb);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("model storage keys omit owner identifiers and reject traversal", () => {
    const key = mintObjectKey("private-user@example.com", "11111111-1111-4111-8111-111111111111", 1, "provider_glb", "glb");
    assert.equal(key.includes("private-user"), false);
    assert.match(key, /^models\/11111111-1111-4111-8111-111111111111\/attempt-1\/provider_glb-/);
    assert.throws(() => mintObjectKey("owner", "../escape", 1, "provider_glb", "glb"));
  });
});
