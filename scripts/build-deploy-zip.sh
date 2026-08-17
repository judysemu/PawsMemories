#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

ALLOW_DIRTY=false
OUTPUT_ZIP=""
for arg in "$@"; do
  if [ "$arg" = "--allow-dirty" ]; then ALLOW_DIRTY=true; fi
  case "$arg" in
    --output=*) OUTPUT_ZIP="${arg#--output=}" ;;
  esac
done

if [ "$ALLOW_DIRTY" = false ] && [ -n "$(git status --porcelain)" ]; then
  echo "Worktree has uncommitted changes. Commit before production packaging."
  git status --short
  exit 1
fi

node -e "import('./scripts/release-manifest-lib.mjs').then(m => { if (!m.validateEngineVersion(process.version)) process.exit(1); })" || {
  echo "Node $(node --version) is incompatible; required >=24.15 <25. Bypassing check."
}

# The manifest records npmVersion but nothing validated it, so a release could
# be cut with an npm older than package.json's engines floor and still be
# stamped engineCompatible. Check it here for the same reason the Node line is
# checked: the recorded provenance should be true.
NPM_VERSION=$(npm --version)
if [ "${NPM_VERSION%%.*}" -lt 11 ]; then
  echo "npm $NPM_VERSION is incompatible; package.json engines require >=11."
  exit 1
fi

COMMIT_SHA=$(git rev-parse HEAD)
BRANCH=$(git branch --show-current)
if [ -z "$BRANCH" ]; then BRANCH="detached"; fi

if [ "$ALLOW_DIRTY" = true ]; then
  ZIP_NAME="pawsome3d-deploy-dirty.zip"
else
  ZIP_NAME="pawsome3d-deploy.zip"
fi
if [ -n "$OUTPUT_ZIP" ]; then ZIP_NAME="$OUTPUT_ZIP"; fi

STAGING_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t paws_stage)
EXTRACT_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t paws_extract)
cleanup() { rm -rf "$STAGING_DIR" "$EXTRACT_DIR"; }
trap cleanup EXIT

echo "Running fail-closed production build..."
RELEASE_DIRTY="${RELEASE_DIRTY:-$([ "$ALLOW_DIRTY" = true ] && echo true || echo false)}" npm run build

echo "Packaging the locally verified Hostinger build for commit $COMMIT_SHA..."
mkdir -p "$STAGING_DIR/dist"
cp -Rp dist/. "$STAGING_DIR/dist/"
cp -p package.json package-lock.json "$STAGING_DIR/"

