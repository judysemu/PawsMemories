import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * UV2 — canonical view rendering.
 *
 * These are source-level contract tests, matching the approach already used by
 * tests/texture_rebake.test.mjs. Blender is not available in CI, so the Python
 * cannot be executed; what CAN be checked mechanically is the property that
 * actually breaks the pipeline — that the render cameras and the bake cameras
 * agree. A rotated bake looks fine in every individual view and only reveals
 * itself when someone orbits a finished model, so it needs to fail here.
 */

const repoRoot = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(repoRoot, p), "utf8");

const REBAKE_PY = "blender-worker/jobs/rebake_texture.py";
const RENDER_PY = "blender-worker/jobs/render_views.py";

function pythonAvailable() {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compare a function between the two scripts by its parsed AST with the
 * docstring removed, so prose and comments may differ but no executable
 * statement can. String comparison would fail on comment drift; this fails only
 * on real divergence.
 */
const COMPARE_SCRIPT = `
import ast, json, sys

def fn(path, name):
    src = open(path).read()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            n = ast.parse(ast.unparse(node)).body[0]
            if (n.body and isinstance(n.body[0], ast.Expr)
                    and isinstance(n.body[0].value, ast.Constant)
                    and isinstance(n.body[0].value.value, str)):
                n.body = n.body[1:]
            return ast.unparse(n)
    return None

def const(path, name):
    for node in ast.parse(open(path).read()).body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], 'id', None) == name:
            return ast.literal_eval(node.value)
    return None

a, b, names = sys.argv[1], sys.argv[2], sys.argv[3].split(',')
out = {"functions": {}, "azimuth_a": const(a, 'VIEW_AZIMUTH_DEG'), "azimuth_b": const(b, 'VIEW_AZIMUTH_DEG')}
for n in names:
    fa, fb = fn(a, n), fn(b, n)
    out["functions"][n] = {"present": fa is not None and fb is not None, "identical": fa == fb}
print(json.dumps(out))
`;

test("render and bake scripts place cameras identically", (t) => {
  if (!pythonAvailable()) return t.skip("python3 unavailable");
  const raw = execFileSync(
    "python3",
    ["-c", COMPARE_SCRIPT, path.join(repoRoot, REBAKE_PY), path.join(repoRoot, RENDER_PY),
     "_make_camera,_scene_bounds,_mesh_objects"],
    { encoding: "utf8" },
  );
  const result = JSON.parse(raw);

  for (const [name, info] of Object.entries(result.functions)) {
    assert.ok(info.present, `${name} must exist in both scripts`);
    assert.ok(
      info.identical,
      `${name} diverged between ${REBAKE_PY} and ${RENDER_PY}. ` +
        `UV2 renders and UV4 bakes must share one camera convention — a mismatch ` +
        `silently rotates every baked texture.`,
    );
  }

  assert.deepEqual(
    result.azimuth_a,
    result.azimuth_b,
    "VIEW_AZIMUTH_DEG must match between render and bake",
  );
  assert.deepEqual(result.azimuth_a, { front: 0, right: 90, back: 180, left: 270 });
});

test("both scripts are syntactically valid Python", (t) => {
  if (!pythonAvailable()) return t.skip("python3 unavailable");
  for (const f of [REBAKE_PY, RENDER_PY]) {
    execFileSync("python3", ["-c", `import ast;ast.parse(open(${JSON.stringify(path.join(repoRoot, f))}).read())`]);
  }
});

test("render script documents the convention it duplicates", () => {
  const src = read(RENDER_PY);
  // The duplication is deliberate and load-bearing; if someone deletes the
  // explanation the next reader will "clean it up" into a divergence.
  assert.match(src, /rebake_texture\.py/, "must name the file it must stay in sync with");
  assert.match(src, /azimuth 0 = camera on -Y looking toward \+Y/i);
});

test("view sets follow the plan's tier rules (D3)", (t) => {
  if (!pythonAvailable()) return t.skip("python3 unavailable");
  const raw = execFileSync(
    "python3",
    ["-c",
     `import ast,json,sys
src=open(sys.argv[1]).read()
out={}
for node in ast.parse(src).body:
    if isinstance(node, ast.Assign) and getattr(node.targets[0],'id',None) in ('VIEW_SETS','TIER_RESOLUTION','CORNER_AZIMUTH_DEG','MAX_RESOLUTION'):
        out[node.targets[0].id]=ast.literal_eval(node.value)
print(json.dumps(out))`,
     path.join(repoRoot, RENDER_PY)],
    { encoding: "utf8" },
  );
  const { VIEW_SETS, TIER_RESOLUTION, CORNER_AZIMUTH_DEG, MAX_RESOLUTION } = JSON.parse(raw);

  // D3: Draft is 4 views low-res, Studio is 8 views high-res.
  assert.equal(VIEW_SETS.draft.length, 4, "Draft renders the four cardinals");
  assert.equal(VIEW_SETS.studio.length, 8, "Studio renders eight views");
  assert.ok(
    TIER_RESOLUTION.draft < TIER_RESOLUTION.studio,
    "Draft must render at lower resolution than Studio",
  );

  // Every named view must resolve to an azimuth, or the render throws at runtime.
  const known = new Set([...Object.keys(CORNER_AZIMUTH_DEG), "front", "right", "back", "left"]);
  for (const [tier, views] of Object.entries(VIEW_SETS)) {
    for (const v of views) {
      assert.ok(known.has(v), `${tier} references unknown view "${v}"`);
    }
  }

  assert.ok(MAX_RESOLUTION <= 2048, "resolution ceiling keeps worker cost bounded");
});

test("worker exposes render-views following the bridge pattern", () => {
  const server = read("blender-worker/server.js");
  assert.match(server, /app\.post\("\/texture\/render-views"/);
  // Same import-then-run-script shape as /texture/rebake and /bake-lod.
  const block = server.slice(
    server.indexOf('app.post("/texture/render-views"'),
    server.indexOf('app.post("/agent/build"'),
  );
  assert.match(block, /RENDER_VIEWS_SCRIPT_PATH/);
  assert.match(block, /bpy\.ops\.import_scene\.gltf/, "must import the GLB before rendering");
  assert.match(block, /run_render_views/);
  assert.match(block, /RENDER_VIEWS_RESULT/);
  assert.match(block, /glb_base64 or glb_url is required/);
});

test("render script cleans up its cameras", () => {
  const src = read(RENDER_PY);
  // A leftover camera becomes scene geometry for any later bounds computation
  // in the same Blender session, quietly shifting a subsequent bake.
  assert.match(src, /bpy\.data\.objects\.remove\(cam, do_unlink=True\)/);
});

test("render script emits camera metadata for re-projection", () => {
  const src = read(RENDER_PY);
  for (const key of ["ortho_scale", "rotation_euler", "location", "direction", "azimuth_deg"]) {
    assert.ok(src.includes(key), `camera metadata must carry ${key} for UV4 re-projection`);
  }
});

test("render script fails as data, never as an exception", () => {
  const src = read(RENDER_PY);
  // The worker parses stdout for the result marker; an uncaught traceback would
  // surface as an opaque "render-views failed" with the cause only in logs.
  assert.match(src, /except Exception/);
  assert.match(src, /"success": False/);
});

test("render worker selects an engine supported by the running Blender build", () => {
  const src = read(RENDER_PY);
  assert.match(src, /def _select_render_engine\(/);
  assert.match(src, /scene\.render\.engine = _select_render_engine\(scene\)/);
  assert.doesNotMatch(
    src,
    /scene\.render\.engine\s*=\s*["']BLENDER_EEVEE_NEXT["']/,
    "Blender 5.x must not fail before the EEVEE fallback can run",
  );
});

test("standard cameras use Blender camera-local Y as the up axis", () => {
  for (const f of [REBAKE_PY, RENDER_PY]) {
    const src = read(f);
    assert.match(
      src,
      /to_track_quat\(["']-Z["'],\s*["']Y["']\)/,
      `${f} must keep the model upright in cardinal review views`,
    );
  }
});
