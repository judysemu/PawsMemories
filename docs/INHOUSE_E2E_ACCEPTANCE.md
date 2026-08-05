# In-house image-to-animated-GLB acceptance

This is the final no-customer-billing acceptance command for one real pet
image. It does not create a customer order, reserve PupCoins, write to the
database, or use an outside generative provider. The GPU host still incurs its
ordinary Azure compute cost while allocated, so run the command only inside a
deliberately opened test window and deallocate the worker afterward.

It proves this exact sequence:

1. The local uploaded-front provider decodes and canonicalizes one real image.
2. The authenticated private worker reports CUDA plus the approved TRELLIS
   model/source revisions and the connected, exactly pinned Blender worker.
3. TRELLIS generates a PBR GLB from that front image.
4. The production stage validator reopens and measures the PBR base.
5. The free rig-capability stage inspects the existing GLB locally without
   starting Blender.
6. The paid-stage implementation is exercised without billing: the private
   worker runs Blender rigging and bakes `idle` and `walk`.
7. The production validator independently requires a mesh, embedded PBR
   material, skin, weights, valid animation targets, and both animation clips.
8. The verified final GLB and a redacted PASS/FAIL report are written locally.

## Run it

Use the GPU worker's private IP directly, or an SSH tunnel bound to loopback.
The harness deliberately refuses public hostnames, redirects, URL credentials,
query strings, and every route outside the audited worker contract.

```bash
export TRELLIS_WORKER_URL="http://10.0.2.4:8000"
export BLENDER_WORKER_REVISION="<exact-reviewed-worker-build-revision>"
read -s TRELLIS_WORKER_SHARED_SECRET
export TRELLIS_WORKER_SHARED_SECRET

npm run accept:inhouse-e2e -- \
  --input "/absolute/path/to/real-pet-photo.jpg" \
  --output "/absolute/path/to/accepted-pet.glb" \
  --report "/absolute/path/to/accepted-pet-report.json"
```

The worker secret is accepted only from the environment and is never printed
or placed in the JSON report. Output files are created with owner-only
permissions. Existing GLB or report output is not overwritten unless
`--overwrite` is supplied explicitly, and neither target may reuse the source
image path.

Do not run this against the earlier cached images: they predate the aggregate
Blender readiness fields and are expected to fail closed. Both worker images
must first be rebuilt from the same reviewed checkpoint, privately cached and
read back, then pinned in the selected runtime lane.

Use `--mesh-profile hd` for the higher triangle target. The default is
`smart_mesh`. Polling defaults to five seconds and the whole run is bounded to
90 minutes; `--poll-ms` and `--timeout-minutes` can reduce those limits.

## Acceptance rule

Only `IN-HOUSE E2E PASS` with every step marked `PASS`, `external=0`,
`blocked=0`, and a final SHA-256 is completion evidence. CUDA readiness alone,
a worker health response, a base mesh, or an existing rigged fixture does not
count as this end-to-end proof.

The harness is intentionally separate from customer payment and persistence.
After it passes, the customer-path cutover still requires an authenticated
credit reservation/refund test against the exact release selected for deploy.