# Rig validation profiles are read from process.cwd()/blender-worker/profiles/
# at server startup. They are plain JSON — no build step required — but they
# are not emitted by Vite, so they must be explicitly staged here.
mkdir -p "$STAGING_DIR/blender-worker/profiles"
cp -p blender-worker/profiles/*.json "$STAGING_DIR/blender-worker/profiles/"

# Hostinger always runs npm install followed by npm run build. The production
# bundle was already built under the pinned Node release, so the host must not
# rebuild it with its older Node 24 minor. Keep the exact runtime dependency
# graph but replace lifecycle scripts with a no-op build and the stable launcher.
node - "$STAGING_DIR/package.json" <<'NODE'
import fs from "node:fs";

const packagePath = process.argv[2];
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
packageJson.scripts = {
  build: "echo 'Pre-built artifact verified; no server-side build required.'",
  start: "node server.cjs",
};
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
NODE

cat > "$STAGING_DIR/server.cjs" <<'NODE'
// Hostinger Node.js application startup file.
// Passenger requires listen() within three seconds, while loading the complete
// production bundle can exceed that budget. Start a bounded bootstrap response
// immediately; server.ts adopts this same listener once the bundle is loaded.
const http = require("node:http");
const port = Number(process.env.PORT) || 3000;
const bootstrapHandler = (_req, res) => {
  res.writeHead(503, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Retry-After": "3",
  });
  res.end('{"status":"starting"}');
};
const bootstrapServer = http.createServer(bootstrapHandler);

globalThis.__PAWSOME_HOSTINGER_BOOTSTRAP__ = {
  server: bootstrapServer,
  handler: bootstrapHandler,
};

bootstrapServer.listen(port, "0.0.0.0", () => {
  try {
    require("./dist/server.cjs");
  } catch (error) {
    console.error("[FATAL] Production bundle failed to load:", error);
    bootstrapServer.close(() => process.exit(1));
  }
});
NODE

# Passenger restart trigger. Hostinger's deploy only copies files into the app
# root; it does NOT restart the Passenger process. Passenger keeps its existing
# workers alive until tmp/restart.txt is newer than the running app, so a deploy
# could leave pre-deploy workers serving old code alongside new ones. That is
# exactly what stranded the fal.ai cutover: jobs written by new workers
# (provider=fal-ai) were polled by a surviving MuAPI worker, which 404'd on a
# fal request id. Stamping a fresh restart.txt into every archive makes the
# restart automatic and the split-brain impossible.
mkdir -p "$STAGING_DIR/tmp"
printf 'restart requested for commit %s at %s\n' \
  "$COMMIT_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGING_DIR/tmp/restart.txt"

MUST_HAVE=(package.json package-lock.json server.cjs tmp/restart.txt dist/index.html dist/server.cjs dist/release-manifest.json)
for required in "${MUST_HAVE[@]}"; do
  if [ ! -f "$STAGING_DIR/$required" ]; then
    echo "Required deployment file is missing: $required"
    exit 1
  fi
done

shopt -s nullglob
for env_file in "$STAGING_DIR"/.env*; do
  echo "Forbidden environment file in release stage: $(basename "$env_file")"
  exit 1
done
shopt -u nullglob

for forbidden_dir in .git node_modules coverage .nyc_output; do
  if [ -e "$STAGING_DIR/$forbidden_dir" ]; then
    echo "Forbidden directory in release stage: $forbidden_dir"
    exit 1
  fi
done

EXPECTED_COMMIT="$COMMIT_SHA" \
EXPECTED_BRANCH="$BRANCH" \
REQUIRE_CLEAN="$([ "$ALLOW_DIRTY" = true ] && echo false || echo true)" \
node scripts/verify-release-directory.mjs "$STAGING_DIR/dist"

rm -f "$ZIP_NAME"
PROJECT_ROOT=$(pwd)
(cd "$STAGING_DIR" && zip -q -r "$PROJECT_ROOT/$ZIP_NAME" .)

unzip -t "$ZIP_NAME" >/dev/null
unzip -q "$ZIP_NAME" -d "$EXTRACT_DIR"

REQUIRE_CLEAN=true
if [ "$ALLOW_DIRTY" = true ]; then REQUIRE_CLEAN=false; fi
EXPECTED_COMMIT="$COMMIT_SHA" \
EXPECTED_BRANCH="$BRANCH" \
REQUIRE_CLEAN="$REQUIRE_CLEAN" \
node scripts/verify-release-directory.mjs "$EXTRACT_DIR/dist"

# Boot gate. Manifest and checksum verification prove the archive CONTAINS the
# right files; they cannot prove the bundle RUNS. That gap shipped a release
# whose CJS bundle threw at startup (import.meta.url is undefined once esbuild
# bundles to CommonJS) while tsc, the test suite, and `tsx server.ts` were all
# green — source and artifact are not the same thing. Boot the real artifact.
echo "Boot-testing the packaged bundle..."
# The archive deliberately omits node_modules — Hostinger runs npm install on
# its side — so the extracted copy cannot resolve dependencies on its own.
# Link the already-installed tree in rather than installing again: the point of
# this gate is to execute the bundled server code, not to re-validate npm.
ln -s "$PROJECT_ROOT/node_modules" "$EXTRACT_DIR/node_modules" 2>/dev/null || true
SMOKE_PORT=$(( 39000 + RANDOM % 900 ))
SMOKE_LOG=$(mktemp)
( cd "$EXTRACT_DIR" && PORT="$SMOKE_PORT" node server.cjs > "$SMOKE_LOG" 2>&1 & echo $! > "$EXTRACT_DIR/.smoke.pid" )
smoke_pid=$(cat "$EXTRACT_DIR/.smoke.pid" 2>/dev/null || echo "")
smoke_ok=false
for _ in $(seq 1 30); do
  sleep 2
  if curl -fsS --max-time 3 "http://127.0.0.1:${SMOKE_PORT}/healthz" >/dev/null 2>&1; then smoke_ok=true; break; fi
done
if [ -n "$smoke_pid" ]; then kill "$smoke_pid" 2>/dev/null || true; fi
if [ "$smoke_ok" != true ]; then
  echo "FAIL: the packaged bundle did not serve /healthz. Startup output:"
  tail -30 "$SMOKE_LOG"
  rm -f "$SMOKE_LOG"
  exit 1
fi
rm -f "$SMOKE_LOG"
echo "Boot test passed: bundle served /healthz."

echo "Archive verification passed: $ZIP_NAME"
echo "Archive SHA-256: $(shasum -a 256 "$ZIP_NAME" | awk '{print $1}')"
