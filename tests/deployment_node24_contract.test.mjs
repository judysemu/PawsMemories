import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
const deployScript = readFileSync(new URL("../scripts/build-deploy-zip.sh", import.meta.url), "utf8");

test("deployment is pinned to the supported Node 24 LTS line", () => {
  assert.equal(packageJson.engines.node, ">=24.15 <25");
  assert.equal(readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim(), "24.18.0");
  assert.equal(packageJson.dependencies.sharp, "^0.35.3");
  assert.equal(packageJson.overrides.sharp, "$sharp");
});

test("release packaging validates both pinned runtime versions", () => {
  // The manifest records npmVersion; without this guard a release could be cut
  // on npm 10 and still be stamped engineCompatible, which is how the
  // 2026-08-04 archive ended up claiming npm 10.8.2 against an engines floor
  // of >=11.
  assert.match(deployScript, /validateEngineVersion\(process\.version\)/);
  assert.match(deployScript, /engines require >=11/);
  assert.equal(packageJson.engines.npm, ">=11");
});

test("unknown /api routes answer with JSON 404 rather than the SPA shell", () => {
  // app.get("*") would otherwise serve index.html with a 200 for a mistyped or
  // retired endpoint, so a failing fetch() looked successful until .json() threw.
  const apiFallbackIndex = serverSource.indexOf('app.use("/api", (_req, res) => {');
  const spaCatchAllIndex = serverSource.indexOf('app.get("*", serveSpaShell)');

  assert.notEqual(apiFallbackIndex, -1, "the /api 404 fallback is missing");
  assert.notEqual(spaCatchAllIndex, -1, "the SPA catch-all is missing");
  assert.ok(
    apiFallbackIndex < spaCatchAllIndex,
    "the /api 404 fallback must be registered before the SPA catch-all",
  );
});

test("Hostinger archive uses the verified local build instead of rebuilding on the host", () => {
  assert.match(deployScript, /cp -Rp dist\/\. \"\$STAGING_DIR\/dist\/\"/);
  assert.match(deployScript, /Pre-built artifact verified/);
  assert.match(deployScript, /node server\.cjs/);
  assert.match(deployScript, /verify-release-directory\.mjs \"\$EXTRACT_DIR\/dist\"/);
  assert.doesNotMatch(deployScript, /git archive HEAD/);
});

test("Hostinger starts listening before database initialization", () => {
  const listenIndex = serverSource.indexOf("httpServer = app.listen(");
  const initDbIndex = serverSource.indexOf("await initDb();");

  assert.notEqual(listenIndex, -1, "server listener is missing");
  assert.notEqual(initDbIndex, -1, "database initialization is missing");
  assert.ok(listenIndex < initDbIndex, "Passenger requires listen() before database migrations");
  assert.match(serverSource, /httpServer\.close\(\(\) => resolve\(\)\)/);
  assert.match(deployScript, /http\.createServer\(bootstrapHandler\)/);
  assert.match(deployScript, /bootstrapServer\.listen\(port, "0\.0\.0\.0"/);
  assert.match(deployScript, /globalThis\.__PAWSOME_HOSTINGER_BOOTSTRAP__/);
  assert.match(serverSource, /httpServer\.removeListener\("request", bootstrap\.handler\)/);
  assert.match(serverSource, /httpServer\.on\("request", readinessGate\)/);
  assert.match(serverSource, /if \(isEntryPoint \|\| hasHostingerBootstrap\)/);
});

test("the adopted socket answers 503 until every route is registered", () => {
  // Handing the socket straight to Express opened a window between adoption and
  // the end of route registration — thousands of lines later, and after initDb's
  // migrations — where a request hit a live app that had no such route yet and
  // got Express's 404. In production that surfaced as an intermittent
  // "Cannot GET /readyz" during restarts, which reads as a broken deploy rather
  // than a starting one. The gate must open only after the last route exists.
  const gateIndex = serverSource.indexOf("const readinessGate =");
  const initDbIndex = serverSource.indexOf("await initDb();");
  const spaCatchAllIndex = serverSource.indexOf('app.get("*", serveSpaShell)');
  const readyIndex = serverSource.indexOf("markRoutesReady();");

  assert.notEqual(gateIndex, -1, "the readiness gate is missing");
  assert.notEqual(readyIndex, -1, "the gate is never opened");
  assert.ok(gateIndex < initDbIndex, "the gate must be installed before migrations run");
  assert.ok(
    spaCatchAllIndex < readyIndex,
    "the gate must open after the last route is registered, not before",
  );
  assert.match(serverSource, /res\.end\('\{"status":"starting"\}'\)/);
});

test("brand logo and product deep links remain part of the application shell", () => {
  assert.match(appSource, /\/brand\/pawsome-logo\.png/);
  for (const path of ["/home", "/furball3d", "/animator", "/pawprints", "/fidos-styles"]) {
    assert.ok(appSource.includes(path), `missing app path ${path}`);
  }
});

test("media-heavy JSON routes receive the scoped 50 MB parser", () => {
  assert.match(serverSource, /express\.json\(\{ limit: "50mb" \}\)/);
  for (const path of ["/api/avatars", "/api/image-to-3d", "/api/pawprints/generate", "/api/profile/photos"]) {
    assert.ok(serverSource.includes(path), `missing upload parser path ${path}`);
  }
});
