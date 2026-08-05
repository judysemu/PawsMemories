# TRELLIS.2 GPU Worker

Authenticated, single-concurrency image-to-GLB worker for the in-house
Pawsome3D pipeline. It pins Microsoft TRELLIS.2 source revision
`75fbf0183001ed9876c8dbb35de6b68552ee08bd` and CUDA 12.4.

The runtime contract deliberately accepts image bytes, not arbitrary URLs. The
core service owns reference authorization and uploads approved bytes to the
private worker, preventing the GPU service from becoming an SSRF proxy.

Endpoints:

- `GET /healthz`: process liveness only.
- `GET /readyz`: authenticated CUDA/model readiness.
- `POST /v1/jobs`: authenticated multipart image submission.
- `GET /v1/jobs/{id}`: authenticated durable status.
- `GET /v1/jobs/{id}/artifact`: authenticated GLB download.
- `POST /v1/jobs/{id}/finalize`: queue the internal Blender rig and clip bake.
- `GET /v1/jobs/{id}/final-artifact`: authenticated final rigged/animated GLB.

The model weights are downloaded once to a persistent volume, then the serving
container runs with `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`. Runtime
inference therefore makes no call to Hugging Face or another model API.

This worker creates geometry and PBR material, then durably coordinates the
separate Blender rig and animation stages. TRELLIS job bytes stay on the GPU
host: the TRELLIS adapter emits a provider-neutral artifact locator, and
Blender's replaceable shared-artifact resolver reads only a hash-verified
`master.glb` from the read-only volume. Authenticated container-network calls
return the measured rig and baked clips. A final result is accepted only when
the rig rules pass and the saved GLB bytes themselves contain `idle` and
`walk` animations.

`WORKER_SHARED_SECRET` must have the same value in the TRELLIS and Blender
secret files. Do not place its value in Compose or this repository.
