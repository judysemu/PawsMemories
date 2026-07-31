import test from "node:test";
import assert from "node:assert";
import { ALL_OBJECT_KINDS, OBJECT_CATALOG } from "../src/three/objects/catalog.ts";
import fs from "fs";
import path from "path";

test("animator_object_palette", async (t) => {
  await t.test("catalog never points at an absent GLB", () => {
    for (const kind of ALL_OBJECT_KINDS) {
      const def = OBJECT_CATALOG[kind];
      if (!def.glbUrl) continue;
      assert.ok(def.glbUrl.endsWith(".glb"), `kind ${kind} glbUrl must be a .glb file`);
      assert.ok(def.glbUrl.startsWith("/objects/"), `kind ${kind} glbUrl must be in /objects/`);
      assert.ok(fs.existsSync(path.join(process.cwd(), "public", def.glbUrl)), `${def.glbUrl} must exist`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "public/objects/manifest.json"), "utf8"));
    assert.deepEqual(manifest.assets, {});
  });

  await t.test("catalog defines emoji and label for all objects", () => {
    for (const kind of ALL_OBJECT_KINDS) {
      const def = OBJECT_CATALOG[kind];
      assert.ok(def.label, `kind ${kind} missing label`);
      assert.ok(def.emoji, `kind ${kind} missing emoji`);
    }
  });
});
