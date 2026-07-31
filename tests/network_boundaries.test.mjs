import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import test from "node:test";

import { fetchBoundedRemoteBuffer } from "../server/safeRemoteFetch.ts";

test("bounded remote fetch rejects redirects, disallowed origins, and oversized streams", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/ok" });
      return res.end();
    }
    if (req.url === "/large") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(Buffer.alloc(2048, 1));
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "2" });
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const ok = await fetchBoundedRemoteBuffer(`${origin}/ok`, {
    allowedOrigins: [origin], maxBytes: 10, timeoutMs: 2_000, allowHttpForTests: true,
  });
  assert.equal(ok.buffer.toString(), "ok");
  await assert.rejects(() => fetchBoundedRemoteBuffer(`${origin}/redirect`, {
    allowedOrigins: [origin], maxBytes: 10, timeoutMs: 2_000, allowHttpForTests: true,
  }), /redirect/i);
  await assert.rejects(() => fetchBoundedRemoteBuffer(`${origin}/large`, {
    allowedOrigins: [origin], maxBytes: 100, timeoutMs: 2_000, allowHttpForTests: true,
  }), /size limit/i);
  await assert.rejects(() => fetchBoundedRemoteBuffer(`${origin}/ok`, {
    allowedOrigins: ["http://127.0.0.1:1"], maxBytes: 10, timeoutMs: 2_000, allowHttpForTests: true,
  }), /origin/i);
});

test("download, customizer, and Animator routes enforce owner/auth boundaries", async () => {
  const [serverSource, routesSource, assetsSource, scenesSource, customizerSource] = await Promise.all([
    fs.readFile(new URL("../server.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../server/animator/routes.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../server/animator/assets.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../server/animator/scenes.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../server/customizerCheckout.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(serverSource, /express\.static\(ANIMATOR_DATA_DIR\)/);
  assert.match(serverSource, /animatorAliasPrefixes/);
  assert.match(serverSource, /userOwnsCreationMediaUrl/);
  assert.match(serverSource, /fetchBoundedRemoteBuffer/);
  assert.doesNotMatch(assetsSource, /fetch\(args\.sourceUrl\)|sourceUrl\?:/);
  assert.doesNotMatch(routesSource, /sourceUrl:\s*modelUrl/);
  assert.match(scenesSource, /const id = uuidv4\(\)/);
  assert.doesNotMatch(scenesSource, /partial\.id\s*\|\|/);
  assert.match(customizerSource, /resolveOwnedCustomizerSource/);
  assert.doesNotMatch(customizerSource, /fetch\(String\(input\.sourcePhotoUrl\)/);
});
