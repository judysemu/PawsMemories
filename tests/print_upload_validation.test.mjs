import test from "node:test";
import assert from "node:assert/strict";
import { validatePrintUpload } from "../server/printUploadValidation.ts";
import fs from "node:fs";

const dataUrl = (mime, bytes) =>
  `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

test("accepts a structurally valid GLB and canonicalizes its MIME", () => {
  const glb = fs.readFileSync(
    new URL("../fixtures/1m-cube.glb", import.meta.url),
  );
  const result = validatePrintUpload(
    dataUrl("application/octet-stream", glb),
    "application/octet-stream",
  );
  assert.equal(result.mime, "model/gltf-binary");
  assert.equal(result.bytes, glb.length);
});

test("accepts valid glTF JSON, OBJ, ASCII STL, and binary STL", () => {
  const gltf = Buffer.from(
    JSON.stringify({ asset: { version: "2.0" }, scenes: [] }),
  );
  assert.equal(
    validatePrintUpload(dataUrl("model/gltf+json", gltf), "model/gltf+json")
      .mime,
    "model/gltf+json",
  );

  const obj = Buffer.from("o Pet\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
  assert.equal(
    validatePrintUpload(dataUrl("text/plain", obj), "text/plain").mime,
    "model/obj",
  );

  const asciiStl = Buffer.from(
    "solid pet\nfacet normal 0 0 1\n outer loop\n vertex 0 0 0\n vertex 1 0 0\n vertex 0 1 0\n endloop\nendfacet\nendsolid pet\n",
  );
  assert.equal(
    validatePrintUpload(dataUrl("model/stl", asciiStl), "model/stl").mime,
    "model/stl",
  );

  const binaryStl = Buffer.alloc(84 + 50);
  binaryStl.writeUInt32LE(1, 80);
  assert.equal(
    validatePrintUpload(
      dataUrl("application/octet-stream", binaryStl),
      "application/octet-stream",
    ).mime,
    "model/stl",
  );
});

test("rejects spoofed MIME, malformed base64, invalid structures, and oversize declarations", () => {
  const glb = fs.readFileSync(
    new URL("../fixtures/1m-cube.glb", import.meta.url),
  );
  assert.throws(
    () => validatePrintUpload(dataUrl("image/png", glb), "image/png"),
    /MIME type/,
  );
  assert.throws(
    () =>
      validatePrintUpload(
        "data:model/gltf-binary;base64,%%%%",
        "model/gltf-binary",
      ),
    /base64/,
  );
  assert.throws(
    () =>
      validatePrintUpload(
        dataUrl("model/gltf-binary", "not a model"),
        "model/gltf-binary",
      ),
    /not a valid/,
  );
  const oversizedBase64 = "A".repeat(Math.ceil((25 * 1024 * 1024 + 4) / 3) * 4);
  assert.throws(
    () =>
      validatePrintUpload(
        `data:model/gltf-binary;base64,${oversizedBase64}`,
        "model/gltf-binary",
      ),
    /25 MB/,
  );
});

test("print upload route is authenticated, rate-limited, quota-counted, and content-validated", () => {
  const source = fs.readFileSync(
    new URL("../server.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /app\.post\("\/api\/print-uploads", requireAuth, printUploadLimiter/,
  );
  assert.match(source, /validatePrintUpload\(fileBase64, mime\)/);
  assert.match(source, /bumpDailyUsage\(req\.user!\.phone, "print_upload"\)/);
});
