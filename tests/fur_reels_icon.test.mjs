import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const iconPath = fileURLToPath(new URL("../public/brand/fur-reels-icon.png", import.meta.url));

test("Fur Reels icon is a tightly cropped standalone transparent glyph", async () => {
  const { data, info } = await sharp(iconPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.ok(info.width <= 512 && info.height <= 512, "sidebar glyph should not retain the source canvas");

  const alphaAt = (x, y) => data[(y * info.width + x) * 4 + 3];
  assert.equal(alphaAt(Math.floor(info.width / 2), Math.floor(info.height / 2)), 0, "white center panel must be transparent");

  let opaque = 0;
  for (let index = 3; index < data.length; index += 4) if (data[index] > 16) opaque += 1;
  assert.ok(opaque > info.width * info.height * 0.08, "film and pet line art must remain visible");
});
