# In-house 3D fixture intake

Copy or download additional `.glb` samples into:

`fixtures/inhouse3d/imports/`

That folder is excluded locally from Git so large, private, or licensed model
files are not committed by accident. Inspect the whole drop folder with:

```bash
node scripts/audit-glb-fixtures.mjs --folder fixtures/inhouse3d/imports
```

The audit reports independent gates for GLB parsing, mesh content, embedded
textures, skin/rig structure, animation clips, and external URIs. A model is
never labeled globally “good” merely because one of those gates passes.

Build the private per-file passability report with:

```bash
npx tsx scripts/build-model-intake-report.ts
```

The generated `docs/MODEL_INTAKE_REPORT.html` stays local because it contains
private intake filenames. Its ready/remap/animate/rig/reject buckets are
structural gates; every ready candidate still requires a rendered visual check.

For a durable regression sample, add an entry to `manifest.json` using a stable
path and an explicit expected result for every gate. Do not copy a model into
the repository until its license and redistribution status are known.
