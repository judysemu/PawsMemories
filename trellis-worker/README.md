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

The model weights are downloaded once to a persistent volume, then the serving
container runs with `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`. Runtime
inference therefore makes no call to Hugging Face or another model API.

This worker creates geometry and PBR material. It does not claim rigging or
animation; those are separate, verified Blender stages.
